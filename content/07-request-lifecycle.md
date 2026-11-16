---
title: Controllers, services, repositories and middleware
part: The request
summary: What happens to a request between the socket and the database, and how to split that work into layers you can change and test.
---

A request doesn't go straight from the router to the database. On its way in it is logged, given an id, parsed, authenticated, validated and handed to your code; on its way out it is serialized, given headers and logged again. How you arrange those steps decides whether the codebase is easy to change in a year. This lesson names the pieces every backend framework uses, in any language, and moves Linkbox onto Fastify.

## The first principle

Look at what one handler from lesson 05 has to do to create a bookmark:

```
read the session cookie, look up the user, 401 if none     ← every protected route does this
read and parse the JSON body, 400 if broken                ← every POST and PATCH does this
check the URL and title, 400 with field errors             ← rules about bookmarks
decide: new id, owner, timestamps                          ← rules about bookmarks
store it                                                   ← storage detail
reply 201 with JSON                                        ← HTTP detail
log the outcome and how long it took                       ← every route does this
```

Put all of that in one function and two problems appear.

**Repetition.** The first, second and last lines are the same for dozens of routes. Copy them and one day a new route forgets the session check. That is a security bug made of missing lines. Work that applies to *many* routes should be written once and run *around* every handler. That idea is **middleware**.

**Tangling.** The rest mixes three different kinds of knowledge: how HTTP works (status codes, headers), what a bookmark *is* (rules), and where bookmarks are kept (SQL). Each changes for different reasons. You'll swap the in-memory store for Postgres in lesson 09, add a background job that creates bookmarks without any HTTP request in lesson 11, and test the rules without a server in lesson 22. If the three are tangled, every one of those changes means rewriting everything. Separate them into **layers**: a controller for HTTP, a service for rules, a repository for storage.

Middleware is the horizontal cut (same work across many routes). Layers are the vertical cut (different kinds of work inside one route). One more piece ties them together: **request context**, the per-request data (id, user, deadline) that all of them need to see.

## Core ideas

### The life of a request

Here is the full path, the same in Express, Fastify, Go's `net/http` or Django:

```
client ──TCP/TLS──▶ HTTP parser (Node) ──▶ router: (method, path) → route
                                              │
          ┌───────────── middleware chain ────┴──────────────────────────┐
          │ request id → logging → CORS → rate limit → body parse → auth │
          └──────────────────────────────┬───────────────────────────────┘
                                         ▼
                 controller (handler): read params/body, call the service
                                         ▼
                 service: business rules, decisions, orchestration
                                         ▼
                 repository: SQL / Redis / HTTP calls to other systems
                                         ▼
                                     database
     ◀── serialize JSON ◀── set status and headers ◀── result or error
     ◀── error handler turns thrown errors into responses
     ◀── logging middleware records status and duration
```

Calls go down the layers and results come back up. Errors thrown anywhere bubble up to one place that turns them into an HTTP response.

### Controllers: HTTP in, HTTP out

The **controller** (also called a *handler*) is the only layer that knows it's in an HTTP server. Its job is translation:

1. Pull what the service needs out of the request: path params, query, body, the current user.
2. Call one service method.
3. Turn the result into a response: status code, headers, body.

```js
create: async (req, reply) =>
  reply.code(201).send(await service.create(req.user.id, req.body)),
```

A good controller is short and boring. If you see an `if` about bookmarks in it, that rule belongs in the service. If you see SQL, it belongs in the repository.

### Services: the business logic

The **service** holds what your application actually *does*: the rules that would stay the same if you swapped HTTP for a CLI, a queue consumer or a test. "A bookmark's URL must be valid", "only the owner may delete it", "creating a bookmark also enqueues a metadata fetch" all live here.

A service takes plain values (`ownerId`, `input`) and returns plain values or throws an error. It never sees `req`, `reply`, status codes or cookies. That is what lets a background worker call `service.create()` in lesson 11 and a unit test call it in lesson 22 without building a fake HTTP request.

Services can call several repositories and other services, and they are where a transaction usually starts (lesson 09).

### Repositories: storage behind an interface

The **repository** is the only layer that knows *where* data lives and *how* to get it: SQL text, table names, Redis keys, the URL of another company's API. To the service it offers methods named after what they mean:

```js
bookmarks.findForOwner(id, ownerId)   // not: db.query("SELECT ... WHERE ...")
```

That boundary pays off three times in this course: when the in-memory `Map` becomes Postgres (lesson 09), when a Redis cache is added in front of reads (lesson 10), and in tests, where you can hand the service a fake repository.

### Why each boundary exists, and when it's too much

| Boundary | Protects you from | Ask yourself |
|---|---|---|
| Controller ↔ service | HTTP details leaking into rules | Could a CLI or a job call this logic without faking a request? |
| Service ↔ repository | Storage details leaking into rules | Could I move this table to another database without touching the rules? |
| Middleware ↔ handler | Copy-pasted cross-cutting code | Does every route that needs this get it automatically? |

The direction matters as much as the split: controllers depend on services, services on repositories, never the other way. A repository that returns a 404 response, or a service that reads a cookie, has crossed a line.

Don't overdo it. A four-route internal tool doesn't need three files per route, interfaces with one implementation, or a dependency-injection container. Plain functions wired together in one place (as Linkbox does below) are enough. Add a layer when it removes a real problem, not because a template has one. These are conventions, not laws, and different teams draw the lines a little differently.

### Middleware: code that runs around every handler

A **middleware** is a function that receives the request before the handler does, and can do one of three things:

1. **Pass it on**, maybe after adding something (`req.user = ...`), by calling `next()`.
2. **Stop it** by sending a response itself (a `401`, a `429`) and *not* calling `next()`.
3. **Fail** by throwing or calling `next(err)`, which skips to the error handler.

Because each middleware calls the next one, the chain nests like an onion. Code before `await next()` runs on the way in; code after it runs on the way out:

```
logger in ─▶ auth ─▶ handler
logger out ◀──────────┘          (logger saw the final status and duration)
```

That is how one logging middleware can time every request: it notes the start, awaits the rest of the chain, then logs the status. Express (`app.use((req, res, next) => ...)`), Koa, Hono and Go's `func(http.Handler) http.Handler` pattern are all versions of this.

### Order matters

Middleware runs in the order you register it, so order is part of your security design:

| Order | Middleware | Why here |
|---|---|---|
| 1 | Request id | Everything after it, including logs and errors, can mention the id |
| 2 | Request logging | Must wrap everything to measure the full time and see the final status |
| 3 | Security headers, CORS | CORS must answer browser preflight `OPTIONS` requests before auth rejects them |
| 4 | Rate limiting | Cheap, and should run before expensive work like hashing passwords |
| 5 | Body parsing | Reads the JSON body with a size limit (lesson 04) |
| 6 | Authentication | Turns the cookie or token into `req.user` |
| 7 | Validation | Checks params and body (lesson 06) |
| 8 | Handler | Your controller |
| last | Error handler | Catches anything thrown above and sends one consistent error response |

Some mistakes that come from wrong order: auth registered *after* the routes it was meant to protect (they run unprotected); a logger registered after auth (rejected requests never get logged); rate limiting after the login handler (attackers get unlimited password guesses).

A word on **CORS**, since it's in every list: it is not server security. It's the browser asking your server, "may JavaScript from `https://app.example.com` read your responses?" The server answers with `Access-Control-Allow-Origin` and friends. `curl` ignores CORS completely. Allow the specific origins of your own frontends, never `*` together with cookies.

### Request context

Some data belongs to exactly one request and is needed all the way down the stack:

- **Request id**: a unique id for this request, sent back in a response header and printed in every log line, so one failing request can be found among millions (lesson 15). If a trusted proxy in front of you already assigned one (`X-Request-Id`, or a W3C `traceparent`), reuse it.
- **The user**: who is calling, set by the auth middleware.
- **A deadline and cancellation signal**: if the client hangs up, or the request has been running for 10 seconds, there is no point finishing the database query or the outbound fetch.

How does that data reach a repository five calls down? Three options:

1. **Attach it to the request object** (`req.user`). Fine for controllers and middleware, but services shouldn't see `req`.
2. **Pass it explicitly** as an argument (`service.create(userId, input)`). Clear and testable. Do this for things the logic depends on, such as the user id.
3. **Store it in async-local context.** For things that are *about* the request rather than inputs to the logic (request id, logger, signal), passing them through every function is noise.

Go solves this with `context.Context`, which every function takes as its first argument and which carries values, a deadline and cancellation. In Node the third option is **`AsyncLocalStorage`** from `node:async_hooks`: you start a context with `als.run(store, fn)`, and any code that runs as part of `fn`, including after any number of `await`s and timers, gets the same `store` from `als.getStore()`. Concurrent requests each see their own store.

```js
import { AsyncLocalStorage } from "node:async_hooks";
const als = new AsyncLocalStorage();

als.run({ requestId: "req-1" }, async () => {
  await somethingSlow();
  console.log(als.getStore().requestId);   // "req-1", even after the await
});
```

Use it sparingly. Data that changes what the code *does* should be a visible argument; hidden globals make code hard to follow.

**Cancellation** in Node uses `AbortSignal`. `fetch()`, `stream.pipeline()`, `timers/promises` and many libraries accept a `signal` option and stop when it fires. `AbortSignal.timeout(ms)` gives you a deadline; `AbortSignal.any([a, b])` combines a deadline with "the client disconnected". Fastify 5.8 and newer creates one for you as `request.signal`, aborted when the client goes away or when the route's `handlerTimeout` expires. On a timeout Fastify sends a `503` itself, but the timeout is cooperative: your code keeps running unless it passes the signal on or checks it. If you set `handlerTimeout`, run 5.12.8 or newer. Versions 5.8.0 to 5.12.7 could crash the process when the timeout fired during a streaming response.

### The Fastify version

From here on Linkbox uses **Fastify** (version 5). Its pieces map one to one onto what you've just read, under different names:

**Hooks are middleware, with named slots.** Instead of one chain, Fastify has fixed points in the lifecycle where you can attach functions:

| Hook | Runs | Typical use |
|---|---|---|
| `onRequest` | First, before the body is read | Request id, auth lookup, rate limiting |
| `preParsing` | Before the body is parsed | Decompressing, limiting the raw stream |
| `preValidation` | After parsing, before schema validation | Shape fixes before validation |
| `preHandler` | Right before the handler | Authorization checks that need the body |
| `preSerialization` | Before the result becomes JSON | Wrapping or reshaping the payload |
| `onSend` | Before bytes go out | Adding response headers |
| `onResponse` | After the response is sent | Access logs, metrics |
| `onError` | When something threw | Extra error logging (the reply is built by the error handler) |

A hook stops the request by sending a reply itself: `return reply.code(401).send(...)`. Async hooks must not also call `done()`; pick one style per hook.

**Plugins are groups with their own scope.** `app.register(plugin, { prefix: "/api/v1" })` runs `plugin(app, options)` with a *child* instance. Hooks and decorators added inside only apply to routes inside, which is how "all bookmark routes need a user, `/health` doesn't" is expressed. This is called **encapsulation**. When a plugin should affect everything (a request-id hook, an auth decorator), wrap it with `fastify-plugin` to opt out of encapsulation.

**Decorators add properties.** `app.decorateRequest("user", null)` declares that every request has a `user` field, which a hook then fills. Declare it up front with a `null` placeholder so every request object has the same shape (fast for V8). Fastify refuses objects and arrays as initial values, since they would be shared by every request. `app.decorate("requireUser", fn)` adds a reusable function to the instance.

**Built-ins replace common middleware.** Fastify parses JSON bodies itself (1 MiB limit by default, `bodyLimit` to change), generates request ids (`request.id`, override with `genReqId`), logs through pino with that id on every line, and has one `setErrorHandler`. Official plugins cover the rest: `@fastify/cookie`, `@fastify/cors`, `@fastify/helmet`, `@fastify/rate-limit`.

## Try it

**1. Build the onion.** Save as `onion.mjs` and run it with `node onion.mjs`:

```js
// A middleware is (ctx, next) => ...; compose() chains them into one function.
function compose(middlewares, handler) {
  return (ctx) => {
    const run = (i) => (i === middlewares.length ? handler(ctx) : middlewares[i](ctx, () => run(i + 1)));
    return run(0);
  };
}

const logger = async (ctx, next) => {
  const start = performance.now();
  console.log("→ logger in");
  await next();
  console.log(`← logger out: ${ctx.status} in ${(performance.now() - start).toFixed(1)} ms`);
};
const auth = async (ctx, next) => {
  console.log("→ auth");
  if (!ctx.headers.authorization) { ctx.status = 401; return; }   // stop: never call next()
  ctx.user = { id: 7 };
  await next();
};
const handler = async (ctx) => { console.log("→ handler"); ctx.status = 200; };

const app = compose([logger, auth], handler);
await app({ headers: { authorization: "Bearer x" } });
console.log("---");
await app({ headers: {} });
```

The second call never reaches the handler, but the logger still records the 401: it wraps everything.

**2. Watch context survive `await`.** Save as `als.mjs`:

```js
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const als = new AsyncLocalStorage();
const log = (msg) => console.log(`[${als.getStore()?.requestId ?? "-"}] ${msg}`);

async function repositoryFind() {        // deep in the stack, nothing passed in
  await sleep(Math.random() * 50);
  log("query finished");
}

const handle = (requestId) => als.run({ requestId }, async () => {
  log("start");
  await repositoryFind();
  log("done");
});

await Promise.all([handle("req-1"), handle("req-2"), handle("req-3")]);
log("outside any request");
```

The three "requests" interleave in random order, yet every line carries the right id.

**3. See Fastify's hook order.** In a folder with `npm i fastify`, save as `hooks.mjs`:

```js
import Fastify from "fastify";

const app = Fastify();
for (const hook of ["onRequest", "preParsing", "preValidation", "preHandler",
                    "preSerialization", "onSend", "onResponse"]) {
  app.addHook(hook, async () => console.log(hook));
}
app.post("/echo", async (req) => { console.log("handler"); return req.body; });

const res = await app.inject({ method: "POST", url: "/echo", payload: { hi: 1 } });
console.log(res.statusCode, res.body);
```

`app.inject()` sends a fake request through the whole lifecycle without opening a port. You'll use it for tests in lesson 22.

Break it on purpose:

1. In `onion.mjs`, swap the order to `[auth, logger]`. Which requests does the logger miss now?
2. Make the handler slow (`await new Promise((r) => setTimeout(r, 20))` as its first line), then remove `await` before `next()` in the logger. Why does the logger now print `undefined` and a tiny duration, and why does "→ handler" appear after it?
3. In `als.mjs`, replace `als.run(...)` with a module-level `let currentRequestId` that each request sets. Run it again and watch the ids get mixed up.
4. In `hooks.mjs`, add `app.decorateRequest("user", {})` just after `Fastify()` and run it. Read Fastify's error, then change `{}` to `null`.

## Common mistakes

- **Fat controllers.** Rules, SQL and HTTP in one handler. Nothing can be reused by a job or tested without a server. Keep controllers to "parse, call one service method, reply".
- **Services that know about HTTP.** A service that takes `req` or returns `reply.code(404)` can't be called from a worker. Throw a typed error (`NotFoundError`) and let the error handler choose the status (lesson 13).
- **Middleware in the wrong order.** Auth after the routes, logging after auth, rate limiting after login. Write the order down and test that a protected route really returns 401 without a session.
- **Forgetting to stop.** A middleware sends a 401 and then also calls `next()`, or a Fastify hook sends a reply without returning, and the handler runs anyway ("reply already sent"). After you respond, return.
- **Module-level variables for per-request data.** `let currentUser` is shared by every concurrent request, so users see each other's data under load. Use the request object, explicit arguments or `AsyncLocalStorage`.
- **Trusting a client's request id.** Accept `X-Request-Id` only from your own proxy, and cap its length, or attackers write anything they like into your logs.

## Build: Linkbox, step 7

Move Linkbox from `node:http` to Fastify and split it into layers. Behaviour stays the same; every `curl` from lessons 03 to 06 should still pass.

1. Install the dependencies: `npm i fastify @fastify/cookie fastify-plugin`, and set `"type": "module"` in `package.json`. Check that `npm ls fastify` shows 5.12.8 or newer, because `buildApp()` below sets `handlerTimeout`.
2. Create this layout. Each resource gets a folder with its four layers:

   ```
   src/
     server.js                  start: build the app, listen
     app.js                     buildApp(): wire layers, register plugins and routes
     context.js                 AsyncLocalStorage store
     errors.js                  AppError, NotFoundError, ValidationError
     plugins/
       request-context.js       request id header + async context
       auth.js                  session cookie → request.user, requireUser
     auth/
       auth.routes.js  auth.controller.js  auth.service.js
       users.repository.js  sessions.repository.js  passwords.js
     bookmarks/
       bookmarks.routes.js  bookmarks.controller.js
       bookmarks.service.js  bookmarks.repository.js  bookmarks.validation.js
   ```

   `passwords.js` is `auth.js` from lesson 05; `bookmarks.validation.js` is your lesson 06 validator, changed to throw `ValidationError` with the per-field errors.
3. Write the context and the two plugins. `fastify-plugin` makes their hooks apply to every route:

   ```js
   // src/context.js
   import { AsyncLocalStorage } from "node:async_hooks";
   export const als = new AsyncLocalStorage();
   export const ctx = () => als.getStore() ?? {};
   ```

   ```js
   // src/plugins/request-context.js
   import fp from "fastify-plugin";
   import { als } from "../context.js";

   export default fp(async (app) => {
     app.addHook("onRequest", (req, reply, done) => {
       reply.header("X-Request-Id", req.id);
       als.run({ requestId: req.id, log: req.log, signal: req.signal }, done);
     });
   });
   ```

   ```js
   // src/plugins/auth.js
   import fp from "fastify-plugin";
   import { ctx } from "../context.js";

   export default fp(async (app, { sessions, users }) => {
     app.decorateRequest("user", null);

     app.addHook("onRequest", async (req) => {
       const session = await sessions.get(req.cookies.sid);
       if (!session) return;
       req.user = await users.findById(session.userId);
       ctx().userId = req.user?.id;
     });

     app.decorate("requireUser", async (req, reply) => {
       if (!req.user) {
         return reply.code(401).header("WWW-Authenticate", 'Cookie realm="linkbox"')
           .send({ error: "log in first" });
       }
     });
   });
   ```

4. Write the bookmark layers. The repository is the in-memory `Map` from lesson 05 behind named methods; the service owns the rules; the controller only translates:

   ```js
   // src/bookmarks/bookmarks.repository.js  (Postgres replaces this in lesson 09)
   export function createBookmarkRepository() {
     const rows = new Map();
     return {
       async insert(b) { rows.set(b.id, b); return b; },
       async findForOwner(id, ownerId) {
         const b = rows.get(id);
         return b?.ownerId === ownerId ? b : null;
       },
       async listByOwner(ownerId) { return [...rows.values()].filter((b) => b.ownerId === ownerId); },
       async remove(id) { return rows.delete(id); },
     };
   }
   ```

   ```js
   // src/bookmarks/bookmarks.service.js
   import { randomUUID } from "node:crypto";
   import { NotFoundError } from "../errors.js";
   import { validateBookmark } from "./bookmarks.validation.js";
   import { ctx } from "../context.js";

   export function createBookmarkService({ bookmarks }) {
     async function get(ownerId, id) {
       const b = await bookmarks.findForOwner(id, ownerId);
       if (!b) throw new NotFoundError("bookmark");
       return b;
     }
     return {
       get,
       list: (ownerId) => bookmarks.listByOwner(ownerId),
       async create(ownerId, input) {
         const data = validateBookmark(input);
         const b = await bookmarks.insert({ id: randomUUID(), ownerId, ...data,
           createdAt: new Date().toISOString() });
         ctx().log?.info({ bookmarkId: b.id }, "bookmark created");   // carries the request id
         return b;
       },
       async remove(ownerId, id) {
         await get(ownerId, id);              // the ownership check lives here, once
         await bookmarks.remove(id);
       },
     };
   }
   ```

   ```js
   // src/bookmarks/bookmarks.controller.js
   export function createBookmarkController({ service }) {
     return {
       list: async (req) => ({ data: await service.list(req.user.id) }),
       get: async (req) => service.get(req.user.id, req.params.id),
       create: async (req, reply) =>
         reply.code(201).send(await service.create(req.user.id, req.body)),
       remove: async (req, reply) => {
         await service.remove(req.user.id, req.params.id);
         return reply.code(204).send();
       },
     };
   }
   ```

   ```js
   // src/bookmarks/bookmarks.routes.js
   export default async function bookmarkRoutes(app, { controller }) {
     app.addHook("preHandler", app.requireUser);   // only routes in this plugin
     app.get("/bookmarks", controller.list);
     app.post("/bookmarks", controller.create);
     app.get("/bookmarks/:id", controller.get);
     app.delete("/bookmarks/:id", controller.remove);
   }
   ```

   Add `PATCH /bookmarks/:id` the same way. Do the `auth/` folder the same way: the service owns signup, login (with the dummy-hash trick) and logout; the controller sets and clears the cookie with `reply.setCookie("sid", id, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge })`.
5. Wire everything in one place. This is the only file that knows how the layers fit together:

   ```js
   // src/app.js
   import Fastify from "fastify";
   import cookie from "@fastify/cookie";
   import { randomUUID } from "node:crypto";
   import requestContext from "./plugins/request-context.js";
   import auth from "./plugins/auth.js";
   import bookmarkRoutes from "./bookmarks/bookmarks.routes.js";
   import { createBookmarkRepository } from "./bookmarks/bookmarks.repository.js";
   import { createBookmarkService } from "./bookmarks/bookmarks.service.js";
   import { createBookmarkController } from "./bookmarks/bookmarks.controller.js";
   // ...plus the auth imports

   export function buildApp() {
     const app = Fastify({ logger: true, genReqId: () => randomUUID(), handlerTimeout: 10_000 });

     const users = createUserRepository();
     const sessions = createSessionRepository();
     const bookmarkService = createBookmarkService({ bookmarks: createBookmarkRepository() });

     app.register(requestContext);
     app.register(cookie);
     app.register(auth, { sessions, users });
     app.register(authRoutes, { prefix: "/api/v1", controller: createAuthController({ service: createAuthService({ users, sessions }) }) });
     app.register(bookmarkRoutes, { prefix: "/api/v1", controller: createBookmarkController({ service: bookmarkService }) });
     app.get("/health", async () => ({ ok: true }));

     app.setErrorHandler((err, req, reply) => {
       const status = err.statusCode ?? 500;
       if (status >= 500) req.log.error(err);
       reply.code(status).send({
         error: status >= 500 ? "internal error" : err.message,
         ...(err.errors && { errors: err.errors }),
         requestId: req.id,
       });
     });
     return app;
   }
   ```

   `server.js` is two lines: `const app = buildApp(); await app.listen({ port: 3000 });`. Keeping `buildApp()` separate lets tests call `app.inject()` without a port.
6. Run it and check the logs: every line for one request carries the same `reqId`, including the "bookmark created" line written from the service, and the response has a matching `X-Request-Id` header.

**Done when** the lesson 03–06 `curl` checks still pass on Fastify, `/health` works without a cookie while `/api/v1/bookmarks` returns 401 without one, and no service file imports Fastify or mentions `req`, `reply` or a status code.

## Check yourself

<details markdown="1">
<summary>Where does the rule "a user may only delete their own bookmark" belong: controller, service or repository?</summary>

The service. It's a business rule that must hold no matter who calls (HTTP, a job, an admin script). The repository can help by offering `findForOwner`, but the decision to refuse lives in the service, and the controller only maps the resulting error to a 404.
</details>

<details markdown="1">
<summary>A logging middleware is registered after the auth middleware. What goes wrong?</summary>

Requests that auth rejects with a 401 stop before the logger runs, so they never appear in the logs. Those are exactly the requests you want to see during an attack. Logging (and request ids) belong first, so they wrap everything.
</details>

<details markdown="1">
<summary>Why is the CORS middleware placed before authentication?</summary>

Browsers send a preflight `OPTIONS` request without cookies or tokens before a cross-origin call. If auth runs first it rejects the preflight with a 401, and the browser blocks the real request.
</details>

<details markdown="1">
<summary>What problem does <code>AsyncLocalStorage</code> solve, and what shouldn't you use it for?</summary>

It makes per-request data (request id, logger, abort signal) available deep in the call stack, across `await`s, without passing it through every function, and keeps concurrent requests separate. Don't use it to smuggle in inputs that change behaviour, like the user id a service filters by. Those should be explicit arguments.
</details>

<details markdown="1">
<summary>In Fastify, why wrap the auth plugin in <code>fastify-plugin</code> but not the bookmark routes plugin?</summary>

Plugins are encapsulated: hooks and decorators added inside apply only to that plugin's routes. The auth plugin must decorate *every* request with `user`, so it opts out with `fastify-plugin`. The bookmark routes plugin adds a `requireUser` hook that should apply only to bookmark routes, so it stays encapsulated and `/health` remains public.
</details>

## Go deeper

- [Fastify: Hooks](https://fastify.dev/docs/latest/Reference/Hooks/): every lifecycle hook, the async vs callback rules, and how to respond early.
- [Fastify: Encapsulation](https://fastify.dev/docs/latest/Reference/Encapsulation/): how plugin scope works and when to use `fastify-plugin`.
- [Node.js: AsyncLocalStorage](https://nodejs.org/api/async_context.html#class-asynclocalstorage): the API, with a request-id logging example.
- [Go blog: Go Concurrency Patterns: Context](https://go.dev/blog/context): the clearest explanation of request-scoped values, deadlines and cancellation, from the language that passes them to every function as an argument.
- [Express: Using middleware](https://expressjs.com/en/guide/using-middleware.html): the classic `(req, res, next)` model, including error-handling middleware.
- [Martin Fowler: Repository](https://martinfowler.com/eaaCatalog/repository.html): the original short description of the pattern.
