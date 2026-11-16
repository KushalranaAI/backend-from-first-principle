# Writing a lesson

A lesson has three files:

| File | What it holds |
|---|---|
| `content/NN-slug.md` | The lesson text (Markdown). |
| `src/extras/part1.ts` or `part2.ts`, entry `"NN"` | The everyday comparison, three real-world uses and the opening animation. |
| `src/extras/scenes/NN.ts` | The animations placed inside the lesson. |

`content/03-routing.md` and `src/extras/scenes/03.ts` are the reference pair: match their shape, tone and length.
The course is original writing from research. It has no videos and does not refer to any.

## Front matter

```
---
title: Routing                      (short; it is the page heading)
part: The request                   (must match the other lessons in the same part exactly)
summary: One sentence, shown under the title and in the course outline.
---
```

## Sections, in this order

1. **Opening paragraph** (no heading): 2–4 sentences. What this is and why a backend engineer can't avoid it.
2. `## The first principle`: start from the problem, not the tool. What breaks without this idea? Build the concept up
   from nothing. Name the tool only after the reader understands why it must exist.
3. `## Core ideas`: `###` subsections, one idea each. Tables for comparisons, small diagrams in plain-text code blocks,
   short code. This is the bulk of the lesson.
4. `## Try it`: hands-on experiments the reader runs in a terminal (curl, psql, redis-cli, node scripts, docker). Include
   a "break it on purpose" list.
5. `## Common mistakes`: 4–6 bullets, each a real production mistake and its fix.
6. `## Build: Linkbox, step N`: this lesson's milestone in the running project (see below). Numbered steps, ending
   with a bold **Done when** line.
7. `## Check yourself`: 4–6 questions as `<details markdown="1"><summary>question</summary>answer</details>`. Write
   the question as plain text (inline HTML like `<code>` is fine in the summary, Markdown is not).
8. `## Go deeper`: 3–6 links, each followed by a colon and what the reader gets from it. Prefer primary sources
   (RFCs, official docs, OWASP, the original author), then the best explainer. Every link must load; check it.

## Style

- Plain, direct English. Short sentences. Second person ("you"). No hype words ("powerful", "seamless", "robust",
  "crucial", "dive into", "leverage"), no emoji, no exclamation marks.
- Use real names for things, and say *why* before *how*.
- Code: Node.js 22+, ES modules, plain JavaScript. Standard library first (`node:http`, `node:crypto`, `node:test`).
  From lesson 07 on the project uses Fastify. Postgres through `pg` with plain SQL (no ORM). Redis through `ioredis`.
  Shell commands in `bash` blocks. Keep each code block short enough to read; explain anything non-obvious.
- Cross-reference other lessons as "(lesson 06)".
- Length: roughly 1,800–3,500 words. Big topics (security, databases, scaling) can go longer.
- Facts must be right and current. Check version numbers, defaults and recommendations against the primary source
  before writing them. If something changed recently, say what and since when.

## Animations: `src/extras/scenes/NN.ts`

Each lesson has 3 to 5 animations inside it, each placed at the end of the section it explains. They are data, not
code: the app has one player and two kinds of stage. Types are in `src/extras/types.ts`.

```ts
import type { Scene } from "../types";

export const scenes: Scene[] = [ /* 3 to 5 scenes */ ];
```

Every scene has `after`: the id of the `##` or `###` heading whose section it follows. The id is the heading text
lowercased, punctuation dropped, spaces as hyphens ("404 versus 405" → `404-versus-405`).

**`type: "flow"`: messages moving between actors.** Use it for anything that travels: a request path, a handshake,
a retry, a pipeline.

```ts
{
  type: "flow",
  after: "grouping-prefixes-and-versioning",
  title: "A group applies one rule to many routes",
  actors: ["Client", "/api/v1 group", "Auth check", "Handler"],   // 2 to 6, short names
  steps: [                                                        // 4 to 10
    // [from, to, label, note, kind?]   from === to means the actor works on its own
    [0, 1, "GET /api/v1/tags", "The prefix decides which group the request belongs to."],
    [2, 3, "listTags()", "The check passed, and the request reaches its handler.", "res"],
  ],
}
```

**`type: "boxes"`: named containers whose contents change.** Use it for anything that holds state: a queue, a cache,
a call stack, a connection pool, a token bucket, rows in a table, a sliding window.

```ts
{
  type: "boxes",
  after: "static-and-dynamic-routes",
  title: "Matching /bookmarks/42 against a pattern, segment by segment",
  boxes: ["Pattern", "Request path", "params"],                   // 2 to 4
  frames: [                                                       // 3 to 9
    {
      items: [["bookmarks", ":id"], ["bookmarks", "42"], []],     // one list per box, in box order
      hot: [":id", "42"],                                         // the items this frame is about
      label: ":id matches anything",                              // short; shown in monospace
      note: "A segment starting with a colon accepts any value and stores it under that name.",
      kind: "res",
    },
  ],
}
```

Rules that make an animation teach something:

- **One idea per animation.** If the title needs "and", make two.
- **Something must change in every step.** A step where nothing moves and nothing is highlighted is a slide, not an
  animation.
- **Show the failure too.** The best scenes show the naive version going wrong, then the fix (`kind: "err"`, then `"res"`).
- **The note explains why, in one sentence.** The label says what happened; the note says what it means.
- **Use the lesson's own example.** Linkbox, bookmarks, the same paths and names as the text beside it.
- `kind`: `"req"` (rust, the default) for a request or a neutral step, `"res"` (teal) for a response or success,
  `"err"` (red) for a failure or the wrong way.
- An item label that stays in the same box across frames stays put on screen; a new label animates in. So keep labels
  identical between frames when the thing is the same.

Limits (checked by `npm test`): labels up to 60 characters, box items up to 28 characters and 6 per box, actor names
unique, every `hot` item present in a box, every `after` a real heading id in the lesson.

## The comparison and opening animation: `src/extras/part1.ts`, `part2.ts`

Each lesson's entry has `analogy` (a title, a short story and a table mapping the story to the backend idea), `uses`
(three places the reader has already met the idea) and `flow` (the opening animation, a `FlowData` without `after`).
Never claim what a named company does internally; describe what the reader can see for themselves.

## The running project: Linkbox

A bookmarks API. Users sign up, save links with notes and tags, search them, attach files and get notified when
things change. The domain is small on purpose, but it uses every topic in the course. Each lesson adds one step.

| Lesson | Linkbox step |
|---|---|
| 01 What is a backend | Sketch the system (client, API, Postgres, Redis, object storage, worker). Install Node 22+, Docker, curl. |
| 02 HTTP | A `node:http` server: `GET /health`, correct status codes and `Content-Type`, `HEAD`, explored with `curl -v`. |
| 03 Routing | A small router: bookmark routes under `/api/v1`, path and query params, 404 and 405 with `Allow`. |
| 04 Serialization | Read JSON bodies safely (size limit, bad JSON → 400), one response shape, ISO 8601 dates, in-memory store. |
| 05 Auth | Sign up and log in with `crypto.scrypt` hashes, server-side sessions in an `HttpOnly` cookie, an owner check on every bookmark. In-memory for now. |
| 06 Validation | Validate and transform bookmark input (URL, title length, tags trimmed and lowercased), 400 with per-field errors. |
| 07 Request lifecycle | Move to Fastify. Split into routes → controllers → services → repositories; request-id and auth middleware; request context. |
| 08 REST API design | Final API: resource naming, cursor pagination, filter and sort, PATCH, 201 + `Location`, 204, `application/problem+json` errors, `Idempotency-Key` on POST. |
| 09 Postgres | Schema (users, sessions, bookmarks, tags, bookmark_tags), migrations, constraints, indexes, transactions; swap the in-memory repositories for SQL. |
| 10 Caching | Cache-aside in Redis for single bookmarks and tag counts, TTLs, invalidate on write; `ETag` + `304` on GET. |
| 11 Task queues | On create, enqueue a job (BullMQ) that fetches the page's title and description; retries with backoff; idempotent jobs; a scheduled job that deletes expired sessions. |
| 12 Search | Postgres full-text search (`tsvector`, GIN index, `ts_rank`) over title, description and notes. Optional: the same in OpenSearch/Elasticsearch, compared. |
| 13 Error handling | Typed errors, one central error handler, problem+json, timeouts and retries on outbound fetches, no stack traces to clients. |
| 14 Configuration | One config module, read from the environment and validated at startup (fail fast); `.env.example`; secrets never in git. |
| 15 Observability | Structured logs (pino) with request ids, RED metrics at `/metrics` (prom-client), optional OpenTelemetry traces. |
| 16 Graceful shutdown | Handle SIGTERM/SIGINT: stop accepting, finish in-flight requests and jobs, close pools; liveness vs readiness endpoints. |
| 17 Security | Audit: parameterized queries, rate-limited login, BOLA checks, security headers, cookie flags and CSRF, SSRF protection in the metadata fetcher. |
| 18 Scaling | Load test (autocannon or k6), read p50/p95/p99, fix an N+1 in the list endpoint, size the pool, run 3 stateless instances behind a load balancer. |
| 19 Concurrency | Limit concurrent outbound fetches, move CPU-heavy work to `worker_threads`, find and fix a race condition with a transaction or constraint. |
| 20 Object storage | Attachments in S3-compatible storage: pre-signed PUT, two-phase upload (pending → confirmed), pre-signed GET, multipart for big files, cleanup. |
| 21 Real-time | Server-sent events that tell the user when a bookmark has been enriched; Redis pub/sub so it works across instances. |
| 22 Testing | `node:test` unit tests for validation and services, integration tests against real Postgres (Testcontainers), API tests. |
| 23 Twelve-factor | Audit Linkbox against all twelve factors; separate web and worker processes; migrations as a one-off admin process. |
| 24 OpenAPI | An `openapi.yaml` for the whole API, linted with Spectral, rendered as docs, checked against the server (Schemathesis). |
| 25 Webhooks | Outgoing `bookmark.created` webhooks: outbox table, dispatcher, HMAC-SHA256 signatures, retries with backoff and jitter. |
| 26 DevOps | Multi-stage Dockerfile (non-root), docker compose, GitHub Actions CI (lint, test, build image), deploy, health checks. |
| 27 Capstone | Final checklist, stretch goals and how to present the project. |

Names shared across lessons (keep them identical): cookie `sid`; `/health/live` and `/health/ready`; list responses
`{ data, nextCursor }`; `bigint` ids; `src/errors.js` with the `AppError` family; `assertPublicUrl(url)` for the SSRF
guard; `readJson(req)` and `send(res, status, payload, headers)` in the pre-Fastify lessons.
