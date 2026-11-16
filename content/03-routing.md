---
title: Routing
part: The request
summary: How a server turns a method and a path into the one function that should run.
---

A request arrives as text: a method, a path and some headers. Routing is the small piece of code that reads that line and decides which of your functions runs. Every framework has a router. Write one yourself once, and none of them will confuse you again.

## The first principle

An HTTP server gets one stream of requests. Your application has many jobs: list bookmarks, create one, delete one, log in. Something has to sit between the two and **dispatch**: look at each request and call the right handler.

The request line is all the router needs:

```
GET /bookmarks/42?include=tags HTTP/1.1
```

From that line a router reads two things:

- **the method** (`GET`): *what* the client wants to do
- **the path** (`/bookmarks/42`): *which thing* it wants to do it to

A route is a rule that pairs the two with a handler: `GET /bookmarks/:id → getBookmark`. Routing is a lookup: given (method, path), find the handler. It is not much more than that.

> The method and the path together are the key. `GET /bookmarks` and `POST /bookmarks` share a path but are two different routes doing two different jobs.

## Core ideas

### Static and dynamic routes

A **static route** matches one exact path: `/health`, `/bookmarks`. A **dynamic route** has segments that change: `/bookmarks/:id` matches `/bookmarks/42` and `/bookmarks/abc`. The variable segment is a **path parameter**. The router pulls it out and hands it to the handler as `params.id = "42"`.

Path parameters are always strings. `"42"` is not the number `42` until your code checks and converts it (lesson 06).

The `:name` syntax is common enough to have become a web standard. `URLPattern` matches patterns such as `/bookmarks/:id` in every major browser since 2025, and it is a global in Node 24 and later.

### Path parameters and query parameters

They look alike but mean different things:

| | Path parameter | Query parameter |
|---|---|---|
| Example | `/bookmarks/42` | `/bookmarks?tag=go&sort=-created` |
| Identifies | **which** resource | **how** to read a collection: filter, sort, page |
| Required? | Yes. Without it the URL means something else | Usually optional, with defaults |
| Part of the route? | Yes | No. The router ignores the query string when matching |

A good rule of thumb: if removing the value changes *what* you are talking about, it belongs in the path. If it only changes *how much* or *in what order*, it belongs in the query.

### Matching order and specificity

`/bookmarks/:id` and `/bookmarks/search` both match the path `/bookmarks/search`. Routers settle this in one of two ways:

1. **First match wins**: routes are checked in the order you registered them (Express works like this). Register `/bookmarks/search` before `/bookmarks/:id`, or `search` gets treated as an id.
2. **Most specific wins**: the router stores routes in a tree (a *radix tree* or *trie*) and always prefers a static segment over a parameter (Fastify, Go's `net/http` since 1.22, httprouter). Order stops mattering.

Tree routers are also faster: they walk the path one segment at a time instead of trying every route in turn. In practice your database is slower than any router, so pick a router for clarity, not speed.

### 404 versus 405

When nothing matches, there are two different answers:

- **404 Not Found**: no route has this path at all (`GET /bookmrks`).
- **405 Method Not Allowed**: the path exists but not with this method (`DELETE /health`). The response should include an `Allow` header listing the methods that do work, for example `Allow: GET, HEAD`.

Many apps return 404 for both. It works, but 405 tells the client exactly what it did wrong.

### Grouping, prefixes and versioning

Real apps have dozens of routes. Routers let you **group** them under a prefix and attach shared behaviour to the whole group:

```
/api/v1/bookmarks      ┐
/api/v1/bookmarks/:id  ├─ group "/api/v1", all require login
/api/v1/tags           ┘
/health                ── public
```

Prefix groups are how you add **API versioning** (`/v1`, `/v2`) and how you apply middleware such as authentication to many routes at once (lesson 07).

### Catch-all routes

A wildcard such as `/files/*` matches everything below a prefix. Use it for static files or a single-page app's fallback (`* → index.html`). Keep catch-alls last, or they will swallow routes registered after them.

The spelling differs between routers: `/files/*` in Fastify, `/files/{path...}` in Go, and `/files/*splat` in Express 5, where a wildcard must have a name (a bare `*` worked in Express 4 and throws in 5).

## Try it

Build a router with nothing but Node's standard library. Save this as `router.mjs` (Node 22 or newer):

```js
import http from "node:http";

// A route is (method, pattern, handler). ":name" segments become params.
const routes = [];
const route = (method, pattern, handler) =>
  routes.push({ method, parts: pattern.split("/").filter(Boolean), handler });

function match(parts, path) {
  const segs = path.split("/").filter(Boolean);
  if (segs.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) params[parts[i].slice(1)] = decodeURIComponent(segs[i]);
    else if (parts[i] !== segs[i]) return null;
  }
  return params;
}

route("GET", "/health", () => ({ ok: true }));
route("GET", "/bookmarks", (req) => ({ list: [], tag: req.query.get("tag") }));
route("GET", "/bookmarks/:id", (req) => ({ id: req.params.id }));
route("POST", "/bookmarks", () => ({ created: true }));

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const allowed = [];
  for (const r of routes) {
    const params = match(r.parts, url.pathname);
    if (!params) continue;
    if (r.method !== req.method) { allowed.push(r.method); continue; }
    req.params = params;
    req.query = url.searchParams;
    const body = JSON.stringify(r.handler(req));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }
  if (allowed.length) {
    res.writeHead(405, { Allow: allowed.join(", ") });
    return res.end();
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}).listen(3000, () => console.log("http://localhost:3000"));
```

Run `node router.mjs`, then in a second terminal:

```bash
curl -i localhost:3000/health
curl -i "localhost:3000/bookmarks?tag=go"
curl -i localhost:3000/bookmarks/42
curl -i -X DELETE localhost:3000/bookmarks/42     # 405, with an Allow header
curl -i localhost:3000/nope                       # 404
```

Now break it on purpose:

1. Add `route("GET", "/bookmarks/search", ...)` **after** `/bookmarks/:id` and request `/bookmarks/search`. Which handler runs? Why? Move it above and try again.
2. Request `/bookmarks/hello%20world`. What does `params.id` contain, and which line decoded it?
3. Request `/bookmarks/42/`. Does the trailing slash still match? Decide whether it should.
4. Request `/bookmarks/%E0%A4%A`. The server process dies: `decodeURIComponent` throws a `URIError` on a broken percent-encoding and nothing catches it. One bad URL from anyone takes the API down. Wrap the decode in `try`/`catch` and answer `400`.

## Common mistakes

- **Trusting path parameters.** `params.id` is a raw string from the outside world. Validate it before it reaches a query (lesson 06), and never paste it into SQL (lesson 17).
- **Verbs in paths.** `POST /createBookmark` and `GET /getBookmarks` repeat what the method already says. Use `POST /bookmarks` and `GET /bookmarks` (lesson 08).
- **Route order bugs.** In a first-match router, a parameter route registered early shadows static routes registered after it.
- **Putting secrets in URLs.** Paths and query strings end up in logs, browser history and proxy caches. Tokens belong in headers.
- **One giant file of routes.** Group routes by resource (`bookmarks.routes.js`, `auth.routes.js`) and mount them under a prefix.

## Build: Linkbox, step 3

Take the server from lesson 02 and give it real routes. Use the router above or write your own. Don't add a framework yet; that happens in lesson 07.

1. Add these routes, each returning placeholder JSON for now:
   `GET /bookmarks`, `POST /bookmarks`, `GET /bookmarks/:id`, `PATCH /bookmarks/:id`, `DELETE /bookmarks/:id`, `GET /health`.
2. Mount the bookmark routes under `/api/v1`. Keep `/health` at the root.
3. Return 404 for unknown paths and 405 with an `Allow` header for wrong methods.
4. Read `?tag=` and `?limit=` from the query string in `GET /bookmarks` and echo them back.

**Done when** every `curl` from *Try it* behaves as you predicted before running it.

## Check yourself

<details markdown="1">
<summary>A route is <code>DELETE /bookmarks/:id</code>. What two things does the router compare to pick it?</summary>

The method (`DELETE`) and the path pattern (`/bookmarks/:id`). Both must match. The query string is not part of matching.
</details>

<details markdown="1">
<summary>When should a value be a path parameter rather than a query parameter?</summary>

When it identifies *which* resource you mean (`/bookmarks/42`). Filters, sorting and pagination change *how* you read a collection, so they go in the query string.
</details>

<details markdown="1">
<summary>A client sends <code>PUT /health</code> and only <code>GET</code> is registered for that path. What should the server answer?</summary>

`405 Method Not Allowed` with `Allow: GET` (and `HEAD`, if you support it). A 404 would wrongly suggest the path doesn't exist.
</details>

<details markdown="1">
<summary>Why does <code>/bookmarks/search</code> sometimes hit the <code>/bookmarks/:id</code> handler?</summary>

In a first-match router, `:id` matches any single segment, including `search`. If that route is registered first, it wins. Tree-based routers avoid this by always preferring the static segment.
</details>

## Go deeper

- [MDN: What is a URL?](https://developer.mozilla.org/en-US/docs/Learn_web_development/Howto/Web_mechanics/What_is_a_URL): every part of a URL, named.
- [Go blog: Routing enhancements for Go 1.22](https://go.dev/blog/routing-enhancements): a clear write-up of method matching, wildcards and "most specific wins".
- [find-my-way](https://github.com/delvedor/find-my-way): the radix-tree router inside Fastify. Read its README to see a production router's rules.
- [Express routing guide](https://expressjs.com/en/guide/routing.html): the first-match model, route parameters and `express.Router` groups.
- [MDN: URL Pattern API](https://developer.mozilla.org/en-US/docs/Web/API/URL_Pattern_API): the standard pattern syntax, with named groups, wildcards and optional parts.
