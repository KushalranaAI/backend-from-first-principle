---
title: Task queues and background jobs
part: Data
summary: Move slow and unreliable work out of the request, and make it survive crashes, retries and duplicates.
---

Some work doesn't belong inside an HTTP request: sending an email, resizing an image, calling a slow third-party API, building a report. A task queue lets the request record "this needs doing" and return at once, while separate worker processes do the work. Every non-trivial backend has one, and most of the hard bugs in them come from three facts: jobs fail, jobs run twice, and jobs pile up.

## The first principle

When a user saves a bookmark, Linkbox wants to fetch the page and store its title and description. Do that inside the request and look at what happens:

- **The user waits.** The page might take 3 seconds to load. The request takes 3 seconds plus your own work.
- **Their request fails for someone else's reason.** The site is down or slow, so *saving a bookmark* fails, though the save itself was fine.
- **No second chance.** If the fetch fails, nothing retries it. The work is lost when the request ends.
- **Spikes hurt everyone.** A user imports 5,000 bookmarks. 5,000 outbound fetches run inside web requests and tie up the servers that answer everyone else.

The fix is to split "accept the work" from "do the work":

1. The request handler writes a small message, a **job**, describing what to do (`enrich bookmark 7`), puts it somewhere durable and returns `201` right away.
2. A separate process, a **worker**, takes jobs one at a time, does the work, and records the result.

The place in between holds jobs until a worker is free, in order, and survives restarts. That is a **queue**, and the system that runs it is a **message broker** or **task queue**. Now the request is fast, a failed job can be retried later, spikes wait in the queue instead of crashing the web tier, and you scale workers separately from web servers.

> Rule of thumb: if the work is slow, can fail for outside reasons, or the user doesn't need its result to get their response, it goes on a queue.

Typical background work: transactional email, push notifications, image and video processing, webhooks (lesson 25), imports and exports, search indexing (lesson 12), cleanup jobs, and anything scheduled.

## Core ideas

### Producers, brokers and workers

```
 web server ──add job──>  broker (queue)  ──deliver──>  worker ──> does the work
 (producer)               durable storage   <──ack────   (consumer)   writes results to Postgres
```

- **Producer**: the code that creates jobs. Usually the API, sometimes a scheduler or another worker.
- **Broker**: stores jobs and hands them out. Redis (with BullMQ), RabbitMQ, Amazon SQS, Kafka, or a Postgres table.
- **Worker** (consumer): a long-running process that pulls jobs, runs a handler and reports success or failure. Run it as its own process (`node worker.js`), not inside the web server, so each can scale and restart on its own (lesson 23).

A job is data, not code: a type and a small JSON payload. Put ids in it, not whole objects (`{ bookmarkId: 7 }`, not the bookmark). The worker loads fresh data when it runs, which may be minutes later.

### The job lifecycle

```
            add                fetch              success
 (new) ──> waiting ──────────> active ──────────> completed
  │ delay      ^                 │ error
  └──> delayed ┘<── backoff ─────┤ attempts left
                                 └──> failed (no attempts left: dead letter)
```

A job waits, a worker claims it and it becomes active, then it completes or fails. A failed job with attempts left goes back to *delayed* until its backoff expires. A job out of attempts lands in a failed set for a human to look at.

Two things make this reliable. The broker doesn't delete a job when it hands it out, only when the worker **acknowledges** it as done. And if the worker dies mid-job and never acknowledges, the broker eventually gives the job to someone else.

### Delivery guarantees: at-least-once

There are three possible promises:

| Guarantee | What it means | Cost |
|---|---|---|
| At-most-once | Delete the job on delivery. A crash loses it | Lost work |
| At-least-once | Delete only after the ack. A crash before the ack means redelivery | Duplicates |
| Exactly-once | Each job has its effect once | Not possible across a network in general |

Almost every task queue gives you **at-least-once**. The worker can finish the work and crash before the ack, or the ack can be lost on the network. The broker can't tell that apart from "never did it", so it delivers again. Some brokers advertise exactly-once *delivery* within a window (SQS FIFO deduplicates for five minutes), but your handler's *effects* (an email, a charge, an API call) can still happen twice. You get exactly-once *effects* by combining at-least-once delivery with idempotent handlers.

### Idempotency

A handler is **idempotent** if running it twice has the same effect as running it once. This is the most important property of a background job. Ways to get it:

- **Check before acting.** "If `enriched_at` is already set, return." Cheap and often enough.
- **Make the write itself idempotent.** `update bookmarks set description = $2 where id = $1` can run any number of times. `insert ... on conflict do nothing` with a unique key turns a duplicate into a no-op (lesson 09).
- **Deduplicate by job id.** Give the job a deterministic id such as `enrich-7`; most brokers ignore a second job with the same id while the first one exists.
- **Record what you did.** For side effects outside your database (sending an email, charging a card), store a key in a table with a unique constraint before acting, and pass an idempotency key to the provider if it supports one (Stripe does, lesson 08).

Write every handler assuming it will run twice, at the same time, on two machines.

### Retries, backoff and jitter

Most failures are temporary: a timeout, a 503, a dropped connection. Retrying fixes them, but retrying *immediately* hammers a service that is already struggling. Use **exponential backoff**: wait longer after each failure.

```
attempt 1 fails → wait  2 s
attempt 2 fails → wait  4 s
attempt 3 fails → wait  8 s
attempt 4 fails → wait 16 s      delay = base × 2^(attempt - 1), with a maximum
```

Add **jitter**, a random part of the delay. Without it, a thousand jobs that failed at the same moment all retry at the same moment, and fail together again. With jitter they spread out. BullMQ's `jitter: 0.5` picks each delay at random between half and all of the exponential value.

Not every error deserves a retry. A 404 or a validation error will fail the same way every time. Classify:

| Error | Retry? |
|---|---|
| Timeout, connection reset, 429, 5xx | Yes, with backoff (respect `Retry-After` on 429/503) |
| 400, 401, 403, 404, 410, bad payload | No. Fail the job at once |
| Bug in your code | Retries won't help; they show up as the same error every attempt |

Always cap the attempts. Unlimited retries turn one bad job into permanent load.

### Dead-letter queues

A job that fails all its attempts must not vanish and must not retry forever. It goes to a **dead-letter queue** (DLQ): a holding area for failed jobs with their error and stack trace. A person or a tool inspects them, fixes the cause (a bug, a bad record, an expired API key) and replays them.

In SQS and RabbitMQ the DLQ is a separate queue you configure. In BullMQ it is the queue's **failed** set: jobs stay there until removed, and you can retry them with `job.retry()`. Either way, alert on it: a growing dead-letter count means something is broken right now.

### Visibility timeouts and stalled jobs

How does the broker know a worker died? It gives each claimed job a deadline:

- **SQS** hides a received message for the **visibility timeout** (30 seconds by default, up to 12 hours). If the worker doesn't delete it in time, it becomes visible again and another worker gets it. After `maxReceiveCount` receives, the redrive policy moves it to the DLQ.
- **BullMQ** gives the worker a lock on the job (`lockDuration`, 30 seconds by default) that the worker renews while it runs. If the lock expires, the stalled-job check moves the job back to waiting, or to failed after `maxStalledCount` stalls (default 1).
- **RabbitMQ** redelivers unacknowledged messages when the consumer's connection or channel closes.

The timeout must be longer than the slowest normal run, or a healthy but slow job is handed to a second worker while the first is still working, and runs twice. A long-running worker that blocks Node's event loop (heavy CPU work) can't renew its lock in time and causes exactly this.

### Concurrency, priorities and rate limits

- **Concurrency** is how many jobs one worker runs at once. For I/O-bound jobs (HTTP calls, database writes) in Node, 5 to 50 per process is normal because the work is mostly waiting. For CPU-bound jobs, use one per core, or worker threads (lesson 19). Total concurrency is processes × concurrency; make sure the database pool and the services you call can take it.
- **Priorities** let urgent jobs skip ahead: a password-reset email before a weekly digest. Often simpler: separate queues (`email-urgent`, `email-bulk`) with their own workers, so a flood of bulk jobs can't starve the urgent ones.
- **Rate limits** cap jobs per second against a third-party API that has its own limits.
- **Ordering**: most queues don't promise strict order once there are retries and several workers. If order matters (events for one account), use a FIFO queue grouped by key, or design handlers that tolerate any order.

### Scheduled and delayed jobs

Some work runs on a clock, not because of a request: deleting expired sessions every hour, sending a daily digest, retrying stuck payments. Two forms:

- **Delayed job**: run once, later (`delay: 60_000`: "remind in a minute").
- **Recurring job**: run on a **cron** pattern. `0 * * * *` means minute 0 of every hour. The five fields are minute, hour, day of month, month, day of week.

Don't use plain `setInterval` or the OS cron on each server: with three instances, the job runs three times. Let the queue own the schedule so exactly one job is created per tick, and any worker can run it. BullMQ calls these **job schedulers** (`upsertJobScheduler`). They replaced the older "repeatable jobs" (`repeat` option), which BullMQ 6 removed in July 2026.

### Choosing a broker

| | BullMQ (Redis) | RabbitMQ | Amazon SQS | Postgres table (`SKIP LOCKED`) |
|---|---|---|---|---|
| What it is | Node library on Redis | Dedicated message broker (AMQP) | Managed queue service | Jobs in your own database |
| Extra infrastructure | Redis | A RabbitMQ cluster | None to run; AWS only | None |
| Retries and backoff | Built in | Via redelivery, delivery limits, DLX | Visibility timeout + redrive to DLQ | You write them |
| Delays, cron, priorities | Built in | Plugins and patterns | Delay up to 15 min; no cron | You write them |
| Enqueue in the same transaction as your data | No | No | No | Yes |
| Good fit | Node apps that already run Redis | Many services and languages, complex routing | AWS apps, very high scale, no ops | Small to medium volume, simplicity, transactional jobs |

Notes on each:

- **BullMQ** keeps jobs in Redis data structures and uses Lua scripts so state changes are atomic. Redis must use `maxmemory-policy noeviction`, or jobs can be evicted under memory pressure (lesson 10). Since version 6 (July 2026) the same API can also run on PostgreSQL 13 or newer through an optional backend (`createPostgresBackend`). Redis is still the default and the faster of the two, and it is what this course uses.
- **RabbitMQ** routes messages through exchanges into queues, with acks and a prefetch limit per consumer. Use quorum queues for durability; since RabbitMQ 4.0 they have a default delivery limit of 20, after which a message is dropped or dead-lettered to a dead-letter exchange.
- **SQS** keeps messages for 4 days by default (up to 14) and allows messages up to 1 MiB. Standard queues are at-least-once and roughly ordered; FIFO queues keep order per message group.
- **Postgres** can be a queue with `for update skip locked`: each worker locks one ready row and skips rows other workers have locked, so they never block each other or take the same job.

```sql
update jobs
set status = 'running', locked_at = now(), attempts = attempts + 1
where id = (
  select id from jobs
  where status = 'queued' and run_at <= now()
  order by run_at
  limit 1
  for update skip locked
)
returning id, kind, payload, attempts;
```

The big advantage: the job is inserted in the same transaction as the bookmark, so you can never commit a bookmark without its job, or enqueue a job for a bookmark that was rolled back. With Redis or SQS that gap exists; the **outbox pattern** (lesson 25) closes it. Libraries such as pg-boss (Node), Graphile Worker (Node), River (Go) and Solid Queue (Rails) are built on this idea, and so is BullMQ's PostgreSQL backend. Postgres queues handle thousands of jobs per second, but very high volumes add write and vacuum load to your main database.

### Monitoring

A queue hides problems: the API looks healthy while work silently piles up. Watch:

- **Queue depth** (waiting jobs) and **age of the oldest job**. Rising depth means workers can't keep up.
- **Throughput and duration**: jobs completed per minute and how long each takes.
- **Failure rate and dead-letter count**, with alerts.
- **Stalled jobs**, which usually mean blocked event loops or a timeout set too short.

Log the job id and attempt number on every line a handler writes (lesson 15). Tools like Bull Board or Taskforce.sh show BullMQ queues in a dashboard.

## Try it

Start Redis and set up a scratch project. Install `ioredis` next to `bullmq`: since BullMQ 6 it is an optional peer dependency and no longer comes along on its own.

```bash
docker run --name redis -p 6379:6379 -d redis:8
mkdir queue-lab && cd queue-lab && npm init -y && npm install bullmq ioredis
```

Save as `producer.mjs`:

```js
import { Queue } from "bullmq";

const queue = new Queue("lab", { connection: { host: "localhost", port: 6379 } });
for (let i = 1; i <= 5; i++) {
  await queue.add("work", { n: i }, {
    jobId: `work-${i}`,
    attempts: 4,
    backoff: { type: "exponential", delay: 1000, jitter: 0.5 },
  });
}
console.log("waiting:", await queue.getWaitingCount());
await queue.close();
```

Save as `worker.mjs`:

```js
import { Worker } from "bullmq";

const worker = new Worker("lab", async (job) => {
  console.log(`job ${job.id} attempt ${job.attemptsMade + 1}`);
  await new Promise((r) => setTimeout(r, 500));
  if (job.data.n === 3 && Math.random() < 0.7) throw new Error("flaky upstream");
  return { doubled: job.data.n * 2 };
}, { connection: { host: "localhost", port: 6379 }, concurrency: 2 });

worker.on("completed", (job, result) => console.log(`done ${job.id}`, result));
worker.on("failed", (job, err) => console.log(`failed ${job.id}: ${err.message}`));
```

Run `node producer.mjs`, then `node worker.mjs`. Watch two jobs run at a time and job 3 retry with growing gaps.

Break it on purpose:

1. Run `node producer.mjs` twice before starting the worker. How many jobs run? Which option made the second run a no-op?
2. Start two workers in two terminals and add 20 jobs (raise the loop limit and change the ids). Does any job run on both?
3. Make job 3 always throw. Where does it end up after 4 attempts? Find it with `redis-cli KEYS 'bull:lab:*'` and `ZRANGE bull:lab:failed 0 -1`.
4. Make the handler block the event loop for 70 seconds with a busy `while` loop. What happens to the job's lock, and how many times does it run?

## Common mistakes

- **Handlers that aren't idempotent.** A redelivered job sends the email twice or double-counts a total. Check state first, use unique constraints, and use deterministic job ids.
- **Putting whole objects in the payload.** The data is stale by the time the job runs, and large payloads bloat the broker. Store ids and load fresh data in the worker.
- **Retrying everything forever.** A 404 retried 100 times is wasted work, and unlimited retries keep a broken job alive. Cap attempts, use backoff with jitter, and fail permanent errors at once (BullMQ's `UnrecoverableError`).
- **Enqueuing before the transaction commits.** The worker runs, can't find the bookmark (still uncommitted or rolled back) and fails. Enqueue after commit, or use a Postgres queue or an outbox in the same transaction.
- **No monitoring of the failed set.** Jobs fail quietly for weeks. Alert on dead-letter count and on the age of the oldest waiting job.
- **Running cron in every web instance.** Three servers send three digests. Let the queue own schedules.

## Build: Linkbox, step 11

Enrich new bookmarks in the background and clean up expired sessions on a schedule.

1. Add `migrations/002_bookmark_enrichment.sql`:

   ```sql
   alter table bookmarks add column description text not null default '';
   alter table bookmarks add column enriched_at timestamptz;
   ```

2. Create `queues.js` exporting `enrichQueue` and `maintenanceQueue` (BullMQ `Queue`s) and the Redis connection settings from `REDIS_URL`. Run this Redis with `noeviction`, or use a second instance separate from the cache.
3. In the create-bookmark service, after the transaction commits, enqueue:

   ```js
   await enrichQueue.add("enrich", { bookmarkId: bookmark.id }, {
     jobId: `enrich-${bookmark.id}`,          // a second add for the same bookmark is ignored
     attempts: 5,
     backoff: { type: "exponential", delay: 2000, jitter: 0.5 },
     removeOnComplete: 1000,
     removeOnFail: 5000,
   });
   ```

4. Write `worker.js` as a separate process with a `Worker` for `enrich` (concurrency 5). The handler loads the bookmark, returns early if it is gone or `enriched_at` is set, fetches the URL with `AbortSignal.timeout(10_000)`, reads the `<title>` and `<meta name="description">`, and saves them with `update ... set description = $2, enriched_at = now() where id = $1 and enriched_at is null`. Keep the user's title unless it is empty. Lesson 17 adds SSRF protection to this fetch.
5. Throw `UnrecoverableError` (from `bullmq`) for 404 and 410 responses so they fail at once; throw a normal `Error` for timeouts and 5xx so they retry. Delete the bookmark's cache key after the update (lesson 10).
6. Add a job scheduler in the worker process, and a handler that deletes expired sessions:

   ```js
   await maintenanceQueue.upsertJobScheduler("purge-sessions",
     { pattern: "0 * * * *" }, { name: "purge-sessions" });
   // handler: await pool.query("delete from sessions where expires_at < now()");
   ```

7. Log every failed job with its id, attempt number and error.

**Done when** `POST /api/v1/bookmarks` returns in a few milliseconds, the bookmark gets a description a moment later, a URL that returns 503 is retried with growing delays, a 404 URL fails once without retrying, running the same job twice changes nothing, and expired sessions disappear on the hour.

## Check yourself

<details markdown="1">
<summary>Why can a job run twice even when nothing is "wrong"?</summary>

Queues deliver at least once. If a worker finishes the work but crashes, or its ack is lost, or its lock or visibility timeout expires while it is still running, the broker can't tell that apart from a job that never ran, so it delivers it again.
</details>

<details markdown="1">
<summary>What problem does jitter solve that exponential backoff alone does not?</summary>

Synchronized retries. Jobs that failed together would retry together at 2 s, 4 s, 8 s and keep hitting the service in bursts. Random jitter spreads the retries out over time.
</details>

<details markdown="1">
<summary>Which errors should not be retried, and why?</summary>

Permanent ones: 400, 401, 403, 404, 410, invalid payloads. The same input will fail the same way every time, so retries only add load and delay the move to the dead-letter queue. Retry timeouts, connection errors, 429 and 5xx.
</details>

<details markdown="1">
<summary>What does <code>for update skip locked</code> do in a Postgres job queue?</summary>

Each worker locks the row it selects, and skips rows already locked by other workers instead of waiting for them. Many workers can claim jobs at once without blocking each other or taking the same job.
</details>

<details markdown="1">
<summary>What is the one thing a Postgres-based queue can do that a Redis or SQS queue cannot?</summary>

Enqueue the job in the same transaction as the data it refers to. Either both commit or neither does, so you never get a bookmark without its job or a job for a bookmark that was rolled back.
</details>

<details markdown="1">
<summary>A job's lock is 30 seconds and the handler sometimes takes 45. What happens?</summary>

If the worker can't renew its lock (for example because it blocks the event loop), the job is considered stalled and handed to another worker while the first is still working, so it runs twice. Keep the event loop free so renewal works, raise the lock duration, or split the work into smaller jobs, and make the handler idempotent either way.
</details>

## Go deeper

- [BullMQ documentation](https://docs.bullmq.io/): queues, workers, retries, job schedulers, stalled jobs and flows, from the library's authors.
- [BullMQ: Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs): how attempts work, the built-in fixed and exponential backoff strategies with jitter, and custom strategies.
- [AWS: Exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/): a simulation showing why jitter cuts retry load, with the "full jitter" formula.
- [Amazon SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html): how in-flight messages, redelivery and timeouts work in a managed queue.
- [Implementing Stripe-like idempotency keys in Postgres](https://brandur.org/idempotency-keys): how to make side effects safe to retry, step by step.
- [pg-boss](https://github.com/timgit/pg-boss): a Node job queue on Postgres with `SKIP LOCKED`; read its README to see what a database-backed queue gives you.
