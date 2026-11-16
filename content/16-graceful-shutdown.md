---
title: Graceful shutdown
part: Production
summary: How a server should stop: finish what it started, refuse new work, release its connections and exit before the platform kills it.
---

Servers stop all the time: every deploy, every scale-down, every node upgrade, every Ctrl-C on your laptop. If the process simply dies, the requests it was handling die with it, jobs stop halfway and database connections are cut mid-transaction. Graceful shutdown is the short routine that runs between "please stop" and exit, so that stopping a server is a non-event for its users.

## The first principle

Kill a busy server and look at what was in flight:

```
user A  POST /bookmarks ──▶ row inserted, response not sent yet   ✗ client sees a reset, retries, maybe a duplicate
user B  GET  /bookmarks ──▶ waiting on a query                    ✗ 502 from the load balancer
worker  enrich job 812  ──▶ fetched the page, not saved yet       ✗ job stuck as "active" until a stall check
pool    20 connections  ──▶ dropped without goodbye               ✗ Postgres logs errors, slots linger
logs    last 50 lines   ──▶ still in a buffer                     ✗ the clue to why it crashed is gone
```

None of these is a bug in a handler. They happen because the process had no chance to finish. Two facts make a fix possible:

1. **The platform asks before it forces.** Docker, Kubernetes, systemd and your terminal all send a polite signal first and only kill the process if it doesn't leave in time.
2. **Your process can listen for that request** and use the time to wind down: stop taking new work, finish current work, release resources, exit.

Graceful shutdown is that routine. It has to be fast enough to finish inside the platform's deadline, and safe enough that a process killed anyway leaves nothing permanently broken.

## Core ideas

### The process lifecycle

```
 start ──▶ init ──────────▶ ready ──────────▶ draining ──────────▶ exit
           load config      listening,         signal received:     code 0 if clean,
           connect DB,      readiness = ok,    readiness = fail,    non-zero if not
           Redis, queue     serving traffic    finish in-flight,
                                               close connections
```

Startup and shutdown mirror each other. Init opens resources in order (config, pool, Redis, then listen). Shutdown releases them in reverse (stop listening, wait for requests, then close Redis and the pool). Requests still in flight need the database, so the pool closes last.

### Signals

A signal is a small numbered message the operating system delivers to a process. The ones that matter for servers:

| Signal | Number | Sent by | Can you catch it? | Default action |
|---|---|---|---|---|
| `SIGTERM` | 15 | `kill <pid>`, `docker stop`, Kubernetes, systemd | yes | terminate |
| `SIGINT` | 2 | Ctrl-C in a terminal | yes | terminate |
| `SIGHUP` | 1 | terminal closed; by convention "reload config" for daemons | yes | terminate |
| `SIGQUIT` | 3 | Ctrl-\ | yes | terminate with core dump |
| `SIGKILL` | 9 | `kill -9`, the platform after the deadline | **no** | terminate immediately |
| `SIGSTOP` | 19 on most Linux | `kill -STOP` | **no** | pause |

`SIGTERM` is the polite request and `SIGKILL` is the force. `SIGKILL` cannot be caught, blocked or delayed: the kernel removes the process, and no code of yours runs. That is why graceful shutdown must happen on `SIGTERM`, and why it must finish before the `SIGKILL` arrives.

When a process dies from a signal, shells and orchestrators report exit code 128 + the signal number: 130 for `SIGINT`, 143 for `SIGTERM`, 137 for `SIGKILL`. If you see 137 in `docker ps -a` or Kubernetes, your process was killed by force: it ran out of time, or memory (the OOM killer also uses `SIGKILL`).

In Node, `process.on("SIGTERM", fn)` installs a handler. Installing one removes Node's default behaviour, which is to exit. From then on, your handler is responsible for making the process exit. On Windows only `SIGINT` (Ctrl-C) and a few others are delivered; try the signal experiments in this lesson on macOS, Linux or WSL.

### What happens on deploy and scale-down

**Docker.** `docker stop` sends `SIGTERM` (or the image's `STOPSIGNAL`), waits 10 seconds by default, then sends `SIGKILL`. Change the wait with `docker stop -t 30` or `stop_grace_period` in Compose.

**Kubernetes.** When a pod is deleted (rolling update, scale-down, node drain), two things start **at the same time**:

```
t=0   pod marked Terminating
      ├─ control plane: remove pod from Service endpoints ──▶ kube-proxy / ingress update... (takes a moment)
      └─ kubelet: run preStop hook (if any) ──▶ then send SIGTERM to PID 1 in each container
                                                    │
t=terminationGracePeriodSeconds (default 30 s)      ▼
      SIGKILL anything still running
```

The race in that picture causes most shutdown errors in Kubernetes. Your process may receive `SIGTERM` *before* every load balancer has stopped sending it traffic. If it closes its listener immediately, the requests that arrive in the next second or two get connection refused.

The fix is to keep serving for a few seconds after the signal: either a `preStop` hook that sleeps, or a delay inside your own handler. The grace period counts from the start, so it must cover the preStop sleep plus your whole shutdown:

```yaml
spec:
  terminationGracePeriodSeconds: 45
  containers:
    - name: api
      lifecycle:
        preStop:
          sleep:
            seconds: 5          # built-in sleep action (Kubernetes 1.30+, stable since 1.34); older clusters: exec ["sleep", "5"]
      readinessProbe:
        httpGet: { path: /health/ready, port: 3000 }
        periodSeconds: 5
      livenessProbe:
        httpGet: { path: /health/live, port: 3000 }
        periodSeconds: 10
```

### Liveness and readiness

Two endpoints, two questions (lesson 13 introduced them):

- **`/health/live`**: is the process working at all? It should answer from memory with no dependency checks. Failing it gets the container restarted.
- **`/health/ready`**: should traffic be sent here right now? It returns 503 while starting up, while shutting down, and optionally when a critical dependency is unreachable. Failing it takes the instance out of rotation without a restart.

During shutdown, readiness flips to 503 at once while liveness stays 200. Kubernetes already removes a terminating pod from its endpoints whatever the probe says, but other load balancers (an AWS target group, nginx with health checks, Consul) only learn you're leaving from the failing readiness check.

### The shutdown sequence

When the signal arrives, in this order:

1. **Mark not ready.** `/health/ready` starts returning 503.
2. **Wait a few seconds** so load balancers notice and stop sending new requests. (Skip it if a preStop sleep already did this.)
3. **Stop accepting new connections** and let in-flight requests finish. In Fastify, `app.close()` does this: new requests get 503 with `Connection: close` (the `return503OnClosing` option, on by default), and it resolves once in-flight requests are done.
4. **Stop background workers.** Let current jobs finish or return them to the queue. BullMQ's `worker.close()` stops taking jobs and waits for active ones.
5. **Close resources** in reverse order of opening: Redis clients (`redis.quit()`), the Postgres pool (`pool.end()`), file handles. In Fastify, put these in `onClose` hooks so `app.close()` runs them after requests drain.
6. **Flush logs.** pino flushes its buffer on normal exit; if you log through a transport or a buffered destination, call `logger.flush()` before exiting.
7. **Exit** with code 0 if everything closed, non-zero if something failed. Prefer setting `process.exitCode` and letting the event loop empty; if handles stay open, call `process.exit()` explicitly.

Shutdown must be **idempotent**: a second `SIGTERM`, or a `SIGINT` after a `SIGTERM`, must not start a second shutdown.

### A hard deadline

Graceful shutdown can hang: a request that never finishes, a job stuck on a fetch with no timeout, a socket the client never closes. If you wait forever, the platform's `SIGKILL` decides for you, with no log line explaining why. Set your own deadline, shorter than the platform's, and exit loudly when it passes:

```js
setTimeout(() => {
  logger.error("graceful shutdown timed out, forcing exit");
  process.exit(1);
}, 25_000).unref();
```

`.unref()` tells Node this timer alone should not keep the process alive. If everything closes in two seconds, the process exits in two seconds without waiting for the timer.

Budget the time: preStop sleep + drain delay + longest normal request + job finish + cleanup < your hard deadline < `terminationGracePeriodSeconds`. If one request type can take a minute, either raise the grace period or make that work resumable.

### Keep-alive connections

HTTP/1.1 keeps a TCP connection open after a response, so the next request skips the handshake. Load balancers and proxies hold such connections open for a long time. This interacts badly with shutdown:

- Since Node 19, `server.close()` closes connections that are idle *at the moment you call it*. Fastify's default `forceCloseConnections: "idle"` does the same.
- A connection that was busy at that moment finishes its response and then becomes idle, **and stays open**: until the client closes it or `keepAliveTimeout` passes. Fastify's default `keepAliveTimeout` is 72 seconds, so `app.close()` can hang for over a minute.

The fix is to tell clients to close those connections: while shutting down, add `Connection: close` to every response. Node then ends the socket right after the response is sent.

```js
app.addHook("onSend", async (request, reply) => {
  if (shuttingDown) reply.header("connection", "close");
});
```

Don't reach for `forceCloseConnections: true` to solve this: it destroys every connection at close time, including ones with a request still in progress.

### Jobs that can't finish

Some work outlives any grace period: a 10-minute export, a slow external call. Graceful shutdown doesn't promise everything finishes; it promises nothing is left broken. So:

- Give jobs timeouts shorter than your shutdown budget (lesson 13).
- Make jobs **idempotent** (lesson 11), so a job that was killed and retried does no harm.
- Let the queue recover abandoned jobs. If a BullMQ worker dies holding a job, its lock expires and the job is marked stalled and retried by another worker.
- Break long work into resumable steps that record progress.

### PID 1 in containers

Inside a container, your main process runs as PID 1, which is special:

- **Signals go to PID 1 only.** If PID 1 is a shell or `npm`, your Node process may never see `SIGTERM`. The Dockerfile *shell form* `CMD node server.js` runs `/bin/sh -c "node server.js"`, so the shell is PID 1. `npm start` adds another process in between, and the Docker Node.js best-practices guide warns that npm can swallow signals.
- **PID 1 has no default signal actions.** The kernel won't apply the default "terminate" to PID 1 for a signal it hasn't registered a handler for, so a Node app without a `SIGTERM` handler ignores `docker stop` until the `SIGKILL`. The Docker Node.js best-practices guide says plainly that Node "was not designed to run as PID 1".
- **PID 1 must reap zombies.** Child processes that exit stay as zombies until their parent collects them. If your app spawns processes, something must do that.

The fixes:

```dockerfile
# exec form: node is started directly, no shell in between
CMD ["node", "src/server.js"]
```

and a tiny init process as PID 1 that forwards signals and reaps zombies: run with `docker run --init` (Docker injects tini), set `init: true` in Compose, or install tini in the image and use `ENTRYPOINT ["/sbin/tini", "--"]`. Kubernetes has no `--init` flag, so bake tini into the image if you need it.

## Try it

In a folder with `"type": "module"`, run `npm i fastify` and save `app.js`:

```js
import Fastify from "fastify";
import { setTimeout as sleep } from "node:timers/promises";

const app = Fastify({ logger: true });
let ready = true;
let shuttingDown = false;

app.get("/health/live", async () => ({ status: "ok" }));
app.get("/health/ready", async (request, reply) =>
  ready ? { status: "ok" } : reply.code(503).send({ status: "shutting down" }));
app.get("/slow", async () => { await sleep(5000); return { done: true }; });
app.addHook("onSend", async (request, reply) => {
  if (shuttingDown) reply.header("connection", "close");
});
app.addHook("onClose", async () => app.log.info("closing pools (pretend)"));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutdown started");
  setTimeout(() => { app.log.error("shutdown timed out"); process.exit(1); }, 10_000).unref();

  ready = false;
  await sleep(2000);       // let load balancers notice
  try {
    await app.close();     // 503 for new requests, wait for in-flight, run onClose hooks
    app.log.info("shutdown complete");
  } catch (err) {
    app.log.error({ err }, "shutdown failed");
    process.exitCode = 1;
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: 3000 });
```

Run `node app.js` and note the `pid` field in its log lines (pino adds it to every line). In a second terminal:

```bash
curl -s localhost:3000/slow & sleep 1        # start a 5-second request
kill -TERM <pid>                             # ask the server to stop
curl -i localhost:3000/health/ready          # 503 while draining
curl -i localhost:3000/health/live           # 200: still alive
sleep 2; curl -i localhost:3000/health/live  # 503 or refused: app.close() has begun
wait                                         # the slow request still completes with {"done":true}
```

The server log shows the order: shutdown started, the slow request completed, onClose ran, shutdown complete. Run `echo $?` in the server's terminal: 0.

Now break it on purpose:

1. Replace `/slow`'s 5 seconds with 20 and repeat. The hard deadline fires at 10 seconds; what exit code do you get, and what happened to the request?
2. Delete the `onSend` hook. Make one request on a connection that stays open, then send `SIGTERM` while it runs:
   `node --input-type=module -e 'console.log(await (await fetch("http://localhost:3000/slow")).json()); setInterval(() => {}, 1e6)'`.
   The response arrives, but the server doesn't exit until the 10-second timeout, because the client's keep-alive socket is still open.
3. Send `kill -9 <pid>` during `/slow`. No log line, no cleanup, curl gets an empty reply. This is what every shutdown looks like without a handler and a deadline.
4. If you have Docker: put the app in an image with `CMD npm start` and time `docker stop`. Switch to `CMD ["node", "app.js"]` and time it again.

## Common mistakes

- **No signal handler at all.** The process dies mid-request on every deploy, and users see a burst of 502s each time you ship.
- **Calling `process.exit()` right in the handler.** That is just a faster crash. Drain first, exit after.
- **Closing the database pool before the HTTP server drains.** In-flight requests then fail on their last query. Close in reverse order: listener, workers, then Redis and the pool.
- **No hard deadline.** One hung request or keep-alive socket holds shutdown until `SIGKILL`, with no log line saying why. Add an `unref`'d timer that exits with code 1.
- **Shell-form `CMD` or `npm start` as PID 1.** `SIGTERM` never reaches Node, every stop takes the full timeout and ends in `SIGKILL`. Use exec form, and `--init` or tini.
- **Grace period shorter than the work.** A 30-second default grace with 60-second requests guarantees killed requests. Measure your slowest normal request and size the timeouts around it.

## Build: Linkbox, step 16

Linkbox now has an HTTP server, a Postgres pool, Redis and a BullMQ worker. Make it stop cleanly.

1. Split health into `GET /health/live` (always 200 while the process runs, no dependency calls) and `GET /health/ready` (503 when shutting down; optionally a `SELECT 1` with a short timeout).
2. Register `onClose` hooks that `quit()` the Redis clients and `end()` the Postgres pool. Make sure `app.close()` runs them after in-flight requests finish.
3. Write `src/shutdown.js` with one idempotent `shutdown(signal)`: mark not ready, wait `SHUTDOWN_DRAIN_MS`, set `Connection: close` on responses, `await app.close()`, `await worker.close()` (in the worker process), then exit. Wire it to `SIGTERM` and `SIGINT`.
4. Add a hard deadline (`SHUTDOWN_TIMEOUT_MS`, via the config module from lesson 14) that logs and exits with code 1.
5. Log each step with timings: signal received, drain started, HTTP closed, worker closed, pools closed, exit.
6. In the Dockerfile (or a note for lesson 26), use exec-form `CMD ["node", "src/server.js"]` and run the container with `--init`.

**Done when** sending `SIGTERM` while a slow request and an enrichment job are running lets both finish, `/health/ready` returns 503 during the drain, the process exits with code 0 inside your deadline, and Postgres shows no aborted connections from Linkbox.

## Check yourself

<details markdown="1">
<summary>Why can graceful shutdown run on <code>SIGTERM</code> but not on <code>SIGKILL</code>?</summary>

`SIGTERM` can be caught, so your handler runs. `SIGKILL` cannot be caught, blocked or ignored: the kernel ends the process immediately and no code runs. Platforms send `SIGTERM` first and `SIGKILL` only after a grace period.
</details>

<details markdown="1">
<summary>A pod gets <code>SIGTERM</code> and closes its listener at once. Why might clients still see connection errors?</summary>

Removing the pod from Service endpoints happens in parallel with sending `SIGTERM`, and takes a moment to reach every proxy. Requests routed to the pod in that window hit a closed port. Keep serving for a few seconds (preStop sleep or a delay in the handler) before closing.
</details>

<details markdown="1">
<summary>In what order should Linkbox release its resources, and why?</summary>

Stop accepting requests and let in-flight ones finish, stop the worker and let active jobs finish, then close Redis and the Postgres pool. The requests and jobs still need the database, so the pool goes last, the reverse of startup.
</details>

<details markdown="1">
<summary>Why does <code>app.close()</code> sometimes take over a minute even though every request has finished?</summary>

A keep-alive connection that was busy when close started stays open after its response, until the client closes it or `keepAliveTimeout` (72 s in Fastify) passes. Sending `Connection: close` on responses during shutdown makes Node end those sockets.
</details>

<details markdown="1">
<summary>What does <code>.unref()</code> do on the hard-deadline timer?</summary>

It stops the timer from keeping the event loop alive. If shutdown finishes early the process exits right away; the timer only matters if something else is still holding the process open.
</details>

<details markdown="1">
<summary>Your container takes exactly 10 seconds to stop and exits with 137. What's the likely cause?</summary>

`SIGTERM` never reached Node, so Docker waited its 10-second default and sent `SIGKILL` (128 + 9 = 137). Usually PID 1 is a shell (shell-form `CMD`) or `npm`. Use exec-form `CMD ["node", ...]` and `--init`.
</details>

## Go deeper

- [Kubernetes: Termination of Pods](https://kubernetes.io/docs/concepts/workloads/pods/pod-termination/): the exact order of preStop, `SIGTERM`, endpoint removal and `SIGKILL`.
- [Node.js: Signal events](https://nodejs.org/api/process.html#signal-events): which signals Node can listen for, the default handlers, and Windows caveats.
- [Fastify: Server options](https://fastify.dev/docs/latest/Reference/Server/): `return503OnClosing`, `forceCloseConnections`, `keepAliveTimeout` and what `close()` does step by step.
- [Docker Node.js best practices](https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md): PID 1, `--init` and why to run `node` instead of `npm start`.
- [signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html): the Linux manual page with every signal, its number and default action.
- [tini](https://github.com/krallin/tini): the tiny init process behind `docker run --init`, and why containers need one.
