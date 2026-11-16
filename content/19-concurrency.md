---
title: Concurrency and parallelism
part: Scale
summary: How one server handles thousands of requests at once, what really happens at an await, and how to keep shared data correct.
---

A backend spends most of its life waiting: for the database, for Redis, for another API, for the disk. Concurrency is how it does useful work while it waits, so one process can serve thousands of users instead of one at a time. It is also where the strangest bugs live, because two things happening "at once" can step on the same data. This lesson explains the models runtimes use (threads, event loops, goroutines), what `async`/`await` does under the hood, and how to keep shared state correct in Node and in the database.

## The first principle

Look at what a typical request does with its time:

```
GET /api/v1/bookmarks/42           total 25 ms
  parse request, check session      0.2 ms   CPU
  SELECT ... FROM bookmarks          9 ms    waiting on Postgres
  GET tag counts from Redis          1 ms    waiting on Redis
  build JSON, write response         0.3 ms   CPU
  (network back to client)          14 ms    waiting
```

The CPU works for about half a millisecond. The rest is waiting. If the server handled one request at a time, the CPU would be idle about 98% of the time and you could serve roughly 40 requests a second. That is the **cost of not using concurrency**: wasted hardware and a queue of users.

The fix is to start the next request while the first one waits. Then a single CPU can keep dozens or thousands of requests "in progress" at once, switching to whichever one has something to do. That is **concurrency**: structuring a program so many tasks can make progress over the same period of time.

Doing this is easy when tasks are independent. It is hard when they share something: a counter, a cache, a database row. Then the order in which their steps interleave changes the result. So concurrency comes with a second job: making sure the result is correct whatever the interleaving.

## Core ideas

### IO-bound and CPU-bound work

The first question about any piece of work is: what is it waiting for?

| | IO-bound | CPU-bound |
|---|---|---|
| Spends its time | Waiting for network, disk, database | Computing |
| Examples | Queries, HTTP calls, reading files, Redis | Password hashing, image resizing, parsing big documents, compression |
| What helps | Concurrency: do something else while waiting | Parallelism: more cores working at once |
| Faster CPU helps? | Barely | Yes |

Most API endpoints are IO-bound. Background jobs are often a mix: fetch a page (IO), then parse it (CPU). The right tool depends on which kind you have, so measure (lesson 18) before choosing.

### Concurrency versus parallelism

The two words are often used as synonyms. They are not.

- **Concurrency** is about *structure*: many tasks are in progress at the same time, and their steps interleave. One core can do this by switching between them.
- **Parallelism** is about *execution*: several things literally run at the same instant, on different cores.

```
Concurrency, one core:     A A ░ B B ░ A ░ C C ░ B ░ A        (░ = switch)
Parallelism, two cores:    core 1: A A A A A A
                           core 2: B B B B B B
```

Rob Pike's summary: concurrency is *dealing with* lots of things at once, parallelism is *doing* lots of things at once. A Node server handling 5,000 open requests on one thread is highly concurrent and not parallel. Concurrency fixes IO-bound waiting. Only parallelism makes CPU-bound work finish faster, and you can have either without the other.

### Picture a server under load

Three requests arrive almost together. Each needs 1 ms of CPU, then a 10 ms query, then 1 ms of CPU.

```
Sequential (one at a time):
  req1 ▓░░░░░░░░░░▓
  req2              ▓░░░░░░░░░░▓
  req3                          ▓░░░░░░░░░░▓          done at 36 ms

Concurrent (switch while waiting):
  req1 ▓░░░░░░░░░░▓
  req2  ▓░░░░░░░░░░▓
  req3   ▓░░░░░░░░░░▓                                 done at 14 ms
       ▓ = CPU   ░ = waiting on the database
```

Same CPU, same database, same work. Concurrency just stops the CPU from sitting idle during the waits. The question for every runtime is *how* it switches: who keeps track of each request's place, and what that costs.

### The threading model

The classic answer: give each request its own **operating system thread**. The thread runs the handler top to bottom with ordinary blocking calls (`result = db.query(...)`). When it blocks on IO, the OS kernel parks it and runs another thread. Apache's worker model, traditional Java servlets, Ruby's Puma and Python's Gunicorn with threads work this way.

It is easy to write, because each request reads like a straight line. The kernel does the switching and keeps each thread's place on its own **stack**. Threads also give you parallelism for free: the OS spreads them across cores. Python and Ruby are the exception. Their standard interpreters hold a global lock, so only one thread runs interpreter code at a time, and threads help with waiting but not with computing. Python 3.14 officially supports an optional free-threaded build without that lock.

### What threads cost: memory and context switches

Threads are not free, and the costs grow with the number of concurrent requests:

- **Memory.** Each thread has its own stack. Linux reserves 8 MB of virtual address space per thread by default (much less is actually touched); the JVM defaults to 1 MB per thread on 64-bit Linux. Ten thousand threads means gigabytes reserved, plus kernel bookkeeping for each.
- **Context switches.** Switching threads means entering the kernel, saving one thread's registers, choosing the next and restoring its state. That direct cost is on the order of microseconds. The indirect cost is larger: the new thread's data is not in the CPU caches, so it runs slowly for a while. With thousands of threads, a lot of CPU goes to switching instead of working.
- **Creation.** Starting a thread takes a system call and memory, so servers keep a **thread pool** of fixed size. When all pool threads are blocked on slow queries, new requests wait, even if the CPU is idle.
- **Shared memory.** All threads in a process share the heap, so any shared object can be changed by two threads at the same instant. That is the root of race conditions (below).

In the late 1990s this was named the **C10k problem**: how do you handle ten thousand concurrent connections on one machine, when ten thousand threads is too many? The answer the industry found was to stop dedicating a thread to each connection.

### The event loop model

Operating systems can tell you which of many sockets are ready: `epoll` on Linux, `kqueue` on macOS and BSD, IOCP on Windows. An **event loop** uses that. One thread starts IO operations without waiting, asks the OS "which of these are ready?", and runs the callback for each one that is. No thread is ever parked on a single socket, so one thread can juggle tens of thousands of connections with very little memory per connection. nginx, Redis and Node.js all work this way.

Node's event loop is provided by **libuv**. Each turn of the loop goes through phases:

```
   ┌─▶ timers            setTimeout / setInterval callbacks that are due
   │   pending callbacks some deferred system callbacks (e.g. TCP errors)
   │   idle, prepare     internal
   │   poll              wait for IO; run IO callbacks (sockets, files done)
   │   check             setImmediate callbacks
   └── close callbacks   'close' events, e.g. socket.on('close')
```

Two queues sit outside the phases and are drained after every single callback: the `process.nextTick` queue and then the **microtask** queue, where promise reactions (`.then`, the continuation after `await`) run.

Not all IO can be done this way. File system calls, `dns.lookup()` (used by default for hostnames), and some CPU-heavy built-ins (`crypto.pbkdf2`, `crypto.scrypt`, async `zlib`) run on libuv's **thread pool**: 4 threads by default, configurable with the `UV_THREADPOOL_SIZE` environment variable up to 1,024. Network sockets do not use it. So Node is "single-threaded" only for your JavaScript.

The model has one hard rule: **don't block the loop**. There is one thread running JavaScript. While it runs a callback, nothing else happens: no other request is parsed, no timer fires, no response is sent. A 200 ms synchronous loop adds 200 ms to *every* request in flight. Common ways to block it:

- CPU-heavy code: hashing with `*Sync` functions, resizing images, big loops.
- `JSON.parse` or `JSON.stringify` of multi-megabyte payloads.
- Synchronous APIs: `fs.readFileSync`, `crypto.scryptSync` in a request handler.
- A regular expression with catastrophic backtracking on user input (ReDoS).

You can measure it. `perf_hooks.monitorEventLoopDelay()` records how late the loop runs its timers; a healthy server sees a few milliseconds, a blocked one hundreds.

### async/await

Callbacks were Node's first interface to the loop, and they nest badly. **Promises** made a pending result into a value: an object that will later be fulfilled with a value or rejected with an error, to which you attach reactions. **`async`/`await`** lets you write promise code as if it were blocking:

```js
async function getBookmark(id) {
  const b = await repo.find(id);     // pause here; the thread goes off to do other work
  const tags = await repo.tags(id);  // resume when find() settles, then pause again
  return { ...b, tags };
}
```

`await` does not block the thread. It suspends *this function*, returns control to the event loop, and resumes the function later, when the promise settles, as a microtask. Between those two moments, other requests run. Three practical consequences:

- An `async` function always returns a promise, and its code before the first `await` runs synchronously.
- Two `await`s in a row run one after the other. If the calls are independent, start both and await together: `const [b, tags] = await Promise.all([repo.find(id), repo.tags(id)])`.
- `await` makes code look sequential, but **every `await` is a point where other code can run and change shared state**. Remember this for the race conditions section.

### How async/await works under the hood: state machines

How can a function stop halfway and continue later, with its local variables intact, on a thread that has been busy with other things in between? A normal function call can't: its locals live on the stack, and the stack is reused as soon as it returns.

The answer is to turn the function into an object that remembers where it was: a **state machine**. Each `await` becomes a state boundary; local variables move from the stack into the object; "resume" means calling a `step` function that jumps to the saved state. This is roughly what compilers do: C# and Rust compile async functions into state machines, and tools like TypeScript and Babel did the same for JavaScript when targeting older engines. V8 implements `async` functions natively with the same idea (a suspendable function whose frame is saved on the heap). Written by hand, `getBookmark` becomes:

```js
function getBookmark(id) {
  let state = 0, b, tags;                 // locals now survive between steps
  return new Promise((resolve, reject) => {
    function step(value) {
      try {
        switch (state) {
          case 0: state = 1; return repo.find(id).then(step, reject);             // first await
          case 1: b = value; state = 2; return repo.tags(id).then(step, reject);  // second await
          case 2: tags = value; return resolve({ ...b, tags });                   // return
        }
      } catch (err) { reject(err); }
    }
    step();
  });
}
```

(A real compiler also routes rejections back into the function so `try`/`catch` around an `await` works; this sketch just rejects.) Notice what is not there: no thread, no stack held while waiting. A suspended request costs a small heap object, which is why an event-loop server can hold tens of thousands of them.

### Virtual threads and goroutines

The event loop is cheap but makes you write `async` everywhere, and a mistake (a blocking call) stalls everything. Threads are easy to write but expensive. Some runtimes give you both: code that looks blocking, running on threads that are cheap.

The trick is **M:N scheduling**: the language runtime runs M lightweight threads on N operating system threads (N is usually the number of cores). When a lightweight thread does blocking IO, the *runtime*, not the kernel, parks it, registers the socket with epoll/kqueue, and runs another lightweight thread on the same OS thread. When the IO is ready, it is put back in the run queue. It is an event loop hidden under an ordinary threading API.

- **Go goroutines.** `go handle(conn)` starts one. A goroutine starts with a stack of about 2 KB that grows and shrinks as needed, so a million of them fit in memory. Go's scheduler has three parts: G (goroutines), M (OS threads) and P (processors, `GOMAXPROCS` of them, defaulting to the number of CPUs or, since Go 1.25 on Linux, to the container's CPU limit if that is lower). Each P has a run queue, idle Ps steal work from busy ones, and long-running goroutines are preempted so one cannot hog a core. Go's standard HTTP server starts a goroutine per connection.
- **Java virtual threads** (final in JDK 21). `Thread.ofVirtual().start(task)` or `Executors.newVirtualThreadPerTaskExecutor()`. Blocking JDBC or HTTP calls unmount the virtual thread from its carrier OS thread. JDK 24 removed the main early limitation, where blocking inside a `synchronized` block pinned the carrier thread.

Unlike Node, these runtimes also give you **parallelism**: goroutines run on all cores at once. That is good for CPU-bound work, and it means shared memory really is touched by two cores at the same instant, so you need the synchronization tools below more often.

| Model | Examples | Write code as | Memory per task | Parallel by default | Main risk |
|---|---|---|---|---|---|
| OS thread per request | Classic Java, Puma | Blocking | ~1 MB stack | Yes | Memory, switching, pool exhaustion |
| Event loop | Node.js, nginx, Redis | Callbacks, async/await | Small heap object | No (one JS thread) | Blocking the loop |
| M:N lightweight threads | Go, Java 21+ virtual threads | Blocking | ~KBs, growable | Yes | Data races on shared memory |

### Race conditions and shared state

A **race condition** is a bug where the result depends on the timing of concurrent operations. The classic form is **check-then-act** or **read-modify-write**: read a value, decide or compute based on it, write it back. If another task changes the value between your read and your write, your write is based on stale data.

People assume Node is immune because JavaScript runs on one thread. It isn't. Each callback runs to completion without interruption, but an `async` function is a series of callbacks, and **every `await` is a gap where other requests run**:

```js
const balances = { alice: 100 };

async function withdraw(user, amount) {
  const balance = balances[user];         // 1. read
  await fraudCheck(user, amount);         // 2. other requests run here
  if (balance < amount) throw new Error("insufficient funds");
  balances[user] = balance - amount;      // 3. write, based on the read in step 1
}

await Promise.all([withdraw("alice", 80), withdraw("alice", 80)]);
// Both read 100, both pass the check, both write 20. Alice withdrew 160 from 100.
```

Run it: both calls succeed and the balance ends at 20. In a database-backed app the gap is a query instead of `fraudCheck`, and the shared state is a row, but the bug is the same. In multithreaded runtimes it is worse: even `count++` is three steps (load, add, store) and two cores can interleave them, losing updates without any `await` at all.

Races are hard to find because they depend on timing. The code passes every test run one request at a time, and fails once a week in production under load. The defense is to recognize the pattern (read, gap, write based on the read) and make that sequence **atomic**: no one else may act in between.

### Locks, mutexes and channels

Three families of tools make a sequence atomic.

**Mutexes (locks).** A mutex (mutual exclusion) lets only one task into a **critical section** at a time; others wait. In Go:

```go
var mu sync.Mutex
mu.Lock()
balance := balances[user]
if balance >= amount { balances[user] = balance - amount }
mu.Unlock()
```

For most of its life Node had no built-in mutex for async code. A promise chain makes one, because each caller waits for the previous one to finish:

```js
function createMutex() {
  let last = Promise.resolve();
  return (fn) => {
    const run = last.then(fn);
    last = run.catch(() => {});   // a failed task must not jam the queue
    return run;
  };
}

const lock = createMutex();
await Promise.allSettled([lock(() => withdraw("alice", 80)), lock(() => withdraw("alice", 80))]);
// First succeeds (balance 20), second throws "insufficient funds".
```

Node 24.5 added an experimental built-in for the same job, the Web Locks API that browsers have: `import { locks } from "node:worker_threads"`, then `await locks.request("balance:alice", () => withdraw("alice", 80))`. The lock is held until the callback's promise settles, and it also works across worker threads in the same process.

Locks have well-known failure modes: **deadlock** (A holds lock 1 and waits for lock 2, B holds 2 and waits for 1; fix by always taking locks in the same order), **contention** (one hot lock serializes everything), and forgetting to unlock on an error path (use `defer mu.Unlock()` in Go, `finally` elsewhere). An in-process lock also only protects one process: with three instances (lesson 18), it protects nothing. Shared state across instances needs the database.

**Atomic operations.** For a single number, the CPU can do read-modify-write as one indivisible instruction. Go has `sync/atomic`, Java `AtomicLong`, and JavaScript has `Atomics` for `SharedArrayBuffer` memory shared between worker threads. The database equivalent is a single `UPDATE ... SET n = n + 1` (below).

**Channels and message passing.** Instead of sharing memory and locking it, give each piece of state one owner and send it messages. Go's proverb: "Don't communicate by sharing memory; share memory by communicating."

```go
requests := make(chan Withdrawal)
go func() {                        // the only goroutine that touches balances
  for w := range requests {
    if balances[w.User] >= w.Amount { balances[w.User] -= w.Amount; w.Reply <- nil } else { w.Reply <- ErrInsufficient }
  }
}()
```

Node's worker threads and job queues (lesson 11) follow the same idea: workers exchange messages rather than share objects.

### Node: worker_threads for CPU-bound work

Since JavaScript runs on one thread, CPU-heavy work blocks every request. For that work, Node has `node:worker_threads`: real OS threads, each with its own V8 instance, heap and event loop. They share nothing by default and talk by messages, which are copied (structured clone) unless you transfer an `ArrayBuffer` or use a `SharedArrayBuffer`.

```js
// parse-worker.mjs: runs on its own thread
import { parentPort } from "node:worker_threads";
import { extractMetadata } from "./extract.mjs";   // CPU-heavy HTML parsing

parentPort.on("message", ({ id, html }) => {
  parentPort.postMessage({ id, result: extractMetadata(html) });
});
```

```js
// main thread: send work, get a promise back
import { Worker } from "node:worker_threads";

const worker = new Worker(new URL("./parse-worker.mjs", import.meta.url));
const pending = new Map();
let nextId = 0;
worker.on("message", ({ id, result }) => { pending.get(id)(result); pending.delete(id); });

export const parseInWorker = (html) =>
  new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); worker.postMessage({ id, html }); });
```

That is one worker. In practice, use a **pool** with one worker per spare core, a queue, error handling and restart on crash: the `piscina` package does all of that (`new Piscina({ filename })`, then `await pool.run(html)`). Some rules:

- Workers are for **CPU-bound** work only. For IO, the event loop is already the right tool; a worker would just add overhead.
- Starting a worker costs tens of milliseconds and some megabytes. Create a pool at startup, don't start a worker per request.
- Copying large messages costs time too. Send what the worker needs, not whole objects.
- Before reaching for workers, check whether the work is already off the loop. Async `crypto.scrypt` and the `argon2` package run on libuv's thread pool, so password hashing does not need a worker; it may need a bigger `UV_THREADPOOL_SIZE`.

### Node: limiting concurrency

The opposite mistake is too *much* concurrency. This looks efficient:

```js
// VULNERABLE to your own success: 10,000 URLs means 10,000 simultaneous fetches
await Promise.all(urls.map((u) => fetchPage(u)));
```

It opens thousands of sockets at once, exhausts file descriptors, overruns the database pool, gets you rate-limited or banned by the sites you fetch, and runs out of memory holding every response. Concurrency must be **bounded**: allow at most N operations in flight and queue the rest. A limiter is a few lines:

```js
export function limit(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

const run = limit(5);
const pages = await Promise.all(urls.map((u) => run(() => fetchPage(u)))); // at most 5 in flight
```

The `p-limit` package does the same. Pick N with Little's law (lesson 18) and the limits of whatever you call: the database pool size, a partner API's rate limit, politeness towards other people's servers. BullMQ workers take a `concurrency` option that bounds jobs per worker process in the same way.

### Races in the database

With several instances, Node's in-process tools cannot protect shared data. The data lives in Postgres, and so must the protection. Three tools, from simplest:

**1. One atomic statement.** Don't read a value into your app, change it and write it back. Let the database do read-modify-write in one statement, which it executes atomically:

```js
// RACE: two requests read 41, both write 42
const { rows: [t] } = await pool.query("SELECT use_count FROM tags WHERE id = $1", [id]);
await pool.query("UPDATE tags SET use_count = $2 WHERE id = $1", [id, t.use_count + 1]);

// FIXED: the row is locked for the duration of the UPDATE; increments queue up
await pool.query("UPDATE tags SET use_count = use_count + 1 WHERE id = $1", [id]);
```

Conditions can go in the same statement: `UPDATE accounts SET balance = balance - $2 WHERE id = $1 AND balance >= $2 RETURNING balance`. Zero rows updated means "insufficient funds", and two concurrent withdrawals cannot both pass.

**2. Unique constraints for "create if not exists".** Two requests save a bookmark with the new tag `go` at the same moment. Both `SELECT` it, both find nothing, both `INSERT`. Without a constraint you get duplicate tags; no amount of app code checking first can stop it. A `UNIQUE (user_id, name)` constraint makes the database the referee, and `ON CONFLICT` turns the loser's insert into a lookup:

```sql
INSERT INTO tags (user_id, name) VALUES ($1, $2)
ON CONFLICT (user_id, name) DO UPDATE SET name = EXCLUDED.name   -- no-op update so RETURNING works
RETURNING id;
```

(`DO NOTHING` returns no row when the tag already exists, so you would need a second `SELECT`.) The same pattern makes idempotency keys (lesson 08) safe under concurrency.

**3. Row locks with `SELECT ... FOR UPDATE`.** When the check and the write involve several statements or rows, lock the row that represents the decision inside a transaction. Free Linkbox users may keep 1,000 bookmarks:

```js
const client = await pool.connect();
try {
  await client.query("BEGIN");
  // Lock this user's row: a concurrent request for the same user waits here until we commit.
  await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const { rows: [{ n }] } = await client.query(
    "SELECT count(*)::int AS n FROM bookmarks WHERE user_id = $1", [userId]);
  if (n >= 1000) throw new QuotaExceededError();
  await client.query("INSERT INTO bookmarks (user_id, url, title) VALUES ($1, $2, $3)", [userId, url, title]);
  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}
```

Without `FOR UPDATE`, two requests at 999 bookmarks both count 999 and both insert. With it, the second waits for the first to commit, then counts 1,000. Keep such transactions short, never do network calls while holding the lock, and lock rows in a consistent order to avoid deadlocks (Postgres detects them and aborts one transaction with an error). Alternatives: the `SERIALIZABLE` isolation level, where Postgres aborts conflicting transactions with error `40001` and you retry; and **optimistic locking**, a `version` column checked in `UPDATE ... WHERE id = $1 AND version = $2`, retried when no row matches.

## Try it

See the event loop block. Save as `block.mjs`:

```js
import http from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
setInterval(() => {
  console.log(`loop delay p99 ${(delay.percentile(99) / 1e6).toFixed(0)} ms`);
  delay.reset();
}, 1000);

http.createServer((req, res) => {
  if (req.url === "/block") {                 // 500 ms of synchronous CPU
    const end = Date.now() + 500; while (Date.now() < end);
  }
  res.end("ok\n");
}).listen(3000);
```

```bash
node block.mjs
# terminal 2: fast requests are instant
time curl -s localhost:3000/
# terminal 3: start a blocking request, then immediately repeat terminal 2
curl -s localhost:3000/block & time curl -s localhost:3000/
```

The fast request now takes about 500 ms, though it does no work, and the logged loop delay jumps.

See the thread pool. Save as `pool.mjs` and run it twice:

```js
import { pbkdf2 } from "node:crypto";
const t0 = performance.now();
for (let i = 0; i < 8; i++) {
  pbkdf2("password", "salt", 600_000, 32, "sha256", () =>
    console.log(`hash ${i} done at ${Math.round(performance.now() - t0)} ms`));
}
```

```bash
node pool.mjs                       # finishes in two batches of 4
UV_THREADPOOL_SIZE=8 node pool.mjs  # one batch, if you have 8 or more cores
```

See a true parallel race. Save as `race.mjs`:

```js
import { Worker, isMainThread, workerData } from "node:worker_threads";

if (isMainThread) {
  const shared = new Int32Array(new SharedArrayBuffer(8));  // [plain, atomic]
  const run = () => new Promise((resolve) =>
    new Worker(new URL(import.meta.url), { workerData: shared }).on("exit", resolve));
  await Promise.all([run(), run(), run(), run()]);
  console.log({ plain: shared[0], atomic: shared[1], expected: 4_000_000 });
} else {
  for (let i = 0; i < 1_000_000; i++) {
    workerData[0]++;                 // load, add, store: threads overwrite each other
    Atomics.add(workerData, 1, 1);   // one indivisible operation
  }
}
```

The plain counter comes out well short of 4,000,000 (lost updates); the atomic one is exact.

Break it on purpose:

1. Put the `withdraw` example and the `createMutex` fix in a file and run both versions. Then move the `await fraudCheck()` to *before* the read. Does the race go away? Why?
2. In `block.mjs`, replace the busy loop with `crypto.scryptSync("pw", "salt", 64, { N: 2 ** 16, maxmem: 2 ** 27 })`, then with the async `crypto.scrypt`. Compare the loop delay.
3. In `psql`, open two sessions. In both run `BEGIN; SELECT * FROM users WHERE id = 1 FOR UPDATE;`. The second one hangs. `COMMIT` the first and watch the second continue.

## Common mistakes

- **Blocking the event loop.** `*Sync` calls, large `JSON.parse`, heavy loops or unsafe regexes in a request handler slow every request. Use async APIs, move CPU work to a worker pool, and alert on event loop delay.
- **Unbounded `Promise.all` over user-sized input.** It opens thousands of connections at once. Put a limiter (or a queue with fixed worker concurrency) on every fan-out.
- **"Node is single-threaded, so no races."** Every `await` is a gap. Read-check-write across an `await` is a race. Use atomic SQL, constraints or row locks.
- **Check-then-insert in application code.** `SELECT` then `INSERT` creates duplicates under load. Add a `UNIQUE` constraint and use `INSERT ... ON CONFLICT`.
- **In-process locks with multiple instances.** A mutex in one Node process does nothing for the other two. Put the coordination where the shared data is: the database (or Redis for non-durable locks).
- **Long transactions holding row locks.** An HTTP call inside a `FOR UPDATE` transaction makes everyone else wait for the network. Fetch first, then lock, write and commit quickly.

## Build: Linkbox, step 19

Make Linkbox's background work and its writes safe under real concurrency.

1. **Limit concurrent outbound fetches.** Set the enrichment worker's BullMQ `concurrency` to 10. Inside it, wrap `fetchPage` (lesson 17) in a per-host limiter: a `Map` from hostname to `limit(2)`, so 500 bookmarks from one site never open 500 connections to it. Log how many fetches are active as a gauge on `/metrics`.
2. **Move CPU-heavy work to `worker_threads`.** Measure first: add `monitorEventLoopDelay` to the worker process and run the enrichment job on large pages (try a long Wikipedia article). Move HTML parsing and text extraction (title, description, and the text that feeds full-text search, lesson 12) into a `piscina` pool sized to `os.availableParallelism() - 1`. Compare loop delay p99 before and after.
3. **Find and fix a race.** Write a test that fires 20 concurrent `POST /api/v1/bookmarks` requests, all with the new tag `"race"`, for one user. Count rows in `tags` with that name. If you get more than one (or 500 errors from unique violations), fix tag creation with the `UNIQUE (user_id, name)` constraint and `INSERT ... ON CONFLICT ... RETURNING id`.
4. **Fix check-then-act.** Add the 1,000-bookmark quota for free users with `SELECT ... FOR UPDATE` on the user row in the create transaction. Test it: seed a user with 999 bookmarks, send 5 concurrent creates, expect exactly one `201` and four `403`s (or `409`, as your API defines it).
5. **Make counters atomic.** Any count you keep (tag use counts, per-user bookmark counts) is updated with `SET n = n + 1` in SQL, never computed in JavaScript.

**Done when** the 20-request tag test always produces exactly one tag row, the quota test always admits exactly one request, and event loop delay in the worker stays low while it enriches large pages.

## Check yourself

<details markdown="1">
<summary>What is the difference between concurrency and parallelism? Give a system that has one but not the other.</summary>

Concurrency is many tasks in progress over the same period, interleaving; parallelism is several tasks executing at the same instant on different cores. A Node server is concurrent (thousands of requests in flight) but runs its JavaScript on one thread, so it is not parallel. A batch job that splits one matrix multiplication across 8 cores is parallel without being concurrent in the request-handling sense.
</details>

<details markdown="1">
<summary>Why can an event-loop server handle far more idle connections than a thread-per-request server on the same machine?</summary>

A thread per connection costs a stack (around 1 MB reserved, often more), kernel bookkeeping and context switches. On an event loop, a waiting connection is just a socket registered with epoll/kqueue plus a small heap object for the suspended request, and one thread services whichever sockets are ready.
</details>

<details markdown="1">
<summary>A handler does <code>const n = await countBookmarks(user); if (n &lt; 1000) await insertBookmark(...)</code>. Node is single-threaded. Can two requests both exceed the limit?</summary>

Yes. Each `await` lets other requests run. Both can count 999 before either inserts. Make the check and the insert atomic in the database: lock the user row with `SELECT ... FOR UPDATE` inside a transaction (or use a constraint or a conditional atomic statement).
</details>

<details markdown="1">
<summary>What does <code>await</code> do to the thread, and how does the function resume later with its local variables?</summary>

Nothing blocks the thread: `await` suspends the function and returns to the event loop. The function is effectively a state machine whose locals and current position are saved on the heap; when the awaited promise settles, a microtask calls back in and execution resumes from the saved state.
</details>

<details markdown="1">
<summary>When should you use <code>worker_threads</code> in Node, and when not?</summary>

For CPU-bound JavaScript that would block the event loop (parsing, image work, heavy computation), using a pool created at startup. Not for IO-bound work, which the event loop already handles efficiently, and not for operations that already run on libuv's thread pool, such as async `crypto.scrypt`.
</details>

<details markdown="1">
<summary>Why is <code>UPDATE tags SET use_count = use_count + 1</code> safe when "SELECT the count, add one in JavaScript, UPDATE it" is not?</summary>

The single statement reads and writes the row while holding its row lock, so concurrent increments queue behind each other and each sees the previous result. The two-step version lets two requests read the same old value and both write old + 1, losing an update.
</details>

## Go deeper

- [Node.js: The event loop, timers and process.nextTick()](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick): the phases of Node's event loop, with examples of what runs when.
- [Node.js: Don't block the event loop (or the worker pool)](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop): what blocks, ReDoS, JSON pitfalls and when to offload work.
- [libuv design overview](https://docs.libuv.org/en/v1.x/design.html): how the event loop, IO polling and the thread pool fit together under Node.
- [Concurrency is not parallelism](https://go.dev/blog/waza-talk): Rob Pike's talk on the distinction, with Go examples.
- [JEP 444: Virtual Threads](https://openjdk.org/jeps/444): why Java added M:N threads and how they mount and unmount on carrier threads.
- [PostgreSQL: Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html): row locks, `FOR UPDATE`, deadlocks and advisory locks.
