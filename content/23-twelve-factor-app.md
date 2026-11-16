---
title: The twelve-factor app
part: Engineering practice
summary: Twelve rules, written at Heroku in 2011, for apps that a platform can build, configure, run, scale and replace without help.
---

Your code does not run on your laptop. It runs on a platform: a container scheduler, a PaaS, a VM with systemd. The platform builds it, hands it configuration, starts copies of it, kills them and starts new ones. The twelve-factor app is the contract between your code and that platform. Most of what modern hosting expects from you (environment variables, logs on stdout, `SIGTERM`, stateless processes) comes from this one short document.

## The first principle

Picture two apps that do the same job. The first was deployed by hand to one server in 2019. Its database password sits in `config/production.js`. It writes logs to `/var/log/app.log` and keeps uploaded files in `./uploads`. Someone once edited a file on the server to fix a bug and never committed it. It only starts if ImageMagick happens to be installed. Nobody dares restart it.

The second app runs the same code on a laptop, in CI, in staging and in production, and the only thing that differs is a handful of environment variables. You can kill any copy of it at any moment and lose nothing. You can run one copy or fifty.

The first app did not start out broken. It **eroded**: each small shortcut tied it a little more to one machine, one person and one moment. Heroku saw this across a very large number of apps. In 2011 Adam Wiggins, one of Heroku's co-founders, wrote down the patterns that kept apps healthy and called them *The Twelve-Factor App*. The introduction names the enemy directly: the goal is to avoid "the cost of software erosion".

Every factor answers one question: what does a platform need to know, and what must it be able to do, to run your app without asking you? The answer is a narrow interface. The app declares its dependencies, reads config from its environment, binds a port, writes logs to a stream, and stops when told. The platform does everything else.

> Twelve-factor is not about Heroku. Kubernetes, Fly.io, Render, Cloud Run, ECS and a plain systemd unit all assume the same contract. Learn the contract once and every platform looks familiar.

## Core ideas

### Where it came from, and who owns it now

The document came out of Heroku in 2011, in the Ruby on Rails era. Its vocabulary shows that: *dynos*, *buildpacks*, the `Procfile`. The ideas aged better than the vocabulary. Containers, which arrived two years later with Docker, made most of the factors easier to follow, because an image already is an isolated build with declared dependencies.

On 12 November 2024 Heroku open-sourced the manifesto. It now lives at [github.com/twelve-factor/twelve-factor](https://github.com/twelve-factor/twelve-factor) under open governance, with maintainers from several companies. The announcement says the core ideas still hold but "many of the details have started to show their age". A community revision lives in the repository's `next` branch and is meant to replace the text at 12factor.net. Its first round, from November 2024 to March 2025, recast the factors as numbered principles, each with examples and guidance, and kept the ideas themselves. No factor has changed since then, and as of November 2026 the website still shows the 2011 wording. So this lesson teaches the original twelve as written and flags where practice has moved.

Heroku has changed as well. In February 2026 it moved to what it calls a sustaining engineering model: the platform stays supported and secure, but gets no new features. The manifesto no longer depends on the company that wrote it.

### I. Codebase: one codebase, many deploys

One app lives in one repository, tracked in version control. That one codebase is deployed many times: your laptop, CI, staging, production. Each deploy may run a different commit, but they all come from the same history.

What it prevents: the "production copy" that drifted from the repository, and two apps that secretly share code by copy and paste. If two apps need the same code, extract it into a library and declare it as a dependency.

A monorepo does not break this rule as long as each app inside it is built and deployed on its own. The rule is about one *app* having one source of truth, not about counting repositories.

### II. Dependencies: declare them, isolate them

An app never relies on something that happens to be installed on the machine. Every dependency is declared, and the build installs exactly that.

In Node that means `package.json` plus a committed `package-lock.json`, installed with `npm ci` (which fails if the two disagree, and never rewrites the lock file). Declare the Node version too, with `"engines"` and the base image you build on. System tools count: if your thumbnailer shells out to `convert`, ImageMagick is a dependency and belongs in the Dockerfile, not in a wiki page that says "install this first".

What it prevents: "works on my machine", and builds that change because a transitive package published a new version overnight.

### III. Config: in the environment, never in the code

**Config** is everything that changes between deploys: database URLs, credentials for other services, the public hostname, feature switches per environment. It is *not* your route table or your validation rules; those are the same everywhere and belong in code.

The manifesto gives a litmus test: *could you make the codebase open source right now, without compromising any credentials?* If the answer is no, config is leaking into code.

The recommended home is environment variables, because every language and every platform supports them, and they are hard to commit by accident. It also warns against grouping config into named "environments" (`config.staging.js`, `config.production.js`): every new deploy needs a new group, and the groups multiply. Each variable should stand on its own. You built exactly this in lesson 14: one config module that reads `process.env`, validates it at startup and fails fast.

**The debate: environment variables for secrets.** Diogo Mónica, then at Docker, argued in 2017 that env vars are a poor place for secrets. They are inherited by every child process you spawn. Crash reporters and debug pages often dump the whole environment. `docker inspect` shows them. On Linux, `/proc/<pid>/environ` exposes them to anything that can read that file. None of these is a break-in, but each is a quiet leak.

Common answers, from simplest to strongest:

| Approach | How it works | Trade-off |
|---|---|---|
| Env var | `DATABASE_URL=...` | Simple, universal, leaks as above |
| Secret file | Platform mounts `/run/secrets/db_url`; app reads it at boot (`DATABASE_URL_FILE=/run/secrets/db_url`) | Not inherited by children; still readable by the process user |
| Secret manager | App fetches from Vault, AWS Secrets Manager, GCP Secret Manager at boot | Rotation and audit logs; one more service to depend on |
| Workload identity | The platform gives the process a short-lived identity token; no long-lived secret exists at all | Best, where the cloud supports it (lesson 26) |

The principle survives in every row: config is outside the code and supplied by the environment. Only the delivery channel changes. Supporting a `*_FILE` variant costs a few lines in your config module:

```js
import { readFileSync } from "node:fs";

// Read NAME, or the contents of the file named by NAME_FILE.
export function secret(name) {
  const file = process.env[`${name}_FILE`];
  if (file) return readFileSync(file, "utf8").trim();
  return process.env[name];
}
```

### IV. Backing services: attached resources

Postgres, Redis, the S3 bucket, the SMTP relay, a third-party payments API: each is a **backing service**, a resource the app reaches over the network. The app treats them all the same way: a URL and credentials in config. It makes no distinction between a Postgres you run and one a cloud provider runs.

What it prevents: code that assumes the database is on `localhost`. The test is whether you could swap your local Postgres for a managed one, or fail over to a replica, by changing one variable and restarting. No code change, no redeploy of a different build.

### V. Build, release, run

Getting code into production is three separate stages:

```
 codebase ──build──▶ build artefact ──+ config──▶ release v42 ──run──▶ processes
 (a commit)          (image, bundle)              (immutable, has an id)
```

- **Build** turns a commit into an artefact: install dependencies, compile, produce a container image (lesson 26).
- **Release** combines that artefact with one deploy's config. A release is immutable and has an id (`v42`, a timestamp, an image digest plus config version).
- **Run** starts processes from a release.

What it prevents: editing code on a running server (it cannot flow back into a build), and builds that happen at start-up time (slow, and they can fail at 3 a.m. when a registry is down). It also makes rollback trivial: a rollback is "run release v41 again", not "rebuild the old commit and hope".

### VI. Processes: stateless and share-nothing

The app runs as one or more processes that keep nothing they need between requests. Memory and local disk are scratch space for the length of one request or one job. Anything that must survive goes to a backing service: sessions to Redis or Postgres (lesson 05), files to object storage (lesson 20), caches to Redis (lesson 10).

Why: the platform will move, restart and multiply your processes without warning. A deploy replaces every one of them. If a user's cart lived in one process's memory, it vanishes on the next deploy, and the second process behind the load balancer never saw it at all.

**Sticky sessions** (the load balancer pins each user to one process) are the usual workaround, and the manifesto rejects them outright: they "are a violation of twelve-factor and should never be used or relied upon". Stickiness hides state instead of removing it. When the pinned process dies, the user's state dies with it, and load can no longer spread evenly.

**The WebSocket exception.** A WebSocket or SSE stream (lesson 21) is a long-lived connection, and a connection physically lives in one process. That is not a violation, as long as the connection is the *only* thing pinned. The rules that keep it twelve-factor:

- Nothing you can't rebuild lives only on the connection. Subscriptions, unread counts and messages live in Redis or Postgres.
- Messages reach the right process through a backing service (Redis pub/sub), not by assuming the sender and the socket share a process.
- When the process dies, the client reconnects, possibly to a different process, and resumes (SSE has `Last-Event-ID` for exactly this).

One real case needs stickiness anyway: Socket.IO's HTTP long-polling fallback sends each poll as a separate request, and they must all reach the process that holds that session. The fix is to turn off long-polling or accept stickiness for that one route, knowing what it costs.

### VII. Port binding

The app is self-contained and exports its service by **binding a port** itself. It does not get injected into an external web server the way PHP apps run inside Apache. The platform says which port (`PORT=8080`), the app listens on it, and a router or load balancer in front sends traffic there.

In Node this comes for free: Fastify, or `node:http`, is the web server. Two details trip people up in containers: read the port from config, and listen on `0.0.0.0`, not `127.0.0.1`, or nothing outside the container can reach you.

```js
await app.listen({ port: config.port, host: "0.0.0.0" });
```

Port binding also means one app can be a backing service for another: it's just a URL.

### VIII. Concurrency: scale out with processes

You scale by running more processes, not by making one process bigger. Different kinds of work get different **process types**: `web` handles HTTP, `worker` handles queue jobs, `clock` (if you need one) enqueues scheduled work. The set of process types and how many of each you run is the **process formation**:

```
web     ×3   ← scale for request load
worker  ×2   ← scale for queue depth
```

This fits Node well. One Node process runs your JavaScript on one thread, so a 4-core machine runs about four web processes, or you run one process per container and let the platform add containers.

The manifesto adds that apps should never daemonize or write PID files. Run in the foreground and let the process manager (systemd, Kubernetes, Heroku) restart crashes, capture output and handle the count.

### IX. Disposability: fast start, graceful stop

Processes can be started or stopped at a moment's notice. That needs three things:

1. **Fast startup.** Seconds, not minutes, so scaling up and replacing crashed processes is cheap. Don't run migrations or warm huge caches in the boot path.
2. **Graceful shutdown on `SIGTERM`.** The platform sends `SIGTERM`, waits a grace period (30 seconds on Heroku and in Kubernetes by default), then sends `SIGKILL`. A web process stops accepting connections, finishes in-flight requests and exits. A worker stops taking new jobs and either finishes or returns the current one to the queue (lesson 16).
3. **Safe against sudden death.** `SIGKILL`, an out-of-memory kill or a power cut gives no warning. Jobs must be safe to run twice (lesson 11), and nothing important may live only in memory.

The third point is the deeper one. Design as if every process could vanish mid-sentence, and graceful shutdown becomes an optimisation, not a requirement for correctness. This idea is sometimes called *crash-only software*.

### X. Dev/prod parity

Keep development, staging and production as alike as possible. The manifesto names three gaps:

| Gap | Traditional | Twelve-factor |
|---|---|---|
| Time | Weeks between writing code and deploying it | Hours or minutes |
| Personnel | Developers write, ops deploy | The people who write it deploy and watch it |
| Tools | SQLite and a dev server locally, Postgres and nginx in prod | The same backing services, same versions, everywhere |

The tools gap is the one that bites. A query that works on SQLite and fails on Postgres, or a Redis command that exists in your local 7.x but not your hosted 6.x, is a bug you meet only in production. Docker made parity cheap: `docker compose up` gives every developer the same Postgres major version as production, and Testcontainers does the same for tests (lesson 22).

### XI. Logs: a stream of events

An app does not route or store its own logs. It writes one event per line, unbuffered, to **stdout**, and stops caring. In development you watch the terminal. In production the platform captures the stream and ships it to wherever logs go: Loki, Elasticsearch, CloudWatch, Datadog.

What it prevents: log files filling a disk, logs lost when a container is replaced, and every app inventing its own rotation scheme. Lesson 15 already did this with pino: JSON lines to stdout, one per event, each with a request id. The same idea now covers metrics and traces: the app emits, the platform collects.

### XII. Admin processes: one-off tasks in the same environment

Database migrations, a data backfill, a REPL to inspect production: these are **one-off admin processes**. Run them against the *same release*, with the *same config* and the same dependency isolation as the long-running processes. On Heroku that is `heroku run node scripts/migrate.js`; in Kubernetes it is a `Job` using the same image; with Docker it is `docker run --rm <same image> node scripts/migrate.js`.

What it prevents: SSHing into a server and running a hand-edited SQL file, or running a migration from your laptop with your laptop's version of the code. Admin code ships in the repository, next to the app code it changes.

### The real formation: web, worker, one-off migration

Put it together for a Node service with a queue. A `Procfile` is the simplest way to write a formation down, and most platforms read it or have an equivalent:

```
web:     node src/server.js
worker:  node src/worker.js
release: node scripts/migrate.js
```

`release` is Heroku's name for a one-off command that runs once per release, before new processes start. The life of a deploy:

```
1. build      image linkbox@sha256:ab12...      (from one commit)
2. release    image + config → v42
3. one-off    node scripts/migrate.js            runs once; deploy stops if it fails
4. run        web ×3 and worker ×2 start from v42
              each boots fast, connects to Postgres/Redis, binds a port or opens the queue
5. old ones   receive SIGTERM → stop accepting → drain → close pools → exit 0
```

Two details make this safe:

- **Migrations run once, not in every web process.** Three web processes that each run migrations on boot race each other. Run them as one step, and take a Postgres advisory lock inside the script as a second guard.
- **Old and new code overlap.** During a rolling deploy, v41 processes still serve traffic after v42's migration has run. So migrations must be backwards-compatible: add a nullable column now, start writing it in this release, make it `NOT NULL` in a later one. This pattern is called *expand and contract*.

## Try it

**1. See how far an environment variable travels.** Every child process inherits it:

```bash
SECRET=hunter2 node --input-type=module -e '
  import { execSync } from "node:child_process";
  execSync("env | grep SECRET", { stdio: "inherit" });'
```

On Linux, also run `SECRET=hunter2 sleep 60 &` and then `cat /proc/$!/environ | tr '\0' '\n' | grep SECRET`. Any process running as your user can read that.

**2. Watch a graceful shutdown.** Save as `shutdown.mjs`:

```js
import http from "node:http";

const server = http.createServer((req, res) => {
  // Every request takes 3 seconds, like a slow query.
  setTimeout(() => res.end(`done by pid ${process.pid}\n`), 3000);
});
server.listen(process.env.PORT ?? 3000, () =>
  console.log(`pid ${process.pid} listening on ${server.address().port}`));

process.on("SIGTERM", () => {
  console.log("SIGTERM: no new connections, finishing in-flight requests");
  server.close(() => { console.log("all requests done, exiting"); process.exit(0); });
  // If something hangs, give up before the platform's SIGKILL does.
  setTimeout(() => { console.log("forced exit"); process.exit(1); }, 10_000).unref();
});
```

```bash
node shutdown.mjs &
curl -s localhost:3000 &          # in flight for 3 seconds
sleep 1; kill -TERM %1            # the platform says "stop"
curl -s localhost:3000            # refused: no new connections
wait                              # the first curl still gets its answer
```

(On Windows, run this in WSL or a container; Windows has no real `SIGTERM`.)

**3. Feel why state can't live in memory.** Write a server that counts requests in a variable, start it twice on ports 3001 and 3002, and hit both alternately with curl, as a load balancer would. Each process has its own count. Now imagine the count is a login session.

Break it on purpose:

1. In `shutdown.mjs`, remove the `SIGTERM` handler and repeat. What happens to the in-flight request?
2. Repeat with a client that keeps its connection open: replace the first `curl` with `node -e "fetch('http://localhost:3000').then(r => r.text()).then(console.log); setTimeout(() => {}, 15000)" &`. The answer still arrives after 3 seconds. How much later does `all requests done` print, and what was the server waiting for? (`close()` drops connections that are idle when you call it. This one was busy. Lesson 16 has the fix.)
3. Run `NODE_ENV=production` and grep your project for every place that branches on it. Each branch is a difference between dev and prod that no test on your laptop covers.

## Common mistakes

- **Migrations in the web process's boot path.** Three replicas race to migrate, and a slow migration makes every new process fail its health check. Run migrations as a one-off step before the new processes start.
- **Uploads written to local disk.** They disappear on the next deploy and are invisible to the other replicas. Put files in object storage (lesson 20).
- **Branching on `NODE_ENV` all over the code.** `if (env === "staging")` turns config into code. Make each behaviour its own variable (`EMAIL_ENABLED=false`) and set it per deploy.
- **Logging to a file inside the container.** The file grows until the disk fills or the container is replaced and the logs are gone. Write to stdout and let the platform ship it.
- **A process manager inside the container.** Running `pm2` or a shell script that restarts Node inside a container hides crashes from the platform. One process per container; let the platform restart it.
- **Dumping `process.env` in error reports.** Crash reporters and debug endpoints that send the environment leak every secret at once. Scrub them, or move secrets to files.

## Build: Linkbox, step 23

Audit Linkbox against all twelve factors, then reshape it into a real process formation.

1. Write `docs/twelve-factor.md` with one line per factor: how Linkbox meets it today, or what you must change. Be honest; "partly" is a useful answer.
2. Split the entry points. `src/server.js` starts Fastify only. `src/worker.js` starts the BullMQ workers and the scheduled session-cleanup job only. Both import the same config, `pg` pool and Redis client modules.
3. Move migrations out of server start-up into `scripts/migrate.js`. Inside it, wrap the run in `SELECT pg_advisory_lock(<constant>)` and `pg_advisory_unlock(...)` so two runs can never overlap.
4. Add a `Procfile` with `web`, `worker` and `release` lines, and matching `npm` scripts (`start`, `start:worker`, `migrate`).
5. Add `*_FILE` support to your config module for `DATABASE_URL` and `SESSION_SECRET`.
6. Run the formation locally: `npm run migrate` once, then two web processes on different ports and one worker. Create a bookmark through one web process, read it through the other, and watch the worker enrich it.
7. Send `SIGTERM` to the worker while it processes a job. Confirm the job either finishes or is picked up again after restart.

**Done when** you can kill any Linkbox process at any moment, start it again, and lose nothing, and the codebase contains no value that differs between your laptop and production.

## Check yourself

<details markdown="1">
<summary>What is the "open source litmus test" for config?</summary>

Ask whether you could publish the codebase right now without leaking any credentials. If you couldn't, config (passwords, keys, hostnames per deploy) is living in code and should move to the environment.
</details>

<details markdown="1">
<summary>Why does twelve-factor reject sticky sessions, and why is a WebSocket connection not the same thing?</summary>

Sticky sessions hide state in one process's memory; when that process dies or is replaced, the state is lost, and load can't spread evenly. A WebSocket pins only the connection itself. If everything durable lives in a backing service and messages are routed through one (Redis pub/sub), the client can reconnect to any process and carry on.
</details>

<details markdown="1">
<summary>What is the difference between a build and a release?</summary>

A build is the artefact made from one commit (an image). A release is that build combined with one deploy's config, given an id and never changed. Rolling back means running an older release, not rebuilding old code.
</details>

<details markdown="1">
<summary>Why should migrations not run inside each web process at start-up?</summary>

Several replicas start at once and race to migrate. Slow migrations also delay start-up and can fail health checks. Running them once as a one-off admin process, from the same release and config, avoids both.
</details>

<details markdown="1">
<summary>Name three ways environment variables can leak secrets.</summary>

They're inherited by every child process, crash reporters and debug pages often dump them, and they're visible through `docker inspect` and `/proc/<pid>/environ` on Linux.
</details>

## Go deeper

- [The Twelve-Factor App](https://12factor.net): the original text. Each factor is one short page; read all twelve in one sitting.
- [Twelve-Factor is now open source](https://12factor.net/blog/open-source-announcement): the November 2024 announcement and what the community revision set out to do.
- [twelve-factor/twelve-factor on GitHub](https://github.com/twelve-factor/twelve-factor): the revised text so far (the `content` folder on the `next` branch), its vision document and open discussions.
- [Why you shouldn't use ENV variables for secret data](https://blog.diogomonica.com/2017/03/27/why-you-shouldnt-use-env-variables-for-secret-data/): Diogo Mónica's case against env vars for secrets, and the alternatives.
- [Candea and Fox: Crash-Only Software (2003)](https://www.usenix.org/legacy/events/hotos03/tech/full_papers/candea/candea.pdf): the short paper behind the deeper point of factor IX, that stopping a process by killing it should always be safe.
- [Heroku: The Procfile](https://devcenter.heroku.com/articles/procfile): process types, the `release` phase and how a formation is declared.
