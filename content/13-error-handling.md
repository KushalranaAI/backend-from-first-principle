---
title: Error handling and fault tolerance
part: Production
summary: How to sort failures into kinds, answer each one with the right status code, and keep a service up when the things it depends on are not.
---

Every backend fails. The database restarts, a partner API hangs, a user sends a date in the wrong format, you ship a typo. Error handling is deciding, ahead of time, what your server does in each of those cases: what the client sees, what you log, and whether the process keeps going. Fault tolerance is the next step: staying useful while some part of the system is broken.

## The first principle

Picture a handler with no error handling at all. Four things can go wrong, and each one goes wrong differently:

```
bad input        → handler throws deep inside → client gets 500 for its own mistake
database down    → every request throws       → 500s, and the stack trace leaks the DB host
partner API hangs → request waits forever     → connections pile up, the server stops answering
a bug            → TypeError                  → 500, maybe a crashed process
```

The fix is not "wrap everything in try/catch". A catch that swallows an error is worse than no catch, because now the failure is silent. The fix is to **classify** failures. Once you know what kind of failure you have, three questions have clear answers:

1. **Whose fault is it?** The client's (4xx) or yours (5xx)?
2. **Will trying again help?** A timeout might pass. A validation error never will.
3. **Is the process still healthy?** A missing bookmark is a normal Tuesday. An exception you never expected means your program is in a state you didn't design for.

Everything in this lesson follows from those three questions.

> An error is information. Your job is to route it: a precise message to the client, full detail to your logs, and a decision about retrying or crashing.

## Core ideas

### Kinds of errors

| Kind | Example | Whose fault | Retry helps? | Typical answer |
|---|---|---|---|---|
| Input | missing `url`, title too long | client | no | 400 with field errors |
| Business rule | bookmark already saved, not your bookmark | client | no | 409, 403/404 |
| Database | unique violation, connection refused, deadlock | depends | sometimes | 409, 503, or retry the transaction |
| External service | metadata site returns 503 or hangs | theirs | often | timeout, retry, fallback, 502/504 |
| Configuration | `DATABASE_URL` missing, bad port | yours | no | refuse to start (lesson 14) |
| Logic (bug) | `undefined.title`, wrong `if` | yours | no | 500, log, fix the code |

Database errors deserve a closer look because one driver error type covers very different situations. Postgres gives every error a five-character `SQLSTATE` code, and `pg` exposes it as `err.code`. `23505` (unique violation) is a client conflict and should be a 409. `40001` (serialization failure) and `40P01` (deadlock) mean "run the transaction again". `57014` (query cancelled, often by `statement_timeout`) means you were too slow. A connection error such as `ECONNREFUSED` means the database is unreachable, and no amount of input fixing will help.

### Operational errors versus programmer errors

The Node.js community splits failures into two groups, and the split decides how you react.

- **Operational errors** are things that go wrong in a correct program: a timeout, a refused connection, a 404 from an upstream, invalid user input. You expect them, you handle them, the process keeps running.
- **Programmer errors** are bugs: reading a property of `undefined`, passing a string where a number belongs, forgetting to `await`. You cannot handle a bug in code, because you didn't know it was there. You can only stop the damage and fix it.

For a single request, a programmer error becomes a 500 and a loud log line. For the whole process, an error that escapes every handler means memory may be half-updated and invariants broken. That is when you crash and let the supervisor (Docker, Kubernetes, systemd) start a fresh process.

### Fail fast or recover

Two strategies, each right in its place:

- **Fail fast** when the problem is permanent or the state is unknown. Missing config at startup: exit before taking traffic. Invalid input: reject it at the edge instead of letting it travel three layers deep. An uncaught exception: exit.
- **Recover** when the problem is temporary and the operation is safe to repeat: retry a timed-out GET, retry a transaction that hit a deadlock, serve cached data while a dependency is down.

The mistake is mixing them up: retrying a validation error forever, or exiting the process because one upstream returned a 503.

### Typed errors

Business code should say *what* went wrong, not *which status code* to send. Give each failure kind its own class. The HTTP layer maps classes to responses later.

```js
// src/errors.js
export class AppError extends Error {
  constructor(status, title, detail, options) {
    super(detail ?? title, options); // options = { cause }
    this.name = new.target.name;
    this.status = status;
    this.title = title;
  }
}
export class NotFoundError extends AppError {
  constructor(what) { super(404, "Not Found", `${what} not found`); }
}
export class ConflictError extends AppError {
  constructor(detail) { super(409, "Conflict", detail); }
}
export class UpstreamError extends AppError {
  constructor(detail, options) { super(502, "Bad Gateway", detail, options); }
}
```

The `options` argument is the standard `Error` constructor's second parameter. Passing `{ cause: err }` keeps the original error attached, so your logs show both "could not fetch page metadata" and the `ECONNRESET` underneath it. Always wrap with `cause` instead of throwing a new error that loses the original.

### One central error handler

If every route formats its own errors, you get ten slightly different error shapes and at least one route that leaks a stack trace. Put the decision in one place. Routes and services just `throw`; one handler classifies the error, logs it at the right level and writes the response.

```js
// src/error-handler.js
import { STATUS_CODES } from "node:http";
import { AppError, ConflictError } from "./errors.js";

// Map anything thrown to { status, detail }, or null if we don't recognize it.
function classify(err) {
  if (err instanceof AppError) return err;
  if (err.validation) { // Fastify schema validation failed
    return { status: 400, detail: err.message,
      errors: err.validation.map((v) => ({ field: v.instancePath, message: v.message })) };
  }
  if (err.code === "23505") return new ConflictError("Already exists"); // pg unique_violation
  if (err.statusCode >= 400 && err.statusCode < 500) { // Fastify's own: bad JSON, 413, 415
    return { status: err.statusCode, detail: err.message };
  }
  return null; // unknown: a bug or an outage
}

export function errorHandler(err, request, reply) {
  const known = classify(err);
  const status = known?.status ?? 500;
  if (status >= 500) request.log.error({ err }, "request failed");
  else request.log.info({ status, reason: err.message }, "client error");

  reply.code(status).type("application/problem+json").send({
    type: "about:blank",
    title: known?.title ?? STATUS_CODES[status],
    status,
    detail: known ? (known.detail ?? known.message) : "Something went wrong on our side.",
    instance: request.url,
    requestId: request.id,
    ...(known?.errors && { errors: known.errors }),
  });
}
```

Register it once with `app.setErrorHandler(errorHandler)`. Fastify calls it for anything thrown in a route, a hook or a schema check. The body follows RFC 9457 problem details (lesson 08).

Notice the log levels. A 404 is the client's business, so it gets `info`. A 500 is yours, so it gets `error` with the whole error object, stack and `cause` included. If you log every 4xx as an error, your error dashboard fills with noise and nobody looks at it.

### Mapping errors to status codes

| Situation | Status |
|---|---|
| Input fails validation, body is not valid JSON | 400 |
| Not logged in | 401 |
| Logged in but not allowed | 403, or 404 if you don't want to reveal the thing exists |
| No such resource | 404 |
| Unique constraint, version conflict | 409 |
| Body too large / wrong content type | 413 / 415 |
| Rate limit hit | 429 with `Retry-After` |
| Bug, unknown error | 500 |
| Upstream returned garbage or failed | 502 |
| Overloaded, shutting down, circuit open | 503 with `Retry-After` |
| Upstream timed out | 504 |

### Never leak internals

The 500 branch above ignores `err.message` on purpose. Error messages are written for developers: `connect ECONNREFUSED 10.0.3.7:5432`, `relation "users" does not exist`, a file path, a stack trace. Each one tells an attacker which database you run, where it lives and what your tables are called. OWASP has long listed this as "improper error handling", and the 2025 edition of its Top 10 added a category for the whole subject: [A10, Mishandling of Exceptional Conditions](https://top10.owasp.org/2025/A10_2025-Mishandling_of_Exceptional_Conditions/).

The rule: **full detail goes to the log, a generic message goes to the client, and the request id joins the two.** When a user reports "error, request id `a1b2…`", you search your logs for that id and see everything (lesson 15).

### Timeouts

A request with no timeout can wait forever. While it waits it holds a socket, memory and often a database connection. When a dependency hangs, those pile up until your server stops answering anything. A slow dependency is more dangerous than a dead one, because a dead one fails fast.

Put a deadline on every call that leaves your process:

| Call | How |
|---|---|
| `fetch` | `fetch(url, { signal: AbortSignal.timeout(3000) })`. Without it, Node's fetch waits up to 5 minutes for headers. |
| Postgres (`pg`) | `statement_timeout` for queries, `connectionTimeoutMillis` for getting a connection from the pool |
| Redis (`ioredis`) | `commandTimeout`, `connectTimeout` |
| Incoming requests | Fastify `handlerTimeout` for the work, `requestTimeout` for a slow client, and the timeout on your load balancer |

The two Fastify options cover different things. `requestTimeout` only limits how long a client may take to send its request. `handlerTimeout`, added in Fastify 5.8 (March 2026), puts a deadline on the whole route, from the first hook to the serialized response. When it passes, the client gets a 503 and `request.signal` is aborted. Your handler keeps running, though, unless you hand that signal to the things it is waiting on, such as `fetch(url, { signal: request.signal })`. Run Fastify 5.12.8 or newer when you set it: earlier 5.x versions with `handlerTimeout` could be crashed by a streaming response that outlived the deadline (lesson 07).

When `AbortSignal.timeout` fires, `fetch` rejects with an error whose `name` is `"TimeoutError"`. Pick the number from what the caller can tolerate: if your API promises an answer in 2 seconds, a 30-second timeout on an internal call is meaningless.

### Retries with backoff and jitter

Many failures are transient: a dropped connection, a 503 during a deploy. Trying again usually works. Retrying badly, though, turns a small outage into a large one. Three rules:

1. **Retry only what can succeed and is safe to repeat.** Timeouts, network errors, 429, 502, 503, 504. Never 400 or 404. Only repeat requests that are idempotent (GET, PUT, DELETE, or a POST with an `Idempotency-Key`, lesson 08).
2. **Back off exponentially.** Wait 200 ms, then 400, then 800. Give the dependency room to recover.
3. **Add jitter.** If a thousand clients all fail at the same moment and all wait exactly 400 ms, they all come back at the same moment. Randomize the wait.

```js
// src/lib/resilience.js
import { setTimeout as sleep } from "node:timers/promises";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const isRetryable = (err) =>
  err.name === "TimeoutError" ||   // our deadline fired
  err.name === "TypeError" ||      // fetch: network failure (refused, reset, DNS)
  RETRYABLE_STATUS.has(err.status);

export async function fetchWithRetry(url, { attempts = 3, timeoutMs = 3000, baseMs = 200, ...init } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${url}`), { status: res.status });
      return res;
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      // "Full jitter": wait a random time in [0, base * 2^attempt).
      await sleep(Math.random() * baseMs * 2 ** attempt);
    }
  }
}
```

Watch out for **retry amplification**. If the browser retries 3 times, your API retries the service 3 times, and that service retries the database 3 times, one click becomes 27 database calls, all aimed at the system that is already struggling. Retry at one layer, usually the one closest to the failing call, and give the others a timeout only. If a server sends `Retry-After`, wait at least that long.

### Circuit breakers

Retries help with blips. They hurt during a real outage: every request still waits for its timeout, then tries again. A **circuit breaker** notices that a dependency keeps failing and stops calling it for a while.

```
          failures ≥ threshold
 CLOSED ─────────────────────────▶ OPEN ── calls fail instantly, no network
   ▲                                │
   │ trial call succeeds            │ after resetMs
   │                                ▼
   └──────────────────────────── HALF-OPEN ── let one trial call through
                trial fails → back to OPEN
```

```js
export function circuitBreaker(fn, { failureThreshold = 5, resetMs = 30_000 } = {}) {
  let failures = 0;
  let openedAt = 0; // 0 means closed
  return async (...args) => {
    if (openedAt && Date.now() - openedAt < resetMs) {
      throw Object.assign(new Error("circuit open"), { code: "CIRCUIT_OPEN" });
    }
    try {
      const result = await fn(...args); // closed, or half-open trial
      failures = 0; openedAt = 0;
      return result;
    } catch (err) {
      failures++;
      if (openedAt || failures >= failureThreshold) openedAt = Date.now();
      throw err;
    }
  };
}
```

Failing instantly is the point. Your threads and sockets stay free for work that can succeed, and the broken service gets quiet time to recover. This sketch lets every caller through once the reset time passes; a production library such as [opossum](https://github.com/nodeshift/opossum) allows a single trial, counts failures in a rolling time window and emits events you can turn into metrics.

### Fallbacks and graceful degradation

When a call fails and retrying is pointless, ask: can I still give a useful answer?

- **Serve stale data.** A cached tag count from 10 minutes ago beats a 500.
- **Return a partial response.** Show the bookmark without its preview image.
- **Use a default.** No recommendations service? Show the newest bookmarks instead.
- **Defer the work.** Can't fetch page metadata now? Save the bookmark anyway and let the queue retry later (lesson 11).

Decide which features are core (saving a bookmark) and which are extras (previews, counts). Extras should degrade quietly. Core features fail loudly with a clear 503. Never invent data to hide a failure, and log every fallback so you can tell when you're running degraded.

One thing must never degrade: a security check. If the session store or a permission lookup is unreachable, answer 503. Don't let the request through as if the check had passed. That is called *failing open*, and it is one of the failures the OWASP category above names.

### When nothing catches the error: Node's last resort

Errors that escape everything reach the process:

- A `throw` outside any try/catch, for example in a timer callback, emits **`uncaughtException`**.
- A rejected promise that nobody awaits or `.catch`es emits **`unhandledRejection`**. Since Node 15 the default mode is `throw`: an unhandled rejection becomes an uncaught exception and the process exits with code 1.

Node's documentation is blunt: the correct use of `uncaughtException` is to clean up synchronously and shut down, and "it is not safe to resume normal operation". So log it and exit:

```js
process.on("uncaughtException", (err, origin) => {
  logger.fatal({ err, origin }, "uncaught exception, exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  throw reason; // let the uncaughtException handler log it and exit
});
```

This only makes sense if something restarts the process: Docker's `--restart`, Kubernetes, systemd. A crash with a restart is a short blip. A process limping along in a broken state can corrupt data for hours. Run more than one instance, so one crash doesn't take the whole service down (lesson 18).

### Health checks

A load balancer or orchestrator needs to know whether your process can take traffic. You tell it with a health endpoint. Keep two ideas apart:

- **Liveness**: "is this process stuck?" Answer from the process alone. If it fails, the orchestrator restarts the process. Never check the database here, or a database blip restarts every instance at once.
- **Readiness**: "should I send this instance traffic right now?" May check that critical dependencies are reachable. If it fails, the instance is taken out of rotation but not restarted.

Lesson 16 builds both for Linkbox and uses readiness during shutdown.

## Try it

Make a folder with `"type": "module"` in `package.json`, run `npm i fastify`, and add `errors.js`, `error-handler.js` and `resilience.js` from above. First a misbehaving upstream, `flaky.js`:

```js
import http from "node:http";
let n = 0;
http.createServer((req, res) => {
  console.log(++n, req.url);
  if (req.url === "/slow") return setTimeout(() => res.end("late"), 5000);
  if (req.url === "/flaky" && n % 3 !== 0) { res.writeHead(503); return res.end(); }
  if (req.url === "/flaky") return res.end("ok");
  res.writeHead(404); res.end();
}).listen(4000);
```

Then the API, `app.js`:

```js
import Fastify from "fastify";
import { errorHandler } from "./error-handler.js";
import { NotFoundError, UpstreamError } from "./errors.js";
import { fetchWithRetry } from "./resilience.js";

const app = Fastify({ logger: true });
app.setErrorHandler(errorHandler);
app.setNotFoundHandler((req) => { throw new NotFoundError(`Route ${req.method} ${req.url}`); });

app.get("/bookmarks/:id", async (req) => { throw new NotFoundError(`Bookmark ${req.params.id}`); });
app.get("/bug", async () => { const b = undefined; return b.title; });
app.get("/preview/:mode", async (req) => {
  try {
    const res = await fetchWithRetry(`http://localhost:4000/${req.params.mode}`, { timeoutMs: 1000 });
    return { upstream: await res.text() };
  } catch (err) {
    throw new UpstreamError("Could not fetch the page", { cause: err });
  }
});
await app.listen({ port: 3000 });
```

Run `node flaky.js` and `node app.js` in two terminals, then:

```bash
curl -i localhost:3000/bookmarks/42          # 404, application/problem+json
curl -i localhost:3000/nope                  # 404 in the same shape
curl -i localhost:3000/bug                   # 500, generic detail; the stack is in the server log only
curl -i localhost:3000/preview/flaky         # 200 after retries: flaky.js logs 3 hits
curl -i localhost:3000/preview/missing       # 502 after 1 hit: a 404 is not worth retrying
curl -i localhost:3000/preview/slow          # 502 after 3-4 s: three 1 s timeouts plus backoff
```

Find the `/bug` request in the server log by its `reqId` and look at the full stack. Then find the `/preview/slow` one and look at `err.cause`.

Now break it on purpose:

1. Comment out `app.setErrorHandler(...)` and hit `/bug` again. Fastify's default handler returns the raw `err.message` (`Cannot read properties of undefined…`). That is a small leak; a database error message would be a bigger one.
2. Remove `signal: AbortSignal.timeout(timeoutMs)` and request `/preview/slow`. How long does curl wait now?
3. Add a route that does `setTimeout(() => Promise.reject(new Error("boom")), 100)` and call it. The client got its 200, but what happened to the process?
4. Make `isRetryable` return `true` for everything and request `/preview/missing` again. Count the wasted hits in the `flaky.js` terminal.

## Common mistakes

- **Swallowing errors.** `catch (e) {}` or `catch (e) { return null }` hides outages. If you catch, either handle it fully (fallback plus a log line) or rethrow with `{ cause }`.
- **Returning 500 for client mistakes, or 200 for failures.** Monitoring counts 5xx as your fault and alerts on it. A 200 with `{ "error": ... }` in the body hides failures from every tool.
- **Sending `err.message` or `err.stack` to the client.** Log it, send a generic message and the request id.
- **No timeout on outbound calls.** One hung dependency exhausts your sockets and pool. Every network call gets a deadline.
- **Retrying everything, at every layer, without jitter.** Retry only transient failures, only idempotent operations, at one layer, with randomized backoff.
- **Keeping the process alive after `uncaughtException`.** Log, exit with a non-zero code, let the supervisor restart you.

## Build: Linkbox, step 13

Linkbox already throws errors in a dozen places, and lessons 07 and 08 gave you a first `src/errors.js` and a problem+json handler. Now make them complete and consistent.

1. Turn the helpers in `src/errors.js` into a small class family under `AppError`, one per failure Linkbox has: `ValidationError` (400, carries per-field errors), `UnauthorizedError` (401), `NotFoundError` (404), `ConflictError` (409), `UpstreamError` (502). Keep `notFound()`, `invalid()` and `conflict()` as one-line shortcuts that return them, so existing call sites keep working.
2. Replace every hand-written `reply.code(...).send(...)` error left in controllers and services with a `throw`. Services must not know about HTTP; they throw typed errors and the handler maps them.
3. Review the central error handler from lesson 08: add a `setNotFoundHandler` that throws `NotFoundError`, make every error leave as `application/problem+json` with `requestId`, and map Postgres `23505` to 409.
4. Make sure no response ever contains a stack trace, SQL or an internal host name: unknown errors get a generic `detail`.
5. In the metadata worker (lesson 11), give every outbound `fetch` an `AbortSignal.timeout` of a few seconds. BullMQ already retries the job with backoff, so don't stack a second retry loop on top; just let the timeout throw. Wrap failures in `UpstreamError` with `{ cause }`.
6. Add `uncaughtException` and `unhandledRejection` handlers that log at `fatal` and exit with code 1.

**Done when** every error response from Linkbox has the same problem+json shape, `/bug`-style crashes show a stack in the logs but not in curl, and a metadata fetch to a site that never answers fails within your timeout instead of hanging.

## Check yourself

<details markdown="1">
<summary>What is the difference between an operational error and a programmer error, and why does it matter?</summary>

An operational error is an expected failure in correct code: a timeout, a refused connection, invalid input. You handle it and keep running. A programmer error is a bug, like reading a property of `undefined`. You can't handle what you didn't anticipate, so for one request you return 500, and if it escapes to the process you exit and restart, because the state may be corrupt.
</details>

<details markdown="1">
<summary>A database query fails with code <code>23505</code>. What status should the client get, and why not 500?</summary>

409 Conflict. `23505` is a unique-constraint violation: the client tried to create something that already exists. That's a problem with the request, not a server fault, so it belongs in the 4xx range.
</details>

<details markdown="1">
<summary>Why add random jitter to retry backoff?</summary>

Without jitter, clients that failed together retry together, in synchronized waves that hit the recovering service all at once. Randomizing the wait spreads the retries out.
</details>

<details markdown="1">
<summary>When would you rather have a circuit breaker than more retries?</summary>

During a sustained outage. Retries make every request wait for several timeouts and add load to a service that is already down. An open breaker fails instantly, frees your resources and gives the dependency time to recover, then tests it with a trial call.
</details>

<details markdown="1">
<summary>Why should a liveness check not query the database?</summary>

If the database has a hiccup, every instance fails liveness at once and the orchestrator restarts all of them, which fixes nothing and adds a cold start on top. Liveness answers "is this process stuck?" Dependency checks belong in readiness.
</details>

<details markdown="1">
<summary>Your service catches <code>uncaughtException</code>, logs it and carries on. What could go wrong?</summary>

The exception interrupted code halfway, so locks, counters, open transactions or in-memory caches may be in a state no code expects. The process keeps serving with corrupted state. Node's docs say it is not safe to resume; log and exit, and let the supervisor start a clean process.
</details>

## Go deeper

- [Node.js: Errors](https://nodejs.org/api/errors.html): error classes, `cause`, system error codes, and how errors travel through callbacks, promises and event emitters.
- [Node.js: process `uncaughtException`](https://nodejs.org/api/process.html#event-uncaughtexception): the official warning about resuming after one, and the `unhandledRejection` event.
- [AWS Builders' Library: Timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/): how Amazon picks timeouts, why retries amplify load and why jitter matters.
- [Martin Fowler: CircuitBreaker](https://martinfowler.com/bliki/CircuitBreaker.html): the original write-up of the pattern, with its states.
- [Google SRE book: Addressing cascading failures](https://sre.google/sre-book/addressing-cascading-failures/): how one slow dependency takes down a whole system, and the defences (deadlines, load shedding, degradation).
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457): the standard error body used by the handler in this lesson.
