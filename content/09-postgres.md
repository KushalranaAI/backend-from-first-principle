---
title: Databases with Postgres
part: Data
summary: Why your data belongs in a database, and how to model, query, index and change it safely in PostgreSQL.
---

Until now Linkbox has kept everything in a JavaScript `Map`. Restart the process and every user, session and bookmark is gone. A database is the part of the system that remembers. Almost every backend bug that costs real money (lost writes, duplicate charges, slow pages) ends up being a database question, so this is the longest lesson in the course.

## The first principle

A server process is temporary. It restarts on every deploy, crashes on a bad input and gets replaced when a machine dies. Memory goes with it. So the first requirement is **persistence**: data has to live on disk and survive the process.

The obvious first try is a file. Write the bookmarks to `bookmarks.json` on every change and read it back on start. It works for one user. Then the questions start:

- **Two requests write at once.** Both read the file, both add a bookmark, both write it back. One bookmark disappears. This is a *lost update*.
- **The process crashes halfway through a write.** The file is now half old, half new, and not valid JSON. Everything is gone.
- **You need one bookmark out of a million.** You read and parse the whole file to find it.
- **You need "all bookmarks tagged `go`, newest first".** You write that loop by hand. Then another loop for the next question.
- **A second server joins.** Each has its own file. They disagree.
- **Someone saves a bookmark with no URL.** Nothing stops it. The bad record breaks a page three weeks later.

Every one of these is a solved problem, and the solution has a name: a **database management system (DBMS)**. It is a separate program whose whole job is to own the data and give you guarantees about it:

| Problem with files | What a DBMS gives you |
|---|---|
| Concurrent writers clobber each other | Concurrency control: locks and multi-version reads |
| A crash leaves half-written data | Atomic transactions and a write-ahead log for crash recovery |
| Finding one record means reading everything | Indexes |
| Every question is hand-written code | A query language (SQL) and a query planner |
| Bad data gets in | Types and constraints, checked on every write |
| Many servers, one truth | A single server they all connect to, plus replication |

PostgreSQL ("Postgres") is the DBMS this course uses. It is open source, around since 1996, and the default choice for most new backends because it does all of the above well and adds JSON, full-text search (lesson 12) and a large extension ecosystem.

> The database is the source of truth. Caches (lesson 10), search indexes (lesson 12) and queues (lesson 11) are copies or helpers. If they disagree with Postgres, Postgres wins.

## Core ideas

### Relational and non-relational

A **relational** database stores data in **tables**: rows of the same shape, with typed columns. Tables refer to each other by key, and SQL joins them back together at query time. The schema is declared up front and enforced on every write.

**Non-relational** ("NoSQL") is a family of different designs that drop some of that to gain something else:

| Kind | Examples | Good at |
|---|---|---|
| Document | MongoDB, Firestore | Nested records read and written as a whole |
| Key-value | Redis, DynamoDB | Very fast lookups by one key (lesson 10) |
| Wide-column | Cassandra, ScyllaDB | Huge write volumes spread over many machines |
| Search | Elasticsearch, OpenSearch | Ranked text search (lesson 12) |
| Graph | Neo4j | Walking relationships many hops deep |

Start relational. Most application data has relationships (users own bookmarks, bookmarks have tags), and you will want to ask questions you did not plan for. SQL handles new questions; a key-value design usually needs a new data layout for each one. Reach for something else when you have a specific need Postgres can't meet at your scale, and keep Postgres as the system of record next to it. Postgres also covers a lot of "NoSQL" ground itself: a `jsonb` column stores and indexes schemaless documents.

### Data types

Choose the narrowest type that fits. The type is your first validation, and it decides how values sort, compare and use storage.

| Type | Use it for | Notes |
|---|---|---|
| `bigint` | ids, counts | 8 bytes. Use `bigint generated always as identity` for auto-increment keys |
| `integer` | small counts | 4 bytes, max about 2.1 billion |
| `numeric(12,2)` | money | Exact decimal. Never use `real`/`double precision` for money |
| `text` | strings | No performance difference from `varchar(n)` in Postgres. Enforce length with a `check` |
| `boolean` | flags | `true`, `false` or `null` |
| `timestamptz` | points in time | Stored as UTC, converted on output. Prefer it over `timestamp` (no time zone) |
| `date` | calendar days | Birthdays, due dates |
| `uuid` | public or distributed ids | `gen_random_uuid()` is built in; Postgres 18 adds time-ordered `uuidv7()` |
| `jsonb` | flexible or third-party payloads | Binary JSON, indexable with GIN. Don't use it to avoid designing a schema |
| `text[]` | small lists | Arrays exist, but a separate table is usually better |
| `tsvector` | search documents | Lesson 12 |

A note for Node: `pg` returns `bigint` (and `count(*)`, which is `bigint`) as a **string**, because a JavaScript number can't hold every 64-bit integer exactly. Cast small values in SQL (`count(*)::int`) or convert in your repository layer.

### Designing a schema

A schema is a set of decisions about what your data *is*. Work from the nouns in your domain. For Linkbox: users, sessions, bookmarks, tags.

**Normalization** is the main rule: store each fact once. If a tag name lived inside every bookmark row as a string, renaming the tag would mean updating every row, and a missed row would leave two spellings. Instead the tag lives in one row of `tags`, and bookmarks point at it.

The normal forms make this precise. In practice you need the first three:

1. **1NF**: one value per column. No comma-separated lists in a `text` column.
2. **2NF**: in a table with a composite key, every column depends on the *whole* key.
3. **3NF**: no column depends on another non-key column. If `bookmarks` had `user_email`, it would depend on `user_id`, not on the bookmark. Move it to `users`.

**Denormalization** is the deliberate opposite: copying a value to save a join or a count, for example keeping `bookmark_count` on `users`. It makes reads faster and writes harder, because now two places must agree. Do it later, when a measured query needs it, and keep both copies in one transaction.

### Keys and constraints

Constraints are rules the database checks on every insert and update, from every client, forever. Application validation (lesson 06) gives users friendly errors. Constraints are the guarantee that bad data never lands, even from a buggy script or a race between two requests.

| Constraint | What it guarantees |
|---|---|
| `primary key` | Every row has a unique, non-null identifier. Postgres indexes it automatically |
| `foreign key` (`references`) | The referenced row exists. `on delete cascade` deletes children with the parent |
| `unique` | No two rows share this value (or combination). Also creates an index |
| `not null` | The column always has a value |
| `check` | Any boolean rule: `check (length(title) between 1 and 200)` |
| `default` | The value used when an insert leaves the column out |

A **natural key** is a real-world value (an email). A **surrogate key** is a generated id with no meaning. Use a surrogate primary key (`bigint` identity or `uuid`) and put a `unique` constraint on the natural key. Emails change; ids don't.

When a constraint fails, Postgres returns an error with a five-character `SQLSTATE` code. `pg` puts it on `err.code`, along with `err.constraint`. Map the common ones to HTTP:

| Code | Meaning | Typical response |
|---|---|---|
| `23505` | unique violation | 409 Conflict ("you already saved this URL") |
| `23503` | foreign key violation | 404 or 422, depending on what was referenced |
| `23514` | check violation | 400 or 422 |
| `23502` | not-null violation | 400 or 422 |

### Relationships

Three shapes cover almost everything:

```
one-to-one     users ──1:1── user_settings     settings.user_id is the primary key AND a foreign key
one-to-many    users ──1:N── bookmarks         bookmarks.user_id references users(id)
many-to-many   bookmarks ──N:M── tags          a join table: bookmark_tags(bookmark_id, tag_id)
```

The foreign key always goes on the "many" side. For many-to-many you need a third table, the **join table**, whose primary key is the pair of foreign keys. That composite key also stops the same tag from being attached twice.

Postgres creates indexes for primary keys and unique constraints, but **not** for foreign key columns. If you ever look up "all bookmarks of user 7" or delete a user (which cascades), index `bookmarks.user_id` yourself.

### SQL you will actually write

Most backend SQL is a handful of shapes. `RETURNING` sends back the rows a write touched, so you don't need a second query to read the generated id or defaults:

```sql
insert into bookmarks (user_id, url, title)
values ($1, $2, $3)
returning id, created_at;
```

Since Postgres 18, `RETURNING` can also give you the values from before the write: `update ... returning old.title, new.title`.

**Joins** combine tables. An inner `join` keeps only rows with a match on both sides; a `left join` keeps every row from the left table and fills the right side with `null` when there is no match. One bookmark with its tags (a bookmark with no tags still appears, with an empty array):

```sql
select b.id, b.url, b.title,
       coalesce(array_agg(t.name order by t.name) filter (where t.name is not null), '{}') as tags
from bookmarks b
left join bookmark_tags bt on bt.bookmark_id = b.id
left join tags t on t.id = bt.tag_id
where b.id = $1 and b.user_id = $2
group by b.id;
```

**Aggregates** (`count`, `sum`, `avg`, `min`, `max`, `array_agg`) collapse many rows into one per group. Every column in the `select` must be either aggregated or in the `group by` (grouping by a primary key lets you select the rest of that table's columns). Filter groups with `having`, not `where`. Tag counts for one user:

```sql
select t.name, count(*)::int as count
from tags t
join bookmark_tags bt on bt.tag_id = t.id
where t.user_id = $1
group by t.name
order by count desc, t.name;
```

**Upserts** insert a row or, if it would break a unique constraint, do something else. This is atomic, unlike "select, then insert if missing", which races:

```sql
insert into bookmarks (user_id, url, title)
values ($1, $2, $3)
on conflict (user_id, url) do update
  set title = excluded.title, updated_at = now()
returning id, title;
```

`excluded` is the row you tried to insert. Use `on conflict ... do nothing` when you only want "insert if absent", but note it returns no row for the conflict.

**Keyset (cursor) pagination** from lesson 08 is a row comparison, which an index on `(user_id, created_at desc, id desc)` serves directly:

```sql
select id, url, title, created_at
from bookmarks
where user_id = $1 and (created_at, id) < ($2, $3)
order by created_at desc, id desc
limit $4;
```

### Parameterized queries

Never build SQL by pasting values into a string:

```js
// SQL injection: title = "x'); drop table bookmarks; --"
await pool.query(`insert into bookmarks (title) values ('${title}')`);
```

Send the SQL text and the values separately. The `$1, $2` placeholders are filled in by the server, which treats the values strictly as data, never as SQL:

```js
await pool.query("insert into bookmarks (user_id, title) values ($1, $2)", [userId, title]);
```

Placeholders work for values only. Table names, column names and sort directions can't be parameters; pick them from a fixed allowlist in code (lesson 08's `sort` parameter maps to one of a few known `order by` clauses). Lesson 17 returns to this.

### Migrations

Your schema will change: lesson 11 adds a `description` column, lesson 12 a search column. Each change must reach every developer's laptop, CI and production, in order, exactly once. Editing a `schema.sql` by hand and hoping does not do that.

A **migration** is one numbered SQL file that moves the schema forward one step. A small table in the database records which files have run:

```
migrations/
  001_init.sql
  002_bookmark_description.sql     (lesson 11)
  003_bookmark_search.sql          (lesson 12)
```

The runner reads the folder, skips files already recorded and applies the rest, each inside a transaction so a failed migration leaves nothing half done. Postgres can roll back DDL (`create table`, `alter table`) inside a transaction, which many databases can't. Rules that keep migrations safe:

- **Never edit a migration that has run anywhere shared.** Write a new one.
- **Make changes backward compatible.** During a deploy, old and new code run at the same time. Add a nullable column, deploy code that writes it, backfill, then add `not null`. Rename in steps: add new, copy, switch reads, drop old.
- **Watch for locks.** `alter table` takes a strong lock. Adding a column with a constant default is instant (Postgres 11+), but some changes rewrite the whole table. On a big table, build indexes with `create index concurrently`, which can't run inside a transaction block.
- **Run migrations as their own step**, before the new code starts (lesson 23), not from every app instance at boot.

Tools such as node-pg-migrate, dbmate and Flyway do this for you. You'll write a 25-line runner below to see there is no magic.

### Indexes

Without an index, `where user_id = 42` makes Postgres read every row in the table and test each one: a **sequential scan**. Fine for a thousand rows, slow for ten million.

An **index** is a separate, sorted data structure that maps column values to row locations. The default kind is a **B-tree**: a balanced tree, a few levels deep, where each page holds hundreds of sorted keys pointing to the next level down. Finding one value takes one page read per level, and a table of a hundred million rows is still only about four levels deep. Because the leaves are sorted and linked, a B-tree also serves range queries (`<`, `between`), `order by` and prefix matches (`like 'abc%'`).

```
                 [ 50 | 100 ]
           /          |          \
    [10|20|30]   [60|70|80]   [110|120|130]     ← leaves point to rows
```

Indexes worth knowing:

| Index | Use it for |
|---|---|
| B-tree (default) | Equality, ranges, sorting. Almost everything |
| Composite `(a, b)` | Queries that filter on `a`, or on `a` and `b`. Column order matters: leftmost first. Since Postgres 18 a *skip scan* can serve a filter on `b` alone, but only when `a` has few distinct values |
| Unique | Enforcing uniqueness (created by `unique` constraints) |
| Partial (`where ...`) | Indexing only some rows, e.g. `where status = 'queued'` |
| Expression | Indexing a computed value, e.g. `(lower(email))` |
| GIN | Values that contain many items: `jsonb`, arrays, `tsvector` (lesson 12) |

Indexes are not free:

- Every insert, update and delete must also update every index on the table. Ten indexes make writes much slower.
- They take disk and memory. An index that doesn't fit in memory is slower to use.
- The planner ignores an index when a query matches a large share of the table; reading the table in order is cheaper than jumping around. An index on a boolean column is usually useless.
- Wrapping the column in a function hides it: `where lower(email) = $1` can't use an index on `email`. It needs an index on `lower(email)`.

Index what your queries filter, join and sort on. Then check, don't guess.

### Reading EXPLAIN ANALYZE

`explain` shows the plan the query planner chose. `explain analyze` also runs the query and reports what actually happened:

```
Index Scan using bookmarks_user_created_idx on bookmarks  (cost=0.42..8.45 rows=20 width=96)
                                       (actual time=0.031..0.058 rows=20 loops=1)
  Index Cond: (user_id = 42)
  Buffers: shared hit=4
Planning Time: 0.120 ms
Execution Time: 0.081 ms
```

What to look for:

- **Scan type.** `Seq Scan` on a big table with a selective filter means a missing index. `Index Scan` and `Index Only Scan` are what you want for small result sets. `Bitmap Heap Scan` is a middle ground for medium ones.
- **Estimated vs actual rows.** `rows=20` estimated and `rows=180000` actual means stale statistics. Run `analyze tablename`.
- **Buffers.** Pages read from memory (`hit`) or disk (`read`). Postgres 18 shows these automatically with `analyze`; on older versions add `buffers`: `explain (analyze, buffers)`.
- **Time.** Where the time goes, node by node.

`explain analyze` really runs the statement. Wrap an `update` or `delete` in `begin; ... rollback;` when you analyze it.

### Transactions and ACID

Creating a bookmark with tags is three writes: the bookmark, any new tags, the links between them. If the server crashes after the first, you have a bookmark whose tags vanished. A **transaction** groups statements so they succeed or fail as one unit:

```sql
begin;
insert into bookmarks ...;
insert into tags ... on conflict ...;
insert into bookmark_tags ...;
commit;      -- or rollback; to undo all of it
```

ACID names the guarantees:

- **Atomicity**: all of the transaction happens, or none of it.
- **Consistency**: constraints hold before and after. A transaction that would break one fails.
- **Isolation**: concurrent transactions don't see each other's half-done work.
- **Durability**: once `commit` returns, the data survives a crash. Postgres writes changes to the write-ahead log (WAL) and flushes it to disk before confirming.

Postgres runs every statement in a transaction. Without `begin`, each statement is its own (autocommit).

### Isolation levels

Full isolation, where transactions behave as if they ran one after another, costs throughput. SQL defines levels that trade safety for concurrency. Postgres uses **MVCC** (multi-version concurrency control): each transaction reads a snapshot, so readers never block writers and writers never block readers. Two writers to the *same row* still wait for each other.

| Level | Snapshot taken | Prevents | Can still happen |
|---|---|---|---|
| Read committed (default) | At the start of each statement | Dirty reads | Non-repeatable reads, lost updates in read-then-write code |
| Repeatable read | At the first statement of the transaction | Also non-repeatable reads and phantoms | Write skew. Conflicting updates fail with error `40001` |
| Serializable | Same, plus conflict tracking | All anomalies: the result matches some serial order | Transactions fail with `40001` and must be retried |

Postgres accepts `read uncommitted` but treats it as read committed; it never shows uncommitted data.

The practical rule: in read committed, don't read a value into JavaScript, change it and write it back. Two requests will both read 10 and both write 11. Do the change in one statement (`set count = count + 1`), lock the row first (`select ... for update`), or use a constraint. If you choose `serializable`, write a retry loop for error `40001`. Lesson 19 comes back to races.

### Connection pooling

Opening a Postgres connection is expensive: a TCP (and usually TLS) handshake, authentication, and a new server **process** on the Postgres side, each using several megabytes of memory. Postgres allows `max_connections = 100` by default. One connection per HTTP request would be slow and would run out under load.

A **pool** opens a few connections and lends them out. A request borrows one, runs its queries and gives it back:

```js
import { Pool } from "pg";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                        // the default; size it to the database, not the traffic
  connectionTimeoutMillis: 5_000, // default 0 waits forever for a free client
});
```

`pool.query()` borrows and returns a connection for one statement. A transaction must run on **one** connection, so check a client out explicitly and always release it:

```js
const client = await pool.connect();
try {
  await client.query("begin");
  // ... queries on client, not pool
  await client.query("commit");
} catch (err) {
  await client.query("rollback");
  throw err;
} finally {
  client.release();
}
```

Forget `release()` and the pool drains: after `max` leaks, every request waits forever. Pool sizes multiply: 3 app instances × 10 connections plus 2 workers × 10 is already 50 of your 100. More connections is not more speed; a database with a few dozen busy connections usually beats one with hundreds. When you have many instances, put PgBouncer (a pooling proxy) in front of Postgres. Lesson 18 sizes the pool by measurement.

## Try it

Start Postgres 18 in Docker and open a SQL shell. Version 18 is the current stable release; in November 2026 Postgres 19 was still a release candidate, and nothing in this lesson depends on it.

```bash
docker run --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:18
docker exec -it pg psql -U postgres
```

Make a table with a million rows (takes a few seconds):

```sql
create table events (
  id bigint generated always as identity primary key,
  user_id int not null,
  kind text not null,
  created_at timestamptz not null
);

insert into events (user_id, kind, created_at)
select floor(random() * 10000)::int,
       (array['view', 'click', 'buy'])[floor(random() * 3)::int + 1],
       now() - random() * interval '365 days'
from generate_series(1, 1000000);

analyze events;
\timing on
```

Watch an index change the plan:

```sql
explain analyze select * from events where user_id = 42;   -- Seq Scan, tens of ms
create index events_user_id_idx on events (user_id);
explain analyze select * from events where user_id = 42;   -- Bitmap/Index Scan, well under 1 ms
explain analyze select * from events where kind = 'view';  -- a third of the table: still a Seq Scan
```

Then a composite index for "one user's latest events":

```sql
explain analyze select * from events where user_id = 42 order by created_at desc limit 10;
create index events_user_created_idx on events (user_id, created_at desc);
explain analyze select * from events where user_id = 42 order by created_at desc limit 10;
```

The second plan has no `Sort` node: the index already returns rows in order.

Now see row locks. Open a second terminal with another `docker exec -it pg psql -U postgres`:

```sql
-- terminal 1
create table counters (id int primary key, n int not null);
insert into counters values (1, 0);
begin;
update counters set n = n + 1 where id = 1;

-- terminal 2: this waits
update counters set n = n + 1 where id = 1;

-- terminal 1
commit;     -- terminal 2 finishes now; select n shows 2
```

Break it on purpose:

1. In terminal 1 run `begin; select n from counters where id = 1;`, then in terminal 2 `update counters set n = 100 where id = 1;`. Run the `select` again in terminal 1. Now repeat with `begin isolation level repeatable read;`. Explain the difference.
2. Insert the same `id` into `counters` twice. Read the error code. Which HTTP status would you send?
3. Run `explain analyze select * from events where user_id + 0 = 42;`. Why does the index stop being used?
4. In a transaction, `drop table events;`, then `rollback;`. Is the table still there?

## Common mistakes

- **Read, modify, write in application code.** Two requests read the same value and one update is lost. Use one atomic statement, `select ... for update`, or a unique constraint plus `on conflict`.
- **No index on foreign keys and filter columns.** Listing a user's bookmarks becomes a full table scan once the table grows. Index `user_id` (and the sort columns with it), and check with `explain analyze`.
- **`pool.query` for a transaction.** Each call may land on a different connection, so `begin` and `commit` run in different sessions. Use `pool.connect()` and release the client in `finally`.
- **String-built SQL.** One quote in a title becomes an injection. Use `$1` placeholders and an allowlist for identifiers.
- **Editing old migrations, or making breaking ones.** Production never sees the edit; a dropped column breaks the old code still running mid-deploy. Add new migrations and change the schema in compatible steps.
- **N+1 queries.** Loading 50 bookmarks, then the tags of each one in its own query, is 51 round trips. Load them in one query with a join or `where bookmark_id = any($1)` (lesson 18).

## Build: Linkbox, step 9

Replace the in-memory repositories from lesson 07 with Postgres. Services and routes should not change; that is the point of the repository layer.

1. Run Postgres with the `docker run` above (create a `linkbox` database with `create database linkbox;`) and `npm install pg`. Read the connection string from `DATABASE_URL`, for example `postgres://postgres:pg@localhost:5432/linkbox`.
2. Write `migrations/001_init.sql`:

   ```sql
   create table users (
     id bigint generated always as identity primary key,
     email text not null,
     password_hash text not null,
     created_at timestamptz not null default now()
   );
   create unique index users_email_key on users (lower(email));

   create table sessions (
     id text primary key,                       -- the random token from lesson 05
     user_id bigint not null references users (id) on delete cascade,
     expires_at timestamptz not null,
     created_at timestamptz not null default now()
   );
   create index sessions_user_id_idx on sessions (user_id);
   create index sessions_expires_at_idx on sessions (expires_at);

   create table bookmarks (
     id bigint generated always as identity primary key,
     user_id bigint not null references users (id) on delete cascade,
     url text not null check (url ~ '^https?://'),
     title text not null check (length(title) between 1 and 200),
     notes text not null default '',
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     unique (user_id, url)
   );
   create index bookmarks_user_created_idx on bookmarks (user_id, created_at desc, id desc);

   create table tags (
     id bigint generated always as identity primary key,
     user_id bigint not null references users (id) on delete cascade,
     name text not null check (name = lower(btrim(name)) and length(name) between 1 and 40),
     unique (user_id, name)
   );

   create table bookmark_tags (
     bookmark_id bigint not null references bookmarks (id) on delete cascade,
     tag_id bigint not null references tags (id) on delete cascade,
     primary key (bookmark_id, tag_id)
   );
   create index bookmark_tags_tag_id_idx on bookmark_tags (tag_id);
   ```

3. Write `scripts/migrate.js`, run it with `node scripts/migrate.js`, and add it as `npm run migrate`:

   ```js
   import { readdir, readFile } from "node:fs/promises";
   import pg from "pg";

   const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
   await client.connect();
   await client.query(`create table if not exists schema_migrations (
     name text primary key, applied_at timestamptz not null default now())`);
   await client.query("select pg_advisory_lock(7231)"); // one migrator at a time

   const { rows } = await client.query("select name from schema_migrations");
   const done = new Set(rows.map((r) => r.name));
   const files = (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort();

   for (const file of files) {
     if (done.has(file)) continue;
     const sql = await readFile(`migrations/${file}`, "utf8");
     try {
       await client.query("begin");
       await client.query(sql);
       await client.query("insert into schema_migrations (name) values ($1)", [file]);
       await client.query("commit");
       console.log("applied", file);
     } catch (err) {
       await client.query("rollback");
       throw err;
     }
   }
   await client.end();
   ```

4. Create `db.js` exporting one `Pool`, and rewrite each repository with plain parameterized SQL. Every bookmark query includes `user_id = $n`, so the owner check from lesson 05 lives in the query itself.
5. Create a bookmark and its tags in one transaction. Insert the bookmark with `returning *`, then upsert the tags and link them in one statement:

   ```sql
   with t as (
     insert into tags (user_id, name)
     select $1, name from (select distinct unnest($2::text[]) as name) s
     on conflict (user_id, name) do update set name = excluded.name  -- so existing tags return their id
     returning id
   )
   insert into bookmark_tags (bookmark_id, tag_id) select $3, id from t;
   ```

6. Map Postgres errors in the repository: `23505` on `(user_id, url)` becomes a 409 problem response (lesson 08), and convert `bigint` ids to numbers or keep them as strings consistently in your JSON.
7. Implement list with the keyset query above and run `explain analyze` on it with a few thousand seeded bookmarks.

**Done when** you can restart the server and every user, session and bookmark is still there; saving the same URL twice returns 409; and `explain analyze` on the list query shows an index scan, not a sequential scan.

## Check yourself

<details markdown="1">
<summary>Why not store the data in a JSON file the server reads and rewrites?</summary>

Concurrent writes lose updates, a crash mid-write corrupts the file, every lookup reads the whole file, nothing enforces rules on the data, and several servers can't share it safely. A DBMS solves all of these with transactions, a write-ahead log, indexes, constraints and a single shared server.
</details>

<details markdown="1">
<summary>Bookmarks and tags are many-to-many. How do you model that, and what stops the same tag being attached twice?</summary>

A join table, `bookmark_tags(bookmark_id, tag_id)`, with foreign keys to both tables. Its primary key is the pair `(bookmark_id, tag_id)`, so a duplicate pair violates the key.
</details>

<details markdown="1">
<summary>You add an index on <code>status</code>, but <code>where status = 'active'</code> still does a sequential scan. Why might the planner be right?</summary>

If most rows are `active`, the query returns a large share of the table. Reading the table in one sequential pass is cheaper than jumping between the index and the table for each row. Indexes pay off for selective filters. A partial index on the rare value may help instead.
</details>

<details markdown="1">
<summary>Why must a transaction use <code>pool.connect()</code> rather than <code>pool.query()</code>?</summary>

A transaction belongs to one database session. `pool.query()` may run each statement on a different pooled connection, so `begin`, the writes and `commit` would end up in different sessions. Check out one client, run everything on it, and release it in `finally`.
</details>

<details markdown="1">
<summary>Two requests each run <code>select stock</code>, subtract 1 in JavaScript and write the result back. Stock was 5. What can happen, and how do you fix it?</summary>

Both read 5 and both write 4: one sale is lost. Under read committed nothing prevents it. Use one statement (`update ... set stock = stock - 1 where id = $1 and stock > 0 returning stock`), lock the row with `select ... for update` inside a transaction, or use serializable isolation with retries.
</details>

<details markdown="1">
<summary>What does <code>on conflict (user_id, url) do update ... returning id</code> do that "select, then insert if missing" does not?</summary>

It is one atomic statement backed by the unique constraint, so two concurrent requests can't both decide the row is missing and insert duplicates. It also returns the row's id whether it was inserted or updated.
</details>

## Go deeper

- [PostgreSQL tutorial](https://www.postgresql.org/docs/current/tutorial.html): the official introduction to tables, joins, aggregates and transactions, short and accurate.
- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html): exactly what each isolation level guarantees in Postgres, with examples of each anomaly.
- [Use The Index, Luke](https://use-the-index-luke.com/): a free book on how B-tree indexes work and how to write SQL that uses them.
- [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html): how to read every part of a query plan.
- [Don't Do This (PostgreSQL wiki)](https://wiki.postgresql.org/wiki/Don%27t_Do_This): types and habits to avoid, such as `timestamp` without time zone, `money` and `varchar(n)` by default.
- [node-postgres: Transactions](https://node-postgres.com/features/transactions): the checkout, `begin`, `commit`, `release` pattern from the `pg` maintainers.
