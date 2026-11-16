---
title: HTTP
part: The request
summary: The text protocol every backend speaks, from the request line to caching, CORS and TLS.
---

HTTP is the language your backend speaks with browsers, mobile apps, other services and `curl`. Every feature you build arrives as an HTTP request and leaves as an HTTP response, so every bug you chase will show up in one of them. Learn to read the raw messages and most of the web stops being mysterious.

## The first principle

Two programs on different machines want to work together. TCP gives them a reliable pipe for bytes, but bytes alone mean nothing. Before they can cooperate they must agree on a few things:

- **How to ask.** Which action? On which thing?
- **How to describe the data.** Is this JSON or an image? How long is it? Is it compressed?
- **How to answer.** Did it work? If not, whose fault was it?

Any protocol that answers those questions will end up looking like HTTP: a short line saying what you want, some `name: value` lines of metadata, and an optional body. HTTP adds two design choices that shape every backend.

**Client-server.** One side always starts (the client sends a request), the other always answers (the server sends a response). In a plain HTTP exchange the server never speaks first.

**Stateless.** Each request carries everything the server needs to understand it. The server doesn't remember that you sent a request a second ago. If it needs to know who you are, you send a cookie or token with *every* request (lesson 05).

Statelessness sounds like a limitation. It is the reason the web scales: any server behind a load balancer can answer any request, a server can crash and restart without losing a conversation, and a cache can answer a request without asking the server at all. The state still exists, but it lives in the database, the cache or the client, not in the connection.

> HTTP is a text agreement about requests and responses. Everything else in this lesson (methods, status codes, caching, CORS) is a convention layered on that agreement.

## Core ideas

### From HTTP/1.0 to HTTP/3

The meaning of HTTP (methods, headers, status codes) has barely changed since 1997. What changed is how the messages travel.

| Version | Year | Transport | What it fixed |
|---|---|---|---|
| HTTP/0.9 | 1991 | TCP | One line: `GET /page`. HTML only, no headers. |
| HTTP/1.0 | 1996 | TCP | Headers, status codes, `Content-Type`. New connection per request. |
| HTTP/1.1 | 1997 | TCP | Persistent connections by default, required `Host` header (many sites on one IP), chunked transfer, caching rules. |
| HTTP/2 | 2015 | TCP + TLS | Binary framing. Many requests at once over one connection (multiplexing). Compressed headers (HPACK). |
| HTTP/3 | 2022 | QUIC over UDP | No head-of-line blocking in the transport. TLS 1.3 built in. Faster setup, survives network changes. |

The problem each version attacked is **head-of-line blocking**. In HTTP/1.1 one connection carries one request at a time, so a slow response blocks everything behind it; browsers work around it by opening about six connections per host. HTTP/2 splits messages into frames tagged with a stream id, so many responses share one connection. But TCP still delivers bytes strictly in order, so one lost packet stalls every stream. HTTP/3 runs over QUIC, which handles streams independently: a lost packet only delays its own stream.

For a backend developer the news is good: your code reads the same method, path, headers and body whichever version arrived. A reverse proxy or CDN usually speaks HTTP/2 or 3 to browsers and HTTP/1.1 to your app.

### Anatomy of a message

A request, exactly as it goes over an HTTP/1.1 connection:

```
POST /api/v1/bookmarks HTTP/1.1          ← request line: method, target, version
Host: linkbox.example                    ← headers: name: value, one per line
Content-Type: application/json
Content-Length: 38
Authorization: Bearer eyJhbGciOi...
                                         ← empty line: headers are over
{"url":"https://nodejs.org","tags":[]}   ← body (optional)
```

And the response:

```
HTTP/1.1 201 Created                     ← status line: version, code, reason
Content-Type: application/json; charset=utf-8
Content-Length: 46
Location: /api/v1/bookmarks/42

{"id":42,"url":"https://nodejs.org","tags":[]}
```

Lines end with `\r\n`. The blank line is how the receiver knows the headers are done; `Content-Length` (or chunked encoding, below) tells it where the body ends. HTTP/2 and HTTP/3 send the same fields in binary frames, write header names in lowercase, and carry the method and path as pseudo-headers (`:method`, `:path`). Header names are case-insensitive in every version, which is why Node gives you `req.headers["content-type"]` in lowercase.

### Why headers exist, and the kinds you'll meet

The request line says *what* to do. Headers carry everything *about* the message, so the receiver doesn't have to open the body: who is asking, what format the body is in, how long it is, whether it may be cached. Think of the label on a parcel. A proxy can route, cache or reject a request by reading headers alone.

Headers fall into rough groups:

| Group | Examples | Says |
|---|---|---|
| Request | `Host`, `User-Agent`, `Accept`, `Authorization`, `Cookie`, `If-None-Match` | Who is asking, what they accept, conditions |
| Response | `Server`, `Location`, `Set-Cookie`, `Retry-After`, `WWW-Authenticate` | Extra facts about the answer |
| Representation | `Content-Type`, `Content-Length`, `Content-Encoding`, `Content-Language`, `ETag`, `Last-Modified` | What the body is and how it is encoded |
| General / connection | `Date`, `Cache-Control`, `Connection`, `Via` | Apply to the message or the hop, either direction |
| Security | `Strict-Transport-Security`, `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options` | Rules the browser must enforce |

You can invent your own headers. The old `X-` prefix is deprecated (RFC 6648); just pick a clear name such as `Idempotency-Key`. Headers are HTTP's extension point: you can add behaviour without changing the protocol.

### Methods

The method states the client's intent. The server should do what the method says, because caches, proxies, browsers and retry logic all assume it will.

| Method | Meaning | Body |
|---|---|---|
| `GET` | Read a resource | No |
| `HEAD` | Same as GET, headers only | No |
| `POST` | Create something, or run an action | Yes |
| `PUT` | Replace the resource at this URL with this body | Yes |
| `PATCH` | Change part of a resource | Yes |
| `DELETE` | Remove the resource | Usually no |
| `OPTIONS` | Ask what is allowed here | No |
| `QUERY` | Read, with the question in the body | Yes |

`HEAD` is underrated: it lets a client check whether a file changed, or how large it is, without downloading it. A server that supports `GET` should support `HEAD`.

`QUERY` is the newest method (RFC 10008, June 2026). It is a read like `GET`, but the query travels in the body, for searches too long or too structured to fit in a URL. Before it existed, APIs used `POST` for those and gave up safe retries and caching. Node's HTTP parser accepts `QUERY` already; check that your framework, proxies and CDN do before you depend on it.

### Safe and idempotent

Two properties decide what clients and proxies may do on their own:

- **Safe**: the request doesn't change anything on the server. A crawler or a browser's link prefetcher may send it freely.
- **Idempotent**: sending it twice has the same effect on the server as sending it once. A client may retry it after a timeout.

| Method | Safe | Idempotent |
|---|---|---|
| `GET`, `HEAD`, `OPTIONS`, `QUERY` | yes | yes |
| `PUT` | no | yes |
| `DELETE` | no | yes |
| `POST` | no | no |
| `PATCH` | no | not guaranteed |

`DELETE /bookmarks/42` twice leaves the same state as once: the bookmark is gone. The second call might return 404 instead of 204, and that is fine; idempotency is about the server's state, not the response. `POST /bookmarks` twice creates two bookmarks. That matters when the network drops a response: a client can safely retry a `PUT`, but a retried `POST` may charge a card twice. Lesson 08 fixes that with an `Idempotency-Key` header.

The classic bug: a `GET /bookmarks/42/delete` link. The first crawler or prefetching browser that follows it deletes your data.

### OPTIONS and CORS

Browsers enforce the **same-origin policy**: JavaScript on `https://app.linkbox.example` may *send* requests to `https://api.linkbox.example`, but may not *read* the response unless the API says so. An origin is scheme + host + port, so even a different port is another origin. Without this rule, any page you visit could quietly call your bank with your cookies and read the result.

**CORS** (Cross-Origin Resource Sharing) is how a server says "this other origin may read my responses". It is a browser feature. `curl`, servers and mobile apps ignore it completely. CORS protects users, not your API.

There are two flows.

**Simple requests** go straight through. A request is simple when the method is `GET`, `HEAD` or `POST`, the only headers the page set are safelisted ones (`Accept`, `Accept-Language`, `Content-Language`, `Content-Type`, a single `Range`), and `Content-Type` is `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`. These are requests an HTML form could already send before CORS existed, so allowing them adds no new risk. The browser sends the request with an `Origin` header; if the response lacks a matching `Access-Control-Allow-Origin`, the browser hides it from your JavaScript. Note that the request still reached the server and ran.

**Preflighted requests** are everything else: `PUT`, `PATCH`, `DELETE`, a JSON body (`Content-Type: application/json`), an `Authorization` header. Before sending them the browser asks permission with `OPTIONS`:

```
Browser                                             API
   │  OPTIONS /api/v1/bookmarks/42                    │
   │  Origin: https://app.linkbox.example             │
   │  Access-Control-Request-Method: DELETE           │
   │  Access-Control-Request-Headers: authorization   │
   │ ───────────────────────────────────────────────► │
   │  204 No Content                                  │
   │  Access-Control-Allow-Origin: https://app...     │
   │  Access-Control-Allow-Methods: GET, POST, DELETE │
   │  Access-Control-Allow-Headers: Authorization     │
   │  Access-Control-Max-Age: 600                     │
   │ ◄─────────────────────────────────────────────── │
   │  DELETE /api/v1/bookmarks/42   (the real one)    │
   │ ───────────────────────────────────────────────► │
```

If the preflight answer doesn't allow the origin, method and headers, the real request is never sent. `Access-Control-Max-Age` lets the browser cache the answer (the default is 5 seconds; Chromium caps it at 2 hours, Firefox at 24).

Credentials need extra care. For the browser to send cookies cross-origin, the frontend sets `credentials: "include"` and the server must reply with `Access-Control-Allow-Credentials: true` and an exact origin. `Access-Control-Allow-Origin: *` is refused with credentials. When you echo back an origin from an allowlist, also send `Vary: Origin`, so a cache doesn't hand one origin's response to another.

Your browser's DevTools Network tab shows this flow as two rows: the `OPTIONS` request, then the real one.

### Status codes

The status code is the server's one-number summary. Clients branch on it, monitoring counts it, retry logic depends on it. The first digit is the class:

| Class | Meaning | Who should act |
|---|---|---|
| 1xx | Informational, keep going | Rarely seen in app code |
| 2xx | Success | Nobody |
| 3xx | Look elsewhere, or use your cached copy | The client follows |
| 4xx | The client made a mistake | Fix the request; repeating it won't help |
| 5xx | The server failed | The server's owner; the client may retry later |

The ones worth knowing by heart:

| Code | When to use it |
|---|---|
| `200 OK` | Success with a body |
| `201 Created` | `POST` created something; send `Location` pointing at it |
| `202 Accepted` | Queued for later, not done yet |
| `204 No Content` | Success with nothing to return (`DELETE`, preflight) |
| `206 Partial Content` | Answering a `Range` request (resumed downloads, video) |
| `301` / `308` | Moved permanently. 308 keeps the method and body. |
| `302` / `307` | Moved temporarily. 307 keeps the method and body. |
| `304 Not Modified` | Your cached copy is still good (caching, below) |
| `400 Bad Request` | Malformed or invalid input (lessons 04 and 06) |
| `401 Unauthorized` | Not authenticated: missing or bad credentials |
| `403 Forbidden` | Authenticated, but not allowed |
| `404 Not Found` | No such resource (also used to hide ones the user may not see) |
| `405 Method Not Allowed` | Path exists, method doesn't; send `Allow` |
| `409 Conflict` | Clashes with current state (duplicate, version mismatch) |
| `412 Precondition Failed` | An `If-Match` condition failed |
| `413 Content Too Large` | Body over your limit |
| `415 Unsupported Media Type` | Body in a format you don't accept |
| `422 Unprocessable Content` | Well-formed but semantically invalid (some APIs prefer it to 400) |
| `429 Too Many Requests` | Rate limited; send `Retry-After` |
| `500 Internal Server Error` | Your bug |
| `502 Bad Gateway` | A proxy got a bad answer from upstream (often: your app crashed) |
| `503 Service Unavailable` | Overloaded or in maintenance; send `Retry-After` |
| `504 Gateway Timeout` | A proxy gave up waiting for upstream |

Two rules. Never return `200` with `{"error": "..."}` in the body: every tool in the chain will think it worked. And keep 4xx and 5xx honest: a 4xx says "don't retry this as is", a 5xx says "maybe try again". Mixing them up causes retry storms or silent failures.

### HTTP caching

The fastest request is the one you never send. HTTP caching lets a browser, a CDN or a proxy keep a copy of a response and reuse it. It answers two questions.

**Is my copy still fresh?** The server says how long a response may be reused with `Cache-Control`:

| Directive | Meaning |
|---|---|
| `max-age=3600` | Fresh for an hour; reuse without asking |
| `s-maxage=600` | Same, but for shared caches (CDNs) only |
| `no-cache` | You may store it, but revalidate before every use |
| `no-store` | Don't store it anywhere (sensitive data) |
| `private` | Only the user's browser may store it, not shared caches |
| `public` | Shared caches may store it, even for a request with credentials |
| `immutable` | It will never change; don't even revalidate (hashed asset filenames) |
| `stale-while-revalidate=60` | Serve the stale copy for up to 60 s while refreshing in the background |

`no-cache` is the most misread header on the web: it means "check first", not "don't cache".

**If it's stale, has it changed?** Instead of downloading it again, the client sends a **conditional request** carrying a validator the server gave it earlier:

```
first request                       later, after max-age ran out
───────────────                     ─────────────────────────────
GET /bookmarks                      GET /bookmarks
                                    If-None-Match: "a1b2c3"
200 OK
ETag: "a1b2c3"                      304 Not Modified          ← no body
Cache-Control: max-age=60           ETag: "a1b2c3"
[6 KB of JSON]
```

- **`ETag`** is an opaque version id for the content, often a hash. The client sends it back in `If-None-Match`. A `W/` prefix marks a weak ETag, meaning "equivalent content", for example the same data gzipped or not.
- **`Last-Modified`** is a timestamp, sent back in `If-Modified-Since`. It only has one-second resolution, so ETags are more precise. When both are present, `If-None-Match` wins.

A `304` saves the bandwidth and the client's parsing time, though not the round trip. The same validators make writes safe: `PUT` with `If-Match: "a1b2c3"` fails with `412` if someone changed the resource since you read it (lesson 08). Linkbox adds ETags in lesson 10.

### Content negotiation

One URL can have several **representations**: JSON or XML, English or Hindi, gzipped or not. The client lists what it can handle, with optional weights (`q`, from 0 to 1):

```
Accept: application/json, text/html;q=0.8
Accept-Language: hi-IN, en;q=0.7
Accept-Encoding: gzip, br, zstd
```

The server picks one and labels it with `Content-Type`, `Content-Language` or `Content-Encoding`. If it supports nothing on the list it may answer `406 Not Acceptable`, though most APIs just send their default. Whenever a response depends on a request header, list that header in `Vary` (`Vary: Accept-Encoding`), so caches store one copy per variant instead of serving gzip to a client that can't read it.

### Compression

Text compresses well: JSON often shrinks by 70–90%. The client advertises `Accept-Encoding: gzip, br, zstd`, the server compresses and sets `Content-Encoding: br`. Brotli (`br`) usually beats gzip on text; Zstandard (`zstd`) is newer, fast, and supported by Chromium-based browsers and Firefox since 2024 and by Safari since 26.3 (February 2026).

Compress text (JSON, HTML, CSS, JS, SVG), not JPEG, PNG, video or zip files, which are already compressed. Skip tiny responses where the effort outweighs the savings. In production the reverse proxy or CDN usually compresses, so your app doesn't spend CPU on it.

### Persistent connections and keep-alive

Each new connection costs a TCP handshake plus a TLS handshake: two or three round trips before the first byte. HTTP/1.0 paid that for every request. HTTP/1.1 keeps the connection open by default and reuses it for the next request; either side can end it with `Connection: close`, and servers close idle connections after a timeout. Node's HTTP server announces its timeout with `Keep-Alive: timeout=5`: `server.keepAliveTimeout` is 5 seconds by default. Node then waits about one more second before it closes the socket (`server.keepAliveTimeoutBuffer`), so a client that trusts the announced number doesn't send a request into a closing connection. Node 27, due in April 2027, raises the default to 65 seconds. HTTP/2 and HTTP/3 go further and multiplex everything over one long-lived connection.

Keep-alive matters on the backend too. When your app calls another API or a database, reuse connections (connection pools, lesson 09) instead of opening one per request.

### Multipart bodies and chunked transfer

Two ways a body can be split up, for different reasons.

**Multipart** puts several parts in one body, each with its own headers. File uploads from an HTML form use `multipart/form-data`:

```
Content-Type: multipart/form-data; boundary=----X7

------X7
Content-Disposition: form-data; name="title"

Node docs
------X7
Content-Disposition: form-data; name="file"; filename="notes.pdf"
Content-Type: application/pdf

%PDF-1.7 ... binary bytes ...
------X7--
```

The boundary is a string the client chose that doesn't appear in the data. Lesson 20 handles large files differently: the client uploads straight to object storage.

**Chunked transfer** solves a different problem: the server wants to start sending before it knows the total length. Instead of `Content-Length`, it sends `Transfer-Encoding: chunked`, and each chunk is prefixed with its size in hex, ending with a zero-size chunk:

```
7\r\n
tick 1\n\r\n
7\r\n
tick 2\n\r\n
0\r\n
\r\n
```

Node does this for you whenever you don't set `Content-Length`. It's how streamed responses, large exports and server-sent events (lesson 21) work over HTTP/1.1. HTTP/2 and 3 frame every body anyway and forbid chunked encoding.

### HTTPS and TLS

Plain HTTP can be read and edited by anyone on the path: the café Wi-Fi, an ISP, a compromised router. **HTTPS** is HTTP inside **TLS** (Transport Layer Security; "SSL" is the name of its insecure predecessor, still used loosely). TLS gives you three guarantees:

1. **Confidentiality**: the bytes are encrypted.
2. **Integrity**: tampering is detected.
3. **Authentication**: you are talking to the real `linkbox.example`, proven by a certificate.

The TLS 1.3 handshake takes one round trip:

```
Client                                        Server
  │ ClientHello: versions, ciphers, key share,   │
  │   SNI (which host), ALPN (h2? http/1.1?)     │
  │ ───────────────────────────────────────────► │
  │ ServerHello: chosen cipher, key share,       │
  │   certificate, signature, Finished           │
  │ ◄─────────────────────────────────────────── │
  │ (both sides now derive the same secret keys) │
  │ Finished + first HTTP request, encrypted     │
  │ ───────────────────────────────────────────► │
```

Asymmetric cryptography (the key exchange and the certificate's signature) is used only to agree on a shared secret; the rest of the connection uses fast symmetric encryption. The certificate is trusted because a certificate authority your OS trusts signed it after checking you control the domain. Let's Encrypt issues them for free, and tools such as Caddy or certbot renew them automatically. Renewing by hand is no longer realistic: since March 2026 a public certificate may be valid for at most 200 days, falling to 100 days in March 2027 and 47 days in March 2029, and Let's Encrypt is moving its own certificates from 90 days to 45 by 2028.

Two details of the first message have changed recently. The key share sent by current Chrome and Firefox, and by OpenSSL since 3.5, is a hybrid called `X25519MLKEM768`: the classic exchange plus a post-quantum one, so traffic recorded today can't be decrypted by a future quantum computer. You may see that name in `curl -v` output. And SNI is sent unencrypted, so the network still learns which host you asked for. Encrypted Client Hello (RFC 9849, March 2026) hides it when both the client and the server support it.

In practice: allow TLS 1.2 and 1.3 only (1.0 and 1.1 were formally deprecated in 2021), terminate TLS at your reverse proxy or load balancer, redirect HTTP to HTTPS, and send `Strict-Transport-Security` so browsers never try plain HTTP again.

## Try it

Start with a real site. `-v` shows the connection (`*`), what curl sent (`>`) and what came back (`<`):

```bash
curl -v https://example.com -o /dev/null
```

Trimmed, the output looks something like this (the exact lines depend on how your curl was built):

```
* Connected to example.com port 443
* ALPN: curl offers h2,http/1.1
* SSL connection using TLSv1.3 / TLS_AES_256_GCM_SHA384
* ALPN: server accepted h2
* Server certificate:
*  subject: CN=example.com
> GET / HTTP/2
> Host: example.com
> Accept: */*
< HTTP/2 200
< content-type: text/html
```

Find the TLS version and the HTTP version the two sides agreed on through ALPN. Then:

```bash
curl -I https://www.cloudflare.com          # HEAD: headers only. Find alt-svc: h3=":443" (HTTP/3 offered)
curl -sI http://github.com | head -3        # 301 to https
curl -sIL http://github.com | grep -iE '^(HTTP|location|strict)'   # follow it and spot HSTS
```

Now a local lab. Save this as `lab.mjs`:

```js
import http from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const ALLOWED_ORIGIN = "http://localhost:5173";
const data = JSON.stringify({
  items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `Bookmark ${i}` })),
});
// Weak ETag (W/): same data, whether we send it gzipped or not.
const etag = `W/"${createHash("sha256").update(data).digest("base64url").slice(0, 16)}"`;

http.createServer((req, res) => {
  // Echo the raw request body back, so you can see what a client sent.
  if (req.url === "/echo") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return req.pipe(res);
  }

  // No Content-Length: Node falls back to chunked transfer encoding.
  if (req.url === "/stream") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    let n = 0;
    const timer = setInterval(() => {
      res.write(`tick ${++n}\n`);
      if (n === 5) { clearInterval(timer); res.end(); }
    }, 1000);
    return;
  }

  // CORS: allow one known origin, and answer preflights.
  res.setHeader("Vary", "Origin, Accept-Encoding");
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
    });
    return res.end();
  }

  // Caching: a validator (ETag) plus a rule (always revalidate).
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "no-cache");
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    return res.end();
  }

  // Compression: only if the client said it can decode gzip.
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
  const body = gzip ? gzipSync(data) : Buffer.from(data);
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    ...(gzip && { "Content-Encoding": "gzip" }),
  });
  res.end(body);
}).listen(3000, () => console.log("http://localhost:3000"));
```

The ETag check is simplified: a real `If-None-Match` can hold a list of tags or `*`. Run `node lab.mjs` and, in another terminal:

```bash
# Compression: compare the bytes on the wire (about 6.5 KB vs 1 KB)
curl -s -o /dev/null -w "%{size_download} bytes\n" localhost:3000/bookmarks
curl -s -o /dev/null -w "%{size_download} bytes\n" -H "Accept-Encoding: gzip" localhost:3000/bookmarks

# Caching: grab the ETag, then ask "has it changed?"
curl -sI localhost:3000/bookmarks | grep -i etag
curl -v -H 'If-None-Match: W/"paste-the-value-here"' localhost:3000/bookmarks   # 304, no body

# CORS preflight from an allowed and a foreign origin. Compare the headers.
curl -i -X OPTIONS localhost:3000/bookmarks -H "Origin: http://localhost:5173" \
  -H "Access-Control-Request-Method: DELETE" -H "Access-Control-Request-Headers: authorization"
curl -i -X OPTIONS localhost:3000/bookmarks -H "Origin: https://evil.example" \
  -H "Access-Control-Request-Method: DELETE"

# Multipart: see the boundary and the parts exactly as sent
echo '{"a":1}' > note.json
curl -F "title=Hello" -F "file=@note.json" localhost:3000/echo

# Chunked: watch ticks arrive one per second, then see the raw chunk sizes
curl -N localhost:3000/stream
curl -s --raw localhost:3000/stream | od -c | head

# Keep-alive: two URLs, one connection
curl -v localhost:3000/bookmarks localhost:3000/bookmarks -o /dev/null -o /dev/null 2>&1 | grep -iE "connect|re-?us"
```

The foreign origin's preflight still gets a `204`, but without `Access-Control-Allow-Origin`. A browser would stop there; curl doesn't care.

Break it on purpose:

1. Change the `Access-Control-Allow-Origin` value to `*` and imagine the frontend sends cookies. Reread the CORS section: what does the browser do?
2. Remove `Content-Length` from the 200 response and repeat a request with `-v`. Which header appears instead?
3. Send `Accept-Encoding: br`. The lab ignores it. What should a server do with an encoding it doesn't support?
4. Send `curl -i -X DELETE localhost:3000/bookmarks`. The lab happily returns data. What should it return, and with which header?

## Common mistakes

- **Fixing CORS with `*` everywhere.** It fails with credentials, and reflecting any `Origin` back with `Allow-Credentials: true` lets every site read your users' data. Keep an allowlist of exact origins and send `Vary: Origin`.
- **`200 OK` with an error body.** Monitoring, caches and clients all treat it as success. Use the right 4xx or 5xx code and put details in the body.
- **Changing state on `GET`.** Prefetchers, crawlers and caches will trigger it. Anything that writes uses `POST`, `PUT`, `PATCH` or `DELETE`.
- **`no-cache` when you meant `no-store`.** `no-cache` still stores the response. For tokens and personal data, send `Cache-Control: no-store`.
- **Keep-alive timeouts out of step with the load balancer.** If the balancer keeps idle connections open longer than Node does (an AWS ALB defaults to 60 s, Node to 5 s), Node closes a connection the balancer is about to reuse and users see random 502s. Set `server.keepAliveTimeout` above the balancer's idle timeout, for example 65 s. Node 27 makes that the default; on 22, 24 and 26 you set it yourself.
- **Treating 401 and 403 as the same.** 401 means "log in"; 403 means "you're logged in and still can't". Clients react differently to each.

## Build: Linkbox, step 2

Write Linkbox's first server with nothing but `node:http`. No routing yet; lesson 03 adds real routes.

1. Create `src/server.js`. Listen on `process.env.PORT`, defaulting to 3000.
2. `GET /health` returns `200` with `{"status":"ok"}`, `Content-Type: application/json; charset=utf-8`, an exact `Content-Length` (use `Buffer.byteLength(body)`, not `body.length`, which counts characters, not bytes) and `Cache-Control: no-store`.
3. `HEAD /health` returns the same status and headers with no body. Node's `res.end(body)` already drops the body for `HEAD`; check it with `curl -I`.
4. Any other method on `/health` returns `405` with `Allow: GET, HEAD`. Any other path returns `404` with a JSON body.
5. Log one line per request when it finishes: method, path, status, milliseconds. Use `res.on("finish", ...)` and `performance.now()`.
6. Explore it with `curl -v`, `curl -I` and `curl -X POST`. For every response header, write one line saying who added it (you or Node) and what it means.

**Done when** `curl -v localhost:3000/health` shows `200` with your `Content-Type` and `Content-Length`, `curl -I` shows the same headers and no body, `curl -i -X POST localhost:3000/health` returns `405` with `Allow`, and an unknown path returns `404`.

## Check yourself

<details markdown="1">
<summary>HTTP is stateless. How does a server know you are logged in on your second request?</summary>

It doesn't remember. The client sends proof with every request, usually a session cookie or a bearer token in a header, and the server looks it up (lesson 05). The state lives in the database or the token, not in the connection.
</details>

<details markdown="1">
<summary>Is <code>DELETE</code> idempotent if the second call returns 404?</summary>

Yes. Idempotency is about the server's state: after one call or two, the resource is gone. The status code of the repeat may differ.
</details>

<details markdown="1">
<summary>A browser sends <code>OPTIONS</code> before your <code>PATCH</code>, but not before a plain form <code>POST</code>. Why?</summary>

A form-style `POST` (safelisted headers, form or text content type) is a simple request, something browsers could always send, so no permission is needed. `PATCH`, JSON bodies and headers such as `Authorization` need a preflight to check the server allows them.
</details>

<details markdown="1">
<summary>What is the difference between <code>Cache-Control: no-cache</code> and <code>no-store</code>?</summary>

`no-cache` lets caches store the response but requires them to revalidate (for example with `If-None-Match`) before each use. `no-store` forbids storing it at all.
</details>

<details markdown="1">
<summary>When does a response use <code>Transfer-Encoding: chunked</code>, and why?</summary>

When the server starts sending before it knows the total size, so it can't set `Content-Length`. Each chunk carries its own length and a zero-length chunk marks the end. HTTP/1.1 only.
</details>

<details markdown="1">
<summary>What three things does TLS give you that plain HTTP doesn't?</summary>

Confidentiality (encryption), integrity (tampering is detected) and authentication (the certificate proves you reached the real domain).
</details>

## Go deeper

- [RFC 9110: HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110): the current definition of methods, status codes and headers. Sections 9 (methods) and 15 (status codes) read well on their own.
- [MDN: Cross-Origin Resource Sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS): simple and preflighted requests, credentials and every `Access-Control-*` header, with examples.
- [MDN: HTTP caching](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching): freshness, validation, `Vary` and common caching patterns.
- [Jake Archibald: Caching best practices](https://jakearchibald.com/2016/caching-best-practices/): the two caching patterns that work, and the mistakes in between.
- [High Performance Browser Networking](https://hpbn.co/): Ilya Grigorik's free book on TCP, TLS, HTTP/1.1 and HTTP/2, and why latency matters more than bandwidth.
- [MDN: Evolution of HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Evolution_of_HTTP): the history from 0.9 to 3 on one page.
