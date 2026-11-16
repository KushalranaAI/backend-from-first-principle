---
title: REST API design
part: The request
summary: How to shape URLs, methods, status codes, lists, errors and versions so that strangers can use your API correctly without asking you.
---

An API is a contract with people you will never meet: a frontend team, a mobile app on a phone that won't update for a year, a partner's script. Once they depend on it, every inconsistency and odd choice is permanent. REST is the set of conventions most HTTP APIs follow so that a developer who has used one good API can guess how yours works. This lesson is about making those guesses come out right.

## The first principle

Imagine three endpoints from three developers on the same team:

```
POST /createBookmark          → 200 {"success": true, "bm": {...}}
GET  /bookmarks/list?page=2   → 200 {"items": [...], "total": 93}
POST /deleteTag?id=7          → 200 {"error": "not found"}
```

Each works. Together they're a mess. A client author has to read the docs for every single call: which verb is in the path, which field holds the result, whether "200" means success. Errors hide inside 200 responses, so retries, caches and monitoring all misread them. And `POST /deleteTag` can't be safely retried, because nothing says whether doing it twice is harmless.

The fix isn't cleverness, it's **uniformity**. HTTP already defines a vocabulary that every client, proxy, cache and library understands:

- **URLs name things** (resources): `/bookmarks/42`.
- **Methods say what to do** with them, with fixed meanings: `GET` reads and is safe to repeat, `DELETE` removes and is safe to retry.
- **Status codes say what happened**, in a form machines can act on: `404`, `409`, `429`.
- **Headers carry the metadata**: content type, caching, location of a new resource.

Use that vocabulary the same way everywhere and your API becomes predictable. A client that knows `GET /bookmarks/42` can guess `PATCH /bookmarks/42` and `GET /tags`. That predictability is what "RESTful" means in daily practice.

## Core ideas

### Where REST comes from

Tim Berners-Lee built the Web around 1990: URLs, HTTP and HTML. In 2000 Roy Fielding, one of the authors of the HTTP/1.1 specification, described *why* the Web scaled so well in his PhD dissertation and named the style **REST**, Representational State Transfer. It's a set of constraints, not a protocol:

| Constraint | Meaning | What you get |
|---|---|---|
| Client–server | UI and data storage are separate | Each side evolves independently |
| Stateless | Every request carries everything needed to understand it; no hidden conversation state on the server | Any server instance can answer any request (lesson 18) |
| Cacheable | Responses say whether they can be cached | Fewer requests, faster clients (lesson 10) |
| Uniform interface | Resources identified by URIs, manipulated through representations (JSON), self-descriptive messages, links to related actions | Generic tools (browsers, proxies, curl) work with every API |
| Layered system | Clients can't tell whether they talk to the server or a proxy, load balancer or CDN | You can add layers without changing clients |
| Code on demand (optional) | Servers may send code to run (JavaScript) | Rarely relevant for APIs |

The "stateless" constraint doesn't forbid sessions (lesson 05): the cookie travels with every request, so each request is still self-contained. And the last part of the uniform interface, *hypermedia* (responses that link to what you can do next, also called HATEOAS), is something few JSON APIs fully adopt. Most "REST APIs" are really **resource-oriented HTTP APIs**. That's fine. What matters is using HTTP's vocabulary consistently.

### Resources and URIs

A **resource** is any thing your API exposes that has an identity: a bookmark, a user, a tag, a collection of bookmarks. Its URI names it. Rules that work:

- **Nouns, not verbs.** The method is the verb. `POST /bookmarks`, not `POST /createBookmark`.
- **Plural collections, and an item under it.** `/bookmarks` is the collection; `/bookmarks/42` is one member. Stay plural even for the single item, so the pattern never changes.
- **Hierarchy for real containment, one level deep.** `/folders/9/bookmarks` (the bookmarks in folder 9) is clear. `/users/3/folders/9/bookmarks/42/tags` is not: once a resource has its own id, give it a top-level URL (`/bookmarks/42`) and filter collections with query parameters.
- **Lowercase, hyphens for multiple words.** `/api-keys`, not `/apiKeys` or `/api_keys`. Paths may be case-sensitive; don't make clients guess.
- **Opaque ids.** Clients should treat ids as strings they don't parse. UUIDs or prefixed ids (`bkm_8f3k...`, as Stripe does) also stop people from guessing that bookmark 43 exists.
- **No file extensions or trailing slashes.** Use the `Accept` header for formats, and pick one form of the path.

Anatomy of a URL, as an API sees it:

```
https://api.linkbox.dev/api/v1/bookmarks/42?include=tags
└─────── base ─────────┘└version┘└collection┘└id┘└─ query: how to read ─┘
```

### Methods and their semantics

HTTP methods have meanings defined in RFC 9110. Two properties decide how clients, proxies and retries may treat a request:

- **Safe**: doesn't change server state. A crawler or prefetcher may call it freely.
- **Idempotent**: doing it twice has the same effect on the server as doing it once. A client may retry after a timeout without fear.

| Method | Use | Safe | Idempotent | Typical success |
|---|---|---|---|---|
| `GET` | Read a resource or a collection | Yes | Yes | `200` |
| `HEAD` | Like `GET`, headers only | Yes | Yes | `200` |
| `POST` | Create in a collection, or run an action | No | **No** | `201` + `Location`, or `200`/`202` |
| `PUT` | Replace the whole resource at this URL (or create it at a known URL) | No | Yes | `200` or `204` (`201` if created) |
| `PATCH` | Change some fields | No | Not guaranteed | `200` |
| `DELETE` | Remove | No | Yes | `204` (or `200` with a body) |
| `OPTIONS` | Ask what's allowed; used by CORS preflight | Yes | Yes | `204` |
| `QUERY` | Read, with the query in the request body instead of the URL | Yes | Yes | `200` |

Idempotent describes the *effect*, not the response. `DELETE /bookmarks/42` twice deletes it once; the second call may return `404`, and that's still idempotent. `POST /bookmarks` twice creates two bookmarks. That's why POST needs extra help to be retried safely (see *Idempotency keys* below).

Never change state in a `GET`. `GET /bookmarks/42/delete` will be followed by a link-preview bot one day.

`QUERY` is the newest row. RFC 10008 (June 2026) defines it for searches that are too large or too private for a query string. Those used to be sent as `POST`, which told every cache and retry loop that the request might change something. A `QUERY` response can be cached, with the request body as part of the cache key. Check that your framework, proxies and clients pass the method through before you rely on it. Linkbox's filters fit in the URL, so it stays with `GET`.

### PUT versus PATCH

Both update. They differ in what the body means.

**`PUT` replaces.** The body is the *complete* new resource. Fields you leave out are reset or removed. Sending the same `PUT` twice gives the same result, so it's idempotent.

**`PATCH` modifies.** The body describes *changes* (RFC 5789). Two standard formats exist:

```
JSON Merge Patch (RFC 7396)               JSON Patch (RFC 6902)
Content-Type: application/merge-patch+json   Content-Type: application/json-patch+json
{ "title": "New title", "notes": null }   [ { "op": "replace", "path": "/title", "value": "New title" },
                                            { "op": "remove",  "path": "/notes" },
                                            { "op": "add",     "path": "/tags/-", "value": "go" } ]
```

Merge patch is what most APIs use, often under plain `application/json`: send the fields you want to change, `null` means "remove this field", missing means "leave it alone". It can't express "append to this array", for which JSON Patch exists. Most APIs only offer `PATCH` with merge semantics, since clients rarely want to resend the whole resource. Linkbox does the same.

When two clients edit the same resource, the second write silently overwrites the first. The HTTP answer is conditional requests: the client sends `If-Match: "<etag>"` and the server replies `412 Precondition Failed` if the resource changed since (lesson 10 adds ETags).

### Status codes

Status codes are for machines: retry logic, caches, monitoring and client libraries branch on them. Use the specific code; don't put errors inside a `200`.

| Code | When |
|---|---|
| `200 OK` | Success with a body (GET, PATCH, an action that returns a result) |
| `201 Created` | A POST created a resource. Include `Location: /api/v1/bookmarks/42` and usually the resource itself |
| `202 Accepted` | Work was queued and will finish later (lesson 11). Return a way to check on it |
| `204 No Content` | Success, nothing to say (DELETE, logout) |
| `304 Not Modified` | Conditional GET: the client's cached copy is still good (lesson 10) |
| `400 Bad Request` | Malformed or invalid input: bad JSON, failed validation (lesson 06) |
| `401 Unauthorized` | Not authenticated: missing or bad credentials (lesson 05) |
| `403 Forbidden` | Authenticated, but not allowed |
| `404 Not Found` | No such resource (or you may not know it exists) |
| `405 Method Not Allowed` | Path exists, method doesn't. Send `Allow` (lesson 03) |
| `409 Conflict` | Clashes with current state: duplicate unique value, request already in progress |
| `412 Precondition Failed` | An `If-Match` condition failed |
| `415 Unsupported Media Type` | The body's `Content-Type` isn't one you accept |
| `422 Unprocessable Content` | Well-formed but semantically unacceptable. Some APIs use it for validation errors instead of 400; pick one and be consistent |
| `429 Too Many Requests` | Rate limited. Send `Retry-After` |
| `500 Internal Server Error` | Your bug. Never send details |
| `503 Service Unavailable` | Overloaded, shutting down, or a dependency is down. Clients may retry later |

The first digit is the contract: `2xx` worked, `4xx` the client must change something, `5xx` the server failed and a retry might work.

### Collections: pagination

`GET /bookmarks` must never return "everything". A user with 50,000 bookmarks would get a 30 MB response and your database a full table scan. Every list endpoint returns **pages**, with a default size and a maximum.

**Offset pagination**: `?limit=20&offset=40`, which becomes `LIMIT 20 OFFSET 40` in SQL.

- Easy, and lets the UI jump to page 7.
- Slow for deep pages: the database still reads and throws away all skipped rows. `OFFSET 100000` reads 100,020 rows.
- Unstable: if a new bookmark is added while you read page 1, every row shifts by one, and page 2 repeats an item. Deletes make you skip one.

**Cursor (keyset) pagination**: `?limit=20&cursor=eyJjcmVhdGVkQXQiOi...`. The cursor encodes *where the last page ended*: the sort value and id of its last row. The next query starts right after it:

```sql
SELECT * FROM bookmarks
WHERE owner_id = $1 AND (created_at, id) < ($2, $3)     -- after the last row seen
ORDER BY created_at DESC, id DESC
LIMIT 21;                                               -- one extra, to know if there's more
```

- Fast at any depth with an index on `(owner_id, created_at, id)`: the database jumps straight to the position (lesson 09).
- Stable: inserts and deletes don't shift what you've already seen.
- No "jump to page 7", and no cheap total count. For feeds, infinite scroll and API clients syncing data, that's fine.

The `id` in the cursor breaks ties: many bookmarks can share a `created_at`, and without a unique tiebreaker you'd skip or repeat rows. Make cursors **opaque** (base64url-encoded JSON is enough) so clients pass them back without building them, and you can change the format later.

| | Offset | Cursor |
|---|---|---|
| Deep pages | Slow | Fast |
| Concurrent inserts | Duplicates and gaps | Stable |
| Jump to page N, total count | Yes | No |
| Good for | Admin tables, small data | Feeds, timelines, sync, public APIs |

How the next page is announced varies. Stripe returns `has_more` and you pass the last id as `starting_after`; GitHub sends a `Link` header (RFC 8288) with `rel="next"`. A body field such as `"nextCursor": "..."` (null on the last page) is the simplest for clients.

### Collections: filtering and sorting

**Filter** with query parameters named after fields: `?tag=go`, `?createdAfter=2026-01-01T00:00:00Z`, `?archived=false`. Several values for one field are usually written as repetition (`?tag=go&tag=rust`) or a comma list. Only allow filters you can serve with an index; each one is a promise.

**Sort** with one parameter listing fields, a leading `-` meaning descending: `?sort=-createdAt,title`. Accept only fields from an allow-list. Never pass the value into SQL directly: a column name can't be a query parameter, so `ORDER BY ${sort}` is an injection hole (lesson 17).

**Sane defaults** matter as much as options. If the client says nothing, Linkbox returns 20 bookmarks, newest first. Reject what you don't support (`?limit=5000`, `?sort=password`) with a `400` that says what's allowed, instead of silently ignoring it.

Some APIs also offer **field selection** (`?fields=id,title`) and **expansion** of related resources (Stripe's `expand[]=customer`), which save bytes and round trips. Add them when clients ask.

### Actions that aren't CRUD

Not everything fits create, read, update, delete. "Archive a bookmark", "re-fetch its metadata", "send a password reset". Three ways to model these, in order of preference:

1. **A field on the resource.** Archiving is a state: `PATCH /bookmarks/42 {"archived": true}`. Filtering by it is free.
2. **A sub-resource that is created or deleted.** GitHub stars a repository with `PUT /user/starred/{owner}/{repo}` and unstars with `DELETE` on the same URL. Exports become `POST /exports`, then `GET /exports/7` to check progress.
3. **An action endpoint**, a verb under the resource, always `POST`: `POST /bookmarks/42/refresh`. Stripe does this (`POST /v1/payment_intents/{id}/confirm`); Google's API guidelines use a colon (`POST /bookmarks/42:refresh`). This is fine for real operations that aren't state changes, as long as you're consistent.

### Versioning

Clients break when you **remove or rename** a field, **change its type or meaning**, **add a required input**, or change an error's status code. They don't break when you **add** an optional field, a new endpoint or a new optional parameter, *if* clients ignore fields they don't know (tell them to). Most change can be additive, and needs no version at all.

When you must break things, release a new version and keep the old one running for a published period:

| Style | Example | Used by |
|---|---|---|
| Path | `/api/v1/bookmarks` | Very common; visible, easy to route and cache |
| Header with a date | `X-GitHub-Api-Version: 2026-03-10` | GitHub. Without the header you get `2022-11-28`; old versions are supported for 24 months after a new one ships |
| Account-pinned date | `Stripe-Version: 2026-10-28.endive` | Stripe. Each account is pinned to a default version and upgrades are explicit; the header overrides it for one request. Since late 2024, breaking changes come only in two named releases a year, and the monthly releases in between break nothing |
| Media type | `Accept: application/vnd.linkbox.v2+json` | Rare; precise but awkward to use |

For most teams, `/v1` in the path is the right default. Announce deprecations ahead of time (the `Deprecation` and `Sunset` response headers, RFC 9745 and RFC 8594, exist for this) and keep a changelog.

### One error format: problem details

Every error from your API should look the same, so a client writes one error handler. Don't invent the shape: **RFC 9457, Problem Details for HTTP APIs**, defines one, with the media type `application/problem+json`:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json

{
  "type": "https://linkbox.example/problems/validation-error",
  "title": "Your request is not valid",
  "status": 400,
  "detail": "2 fields failed validation",
  "instance": "/api/v1/bookmarks",
  "errors": [
    { "pointer": "/url", "detail": "must be a URL" },
    { "pointer": "/tags/2", "detail": "must be at most 30 characters" }
  ],
  "requestId": "8e03978e-40d5-43e8-bc93-6894a57f9324"
}
```

- **`type`**: a URI that identifies the *kind* of problem. Clients branch on it, not on the message text. Ideally it points at a page explaining the error. `"about:blank"` means "nothing more than the status code".
- **`title`**: a short human summary of the type; the same every time.
- **`status`**: the HTTP status, repeated for convenience.
- **`detail`**: what went wrong *this time*, for humans.
- **`instance`**: which request or resource this occurrence is about.
- **Extensions**: any extra members you need, such as `errors` for per-field problems or a `requestId` the user can quote to support.

Never put stack traces, SQL or internal hostnames in an error (lesson 13).

### Idempotency keys

A client sends `POST /bookmarks`, and the connection drops before the response arrives. Did the bookmark get created? The client can't tell. Retry, and maybe you have two. Don't, and maybe you have none. For bookmarks that's annoying; for payments it's a double charge.

The fix is to let the client make POST idempotent. It generates a unique key (a UUID) per *logical* operation and sends it with every attempt:

```
POST /api/v1/bookmarks
Idempotency-Key: "8e03978e-40d5-43e8-bc93-6894a57f9324"
```

The server remembers each key with a fingerprint (hash) of the request body and the response it sent:

```
first request with key K  → store K as "in progress", run it, store the response
retry with K, same body   → don't run again; replay the stored response
retry with K, other body  → 422: the key was reused for a different request
retry while K in progress → 409: try again shortly
after 24 hours            → forget K
```

Stripe has worked this way for years (keys up to 255 characters, pruned after at least 24 hours, every `POST` accepts one). The IETF is standardizing the `Idempotency-Key` header in the *httpapi* working group (still a draft in late 2026), with the same status codes; the draft writes the value as a quoted string, while Stripe accepts it bare, so accept both.

Implementations differ on failures. Stripe's v1 API saves whatever the endpoint answered once it started running, so a retry replays a `500` too. Linkbox doesn't store server errors (`5xx`), so the client can simply retry those.

### Naming and consistency

Small choices, made once, applied everywhere:

- **One case for JSON fields.** Stripe and GitHub use `snake_case`; many JavaScript APIs use `camelCase`. Either is fine; mixing is not. Linkbox uses `camelCase`, the same as its code.
- **Full words.** `description`, not `desc`; `createdAt`, not `crtd`.
- **Same name, same meaning.** If it's `createdAt` on bookmarks, it isn't `created` on tags. Timestamps are ISO 8601 in UTC (lesson 04). Ids are strings.
- **Same shapes.** Every list returns `{ "data": [...], "nextCursor": ... }`. Every error is problem details. Every create returns `201` and the resource.
- **Booleans read as yes/no questions**: `archived`, `isPublic`.
- **Don't expose internals.** No database column names that make no sense outside, no auto-increment ids if you can avoid them, no `password_hash` in any response.

### Documentation

An API without documentation is an API nobody can use correctly. Good API docs have:

- **A reference for every endpoint**: method, path, parameters, request and response bodies with real examples, every error it can return.
- **Getting started**: how to authenticate and make the first call in a minute.
- **Guides** for the concepts: pagination, errors, idempotency, versioning, rate limits.
- **A changelog**, and deprecation notices before anything breaks.

The industry standard for the reference part is an **OpenAPI** document: a YAML or JSON description of your API from which tools render docs (Swagger UI, Redoc, Scalar), generate client libraries and test the server. Linkbox gets one in lesson 24. Stripe's API reference is the usual model for how good it can be.

## Try it

**1. Read a well-designed API.** GitHub's API needs no key for public data (60 requests an hour):

```bash
# Pagination in a Link header, cursor-based (look for after=...)
curl -si "https://api.github.com/repos/nodejs/node/issues?per_page=2&state=all" | grep -iE '^(HTTP|link|x-ratelimit)'

# A consistent 404 body with a documentation link
curl -s https://api.github.com/repos/nodejs/this-does-not-exist

# Writing without credentials: 401, not 404 or 200
curl -si -X POST https://api.github.com/repos/nodejs/node/issues | head -1
```

Follow the `rel="next"` URL from the first command and notice it carries a cursor, not a page number.

**2. See offset pagination break.** Save as `offset.mjs`:

```js
let rows = Array.from({ length: 10 }, (_, i) => ({ id: 10 - i }));   // newest first: 10..1
const page = (offset, limit) => rows.slice(offset, offset + limit).map((r) => r.id);

console.log("page 1:", page(0, 3));           // [10, 9, 8]
rows = [{ id: 11 }, ...rows];                 // someone adds a bookmark
console.log("page 2:", page(3, 3));           // [8, 7, 6]  ← 8 again

// Keyset: "everything older than the last id I saw"
const after = (lastId, limit) => rows.filter((r) => r.id < lastId).slice(0, limit).map((r) => r.id);
console.log("cursor page 2:", after(8, 3));   // [7, 6, 5]
```

**3. Check idempotency by hand.** Once you finish the build below, send the same `POST` twice with one key and compare the responses and ids:

```bash
K=$(node -e 'console.log(crypto.randomUUID())')
for i in 1 2; do
  curl -si -b jar.txt -X POST localhost:3000/api/v1/bookmarks \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $K" \
    -d '{"url":"https://example.com"}' | grep -iE '^(HTTP|location)'
done
```

Break it on purpose:

1. Send the same key with a different URL. You should get a `422` problem.
2. Request `?sort=-title` with a cursor you got from `?sort=-createdAt`. What would go wrong if the server accepted it?
3. Remove the `id` tiebreaker from the cursor and create several bookmarks in the same millisecond (a loop in Node). Page through with `limit=1` and count what you see.
4. Send a `PATCH` with `Content-Type: application/xml`. Which status comes back, and is it a problem document? Then try `Content-Type: text/plain`: Fastify parses plain text by default, so your validator receives a string. Make sure it answers `400`, not `500`.

## Common mistakes

- **Verbs in URLs and everything as POST.** `POST /getBookmarks` hides the semantics from caches, retries and readers. Nouns for paths, methods for verbs, and a `POST` action endpoint only for real operations.
- **Errors with status 200.** `{"success": false}` in a `200` breaks retries, monitoring and every HTTP client's error handling. Use the right `4xx`/`5xx` and problem details.
- **Unbounded lists.** No default limit, no maximum, offset pagination over millions of rows. Always page, cap `limit`, and prefer cursors for anything that grows.
- **Breaking changes without a version.** Renaming `title` to `name` in place breaks every client that shipped. Add fields freely; rename or remove only in a new version, after a deprecation period.
- **Retrying POST blindly.** A client with a timeout and a retry loop creates duplicates. Support `Idempotency-Key` on POST and tell clients to use it.
- **Passing sort or filter input straight to SQL.** Allow-list sort fields and map them to columns yourself.

## Build: Linkbox, step 8

Bring the Fastify API from lesson 07 to its final shape. Storage is still in memory; lesson 09 swaps the repositories for Postgres without touching anything else.

1. **The routes.** Under `/api/v1`, all requiring a user:

   | Method and path | Success |
   |---|---|
   | `GET /bookmarks?tag=&sort=&limit=&cursor=` | `200 { data, nextCursor }` |
   | `POST /bookmarks` | `201` + `Location` + the bookmark |
   | `GET /bookmarks/:id` | `200` |
   | `PATCH /bookmarks/:id` | `200` with the updated bookmark |
   | `DELETE /bookmarks/:id` | `204` |

2. **Typed errors with problem types.** Replace `errors.js` from lesson 07:

   ```js
   const BASE = "https://linkbox.example/problems/";

   export class AppError extends Error {
     constructor(status, slug, title, detail, extra = {}) {
       super(detail ?? title);
       Object.assign(this, { statusCode: status, type: BASE + slug, title, detail, extra });
     }
   }
   export const notFound = (what) => new AppError(404, "not-found", "Not found", `${what} not found`);
   export const invalid = (errors) =>
     new AppError(400, "validation-error", "Your request is not valid", `${errors.length} problem(s)`, { errors });
   export const conflict = (detail) => new AppError(409, "conflict", "Conflict", detail);
   export const unprocessable = (detail) => new AppError(422, "unprocessable", "Unprocessable content", detail);
   ```

   Change the service and validator to throw `notFound("bookmark")` and `invalid([...])`.
3. **One problem+json handler for everything**, including Fastify's own errors (bad JSON, wrong content type) and unknown routes:

   ```js
   // src/problem.js
   import { STATUS_CODES } from "node:http";
   import { AppError } from "./errors.js";

   export function problemHandler(err, req, reply) {
     const status = err.statusCode ?? 500;
     if (status >= 500) req.log.error(err);
     reply.code(status).type("application/problem+json").send({
       type: err.type ?? "about:blank",
       title: err.title ?? STATUS_CODES[status],
       status,
       detail: status >= 500 ? undefined : err instanceof AppError ? err.detail : err.message,
       instance: req.url,
       requestId: req.id,
       ...err.extra,
     });
   }

   export function notFoundHandler(req, reply) {
     reply.code(404).type("application/problem+json").send({ type: "about:blank", title: "Not Found",
       status: 404, detail: `No route for ${req.method} ${req.url}`, instance: req.url, requestId: req.id });
   }
   ```

   In `app.js`: `app.setErrorHandler(problemHandler); app.setNotFoundHandler(notFoundHandler);`.
4. **Cursor pagination, filter and sort in the service.** Allow-list the sorts, cap the limit, and tie the cursor to the sort it came from:

   ```js
   const SORTS = ["createdAt", "-createdAt", "title", "-title"];
   const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
   const decode = (s) => { try { return JSON.parse(Buffer.from(s, "base64url")); } catch { return null; } };

   async list(ownerId, { tag, sort = "-createdAt", limit = "20", cursor }) {
     const n = Number(limit), errors = [];
     if (!SORTS.includes(sort)) errors.push({ parameter: "sort", detail: `one of ${SORTS.join(", ")}` });
     if (!Number.isInteger(n) || n < 1 || n > 100) errors.push({ parameter: "limit", detail: "1 to 100" });
     const after = cursor ? decode(cursor) : null;
     if (cursor && after?.sort !== sort) errors.push({ parameter: "cursor", detail: "invalid for this sort" });
     if (errors.length) throw invalid(errors);

     const field = sort.replace("-", ""), dir = sort.startsWith("-") ? -1 : 1;
     const rows = await bookmarks.list(ownerId, { tag, field, dir, after: after?.key, limit: n + 1 });
     const page = rows.slice(0, n), last = page.at(-1);
     return {
       data: page,
       nextCursor: rows.length > n ? encode({ sort, key: { [field]: last[field], id: last.id } }) : null,
     };
   },
   ```

   The in-memory repository sorts by `(field, id)` and keeps rows after the cursor, exactly what the SQL `WHERE (created_at, id) < ($2, $3)` will do in lesson 09:

   ```js
   async list(ownerId, { tag, field, dir, after, limit }) {
     const cmp = (a, b) =>
       dir * (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
     return [...rows.values()]
       .filter((b) => b.ownerId === ownerId && (!tag || b.tags.includes(tag)))
       .filter((b) => !after || cmp(b, after) > 0)
       .sort(cmp)
       .slice(0, limit);
   },
   ```

5. **`201` + `Location`, `204`, and merge-patch.** In the controller, `create` replies `` reply.code(201).header("Location", `/api/v1/bookmarks/${b.id}`).send(b) `` and `remove` replies `204`. `update` rejects a body that isn't a JSON object with `400`, validates only the fields present (your lesson 06 validator in a "partial" mode), treats `null` as "clear this field", and sets `updatedAt`. Accept the standard merge-patch media type too, in `bookmarks.routes.js`:

   ```js
   app.addContentTypeParser("application/merge-patch+json", { parseAs: "string" },
     app.getDefaultJsonParser("error", "error"));
   ```

6. **`Idempotency-Key` on POST.** Create `src/idempotency.js` with two hooks:

   ```js
   import { createHash } from "node:crypto";
   import { conflict, unprocessable, invalid } from "./errors.js";

   const TTL_MS = 24 * 60 * 60 * 1000;
   const store = new Map();   // in memory, one instance only; Redis in lesson 10

   export async function checkIdempotency(req, reply) {
     const raw = req.headers["idempotency-key"];
     if (req.method !== "POST" || raw === undefined) return;
     const key = raw.replace(/^"(.*)"$/, "$1");            // accept "quoted" and bare
     if (!key || key.length > 255) throw invalid([{ header: "Idempotency-Key", detail: "1 to 255 characters" }]);

     const id = `${req.user.id}:${req.routeOptions.url}:${key}`;
     const fingerprint = createHash("sha256").update(JSON.stringify(req.body ?? null)).digest("hex");
     const saved = store.get(id);
     if (saved && saved.expiresAt > Date.now()) {
       if (saved.fingerprint !== fingerprint) throw unprocessable("Idempotency-Key reused with a different body");
       if (saved.pending) throw conflict("A request with this Idempotency-Key is still in progress");
       return reply.code(saved.status).headers(saved.headers).send(saved.payload);   // replay
     }
     store.set(id, { fingerprint, pending: true, expiresAt: Date.now() + TTL_MS });
     req.idempotencyId = id;
   }

   export async function saveIdempotency(req, reply, payload) {
     const id = req.idempotencyId;
     if (!id) return payload;
     if (reply.statusCode >= 500) store.delete(id);         // let the client retry
     else store.set(id, { ...store.get(id), pending: false, status: reply.statusCode, payload,
       headers: { "content-type": reply.getHeader("content-type"), location: reply.getHeader("location") } });
     return payload;
   }
   ```

   Register them in `bookmarks.routes.js`, after `requireUser` so `req.user` is set: `app.decorateRequest("idempotencyId", null)`, `app.addHook("preHandler", checkIdempotency)`, `app.addHook("onSend", saveIdempotency)`. Keys are scoped per user and per route, so two users can't collide.
7. Run the *Try it* checks, then these:

   ```bash
   curl -s -b jar.txt "localhost:3000/api/v1/bookmarks?limit=2"                  # data + nextCursor
   curl -s -b jar.txt "localhost:3000/api/v1/bookmarks?limit=2&cursor=<next>"    # the next two
   curl -s -b jar.txt "localhost:3000/api/v1/bookmarks?sort=url&limit=500"       # 400, two errors
   curl -si -b jar.txt -X DELETE localhost:3000/api/v1/bookmarks/<id> | head -1  # 204
   curl -si localhost:3000/api/v1/nope | grep -i content-type                    # application/problem+json
   ```

**Done when** paging with `limit=2` visits every bookmark exactly once even if you create one mid-way, every error (including bad JSON and unknown routes) comes back as `application/problem+json`, and a repeated POST with the same `Idempotency-Key` returns the same bookmark id instead of creating a second one.

## Check yourself

<details markdown="1">
<summary>Is <code>DELETE</code> idempotent if the second call returns 404?</summary>

Yes. Idempotency is about the effect on the server: after one call or ten, the bookmark is gone. The response code may differ, and that's allowed.
</details>

<details markdown="1">
<summary>A client sends <code>PATCH /bookmarks/42</code> with <code>{"notes": null}</code> as JSON Merge Patch. What happens to the title and the notes?</summary>

The title is untouched because it isn't mentioned. The notes are removed (or cleared), because in merge patch `null` means "delete this member".
</details>

<details markdown="1">
<summary>Why does cursor pagination stay correct when rows are inserted between page requests, while offset pagination doesn't?</summary>

An offset counts rows from the start, so a new row at the top shifts everything and page 2 repeats an item. A cursor says "rows after this (createdAt, id)", a fixed position in the sort order that new rows elsewhere don't move.
</details>

<details markdown="1">
<summary>Name two changes that break existing clients and two that don't.</summary>

Breaking: renaming or removing a field, changing a field's type, adding a required parameter, changing a status code clients rely on. Not breaking: adding an optional response field, a new endpoint, a new optional query parameter (as long as clients ignore unknown fields).
</details>

<details markdown="1">
<summary>A client retries <code>POST /bookmarks</code> with the same <code>Idempotency-Key</code> while the first attempt is still running. What should the server answer, and why not just run it?</summary>

`409 Conflict`. Running it would risk the duplicate the key exists to prevent. Replaying isn't possible yet because there's no stored response. The client waits and retries, and then gets the replayed result.
</details>

<details markdown="1">
<summary>What should a client branch on in a problem details response, <code>type</code> or <code>detail</code>?</summary>

`type`. It's a stable identifier for the kind of problem. `detail` is human-readable text about this occurrence and may change wording at any time.
</details>

## Go deeper

- [Roy Fielding's dissertation, chapter 5](https://ics.uci.edu/~fielding/pubs/dissertation/rest_arch_style.htm): REST in the words of the person who named it; short and readable.
- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110): the definitive meaning of every method and status code, including safe and idempotent.
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457): the error format, with examples of extension members.
- [Stripe API reference](https://docs.stripe.com/api): a model of consistent design; read the sections on pagination, errors, idempotent requests and versioning.
- [GitHub: Using pagination in the REST API](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api): `Link` headers and cursors in practice.
- [Zalando RESTful API guidelines](https://opensource.zalando.com/restful-api-guidelines/): a large company's complete rulebook, with reasons for each rule.
