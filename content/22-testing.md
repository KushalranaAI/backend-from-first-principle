---
title: Testing
part: Engineering practice
summary: What a test really proves, how to test code that touches databases, networks and clocks, and how to tell whether your tests are any good.
---

A backend with no tests works until someone changes it. Then every change is a gamble: you deploy, you watch the error rate, and you hope. Tests turn "I think this still works" into a command that answers in seconds. This lesson is about writing tests that catch real bugs, run fast, never lie, and make code easier to change rather than harder.

## The first principle

Strip testing down and a test is three things:

1. **Arrange**: put the system in a known state.
2. **Act**: do one thing to it.
3. **Assert**: check that what happened is what should have happened.

That's it. A test is a small program that runs your code with a known input and fails loudly if the output is wrong. Everything else (frameworks, mocks, containers, coverage) exists to make those three steps possible when your code talks to databases, networks and clocks, or to tell you whether your tests are checking enough.

Why bother, when you could just run the app and click around? Because manual checking doesn't scale with change. Linkbox has validation rules, ownership checks, pagination, caching, queues and webhooks. A change to one can break another you didn't think about. Tests are the record of everything you once checked by hand, re-run on every change for free. The real payoff isn't catching bugs today. It's being able to refactor next year without fear.

> A test that has never failed has never proved anything. Always see it fail first.

## Core ideas

### What a test actually is

Node ships a test runner. No install, no config:

```js
// test/tags.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTags } from "../src/validate.js";

test("tags are trimmed, lowercased and deduplicated", () => {
  const result = normalizeTags([" Go", "go ", "", "HTTP"]);   // arrange + act
  assert.deepEqual(result, ["go", "http"]);                   // assert
});
```

```bash
node --test          # finds **/*.test.js, test/**/*.js and friends, runs each file in its own process
```

`node:assert/strict` makes `equal` mean `===` and `deepEqual` compare deeply and strictly. A test passes if its function returns (or its promise resolves) without throwing. `describe` and `it` are there if you like grouping, plus `before`, `after`, `beforeEach` and `afterEach` hooks.

Good tests share a few traits: each checks **one behaviour**, its name says which, it doesn't depend on other tests or on the order they run in, and when it fails the message tells you what broke without opening a debugger.

### The first test, red then green

Write the test, run it, and **watch it fail** (red). Then make it pass (green). The red step is not ceremony. It proves the test can fail: that it runs, that it tests the code you think, and that the assertion is checking something. A test you've only ever seen pass might be asserting on the wrong variable, never awaited, or skipped by a typo in its file name.

```
✖ rejects a title of 201 characters
  AssertionError: Expected values to be strictly equal:
  true !== false
```

When you fix a bug, do the same: first write a test that reproduces the bug and fails, then fix the code. The bug can never quietly come back.

### Unit, integration, end to end

Tests differ by how much real machinery they run:

| Kind | What runs for real | Example in Linkbox | Speed |
|---|---|---|---|
| **Unit** | one function or module, no I/O | `validateBookmark` rejects `javascript:` URLs | microseconds |
| **Integration** | your code plus a real dependency | the bookmark repository against real Postgres | milliseconds to seconds |
| **End to end (API)** | the whole app, from HTTP request to database and back | `POST /api/v1/bookmarks` returns 201 and a `Location` | tens to hundreds of ms |

Unit tests are fast and pinpoint failures, but they can't see the bugs that live *between* parts: a wrong SQL query, a missing index name, a JSON field spelled differently in two places. End-to-end tests see everything but are slower and tell you less about where things broke. You need both.

### The test pyramid and test sizes

The classic advice is the **test pyramid**: many unit tests at the bottom, fewer integration tests, a handful of end-to-end tests on top. Each layer up is slower and more brittle, so you push each check down to the lowest layer that can make it.

```
        /\        few:   end to end (whole system, real HTTP)
       /  \
      /----\      some:  integration (real Postgres, Redis)
     /      \
    /--------\    many:  unit (pure functions, no I/O)
```

For backends the shape often bulges in the middle. Much of a typical API's logic *is* SQL and wiring, so integration tests against a real database catch the bugs that matter, and with containers they are fast enough to run often.

Google sidesteps the naming debate with **test sizes**, defined by what a test may use rather than what it covers:

| Size | May use | Typical time limit |
|---|---|---|
| Small | one process, no network, no disk, no sleep | 60 s |
| Medium | one machine: localhost network, a database in a container | 300 s |
| Large | many machines, real external services | 900 s |

The useful idea is that the constraints are enforced. A "small" test that opens a socket is a bug in the test.

### Test doubles: dummy, stub, spy, mock, fake

Your service calls a repository, a queue, a clock and a logger. To test the service alone, you hand it stand-ins: **test doubles** (the name comes from stunt doubles). There are five kinds, from Gerard Meszaros's book *xUnit Test Patterns*:

| Double | What it does | Linkbox example |
|---|---|---|
| **Dummy** | is passed in but never used | a `logger` with empty methods |
| **Stub** | returns canned answers | a `clock` whose `now()` always returns 1 Jan 2026 |
| **Spy** | records how it was called, so you assert afterwards | a `queue.add` that remembers its arguments |
| **Mock** | is told in advance which calls to expect and fails if they don't happen | "expect `queue.add('enrich', …)` exactly once" |
| **Fake** | a real working implementation, but simplified | an in-memory bookmark repository |

The service under test takes its collaborators as arguments:

```js
// src/bookmarks.service.js
export function createBookmarkService({ repo, queue, clock, logger }) {
  return {
    async create(userId, input) {
      const bookmark = await repo.insert({ ...input, userId, createdAt: clock.now() });
      await queue.add("enrich", { bookmarkId: bookmark.id });
      logger.info({ bookmarkId: bookmark.id }, "bookmark created");
      return bookmark;
    },
  };
}
```

And the test uses four of the five:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBookmarkService } from "../src/bookmarks.service.js";

function fakeRepo() {                                                 // fake
  const rows = [];
  return {
    rows,
    async insert(row) { const saved = { id: `b_${rows.length + 1}`, ...row }; rows.push(saved); return saved; },
  };
}

test("create saves the bookmark and enqueues enrichment", async (t) => {
  const repo = fakeRepo();
  const queue = { add: t.mock.fn(async () => {}) };                  // spy
  const clock = { now: () => new Date("2026-01-01T00:00:00Z") };      // stub
  const logger = { info() {} };                                       // dummy
  const service = createBookmarkService({ repo, queue, clock, logger });

  const bookmark = await service.create("u_1", { url: "https://example.com", title: "Example" });

  assert.equal(repo.rows.length, 1);
  assert.deepEqual(bookmark.createdAt, new Date("2026-01-01T00:00:00Z"));
  assert.equal(queue.add.mock.callCount(), 1);
  assert.deepEqual(queue.add.mock.calls[0].arguments, ["enrich", { bookmarkId: "b_1" }]);
});
```

`t.mock.fn()` creates a function that records every call in `.mock.calls`, and `t.mock.method(obj, "name")` wraps an existing method the same way. Both are restored automatically when the test ends. `node:test` has no expectation-first mocks; you get the same effect by asserting on a spy's calls afterwards.

Prefer, in order: real objects when they're fast, then **fakes**, then stubs and spies. Heavy use of mocks couples tests to *how* the code works ("called `insert` then `add`") rather than *what* it achieves, so every refactor breaks tests even when behaviour is unchanged. Use interaction checks for things that *are* the behaviour: an email sent, a job enqueued, a webhook fired.

### Dependency injection and the functional core

The service above is testable because it doesn't reach out for its collaborators; it **receives them**. That is **dependency injection**, and it needs no framework: a function that takes its dependencies as parameters. Production wiring passes the real Postgres repository and BullMQ queue; tests pass doubles. Code that does `import { pool } from "../db.js"` and calls it deep inside can only be tested by monkey-patching modules.

Go further and you reach **functional core, imperative shell** (Gary Bernhardt's phrase). Put decisions in pure functions that take plain data and return plain data. Keep the I/O in a thin outer layer that gathers inputs, calls the core and acts on the result:

```js
// core: pure, trivially unit-tested, no doubles needed
export function sessionsToDelete(sessions, now) {
  return sessions.filter((s) => s.expiresAt <= now).map((s) => s.id);
}

// shell: I/O only, covered by one integration test
export async function cleanupSessions(db, now = new Date()) {
  const { rows } = await db.query("SELECT id, expires_at AS \"expiresAt\" FROM sessions");
  const ids = sessionsToDelete(rows, now);
  if (ids.length) await db.query("DELETE FROM sessions WHERE id = ANY($1)", [ids]);
}
```

(In production you'd do this in one `DELETE ... WHERE expires_at <= now()`. The point is the shape.) The more logic lives in the core, the fewer doubles you need.

### Testing the database with Testcontainers

Mocking the database tests your mock, not your SQL. A typo in a column name, a missing `ORDER BY`, a constraint that rejects valid data, a migration that doesn't run: only a real Postgres finds those. An in-memory substitute such as SQLite speaks a different dialect, so it misses the same bugs.

**Testcontainers** starts a real database in Docker from your test, on a random free port, and removes it when the tests finish (a small "Ryuk" sidecar container cleans up even if the test process crashes):

```js
// test/integration/bookmarks.repo.test.js
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { migrate } from "../../src/db/migrate.js";
import { createBookmarkRepo } from "../../src/bookmarks/bookmarks.repository.js";

let container, pool, repo;

before(async () => {
  container = await new PostgreSqlContainer("postgres:18-alpine").start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  await migrate(pool);                         // the same migrations as production
  repo = createBookmarkRepo(pool);
});

after(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => pool.query("TRUNCATE users, bookmarks RESTART IDENTITY CASCADE"));

test("a user only lists their own bookmarks", async () => {
  // insert two users and a bookmark each with repo/SQL, then:
  // const page = await repo.listByUser(alice.id, { limit: 20 });
  // assert.deepEqual(page.items.map((b) => b.userId), [alice.id]);
});
```

Start the container once per test file, not once per test (startup takes a few seconds; the first run also pulls the image). Isolate tests from each other by truncating tables in `beforeEach`, or by running each test inside a transaction you roll back. Pin the same Postgres major version you run in production.

### Network and time in tests

Two things make tests slow and flaky: other people's servers and the clock.

**The network.** A test that calls the real `https://example.com` fails when the site is down, when CI has no internet, or when the page changes. Replace the remote side with something you control:

- **A local server on port 0.** `node:http` on port 0 gets a free port from the OS. No library, and the code under test makes a real HTTP request:

  ```js
  import http from "node:http";

  let server, base;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") return res.end("<title> Hello </title>");
      if (req.url === "/slow") return setTimeout(() => res.end("late"), 1000);
      res.writeHead(500).end();
    });
    await new Promise((resolve) => server.listen(0, resolve));
    base = `http://localhost:${server.address().port}`;
  });
  after(() => server.close());

  test("gives up on a slow server", async () => {
    await assert.rejects(fetchTitle(`${base}/slow`, { timeoutMs: 50 }), { name: "TimeoutError" });
  });
  ```

- **Request interception.** MSW (`msw/node`) and nock (version 14 and later) intercept `fetch` and `node:http` in-process, so the code can keep calling `https://example.com` and you decide the answer. Set MSW's `onUnhandledFrame: "error"` so a forgotten real request fails the test instead of leaking to the internet. (MSW 3, released in September 2026, renamed this option from `onUnhandledRequest`. MSW 3 is ESM-only and needs Node 22 or newer.)

Test the unhappy paths too, because that's where production breaks: 500s, timeouts, slow bodies, malformed HTML, redirects to internal addresses (lesson 17).

**Time.** Code that reads `Date.now()` or waits on `setTimeout` is hard to test: you can't wait 30 days for a session to expire. Two fixes. The better one is to **pass time in**, as `sessionsToDelete(sessions, now)` does. When you can't, **fake the clock**:

```js
test("debounce calls once after the quiet period", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fn = t.mock.fn();
  const save = debounce(fn, 500);
  save(1); save(2); save(3);
  t.mock.timers.tick(499);
  assert.equal(fn.mock.callCount(), 0);
  t.mock.timers.tick(1);
  assert.deepEqual(fn.mock.calls[0].arguments, [3]);
});
```

`t.mock.timers` can fake `setTimeout`, `setInterval`, `setImmediate` and `Date` (pass `now` to set the start time), and `tick(ms)` moves time forward instantly. A 30-day expiry test runs in a millisecond.

### TDD: red, green, refactor

**Test-driven development** turns red-then-green into the way you write code:

1. **Red**: write the smallest test for the next bit of behaviour. Run it; watch it fail.
2. **Green**: write the simplest code that passes. Hard-coding is allowed.
3. **Refactor**: clean up code and tests while everything stays green.

Repeat, in steps of minutes. Building `parseLimit` for the list endpoint (lesson 08) goes like this:

```js
test("defaults to 20", () => assert.equal(parseLimit(undefined), 20));            // red → `return 20`
test("uses the given value", () => assert.equal(parseLimit("50"), 50));           // red → Number(value)
test("caps at 100", () => assert.equal(parseLimit("500"), 100));                  // red → Math.min
test("rejects junk", () => assert.throws(() => parseLimit("abc"), /limit/));      // red → validation
test("rejects zero", () => assert.throws(() => parseLimit("0"), /limit/));        // red → lower bound
```

```js
export function parseLimit(value, { fallback = 20, max = 100 } = {}) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new RangeError("limit must be a positive integer");
  return Math.min(n, max);
}
```

What TDD buys you: every line exists because a test demanded it, the design is shaped by being called (which pushes you toward small functions with injected dependencies), and you never write a test that can't fail. It works best for logic with clear inputs and outputs. For exploratory work, where you don't know the shape yet, spike first, then rebuild it test-first or add tests before merging.

### Flaky tests and their causes

A **flaky test** passes and fails on the same code. It's worse than no test: people learn to press "re-run", and then they ignore the real failure too. Common causes:

| Cause | Symptom | Fix |
|---|---|---|
| Shared state between tests | passes alone, fails in the suite (or only in a certain order) | fresh state per test: truncate tables, new objects, no module-level variables |
| Real time | fails at midnight, at month end, in another time zone, around DST | inject the clock or fake it; use UTC |
| Sleeping instead of waiting | `await sleep(100)` then assert; fails on a slow CI machine | wait for the actual event or poll a condition with a deadline; fake timers |
| Real network | fails when a third-party site is slow or down | local server or interception |
| Unordered results | asserts on the order of rows from a query without `ORDER BY` | add `ORDER BY`, or compare as sets |
| Randomness | fails once in 200 runs | seed it, or log the seed so failures can be reproduced |
| Parallel tests sharing a database or port | collisions under `--test-concurrency` | one schema or database per worker; port 0 |
| Leaks | a later test times out because an earlier one left a server or timer running | close everything in `after` |

Treat a flaky test as a bug with a deadline: fix it, or quarantine it (skip with a tracking issue) so the suite stays trustworthy. Never let "just re-run it" become the process.

### Code coverage, what it can and cannot say

Coverage measures which lines, branches and functions ran during the tests:

```bash
node --test --experimental-test-coverage
node --test --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=70   # Node 22.8+: fail below these
```

```
file          | line % | branch % | funcs % | uncovered lines
validate.js   |  88.24 |    90.00 |  100.00 | 11-12
```

Coverage is good at one thing: showing code **no test touches**. Lines 11 and 12 above are the "invalid URL" branch, and nothing exercises it. That is a real gap.

What coverage cannot tell you is whether the code that ran was **checked**. A test that calls a function and asserts nothing gives 100% coverage and proves nothing. And making coverage a target invites exactly those tests. Use it as a flashlight for gaps, set a modest floor in CI so it doesn't silently drop, and don't chase 100%.

### Mutation testing with Stryker

How do you test your tests? Break the code on purpose and see if they notice. That is **mutation testing**. A tool makes small changes (**mutants**) to your source: `>` becomes `>=`, `&&` becomes `||`, a string becomes `""`, a block is emptied. It runs your tests against each one. If a test fails, the mutant is **killed** (good). If every test still passes, the mutant **survived**: your tests didn't check that behaviour. The **mutation score** is killed mutants as a percentage of the total.

StrykerJS does this for JavaScript. With `node:test` it uses its generic command runner:

```json
{
  "testRunner": "command",
  "commandRunner": { "command": "node --test" },
  "mutate": ["src/validate.js"],
  "reporters": ["clear-text", "progress"]
}
```

```bash
npm install -D @stryker-mutator/core
npx stryker run          # reads stryker.config.json
```

On the `validate.js` from this lesson, with the four tests from *Try it* at 88% line coverage, StrykerJS 10 makes 37 mutants and kills 27 of them: a mutation score of about 73%. Your numbers will differ a little with how you write the tests. Among the survivors:

```
[Survived] ObjectLiteral
-     return { ok: true, value: { url: url.href, title, tags: normalizeTags(input.tags ?? []) } };
+     return { ok: true, value: {} };
```

The tests check `result.ok` but never look at `result.value`. The function could return nothing useful and every test would pass. Coverage said this line was tested; mutation testing shows it wasn't. Mutation testing is slow (the suite runs once per mutant), so point it at your most important modules (validation, auth checks, money, permissions) rather than the whole codebase on every commit.

### Cyclomatic and cognitive complexity

Some code is hard to test because it's hard to understand. Two numbers measure that.

**Cyclomatic complexity** (Thomas McCabe, 1976) counts the independent paths through a function: one, plus one for each decision (`if`, loop, `case`, `catch`, `&&`, `||`, `??`, ternary). It is also the minimum number of tests needed to take every branch.

**Cognitive complexity** (SonarSource, 2017) tries to measure how hard code is for a *person* to follow. It adds one for each break in linear flow and adds more the deeper that break is nested, because nested logic is what makes code hard to hold in your head.

```js
export function shippingCost(order) {
  if (order.items.length === 0) return 0;      // cyclomatic +1   cognitive +1
  if (order.country === "IN") {                // cyclomatic +1   cognitive +1
    return order.total > 500 ? 0 : 40;         // cyclomatic +1   cognitive +2 (nested)
  }
  for (const item of order.items) {            // cyclomatic +1   cognitive +1
    if (item.fragile) return 200;              // cyclomatic +1   cognitive +2 (nested)
  }
  return 100;
}                                              // cyclomatic 6    cognitive 7
```

ESLint has a built-in `complexity` rule (default limit 20) and `eslint-plugin-sonarjs` adds `cognitive-complexity` (default 15). Use them as warnings that start a conversation. The fixes are usually early returns, extracting a well-named function, or replacing a chain of conditions with a lookup table.

### Linters, formatters and type checkers

Tests check behaviour. Three other tools catch whole classes of mistakes before a test even runs, and they're cheaper than tests:

| Tool | Catches | Examples |
|---|---|---|
| **Linter** | suspicious code: unused variables, unhandled promises, `==` where you meant `===`, shadowed names, complexity | ESLint |
| **Formatter** | nothing, on purpose: it rewrites layout so style is never discussed in review | Prettier, Biome |
| **Type checker** | calling things with the wrong shape: `undefined` passed where a string is required, a misspelled property | TypeScript (`tsc --noEmit`), also on plain JS with `// @ts-check` and JSDoc |

Run all three in your editor and in CI (lesson 26), and let the formatter run on save so nobody thinks about it. If you want types without a build step, Node 22.18+ runs `.ts` files directly by stripping the type annotations (stable since Node 24.12); `tsc --noEmit` still does the checking.

## Try it

Make a folder with `src/` and `test/`, and set it up: `npm init -y && npm pkg set type=module scripts.test="node --test"`.

1. Save this as `src/validate.js`, then write four tests in `test/validate.test.js`: tag normalization, `javascript:` rejected, 200-character title accepted, 201 rejected. Run `npm test`.

   ```js
   export const normalizeTags = (tags) =>
     [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

   export function validateBookmark(input) {
     const errors = {};
     let url;
     try {
       url = new URL(input.url);
       if (url.protocol !== "http:" && url.protocol !== "https:") errors.url = "must be http or https";
     } catch {
       errors.url = "must be a valid URL";
     }
     const title = (input.title ?? "").trim();
     if (title.length > 200) errors.title = "must be at most 200 characters";
     if (Object.keys(errors).length) return { ok: false, errors };
     return { ok: true, value: { url: url.href, title, tags: normalizeTags(input.tags ?? []) } };
   }
   ```

2. Save the bookmark service and its test from *Test doubles*. Add a second test where `queue.add` throws, and assert with `assert.rejects` that `create` fails.
3. Save the local-server test from *Network and time*, with this `src/fetch-title.js`:

   ```js
   export async function fetchTitle(url, { timeoutMs = 5000 } = {}) {
     const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
     if (!res.ok) throw new Error(`HTTP ${res.status}`);
     const html = await res.text();
     return html.match(/<title>([^<]*)<\/title>/i)?.[1].trim() ?? null;
   }
   ```

   Add tests for the `/ok` and `/boom` (500) routes too.
4. Run `node --test --experimental-test-coverage`. Find the uncovered lines and write the test that covers them.
5. Add the Stryker config above and run `npx stryker run`. Kill at least three survivors by strengthening assertions, not by adding tests that only raise coverage.

Break it on purpose:

1. Change `> 200` to `>= 200` in `validateBookmark`. Which test fails? If none does, your boundary tests are missing.
2. Delete the `await` before `assert.rejects` in the slow-server test. Does the test still "pass"? Why is that dangerous?
3. Move `const rows = []` out of `fakeRepo()` to the top of the test file, then copy the first service test and rename the copy "create works again". Run the file: the copy fails, though it is identical. Run it alone with `node --test --test-name-pattern="again"` and it passes. Same code, different results: shared state.
4. Replace the fake clock in the debounce test with a real `await new Promise((r) => setTimeout(r, 500))`. It still passes, but now takes half a second, and on a slow machine the timing is no longer guaranteed.

## Common mistakes

- **Mocking the database.** The mock agrees with whatever SQL you wrote, including the wrong SQL. Test repositories against real Postgres with Testcontainers.
- **Asserting on implementation, not behaviour.** Tests that check "called `insert` with these exact arguments, then `add`" break on every refactor. Assert on results and on interactions that *are* the behaviour.
- **Tests that share state.** Module-level data, un-truncated tables and leftover servers make tests pass alone and fail together. Give each test a fresh world.
- **`sleep()` in tests.** Fixed waits are slow when generous and flaky when tight. Inject the clock, fake timers, or wait for the real event.
- **Chasing a coverage number.** 100% coverage with weak assertions catches nothing. Use coverage to find gaps and mutation testing to judge strength.
- **Only testing the happy path.** Most production incidents are timeouts, 500s, empty lists, duplicates and permission checks. Write those tests first.

## Build: Linkbox, step 22

Give Linkbox a test suite you trust enough to refactor against.

1. Set `"test": "node --test"` and split the suite into `test/unit`, `test/integration` and `test/api`, with `test:unit` running only the first (fast, no Docker).
2. **Unit tests:** bookmark validation (every rule, at and just past each boundary), tag normalization, cursor encoding and decoding (lesson 08), mapping typed errors to problem+json (lesson 13), and the bookmark service with a fake repository, a spy queue and a stubbed clock.
3. **Integration tests:** start Postgres with `@testcontainers/postgresql` once per file, run your real migrations, truncate between tests. Cover owner scoping, cursor pagination order and stability, the constraints from lesson 09, and full-text search ranking (lesson 12). If you test the cache or queues, start Redis the same way (`new GenericContainer("redis:8-alpine").withExposedPorts(6379)`).
4. **API tests:** build the Fastify app against the test containers and drive it with `app.inject()`, no port needed: sign up, log in and keep the cookie, create a bookmark (201 + `Location`), fetch it, try to fetch it as another user (404), send bad input (400 problem+json).
5. **Network and time:** inject the clock into session expiry and test it without waiting; test the metadata fetcher (lesson 11) against a local server for success, 500, timeout and a redirect to a private address (lesson 17).
6. Add coverage with a floor (`--test-coverage-lines=80`) and run Stryker once on the validation module, killing the survivors that matter.

**Done when** `npm test` passes on a fresh clone with only Docker running, and deleting the owner check from any bookmark route makes at least one API test fail.

## Check yourself

<details markdown="1">
<summary>Why should you watch a new test fail before making it pass?</summary>

To prove it can fail. A test you have only seen pass might not run, might not await its promise, or might assert on the wrong thing. Red first shows the test is wired to the behaviour you care about.
</details>

<details markdown="1">
<summary>What is the difference between a stub, a spy and a fake? Give a Linkbox example of each.</summary>

A stub returns canned answers (a clock that always returns 1 Jan 2026). A spy records its calls so you can assert afterwards (a `queue.add` built with `t.mock.fn()`). A fake is a simplified working implementation (an in-memory bookmark repository).
</details>

<details markdown="1">
<summary>Why test repositories against a real Postgres instead of a mock or SQLite?</summary>

The bugs live in the SQL: wrong columns, missing `ORDER BY`, constraints, migrations, Postgres-specific features. A mock agrees with whatever you wrote, and SQLite is a different dialect. Testcontainers makes real Postgres cheap enough for every run.
</details>

<details markdown="1">
<summary>A test passes on your laptop and fails in CI one run in ten. Name three likely causes.</summary>

Shared state between tests that run in a different order or in parallel; real time (time zone, midnight, slow machine with a fixed `sleep`); real network calls; unordered query results; unseeded randomness. Any three of these.
</details>

<details markdown="1">
<summary>Your tests reach 95% line coverage, yet a mutation tool reports many survivors. What does that tell you?</summary>

The tests run the code but don't check its results closely enough. Coverage measures execution; surviving mutants show behaviours you could break without any test noticing. Strengthen the assertions.
</details>

<details markdown="1">
<summary>A function has cyclomatic complexity 12. What does that number tell you about testing it?</summary>

There are 12 independent paths through it, so at least 12 test cases are needed to take every branch. It's also a hint to split the function into smaller pieces that are easier to test and read.
</details>

## Go deeper

- [Node.js: Test runner](https://nodejs.org/api/test.html): `node:test` in full, including mocks, fake timers, coverage, snapshots and reporters.
- [Ham Vocke: The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html): a long, concrete guide to unit, integration and end-to-end tests and where each belongs.
- [Martin Fowler: Test Double](https://martinfowler.com/bliki/TestDouble.html): the five kinds of doubles, with a link to the longer *Mocks Aren't Stubs*.
- [Testcontainers for Node.js](https://node.testcontainers.org/): starting Postgres, Redis and any other container from your tests.
- [Martin Fowler: Eradicating Non-Determinism in Tests](https://martinfowler.com/articles/nonDeterminism.html): the classic causes of flaky tests and how to remove each.
- [StrykerJS documentation](https://stryker-mutator.io/docs/): mutation testing concepts, mutators and configuration.
