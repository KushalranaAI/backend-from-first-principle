---
title: Scaling and performance
part: Scale
summary: How to measure a slow backend, find the one bottleneck that matters, and grow from one server to many.
---

A backend that is fast for one user can fall over for a thousand. Performance is how quickly you answer one request; scaling is whether you keep answering quickly as load grows. Both start with the same discipline: measure, find the single bottleneck, fix the cheapest thing that moves it, and measure again. This lesson covers the numbers first, then the fixes inside one server, then what changes when you run many.

## The first principle

Every request waits in line somewhere. It waits for a CPU core, for a database connection, for a disk, for a lock, for the network. When a resource is idle, a request walks straight through. When it is busy, requests queue, and the queue is where latency comes from.

So a slow system is almost never "slow everywhere". One resource is saturated, and everything behind it waits. That resource is the **bottleneck**, and at any moment there is usually exactly one that matters. Make anything else faster and nothing changes for the user.

This gives you the whole method:

1. **Measure** what users experience: latency (as percentiles, not averages) and throughput.
2. **Find** the resource that is saturated, with data, not intuition.
3. **Fix** it, cheapest option first: a query, an index, a cache, a pool setting, a bigger machine, more machines.
4. **Repeat.** The bottleneck has moved. Go find it again.

Scaling out to many servers is one of those fixes, and an expensive one. It only helps if the bottleneck is the server, and only if the server holds no state that pins users to it.

## Core ideas: part 1, one server

### Latency

**Latency** is how long one request takes, from the client sending it to the client receiving the response. It is the sum of every stage: DNS, TCP and TLS handshakes, the trip across the network, time waiting in queues, the work itself (**service time**), and the trip back.

```
client ──network──▶ LB ──▶ app: wait for pool ─ query ─ serialize ──▶ network ──▶ client
         20 ms         1 ms        8 ms        12 ms      2 ms          20 ms
```

Two of those stages grow under load: waiting for something busy (the pool, a lock, CPU) and the service time of an overloaded database. The rest are roughly fixed. That is why a request that takes 40 ms at 10 req/s can take 2 s at 500 req/s with the same code.

### Why averages lie

Say 99 requests take 10 ms and one takes 5 s. The average is 59.9 ms. Nobody had a 60 ms request. 99 people had a fast one and one person waited five seconds. The average hides both facts: the typical experience and the bad one.

Latency distributions are not bell curves. They have a long tail to the right: garbage-collection pauses, cache misses, a lock held a bit long, a retransmitted packet. The average is pulled around by the tail and describes nobody.

### Percentiles: p50, p90, p99

A **percentile** says "this fraction of requests were at least this fast". Sort all request times; p50 is the one in the middle, p99 is the one 99% of the way up.

| Percentile | Meaning | Use it for |
|---|---|---|
| p50 (median) | Half of requests are faster | The typical experience |
| p90, p95 | 1 in 10, 1 in 20 is slower | Most dashboards and SLOs |
| p99, p99.9 | 1 in 100, 1 in 1,000 is slower | The tail: where users complain and timeouts fire |
| max | The single worst | Spotting pathologies; too noisy to alert on |

The tail matters more than it looks, for two reasons:

- **Users make many requests.** A page that triggers 20 API calls hits the p95 latency on most page loads (1 − 0.95²⁰ ≈ 64%).
- **Fan-out multiplies it.** If one request calls 100 backends in parallel and must wait for all of them, and each has a 1% chance of being slow, then 1 − 0.99¹⁰⁰ ≈ 63% of requests are slow. This is the point of Dean and Barroso's paper *The Tail at Scale*.

Two practical rules. You **cannot average percentiles**: the p99 of three servers is not the mean of their p99s. Record latencies in histograms (prom-client's `Histogram`, lesson 15) and compute percentiles from the merged buckets. And write targets as percentiles: "p99 under 300 ms at 500 req/s" is a target you can test; "fast" is not.

### Throughput

**Throughput** is how much work gets done per unit of time: requests per second, jobs per minute, rows per second. It is a different question from latency. A highway can move many cars an hour (throughput) while each car takes an hour to arrive (latency).

Throughput on its own is meaningless. Any server can accept 10,000 req/s if you don't mind each one taking 30 seconds. The useful number is **maximum throughput at an acceptable latency**: "800 req/s with p99 under 200 ms". Past that point, adding load adds waiting, not output.

### Utilization and the latency curve

**Utilization** is the fraction of time a resource is busy. A core at 70% utilization is idle 30% of the time. You might expect latency to stay flat until 100%. It doesn't.

Requests arrive in bursts, not evenly. When a burst lands on a busy resource, a queue forms. The busier the resource, the longer queues form and the slower they drain. Queueing theory gives the shape. For the simplest model (random arrivals, one server), average time in the system is:

```
response time = service time / (1 − utilization)
```

| Utilization | Response time vs. idle |
|---|---|
| 50% | 2× |
| 80% | 5× |
| 90% | 10× |
| 95% | 20× |
| 99% | 100× |

```
latency
  │                                   │
  │                                  ╱
  │                                ╱
  │                            _.-'      the "knee"
  │_______________________..--'
  └──────────────────────────────────── utilization
  0%                 70%     90%    100%
```

The curve is flat, then bends sharply. Real systems differ in detail but share the shape. This is why you run production with **headroom** (often 60 to 70% at peak), why "CPU is only at 85%" is not reassuring, and why a small traffic increase can turn a healthy service into a slow one overnight.

A companion law ties the three numbers together. **Little's law**: the average number of requests in the system equals arrival rate times time in the system.

```
L = λ × W
in-flight requests = throughput × latency
```

At 200 req/s and 50 ms per request, 200 × 0.05 = 10 requests are in flight at any moment. If each holds a database connection for its whole life, you need about 10 connections. If latency doubles to 100 ms, you need 20, or requests start queueing for the pool, which raises latency further. Little's law is how you size pools, worker counts and concurrency limits from measurements instead of guesses.

### Finding bottlenecks: measure, don't guess

Engineers are bad at guessing where time goes. The query you are sure is slow takes 2 ms; the JSON serialization nobody looked at takes 40. So you measure, top-down:

- **Per service, the RED metrics** (lesson 15): **R**ate, **E**rrors, **D**uration. They tell you *that* something is slow and since when.
- **Per resource, the USE method** (Brendan Gregg): for each CPU, memory, disk, network link, connection pool and lock, check **U**tilization, **S**aturation (is work queueing?) and **E**rrors. The saturated resource is your bottleneck.

Then reproduce it with a **load test**. A few rules make load tests honest:

- Use realistic data. A query over 50 rows says nothing about 5 million.
- Run the load generator on a different machine (or at least different cores) from the server.
- Warm up first, then measure for long enough to see GC pauses and cache expiry: minutes, not seconds.
- Increase load in steps and note where p99 bends. That is your capacity.
- Beware **coordinated omission**: a closed-loop tool that waits for each response before sending the next one quietly sends less when the server stalls, and under-reports the tail. Tools with a fixed arrival rate (k6's `constant-arrival-rate`, wrk2) avoid this.

### Profiling and distributed tracing

Metrics tell you *which* resource; profiles and traces tell you *which code*.

A **profiler** samples the stack many times a second and shows where CPU time goes. In Node:

```bash
node --cpu-prof server.js            # writes a .cpuprofile on exit; open it in Chrome DevTools
node --inspect server.js             # attach chrome://inspect and record a profile live
```

The usual view is a **flame graph**: each bar is a function, its width is the share of samples it was on the stack. Look for wide bars you did not expect: a regex, `JSON.stringify` of a huge object, a synchronous crypto call.

Profilers see only CPU work in one process. Most backend latency is *waiting*: on the database, on another service. **Distributed tracing** (OpenTelemetry, lesson 15) records a span for each step of one request across every service, with timings:

```
GET /api/v1/bookmarks                         ████████████████████████  182 ms
  pg: SELECT bookmarks ...                    ██                         9 ms
  pg: SELECT tags WHERE bookmark_id = 1         █                        4 ms
  pg: SELECT tags WHERE bookmark_id = 2          █                       4 ms
  ... 18 more ...
  redis: GET user:7                                                ▌     1 ms
```

A trace waterfall makes problems obvious that no metric shows: calls made one after another that could run in parallel, a staircase of identical queries, a slow downstream service.

### The N+1 query problem

That staircase has a name. You fetch a list (1 query), then for each of N items you fetch something related (N queries):

```js
// N+1: 1 query for 20 bookmarks, then 20 queries for their tags
const { rows: bookmarks } = await pool.query(
  "SELECT id, url, title FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [userId]);
for (const b of bookmarks) {
  const { rows } = await pool.query(
    "SELECT t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.bookmark_id = $1", [b.id]);
  b.tags = rows.map((r) => r.name);
}
```

Each query is fast. But every one pays a network round trip, a parse and a pool checkout, and they run in series. 21 queries at 1 ms each is 21 ms of pure overhead on a good day; under load, each checkout also waits for the pool. ORMs make this easy to write by accident: `bookmark.tags` looks like a property but is a query.

The fix is to fetch the related rows for all items at once:

```js
// Fixed: 2 queries, whatever the page size
const { rows: bookmarks } = await pool.query(
  "SELECT id, url, title FROM bookmarks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [userId]);
const { rows: tagRows } = await pool.query(
  `SELECT bt.bookmark_id, t.name FROM bookmark_tags bt JOIN tags t ON t.id = bt.tag_id
   WHERE bt.bookmark_id = ANY($1)`, [bookmarks.map((b) => b.id)]);

const byId = Map.groupBy(tagRows, (r) => r.bookmark_id);
for (const b of bookmarks) b.tags = (byId.get(b.id) ?? []).map((r) => r.name);
```

`ANY($1)` takes a JavaScript array as a Postgres array parameter. A single `JOIN` with `array_agg(t.name)` and `GROUP BY b.id` also works. The same pattern (collect the ids, load once) is what GraphQL's DataLoader does. To catch N+1 early, count queries per request in development, or look at `calls` in `pg_stat_statements`: a cheap query called 50 times more often than its endpoint is a sign.

### Indexes

Without an index, finding rows means reading the whole table (a **sequential scan**): fine at 1,000 rows, painful at 10 million. A **B-tree index** keeps the column's values sorted in a tree, so Postgres finds a row in a handful of page reads (O(log n)) and can read a range in order. Lesson 09 introduced them; for performance work, these are the rules that matter:

- **Index for your queries, not your columns.** Linkbox's list query filters by `user_id` and sorts by `created_at`. One composite index on `(user_id, created_at DESC)` answers both: Postgres jumps to the user's entries and reads them already sorted, stopping after `LIMIT`. Separate indexes on each column do far less.
- **Column order matters.** An index on `(user_id, created_at)` helps `WHERE user_id = $1` but not `WHERE created_at > $1` alone. Equality columns first, then range or sort columns.
- **Functions hide columns.** `WHERE lower(email) = $1` cannot use an index on `email`. Index the expression (`CREATE INDEX ON users (lower(email))`) or store it normalized.
- **`LIKE '%term%'` cannot use a B-tree.** Use full-text search (lesson 12) or a trigram GIN index.
- **Indexes cost writes.** Every insert and update maintains every index. Unused indexes are pure cost; `pg_stat_user_indexes.idx_scan` shows which ones never get used.
- **Low selectivity is ignored.** If a condition matches half the table, a sequential scan is cheaper, and the planner will choose it. A **partial index** (`WHERE deleted_at IS NULL`) can help when you always query a small subset.

Never guess whether an index is used. Ask:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, url, title FROM bookmarks WHERE user_id = 7 ORDER BY created_at DESC LIMIT 20;
-- Look for: "Index Scan using bookmarks_user_id_created_at_idx" vs "Seq Scan" + "Sort",
-- actual time, rows, and shared hit/read buffers.
```

### Connection pooling: internal and external

Opening a Postgres connection is expensive: a TCP handshake, often TLS, authentication, and on the server a new operating system **process** for that connection, with its own memory. That costs milliseconds, and Postgres allows only `max_connections` of them (default 100). So you don't open one per request. You keep a few open and lend them out: a **pool**.

An **internal pool** lives inside your app process. In Node that is `pg.Pool`:

```js
const pool = new pg.Pool({
  max: 10,                        // the default; tune it with measurements
  idleTimeoutMillis: 30_000,      // close connections idle this long
  connectionTimeoutMillis: 2_000, // fail fast instead of waiting forever (default 0 = forever)
});
```

How big? Smaller than you think. The database has a fixed number of cores and disks; past a point, more concurrent queries just make them fight over CPU, locks and cache. A widely quoted starting point from the HikariCP project is `connections ≈ (cores × 2) + effective disks` for the *database* server, then measure. Little's law tells you what the app needs: throughput × time each request holds a connection. If those two disagree, fix the queries, not the pool size.

Internal pools multiply. Twenty app instances with `max: 10` want 200 connections, and a database with `max_connections = 100` refuses half. Autoscaling and serverless make it worse. The answer is an **external pool**, a proxy like **PgBouncer** (or RDS Proxy on AWS) between all your apps and the database:

```
app ×20 (pool 10 each) ──▶ 200 client connections ──▶ PgBouncer ──▶ 20 server connections ──▶ Postgres
```

PgBouncer has three modes. **Session** mode gives a client a server connection until it disconnects: safe, but saves little. **Transaction** mode lends a server connection only for one transaction, then returns it, so thousands of mostly idle clients share a few dozen connections. That is the mode you use for scaling, and it has a cost: anything tied to a session breaks, because your next transaction may run on a different server connection. `SET` (use `SET LOCAL` inside a transaction), session-level advisory locks, `LISTEN`, SQL-level `PREPARE`, and temporary tables that outlive a transaction all stop working. Protocol-level prepared statements, the kind a driver sends, do work: PgBouncer tracks them as long as `max_prepared_statements` is not zero, and since version 1.24 it defaults to 200.

### Caching and invalidation

The fastest query is the one you don't run. A cache keeps a copy of an expensive result somewhere faster. Caches exist at every layer: the browser (`Cache-Control`, `ETag`), the CDN, your app's memory, Redis, and Postgres's own buffer cache. Lesson 10 built Linkbox's cache; the strategies to choose from are:

| Pattern | How it works | Good for |
|---|---|---|
| Cache-aside | App checks cache; on a miss reads the DB and fills the cache | The default. Simple, cache failure is not fatal |
| Read-through | The cache library loads from the DB on a miss | Same as cache-aside, logic in one place |
| Write-through | Every write goes to cache and DB together | Data read right after it is written |
| Write-behind | Write to cache; flush to DB later | Very high write rates that can tolerate loss |

The hard part is **invalidation**: making sure nobody reads a stale copy for longer than you can accept. The tools, from simplest:

- **TTL**: every entry expires after a fixed time. Simple, and it bounds staleness. Pick the TTL from how stale the data may be, not from how fast you want it.
- **Delete on write**: after a successful update, delete the key so the next read refills it. Delete rather than overwrite, and do it *after* the DB commit.
- **Versioned keys**: put a version in the key (`bookmarks:user:7:v42`) and bump the version on write. Old entries just stop being read.

Watch for the **cache stampede**: a hot key expires and a thousand requests miss at once, all hitting the database. Fixes are request coalescing (one request refills, the rest wait for it), a short lock around the refill, adding random jitter to TTLs so keys don't expire together, and serving stale data while one request refreshes in the background.

### Cache hit ratio

The **hit ratio** is hits ÷ (hits + misses). It decides whether a cache helps at all:

```
effective latency = hit ratio × cache latency + (1 − hit ratio) × source latency

hit ratio 90%:  0.90 × 1 ms + 0.10 × 50 ms = 5.9 ms   DB sees 10% of reads
hit ratio 99%:  0.99 × 1 ms + 0.01 × 50 ms = 1.5 ms   DB sees 1% of reads
```

Going from 90% to 99% cuts database reads by ten times. Going from 0% to 50% only halves them, and adds a network hop and an invalidation problem to every request. Measure hit ratio per cache (a counter for hits and one for misses) before and after deploying it. A low ratio means the data is too varied, the TTL too short, or the cache too small for the **working set** (the data actually being read).

### Vertical scaling: scaling up

The simplest fix for a saturated resource is a bigger one: more cores, more RAM, faster disks. No code changes, no new failure modes, and modern servers are huge (hundreds of cores, terabytes of RAM). For databases, scaling up is usually the right first move and stays right for a long time.

Its limits:

- **A ceiling.** The biggest machine is only so big, and the price per unit rises steeply near the top.
- **A single point of failure.** One machine, one outage.
- **Downtime to resize**, on many platforms.
- **Your runtime must use it.** One Node process runs your JavaScript on one thread. A 32-core machine needs many processes (the `cluster` module, PM2, or containers) to use its cores, which already means thinking like horizontal scaling.

### Horizontal scaling: scaling out

**Horizontal scaling** runs more copies of the service behind a load balancer. Capacity grows by adding machines, there is no single machine to lose, and you can scale up and down with traffic.

It only works if two things are true. The service must be **stateless**, so any copy can serve any request (part 2 starts there). And the bottleneck must actually be the service. Ten app servers in front of a saturated database make things worse: ten times the connections fighting over the same CPU. Horizontal scaling moves the bottleneck to whatever all the copies share, usually the database, which is why the rest of this lesson is about state.

## Core ideas: part 2, many servers

### Statelessness

A service is **stateless** when no request depends on something stored in that particular process's memory or disk. Any instance can handle any request, so instances can be added, removed or restarted freely.

Typical hidden state, and where it should live:

| In-process state | Problem with 3 instances | Move it to |
|---|---|---|
| Sessions in a `Map` | Log in on A, next request hits B: logged out | Postgres or Redis |
| Uploaded files on local disk | File exists on one instance only | Object storage (lesson 20) |
| In-memory cache | Three caches, three different stale answers | Redis, or accept it with short TTLs |
| Rate-limit counters | Each instance allows the full limit, so 3× the limit | Redis |
| WebSocket/SSE connections | Event raised on A, user connected to B | Pub/sub (lesson 21) |
| Cron jobs in the web process | Runs three times | A single scheduler or queue (lesson 11) |

**Sticky sessions** (the load balancer pins a user to one instance) hide the problem instead of fixing it: a deploy or crash logs everyone out, and load spreads unevenly. Keep the processes disposable (lesson 23).

### Load balancers

A **load balancer** is one address in front of many instances. It spreads requests, stops sending to unhealthy instances (by polling `/health/ready`, lesson 16) and lets you deploy one instance at a time.

They work at one of two layers:

| | Layer 4 (transport) | Layer 7 (application) |
|---|---|---|
| Sees | IPs, ports, TCP/UDP connections | Full HTTP: path, headers, cookies |
| Balances | Connections | Individual requests |
| Can do | Very fast forwarding, any protocol | TLS termination, routing by path or host, retries, header rewriting, rate limits |
| Examples | AWS NLB, IPVS, HAProxy in TCP mode | nginx, HAProxy, Envoy, AWS ALB, Caddy |

With HTTP keep-alive or HTTP/2, one connection carries many requests, so an L4 balancer can leave one instance with most of the traffic. Most web APIs sit behind an L7 balancer. Because the balancer terminates the client connection, your app sees the balancer's IP and must read the client's from `X-Forwarded-For`, trusting it only from the balancer (lesson 17).

How it picks an instance:

- **Round robin**: next instance in turn. Fine when requests and instances are alike. **Weighted** round robin gives bigger instances more.
- **Least connections**: the instance with the fewest active requests. Better when request cost varies a lot, because an instance stuck on slow requests stops receiving new ones.
- **Power of two choices**: pick two instances at random, send to the less loaded one. Close to the best possible with very little coordination between balancers.
- **IP hash / hash of a key**: the same client or key always goes to the same instance. Useful for caches local to an instance.
- **Consistent hashing**: with a plain `hash(key) % N`, changing N from 3 to 4 moves about three quarters of all keys, emptying every cache at once. Consistent hashing places instances and keys on a ring; each key goes to the next instance clockwise. Adding an instance moves only the keys between it and its neighbour, about 1/N of them. Each instance gets many "virtual nodes" on the ring so load evens out. Cache clusters, sharded databases and CDNs use it.

The balancer itself must not become the single point of failure: managed balancers are redundant by design, and self-hosted ones run in pairs.

### Database scaling: read replicas, partitioning and sharding

Once the app tier is stateless, the database is where the state, and usually the bottleneck, lives. Exhaust the cheap fixes first, in order: fix queries and N+1s, add the right indexes, pool connections, cache hot reads, scale the machine up. Many large products run on one well-tuned Postgres primary. When that is not enough:

**Read replicas.** The primary streams its write-ahead log to one or more replicas, which replay it and serve read-only queries. Most apps read far more than they write, so sending reads to replicas multiplies read capacity.

The catch is **replication lag**. Replication is usually asynchronous, so a replica is milliseconds to seconds behind the primary. A user saves a bookmark (write to primary), the page reloads (read from replica), and the bookmark is missing. Fixes:

- **Read your own writes** from the primary: route reads to the primary for a few seconds after a user writes, or for that user's own data.
- Route by consistency need: lists and search from replicas, "the thing I just changed" from the primary.
- Monitor lag (`pg_stat_replication`) and stop using a replica that falls too far behind.

Replicas do nothing for write throughput: every replica replays every write.

**Partitioning** splits one large table into smaller ones on the *same* server. Postgres's declarative partitioning splits by range (for example, one partition per month of `events`), list or hash. Queries that filter on the partition key touch only the relevant partitions, and dropping old data becomes `DROP TABLE events_2024_01` instead of a huge `DELETE`. It helps with very large tables; it does not add machines.

**Sharding** splits data across *separate* database servers, each holding a subset of rows, chosen by a **shard key**. Linkbox could shard by `user_id`: all of one user's bookmarks, tags and sessions live on one shard. Now writes scale too. The price:

- **Choosing the key is a one-way door.** A good key spreads load evenly and keeps the data one request needs on one shard. A bad one creates **hot shards** (one celebrity user, one big tenant) or forces every query to visit every shard.
- **Cross-shard queries and transactions** become application problems. "Most popular tags across all users" is now a scatter-gather.
- **Resharding** (going from 4 to 8 shards) means moving data while serving traffic. Consistent hashing, or many small logical shards mapped onto fewer servers, makes it bearable.
- **Operations multiply**: backups, migrations and failover for every shard.

Tools like Citus (Postgres) and Vitess (MySQL) handle much of the routing. Shard only when you must; the cheaper steps above go a long way.

### Content delivery networks

Some latency cannot be optimized away, because it is physics. Light in fiber covers about 200 km per millisecond. New York to London is about 5,600 km, so one round trip is at least 56 ms before any processing, and opening a new HTTPS connection takes a couple of round trips before the request itself is even sent.

A **CDN** puts servers (points of presence) in hundreds of cities. Users connect to a nearby one, which:

- **Caches responses** close to users: static assets, images, and API responses that are the same for everyone. A cache hit never touches your origin.
- **Terminates TLS nearby**, so the handshake round trips are short, and keeps warm connections back to your origin.
- **Absorbs traffic spikes and attacks** across a huge network before they reach you.

You control the CDN with HTTP caching headers (lesson 10):

```
Cache-Control: public, max-age=31536000, immutable              # /assets/app.3f9a1c.js: content-hashed name
Cache-Control: public, s-maxage=60, stale-while-revalidate=300  # a public list, shared caches only
Cache-Control: private, no-store                                # anything per-user: never at the CDN
```

Give static files content-hashed names so they can be cached forever and a deploy changes the URL instead of needing a purge. Be careful with what goes into the **cache key**: a response that varies by a header the CDN ignores will be served to the wrong people. Never let a per-user response be cached as public.

### Edge computing

A CDN serves cached bytes. **Edge computing** runs your *code* at those same locations: Cloudflare Workers, Lambda@Edge, Vercel and Netlify edge functions, Fastly Compute. Good uses are cheap decisions that do not need your database: redirects, rewriting requests, checking a signed token, A/B test assignment, geolocation-based routing, assembling a response from cached parts.

The limit is data. An edge function in Sydney that calls a database in Virginia pays the long round trip anyway, often several times per request. Edge runtimes are also restricted (limited CPU time, often no raw TCP or full Node APIs). Put logic at the edge when its data is at the edge (cached, or in an edge key-value store) or when it can answer without data.

### Asynchronous processing

Much of what a request does does not need to finish before you respond: sending email, fetching a page's metadata, resizing images, recomputing counts. Doing it inline makes every request as slow as its slowest side effect. Move it to a **queue** and a **worker** (lesson 11):

```
POST /bookmarks ──▶ insert row, enqueue "enrich" ──▶ 201 in 15 ms
                                     │
                          queue ──▶ worker: fetch page, parse, update row  (2 s, retried on failure)
```

This buys three things for scaling. **Lower latency**, because the user waits for the insert only. **Load levelling**: a spike of 10,000 signups fills the queue, and workers drain it at the rate the system can sustain instead of crushing the database. **Independent scaling**: add workers when the queue grows, without touching the web tier.

The costs are the ones lesson 11 covered: the work is now eventually done rather than done, jobs run at least once so they must be idempotent, and you need to watch queue depth and age. For work the client must wait for, return `202 Accepted` with a status URL, or push a notification when it finishes (lesson 21).

### Monolith or microservices

A **monolith** is one deployable application. **Microservices** split the system into separately deployed services that talk over the network.

Microservices are mostly an answer to an *organizational* scaling problem: many teams changing one codebase and one deploy pipeline get in each other's way. They are not a performance technique. In performance terms they mostly add cost:

- A function call takes nanoseconds. A network call takes a millisecond or more, can fail, can time out, and needs retries, auth and serialization.
- A database transaction becomes a distributed workflow (sagas, outboxes, lesson 25).
- Debugging a request needs distributed tracing.

What they do allow is scaling and deploying parts independently: the image-processing service gets ten instances with lots of CPU, the API gets three. A monolith gets close to that by running the same code as different process types (web and worker, lesson 23). The usual advice holds: start with a **modular monolith** with clear internal boundaries, and split out a service when a specific team or scaling need justifies the network in between.

### Serverless

**Serverless** functions (AWS Lambda, Google Cloud Run functions, Azure Functions) run your code per request or event. The platform starts instances as needed, scales to many in seconds, scales to zero when idle, and bills per invocation and per millisecond. No servers to patch, no capacity to plan.

The trade-offs are concrete:

- **Cold starts.** When no warm instance is available, the platform must start one: download your code, start the runtime, run your initialization. That adds from around a hundred milliseconds to several seconds, depending on runtime, package size and what you do at startup. It shows up exactly in your p99. Mitigations: smaller bundles, lazy initialization, and provisioned (pre-warmed) concurrency, which you pay for whether used or not.
- **Connection limits.** On Lambda's default compute type each instance handles one request at a time and holds its own database connections. (Lambda Managed Instances, which run functions on EC2 instances in your account, let one instance serve several requests at once.) A burst to 1,000 concurrent instances means up to 1,000 Postgres connections against a limit of 100. You need an external pooler (RDS Proxy, PgBouncer) or a database with an HTTP or serverless driver.
- **No local state** across invocations, by design, and **time limits** (15 minutes on Lambda), so long-running work goes elsewhere.
- **Cost at steady load.** Per-request pricing is cheap for spiky or low traffic and can be several times the cost of always-on servers for steady high traffic.
- **Platform coupling.** Triggers, permissions and limits are vendor-specific, and local testing is harder.

Serverless fits event handlers, spiky or low traffic, and glue code. A steady, latency-sensitive API with a relational database is often simpler and cheaper on a few long-running containers.

### Mental models to keep

- **Everything is a queue.** Latency is mostly waiting. Find the queue, and you have found the problem.
- **One bottleneck at a time.** Speeding up anything else is wasted effort. After each fix, it moves.
- **Measure the tail.** Set and test targets as percentiles under realistic load.
- **Keep headroom.** Past roughly 70 to 80% utilization, latency climbs steeply.
- **Cheapest fix first:** query, index, N+1, pool, cache, bigger machine, then more machines, then replicas, then sharding.
- **Scale the stateless parts out freely, the stateful parts carefully.** State is what makes scaling hard.
- **Every layer you add is a new way to fail.** A cache, a replica or a service must earn its complexity.

## Try it

Start a small server with two kinds of endpoint. Save as `slow.mjs`:

```js
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

http.createServer(async (req, res) => {
  if (req.url === "/cpu") {               // burns 5 ms of CPU: blocks this process
    const end = Date.now() + 5; while (Date.now() < end);
  } else {                                // waits, like a DB call; 1% are slow
    await sleep(Math.random() < 0.01 ? 500 : 10);
  }
  res.end("ok");
}).listen(3000);
```

```bash
node slow.mjs
npx autocannon -c 10 -d 20 http://localhost:3000/io      # columns: 2.5%, 50%, 97.5%, 99%, Avg, Max
npx autocannon -c 10 -d 20 -l http://localhost:3000/io   # -l adds a full percentile table
```

Compare the **Avg** column with the **50%** and **99%** columns. The average sits between them and describes no real request.

Now watch the latency curve. The `/cpu` endpoint costs 5 ms of CPU, so one process can do at most about 200 req/s. Raise the request rate with `-R` (requests per second across all connections):

```bash
npx autocannon -c 50 -d 15 -R 100 http://localhost:3000/cpu   # ~50% utilization
npx autocannon -c 50 -d 15 -R 180 http://localhost:3000/cpu   # ~90%
npx autocannon -c 50 -d 15 -R 250 http://localhost:3000/cpu   # over capacity
```

Note p50 and p99 for each run. Utilization went up by less than 2×; the tail went up by far more. Past capacity, requests queue faster than they drain.

Profile it:

```bash
node --cpu-prof slow.mjs        # run a load test against /cpu, then stop the server with Ctrl+C
# open the CPU.*.cpuprofile file in Chrome DevTools (Performance tab) or at https://www.speedscope.app
```

Break it on purpose:

1. Check Little's law. In the `/io` run, multiply requests per second by average latency in seconds. You should get roughly the `-c` connection count. Why?
2. Start `slow.mjs` twice on ports 3000 and 3001 and put both behind the nginx config from the build step. Does `/cpu` capacity double? Does `/io` latency change at all?
3. In Postgres, seed 100,000 bookmarks, run `EXPLAIN ANALYZE` on Linkbox's list query, drop the `(user_id, created_at)` index, and run it again.

## Common mistakes

- **Reporting the average.** Dashboards and load-test reports show p50, p95 and p99 from histograms. Alerts fire on the tail.
- **Optimizing without a profile or trace.** Measure where the time goes before changing code. The slow part is rarely where you expected.
- **Raising the pool size to fix slow queries.** More connections make a saturated database slower. Fix the queries, keep pools small, set a connection timeout, and use PgBouncer when instances multiply.
- **Scaling out a stateful app.** In-memory sessions, local uploads and in-process rate limits break the moment there are two instances. Move state out first.
- **Reading from a replica right after a write.** Users see their change vanish. Route read-your-own-writes to the primary.
- **Caching without measuring hit ratio or planning invalidation.** A cache with a 30% hit ratio and no invalidation rule adds latency and wrong answers. Count hits and misses, and decide how each key is invalidated before adding it.

## Build: Linkbox, step 18

Find Linkbox's limits, fix the biggest bottleneck, and run it as three stateless instances.

1. **Seed realistic data.** A script that creates 1,000 users, 100,000 bookmarks and 3 tags per bookmark, using `generate_series` in SQL for speed.
2. **Load test the list endpoint.** Log in as a seeded user and run, with the session cookie:

   ```bash
   npx autocannon -c 50 -d 30 -l -H "Cookie: sid=..." "http://localhost:3000/api/v1/bookmarks?limit=50"
   ```

   Or use k6 and print exactly the percentiles you want: `k6 run --summary-trend-stats "med,p(95),p(99)" list.js`. Record p50, p95, p99 and req/s in a `PERFORMANCE.md` table.
3. **Find and fix the N+1.** Count queries per request (a counter in the request context, lesson 07, logged on response). If listing tags runs one query per bookmark, replace it with the `ANY($1)` query above or a `JOIN ... array_agg`. Check that `EXPLAIN ANALYZE` uses the `(user_id, created_at DESC)` index. Re-run the load test and add a row to the table.
4. **Size the pool.** Use Little's law: measured req/s × average time a request holds a connection. Set `max` a little above that, set `connectionTimeoutMillis: 2000`, and export the pool's `totalCount`, `idleCount` and `waitingCount` as gauges on `/metrics`. A steadily non-zero `waitingCount` means the database, not the pool, needs attention.
5. **Run three stateless instances.** Confirm sessions, rate limits and cache live in Postgres and Redis, not memory. Add to `docker-compose.yml`:

   ```yaml
   services:
     api:
       build: .
       deploy: { replicas: 3 }
       environment: { DATABASE_URL: "postgres://...", REDIS_URL: "redis://redis:6379" }
     lb:
       image: nginx:1.30
       ports: ["8080:80"]
       volumes: ["./nginx.conf:/etc/nginx/conf.d/default.conf:ro"]
       depends_on: [api]
   ```

   ```nginx
   upstream linkbox {
     least_conn;
     server api:3000;   # Docker DNS returns all three replicas at startup; nginx balances across them
   }
   server {
     listen 80;
     location / {
       proxy_pass http://linkbox;
       proxy_set_header Host $host;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
     }
   }
   ```

6. **Prove it.** Log in through port 8080, then make requests while running `docker compose logs -f api`: different replicas serve them, and you stay logged in. Stop one replica during a load test (`docker stop`) and watch the error count and how quickly it recovers.

**Done when** `PERFORMANCE.md` shows before-and-after percentiles for the N+1 fix, the list endpoint makes the same number of queries whatever the page size, and the three-instance setup survives losing one instance with you still logged in.

## Check yourself

<details markdown="1">
<summary>Your API's average latency is 80 ms and the p99 is 2.4 s. Which number should you alert on, and why is the average misleading here?</summary>

The p99 (and p95). The average blends many fast requests with a few very slow ones and matches neither. One in a hundred requests takes over 2.4 s, and a user who makes dozens of requests will hit that often.
</details>

<details markdown="1">
<summary>A service runs at 60% CPU at peak. Traffic is expected to grow 40%. Using the latency curve, what do you expect?</summary>

Utilization goes to about 84%. With `response time ≈ service time / (1 − utilization)`, response time grows from about 2.5× to about 6× the service time, so latency gets much worse even though CPU is "not maxed out". Add capacity or cut per-request cost before the growth arrives.
</details>

<details markdown="1">
<summary>Your API handles 300 req/s and each request holds a database connection for 20 ms. How many connections does it need, roughly, and what law tells you?</summary>

Little's law, L = λ × W: 300 × 0.02 = 6 connections busy on average. Allow headroom for bursts (say 10). If requests wait for the pool far more than that predicts, the hold time is longer than you think: look for slow queries or slow work done while holding a connection.
</details>

<details markdown="1">
<summary>Why does going from 1 to 20 app instances break a Postgres database that was fine before, and what fixes it?</summary>

Each instance has its own pool: 20 × 10 = 200 connections against a default `max_connections` of 100, and each connection is a Postgres process using memory. Put PgBouncer (or a managed proxy) in transaction mode in between, so many client connections share a small number of server connections.
</details>

<details markdown="1">
<summary>A user creates a bookmark and the next page load doesn't show it. Reads go to a replica. What is happening and how do you fix it?</summary>

Replication lag: the replica has not yet replayed the write. Route reads of data the user just changed (or all of that user's reads for a few seconds after a write) to the primary.
</details>

<details markdown="1">
<summary>With <code>hash(key) % N</code>, what happens to a cache cluster when you add a node, and how does consistent hashing change that?</summary>

Changing N remaps most keys (about 3/4 going from 3 to 4 nodes), so most of the cache misses at once and the database takes the load. With consistent hashing, keys and nodes sit on a ring, and adding a node moves only the keys between it and its neighbour, about 1/N of them.
</details>

## Go deeper

- [The USE Method](https://www.brendangregg.com/usemethod.html): Brendan Gregg's checklist for finding the saturated resource on any system.
- [Use The Index, Luke](https://use-the-index-luke.com/): a free book on how B-tree indexes work and how to write queries that use them.
- [HikariCP: About Pool Sizing](https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing): why smaller connection pools are faster, with the sizing formula.
- [PgBouncer features](https://www.pgbouncer.org/features.html): pool modes and exactly which Postgres features break in transaction mode.
- [PostgreSQL: High Availability, Load Balancing, and Replication](https://www.postgresql.org/docs/current/high-availability.html): the official guide to replicas, synchronous and asynchronous replication, and their trade-offs.
- [Node.js: Flame graphs](https://nodejs.org/en/learn/diagnostics/flame-graphs): how to profile a Node process and read the result.
