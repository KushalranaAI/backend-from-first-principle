---
title: Capstone: finish Linkbox
part: Finish
summary: The full spec, a production-readiness checklist, stretch goals and how to present what you built.
---

You have built Linkbox one lesson at a time. This page puts it together: the spec it should meet, a checklist to go through line by line, and ways to take it further. When every box below is honestly ticked, you have built a backend most teams would be happy to run.

## The spec

**Linkbox** is a bookmarks API. A user can:

- sign up, log in and log out (session cookie)
- create, read, update and delete bookmarks: a URL, a title, notes and tags
- list their bookmarks with filters (tag, date), sorting and cursor pagination
- search them by full text
- attach files to a bookmark, uploaded straight to object storage
- get a live update when a background job has fetched a bookmark's page title and description
- register a webhook URL and receive signed `bookmark.created` events

It runs as two processes, `web` and `worker`, backed by Postgres, Redis and an S3-compatible object store.

```
            ┌────────────┐   HTTPS    ┌──────────────────┐
 client ───▶│ load       │──────────▶ │ web (Fastify) ×3 │──┐
            │ balancer   │◀── SSE ─── └──────────────────┘  │
            └────────────┘                 │   │            │
                                           ▼   ▼            ▼
                                   ┌──────────┐ ┌───────┐ ┌───────────┐
                                   │ Postgres │ │ Redis │ │ S3 storage│
                                   └──────────┘ └───────┘ └───────────┘
                                           ▲   ▲
                                   ┌───────────────────┐       ┌───────────────┐
                                   │ worker (BullMQ)   │──────▶│ user webhooks │
                                   └───────────────────┘       └───────────────┘
```

## Production-readiness checklist

Go through it with the code open. For each line, find the place in your code that makes it true.

**Requests (lessons 02–08)**

- [ ] Every response has the right status code and `Content-Type`; unknown paths return 404 and wrong methods 405.
- [ ] Bodies are size-limited; bad JSON is a 400, not a 500.
- [ ] Passwords are hashed with scrypt or argon2id; sessions live server-side in an `HttpOnly`, `Secure`, `SameSite` cookie.
- [ ] Every bookmark query is scoped to the logged-in user (no one can read or change another user's data).
- [ ] All input is validated and normalized at the edge; errors list each bad field.
- [ ] Routes, controllers, services and repositories are separate; no SQL in a route handler.
- [ ] Errors use one format (`application/problem+json`); lists use cursor pagination; `POST` accepts an `Idempotency-Key`.

**Data (09–12)**

- [ ] The schema is created by migrations, with foreign keys, `NOT NULL` and unique constraints where they belong.
- [ ] Every query is parameterized; multi-step writes run in a transaction.
- [ ] Hot reads are cached with a TTL and invalidated on write; `GET` supports `ETag` and `304`.
- [ ] Page enrichment runs in a worker with retries and backoff, and running a job twice is harmless.
- [ ] Search uses a GIN-indexed `tsvector`, not `LIKE '%…%'`.

**Production (13–17)**

- [ ] One error handler; clients never see a stack trace; outbound calls have timeouts.
- [ ] Config comes from the environment, is validated at startup, and the app refuses to start if it's wrong.
- [ ] Logs are structured JSON with a request id; `/metrics` exposes request rate, errors and latency.
- [ ] `SIGTERM` drains in-flight requests and jobs, then closes pools; `/health/live` and `/health/ready` exist.
- [ ] Login is rate-limited; security headers are set; the metadata fetcher refuses private IP ranges (SSRF).

**Scale (18–21)**

- [ ] You've load-tested the list endpoint and know its p50 and p99.
- [ ] The web process holds no state, so three copies behind a load balancer behave like one.
- [ ] CPU-heavy work doesn't block the event loop; races are prevented by the database, not by luck.
- [ ] File bytes never pass through the API: pre-signed URLs in, pre-signed URLs out; abandoned uploads are cleaned up.
- [ ] Live updates work across instances (Redis pub/sub) and clients reconnect with backoff.

**Engineering practice (22–26)**

- [ ] Unit tests for validation and services; integration tests against a real Postgres; they run in CI.
- [ ] `openapi.yaml` describes the whole API, passes Spectral, and Schemathesis finds no contract violations.
- [ ] Outgoing webhooks go through an outbox, are HMAC-signed, and retry with backoff and jitter.
- [ ] A multi-stage Docker image runs as a non-root user; `docker compose up` starts everything.
- [ ] CI lints, tests and builds the image on every push.

## Stretch goals

Pick the ones that interest you. Each one is a real problem teams deal with.

- **Import**: upload a browser bookmarks HTML export; parse it in a background job and report progress over SSE.
- **Sharing**: public read-only collections with an unguessable slug. Think about caching and the CDN.
- **OAuth login**: "Sign in with GitHub" using the authorization code flow with PKCE.
- **Link checking**: a scheduled job that finds dead links. Watch your outbound concurrency and be polite to other servers.
- **A second implementation**: rewrite the web process in Go against the same `openapi.yaml`, and run the same Schemathesis tests against it. If the course worked, this goes faster than you expect.

## Present it

Code alone doesn't show what you know. Add:

1. **A README** with a one-paragraph pitch, the architecture diagram, how to run it in one command, and the API docs link.
2. **A design notes file**: five decisions you made and what you traded for each (sessions vs JWT, cursor vs offset, Postgres search vs Elasticsearch, and so on). This is what interviewers ask about.
3. **Numbers**: your load-test results before and after a fix you made.
4. **A short write-up or screen recording** walking through one request end to end, from DNS to the database and back.

## Go deeper

- [Designing Data-Intensive Applications](https://dataintensive.net/): the natural next book.
- [System Design Primer](https://github.com/donnemartin/system-design-primer): for taking these ideas to bigger systems.
- [Fastify documentation](https://fastify.dev/docs/latest/): read the parts you used, now that you know what each one is for.
