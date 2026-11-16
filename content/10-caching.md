---
title: Caching
part: Data
summary: Keep a copy of expensive answers close to where they are needed, and know when that copy is lying.
---

A cache is a small, fast store that holds copies of data whose real home is somewhere slower. Your CPU, your operating system, the browser, the CDN and Postgres all cache before your code does. Caching is how fast systems are fast, and stale caches are behind a large share of "it shows the old value" bugs. You need to know both sides.

## The first principle

Some answers are expensive to produce. A page of bookmarks costs a database round trip, a join and some JSON work. A user's tag counts cost a `group by` over every bookmark they own. If a thousand requests ask the same question within a minute, the server does the same work a thousand times and gets the same answer each time.

Two facts make caching work:

- **Locality.** Access is not spread evenly. A small share of the data gets most of the reads (popular bookmarks, the logged-in user's own list, today's trending items). Data read recently is likely to be read again soon (*temporal* locality), and so is data stored next to it (*spatial* locality).
- **Speed gaps.** Storage tiers differ in speed by orders of magnitude. Rough numbers:

| Access | Rough time |
|---|---|
| CPU L1 cache | 1 ns |
| Main memory (RAM) | 100 ns |
| Redis `GET` on the same network | 0.2 to 0.5 ms (mostly network) |
| Simple indexed Postgres query | 0.5 to 2 ms |
| Heavy aggregate query | 10 to 500 ms |
| Call to a third-party API | 50 to 500 ms |
| Round trip across an ocean | 150 ms |

So keep a copy of the answer in something faster and closer, and reuse it. The copy is the cache. Reading from it and finding the answer is a **hit**; not finding it is a **miss**. The **hit ratio**, hits divided by all lookups, tells you whether the cache earns its keep.

The price is that the copy can go out of date. Every caching decision is a trade between speed and **staleness**: how wrong are you willing to be, and for how long?

> A cache must always be safe to lose. If deleting every key would lose data rather than make things slower, it is not a cache, it is a database without backups.

## Core ideas

### The cache hierarchy

Caching happens at every layer between the user and the disk. Each layer is smaller and faster than the one below it.

```
browser cache         Cache-Control, ETag            per user, on their device
CDN / reverse proxy   edge copies of public responses close to users
application cache     Redis, Memcached, in-process   your code decides
database buffers      Postgres shared_buffers        recently used table and index pages
OS page cache         free RAM holding file pages    automatic
CPU caches            L1, L2, L3                      automatic, per core / per chip
disk                  the source of truth
```

- **Hardware.** CPU caches keep recently used memory lines next to each core. You don't manage them, but they are why scanning an array beats chasing pointers.
- **Operating system.** Linux uses free RAM as a **page cache** for file contents. The second read of a file comes from memory.
- **Database.** Postgres keeps hot pages in `shared_buffers` (128 MB by default) and relies on the OS page cache for the rest. This is why the second run of a query is often faster, and why `explain (analyze, buffers)` shows `hit` and `read` (lesson 09).
- **Network.** DNS answers are cached by resolvers for their TTL. A **CDN** (Cloudflare, Fastly, CloudFront) stores copies of responses in data centers near users, so most requests never reach your server.
- **Browser.** The browser stores responses and reuses them according to HTTP headers.
- **Application.** The layer you control most: your code puts computed answers in Redis or in process memory.

### HTTP caching: let the client do the work

The cheapest request is one that never reaches your server. HTTP has caching built in (RFC 9111), controlled by response headers:

| Header | Meaning |
|---|---|
| `Cache-Control: max-age=60` | Any cache may reuse this for 60 seconds without asking |
| `Cache-Control: private` | Only the user's browser may store it, not a shared CDN. Use for per-user data |
| `Cache-Control: no-cache` | Store it, but check with the server before each reuse |
| `Cache-Control: no-store` | Don't store it at all. Use for secrets and sensitive pages |
| `ETag: "abc123"` | A version tag for this representation of the resource |

**Conditional requests** save bandwidth even when content can't be reused blindly. The server sends an `ETag`. Next time the client sends `If-None-Match: "abc123"`. If the resource hasn't changed, the server answers `304 Not Modified` with no body, and the client uses its copy. The server still does the lookup, but skips serializing and sending the body.

### Application caches and Redis

For data only your server can compute, you cache in the application. Two places:

- **In-process memory** (a `Map` with a size limit). Fastest possible, no network. But each instance has its own copy, the copies disagree after a write, and a restart empties it. Good for small, rarely changing data like config or feature flags.
- **A shared cache server.** All instances see the same copy, and it survives app restarts. Redis is the usual choice; Memcached is a simpler alternative that only stores strings.

**Redis** is an in-memory data structure server. Why it is fast:

- All data lives in RAM. No disk read on the request path.
- Commands run one at a time on a single main thread, so there are no locks, and every command is atomic. (Newer versions use extra threads for network I/O.)
- The protocol is small and simple, and clients can pipeline many commands in one round trip.

It can also persist to disk (RDB snapshots and an append-only file), so it is used for sessions, rate limits and queues (lesson 11), not just caches. Its license changed in 2024 and the Linux Foundation forked the last open-source version as **Valkey**; Redis 8 (2025) then added the open-source AGPLv3 as a license option. The commands in this lesson work on both.

### Redis data structures

A Redis value is not just a string. Pick the structure that matches the question you will ask:

| Type | Example commands | Use it for |
|---|---|---|
| String | `SET`, `GET`, `INCR`, `EXPIRE` | Cached JSON, counters, locks |
| Hash | `HSET`, `HGET`, `HINCRBY` | An object with fields you update one at a time. Since Redis 7.4 one field can have its own TTL (`HEXPIRE`) |
| List | `LPUSH`, `RPOP`, `LRANGE` | Recent-items lists, simple queues |
| Set | `SADD`, `SISMEMBER`, `SINTER` | Unique members, tags, "who is online" |
| Sorted set | `ZADD`, `ZRANGE`, `ZINCRBY` | Leaderboards, ranked tag counts, time-ordered items |
| Stream | `XADD`, `XREADGROUP` | Append-only logs with consumer groups |
| Others | bitmaps, HyperLogLog, geo, JSON, time series, vector sets | Flags per user, approximate unique counts, location queries, similarity search. JSON, time series and vector sets are built in from Redis 8; before that they were add-on modules |

Keys are plain strings. Use a consistent naming scheme with colons, such as `bookmark:42:7` or `tagcounts:42`, and include everything that changes the answer.

### Caching strategies

**Cache-aside** (lazy loading) is the default. The application talks to both the cache and the database:

```
read:   GET key ── hit ──> return it
            └── miss ──> query DB ──> SET key value EX ttl ──> return it
write:  update DB ──> DEL key
```

Only data someone actually reads gets cached, and if Redis goes down the app still works, only slower. The cost is that the first read after a miss pays for both trips.

The other strategies:

| Strategy | How it works | Trade-off |
|---|---|---|
| Cache-aside | App reads cache, falls back to DB, fills cache | Simple and resilient. First read is slow; data stale until TTL or invalidation |
| Read-through | The cache library loads from the DB on a miss itself | Same behaviour, loading logic lives in one place |
| Write-through | Every write goes to the cache and the DB together | Cache is always fresh. Writes are slower; you cache things nobody reads |
| Write-behind (write-back) | Write to the cache, flush to the DB later in batches | Very fast writes. A cache crash loses data that was never flushed |

Write-behind turns the cache into the source of truth for a while, so it breaks the rule that a cache must be safe to lose. Use it only for data you can afford to lose, such as view counters you flush every few seconds.

### TTLs

A **TTL** (time to live) makes Redis delete a key after a set time. It is your safety net: even if an invalidation is missed, stale data dies on schedule.

```
SET bookmark:42:7 '{"id":7,...}' EX 300     -- expires in 300 seconds
TTL bookmark:42:7                           -- seconds left
```

Choose the TTL from how stale the data may be, not from how often it changes. A user's own bookmark: a few minutes, with invalidation on write. A public "popular this week" list: an hour, no invalidation. Add a little random **jitter** to TTLs (300 plus 0 to 30 seconds) so keys written together don't all expire together.

### Eviction

Memory is finite. When Redis reaches `maxmemory`, the `maxmemory-policy` decides what happens on the next write:

| Policy | Behaviour |
|---|---|
| `noeviction` (default) | Refuse writes with an error. Right for queues and data you can't lose |
| `allkeys-lru` | Evict the least recently used key. A good default for a pure cache |
| `allkeys-lfu` | Evict the least frequently used key. Better when a stable set of keys is always hot |
| `allkeys-lrm` | Evict the least recently *modified* key: only writes count as use, reads don't. Added in Redis 8.6 |
| `volatile-lru`, `volatile-lfu`, `volatile-lrm` | Same, but only among keys that have a TTL |
| `volatile-ttl` | Evict the key closest to expiring |
| `allkeys-random`, `volatile-random` | Evict at random |

**LRU** keeps what was used recently; a one-off scan of many keys can push out the real hot set. **LFU** keeps what is used often, and decays the counters over time so yesterday's favourite can leave. Redis approximates both by sampling a few keys (`maxmemory-samples`, default 5) instead of tracking exact order, which saves memory and is close to exact in practice.

Don't run your cache and your job queue on the same Redis with `allkeys-lru`: under memory pressure it will evict queued jobs. Use two instances, or `noeviction` for the queue.

### Invalidation

When the data changes, the cached copy is wrong. The rule for cache-aside: **update the database, then delete the key**. Don't write the new value into the cache. Two concurrent writers can set the cache in the opposite order from the database, leaving the older value cached until the TTL. A delete can't be applied in the wrong order; the next read loads the fresh value.

Invalidation is harder than it looks because one change can affect many keys. Editing a bookmark's tags changes the bookmark, the user's tag counts and maybe several list pages. Options:

- Delete every key you can name (`bookmark:42:7`, `tagcounts:42`).
- Don't cache things that are hard to invalidate (filtered, paginated lists), or give them a short TTL.
- **Version the key**: store a counter `ver:user:42` and build list keys as `list:42:v{n}:...`. Incrementing the counter makes all old list keys unreachable at once; they expire on their own.

There is still one race in cache-aside: a reader misses, loads the old row, a writer updates the row and deletes the key, then the reader stores the old row. It is rare and the TTL bounds it. That is one more reason every key needs a TTL.

### Stampedes

A popular key expires. In the next 50 ms, 500 requests miss at once, all run the same expensive query, and all write the same value. The database sees a spike exactly when the cache was supposed to protect it. This is a **cache stampede** (or thundering herd). Defenses:

- **Request coalescing.** Within one process, let only the first miss do the work; the others wait for its promise:

  ```js
  const inflight = new Map();
  function coalesce(key, load) {
    if (!inflight.has(key)) {
      inflight.set(key, load().finally(() => inflight.delete(key)));
    }
    return inflight.get(key);
  }
  ```

- **A lock across instances.** The first miss takes `SET lock:key token NX PX 5000`. Others wait a few milliseconds and read the cache again, or serve a stale copy.
- **Serve stale while revalidating.** Keep the old value a bit past its "fresh" time and refresh it in the background.
- **Early refresh.** Refresh a key slightly before it expires, with a probability that rises as expiry approaches, so one request renews it before everyone misses.
- **TTL jitter**, so many keys don't expire in the same second.

### What not to cache

- **Data that must be exact right now**: balances, stock levels, permissions checked for a write. Read them from the database inside the transaction.
- **Data that is cheap already.** A primary-key lookup in Postgres takes about a millisecond; Redis saves little and adds a second system that can be wrong.
- **Data with a low hit ratio**: long-tail items read once. You pay the write and the memory for nothing.
- **Per-user data under a shared key.** If the key lacks the user id, one user's data is served to another.
- **Secrets and sensitive responses** in any shared cache. Send `Cache-Control: no-store`.

Measure before and after. A cache you add without measuring is a guess with a staleness bug attached.

## Try it

Start Redis 8 and open the CLI:

```bash
docker run --name redis -p 6379:6379 -d redis:8
docker exec -it redis redis-cli
```

Explore the data types and expiry:

```
SET greeting hello EX 10
TTL greeting                 # counts down; after 10 s GET returns (nil)
INCR page:views
HSET user:1 name Ana plan pro
HGETALL user:1
ZADD tags:42 3 go 5 sql 1 redis
ZRANGE tags:42 0 -1 REV WITHSCORES
SET lock:report abc NX PX 5000   # OK
SET lock:report xyz NX PX 5000   # (nil): someone holds the lock
INFO stats                   # look for keyspace_hits and keyspace_misses
```

Now measure a cache-aside read from Node. Save as `cache.mjs` and run `npm install ioredis` first. ioredis 6 (July 2026) needs Node.js 20 or newer and speaks the newer RESP3 protocol to Redis by default; nothing in this lesson changes because of it.

```js
import { Redis } from "ioredis";
const redis = new Redis();

const slowQuery = async (id) => {
  await new Promise((r) => setTimeout(r, 200)); // pretend this is Postgres
  return { id, title: "A bookmark", at: new Date().toISOString() };
};

async function getBookmark(id) {
  const key = `demo:bookmark:${id}`;
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const value = await slowQuery(id);
  await redis.set(key, JSON.stringify(value), "EX", 30);
  return value;
}

for (let i = 0; i < 3; i++) {
  const t = performance.now();
  await getBookmark(7);
  console.log(`read ${i + 1}: ${(performance.now() - t).toFixed(1)} ms`);
}
await redis.quit();
```

The first read takes about 200 ms; the next two take under a millisecond.

Break it on purpose:

1. Fire 100 reads at once on an empty cache with `await Promise.all(Array.from({ length: 100 }, () => getBookmark(8)))` and count how many times `slowQuery` runs. Wrap it with `coalesce` and count again.
2. In `redis-cli`, run `CONFIG SET maxmemory 2mb` and `CONFIG SET maxmemory-policy allkeys-lru`, then write many keys in a loop. Which keys survive? Repeat with `noeviction` and read the error.
3. Change the cached value's source but not the cache. How long does the old value live? What would make it disappear sooner?

## Common mistakes

- **No TTL.** A missed invalidation keeps a stale value forever, and the cache grows until eviction or an out-of-memory error. Give every cache key a TTL.
- **Keys that ignore who is asking.** `bookmark:7` cached from user A's request is served to user B. Put the user id (and anything else that changes the answer, like locale) in the key, or check ownership after the cache read.
- **Updating the cache on write instead of deleting it.** Concurrent writers can leave the older value in the cache. Write the database, then `DEL`.
- **Treating the cache as required.** If Redis is down, cache-aside should fall back to the database, with a short timeout on cache calls, rather than failing the request.
- **One Redis for cache and queue with an evicting policy.** Under memory pressure, jobs vanish. Separate them or use `noeviction` where data must stay.
- **Caching before measuring.** You add a consistency problem to save a millisecond. Find the slow path first (lesson 15, lesson 18).

## Build: Linkbox, step 10

Add Redis as a cache in front of the Postgres repositories from lesson 09. Keep it in the service layer so routes don't know it exists.

1. Run Redis with the `docker run` above, `npm install ioredis`, and create one shared client in `cache.js` from `REDIS_URL` (default `redis://localhost:6379`).
2. Cache single bookmarks with cache-aside. Key `bookmark:{userId}:{id}`, TTL 300 seconds plus up to 30 seconds of random jitter. On a miss, load with the owner-scoped SQL query and store the JSON. Don't cache "not found".
3. Cache the tag counts query from lesson 09 under `tagcounts:{userId}` with a 60-second TTL.
4. Invalidate on every write: after a create, update or delete commits in Postgres, `DEL` the bookmark's key and `tagcounts:{userId}`. Do it after the commit, not before.
5. Wrap the miss path in `coalesce` so concurrent misses for the same key run the query once.
6. If a Redis call fails, log it and fall back to Postgres. Linkbox must keep working with Redis stopped.
7. Add `ETag` to `GET /api/v1/bookmarks/:id`: a weak tag such as `W/"7-1731756000000"` built from the id and `updated_at`. If the request's `If-None-Match` contains the same tag, reply `304` with no body. Send `Cache-Control: private, no-cache` so browsers revalidate and shared caches don't store it.

**Done when** a second `GET` of the same bookmark doesn't touch Postgres (check with a log line or `MONITOR` in `redis-cli`), an edit is visible on the very next read, `curl -i -H 'If-None-Match: <etag>'` returns `304`, and the API still works after `docker stop redis`.

## Check yourself

<details markdown="1">
<summary>Why does caching help at all, if every cache miss is slower than no cache?</summary>

Because access is skewed. Most reads go to a small set of hot data, so most lookups are hits, and a hit is far cheaper than recomputing or refetching. If the hit ratio is low, the cache really does make things slower.
</details>

<details markdown="1">
<summary>After an update, why delete the cache key rather than write the new value into it?</summary>

Two concurrent writers can update the database in one order and the cache in the other, leaving the older value cached. A delete can't be reordered into a wrong value; the next read loads whatever the database now holds.
</details>

<details markdown="1">
<summary>A hot key expires and the database CPU spikes. What happened, and name two fixes.</summary>

A cache stampede: many requests missed at once and all ran the same query. Fixes: coalesce concurrent misses (in-process promise sharing or a Redis `SET NX` lock), serve stale data while one request refreshes, refresh early before expiry, and add jitter to TTLs.
</details>

<details markdown="1">
<summary>When would you choose <code>allkeys-lfu</code> over <code>allkeys-lru</code>?</summary>

When a stable set of keys is read often over a long time, and occasional scans or one-off reads would push them out under LRU. LFU keeps frequently used keys even if they weren't touched in the last few seconds.
</details>

<details markdown="1">
<summary>What does a <code>304 Not Modified</code> save, and what does it not save?</summary>

It saves sending and serializing the body, and the client's download time. It doesn't save the request round trip or the server's work to check whether the resource changed.
</details>

<details markdown="1">
<summary>Give two kinds of data you should not cache.</summary>

Data that must be exact at the moment of a decision (an account balance before a withdrawal, permissions for a write) and data that is already cheap or rarely re-read. Also never cache sensitive per-user responses under shared keys or in shared HTTP caches.
</details>

## Go deeper

- [Redis: Key eviction](https://redis.io/docs/latest/develop/reference/eviction/): every eviction policy, how approximate LRU and LFU work, and how to read hit and miss stats.
- [Redis data types](https://redis.io/docs/latest/develop/data-types/): each structure with its commands and typical uses.
- [MDN: HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching): `Cache-Control`, freshness, validation and `ETag`, explained with examples.
- [AWS: Database caching strategies using Redis](https://docs.aws.amazon.com/whitepapers/latest/database-caching-strategies-using-redis/welcome.html): cache-aside, write-through and TTL choices in a short whitepaper.
- [Scaling Memcache at Facebook (NSDI 2013)](https://www.usenix.org/conference/nsdi13/technical-sessions/presentation/nishtala): how one of the largest caches handles invalidation, stampedes ("leases") and consistency.
- [Latency numbers every programmer should know](https://gist.github.com/jboner/2841832): the speed gaps between cache, memory, disk and network that make caching worthwhile.
