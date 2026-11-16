---
title: Real-time backends
part: Scale
summary: How a server pushes data to clients the moment something happens, from polling to SSE and WebSockets, and what changes when connections stay open for hours.
---

HTTP is built around one rule: the client asks, the server answers. But many features need the opposite. A chat message arrives, a background job finishes, a price changes, and the user should see it now, not when they next click refresh. Real-time backends are the techniques for letting the server speak first, and the engineering that follows once thousands of connections stay open all day.

## The first principle

A server cannot send a response nobody asked for. So "the server tells the client" always means one of two things:

1. **The client keeps asking.** Polling, in its plain and long forms.
2. **The client opens a connection and keeps it open,** and the server writes to it whenever it likes. Server-sent events and WebSockets.

The first is simple and wasteful. The second is efficient and changes your server's shape. A normal request lives for 50 milliseconds. A real-time connection lives for hours. Your server stops being a function that turns requests into responses and becomes a holder of thousands of open sockets, each one a file descriptor, some memory and a user waiting for news. That shift is the whole lesson: pick the right transport, then deal with what long-lived connections do to one machine, and then to many.

## Core ideas

### Polling

The client asks on a timer:

```
every 5 s:  GET /api/v1/notifications?since=1042
            200 []        (nothing new)
            200 []
            200 []
            200 [{...}]   (finally)
```

Polling works through every proxy, firewall and load balancer, needs no special server code, and survives server restarts without noticing. For dashboards that refresh every minute it is often the right answer.

### What polling costs

The cost is the gap between how often you ask and how often something happens:

- **Load.** 10,000 users polling every 5 seconds is 2,000 requests per second, and almost all of them answer "nothing new". Each one pays for TLS, headers, authentication, routing and often a database query.
- **Latency.** An event waits until the next poll: 2.5 seconds on average with a 5-second interval, 5 seconds at worst.
- **The trade-off can't be escaped.** Halve the interval to halve latency and you double the load.

### Long polling

Long polling keeps the same request and response shape but changes when the server answers:

```
GET /api/v1/notifications?since=1042    ──▶ server holds the request open...
                                            ...an event arrives after 12 s
                                        ◀── 200 [{ id: 1043, ... }]
GET /api/v1/notifications?since=1043    ──▶ held again (answers [] after 30 s if nothing happens)
```

Events now arrive almost instantly, and idle clients cost one held request each instead of a stream of empty ones. But every event still costs a full request and response, the server must hold a connection per waiting client, and events that happen between one response and the next request must be buffered somewhere (that `since` id). Long polling was the standard trick before browsers had anything better. Today it is mostly a fallback.

### Server-sent events

**Server-sent events (SSE)** keep one HTTP response open and stream events down it. The client is the browser's built-in `EventSource`:

```js
const events = new EventSource("/api/v1/events");          // sends cookies, same origin
events.addEventListener("bookmark.enriched", (e) => render(JSON.parse(e.data)));
```

The server answers with `Content-Type: text/event-stream` and never ends the body. The format is plain text, one field per line, with a blank line ending each event:

```
retry: 3000

id: 1043
event: bookmark.enriched
data: {"bookmarkId":"b_81","title":"Range requests explained"}

: this line starts with a colon, so it's a comment (used as a keep-alive)

id: 1044
data: first line
data: second line
```

| Field | Meaning |
|---|---|
| `data` | the payload; several `data` lines are joined with newlines |
| `event` | the event type, for `addEventListener`; without it the type is `message` |
| `id` | the event's id; the browser remembers the last one it saw |
| `retry` | how many milliseconds to wait before reconnecting |

The part that makes SSE good is **reconnection**. If the connection drops, `EventSource` waits `retry` milliseconds and reconnects on its own, sending the last id it received in a `Last-Event-ID` header. The server can then replay everything after that id. Ids plus a short event history turn a fragile stream into one that survives network blips and deploys.

Practical notes:

- Send a comment line every 15 to 30 seconds. Proxies and load balancers close connections that look idle.
- Proxies such as nginx buffer responses by default, which holds your events back. Turn buffering off for the events route (`X-Accel-Buffering: no` or `proxy_buffering off`), and keep compression middleware away from it.
- Under HTTP/1.1, browsers allow about six connections per host, shared across tabs. Each open `EventSource` uses one. HTTP/2 multiplexes streams over one connection and removes the problem.
- A response with a status other than 200, or the wrong `Content-Type`, makes `EventSource` give up for good. A `204` is the polite way to say "stop reconnecting".

### One direction only

SSE goes from server to client. That is less of a limit than it sounds: the client can still send anything with ordinary `fetch` requests, which keep all your existing auth, validation and rate limiting. Notifications, live feeds, progress bars and streamed LLM tokens are all one-way.

It becomes a limit when the client also sends many small messages with low latency: chat with typing indicators, multiplayer games, collaborative editors, live cursors. For those, a full request per keystroke is heavy, and you want one connection that carries messages both ways. Two other limits: SSE carries only UTF-8 text, and `EventSource` can only send a `GET` with no custom headers, so auth has to come from cookies. When you need a `POST` body or an `Authorization` header, read the same `text/event-stream` format with `fetch` and a stream reader instead. You then write the reconnect logic yourself.

### The WebSocket handshake

A **WebSocket** starts as an HTTP request and then stops being HTTP. The client asks to switch protocols:

```
GET /chat HTTP/1.1
Host: linkbox.dev
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Version: 13
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Origin: https://linkbox.dev
```

and a server that agrees answers:

```
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

The accept value is `base64(SHA-1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))`, a fixed GUID from RFC 6455:

```js
import { createHash } from "node:crypto";
createHash("sha1").update("dGhlIHNhbXBsZSBub25jZQ==" + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
// 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
```

The key is not security. It proves the server really speaks WebSocket and isn't a plain HTTP server or cache echoing something back. After the `101`, the same TCP connection carries WebSocket frames in both directions until one side closes it.

This is the HTTP/1.1 handshake. HTTP/2 and HTTP/3 have no `Upgrade` header, so there a WebSocket is opened with an extended `CONNECT` request on one stream (RFC 8441 and RFC 9220). Browsers and proxies choose between them for you, and the frames that follow are the same.

Security is your job. Browsers don't apply CORS to WebSockets and do send cookies, so any website can open a socket to your server with your user's session. Check the `Origin` header against an allowlist and authenticate during the handshake. Skipping this is called cross-site WebSocket hijacking.

### Frames, and the mask bit

Every message travels in **frames** with a 2 to 14 byte header, compared with hundreds of bytes of headers on an HTTP request:

```
 byte 0: FIN (1 bit) | RSV1-3 (3 bits) | opcode (4 bits)
 byte 1: MASK (1 bit) | payload length (7 bits)
         length 0–125: that's the length
         length 126:   real length in the next 2 bytes
         length 127:   real length in the next 8 bytes
 then:   4-byte masking key (only if MASK = 1)
 then:   payload
```

| Opcode | Frame |
|---|---|
| `0x1` / `0x2` | text (UTF-8) / binary message |
| `0x0` | continuation of a message split over several frames (`FIN` marks the last) |
| `0x8` | close (with a status code such as 1000 normal, 1001 going away) |
| `0x9` / `0xA` | ping / pong |

The odd rule: **every frame from client to server must be masked**, with a fresh random 4-byte key: each payload byte is XORed with `key[i % 4]`. Frames from server to client must not be masked, and a server must close the connection if a client frame arrives unmasked.

It isn't encryption, since the key travels in the same frame. It defends the network. Without it, JavaScript on a hostile page could choose the exact bytes sent over the wire and craft frames that look like HTTP requests to old proxies that don't understand WebSockets, poisoning their caches. Masking with a key the script can't predict makes the bytes on the wire unpredictable too. Libraries such as `ws` and every browser handle masking; you just need to know why it's there.

### Ping, pong, and a connection that is already dead

TCP only tells you a connection is closed when the other side says so. If a phone goes into a tunnel, a laptop sleeps, or a NAT router silently forgets the mapping, no goodbye packet ever arrives. Your server holds a socket that looks open and leads nowhere: a **half-open** connection. Writes go into a kernel buffer and only fail after the retransmission timeout, which on Linux defaults to around 15 minutes. Meanwhile it costs you a file descriptor and memory, and the user misses events while your server thinks they were delivered.

The fix is a heartbeat. The server sends a **ping** frame every 30 seconds; the peer must answer with a **pong**. No pong by the next round means the connection is dead, so you destroy it. Browsers answer pings automatically. The pattern from the `ws` README:

```js
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data) => {
    for (const client of wss.clients)
      if (client.readyState === client.OPEN) client.send(data.toString());
  });
});

// Every 30 s: drop anyone who didn't answer the last ping, then ping the rest.
const timer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on("close", () => clearInterval(timer));
```

`terminate()` destroys the socket at once. `close()` starts a polite closing handshake, which a dead peer will never finish. Heartbeats also keep traffic flowing past idle timeouts in load balancers (60 seconds by default on AWS's Application Load Balancer). For SSE, the comment line plays the same role.

### One machine: file descriptors

Every open connection is a socket, and every socket is a **file descriptor**. Processes have a limit on how many they can hold, and the default soft limit on many Linux systems is still 1,024:

```bash
ulimit -n                     # the soft limit for this shell, often 1024
ulimit -Hn                    # the hard limit you may raise it to
```

Past the limit, `accept()` fails with `EMFILE` ("too many open files"). Your server then can't take new connections, and can't open files or database connections either. For a real-time server, raise it: `LimitNOFILE=` in a systemd unit, `--ulimit nofile=65535:65535` in Docker, or `ulimit -n` in a start script. There is also a system-wide ceiling (`fs.file-max`), usually much higher.

### Ports, and the four-tuple

A common worry: "there are only 65,535 ports, so a server can't hold more than 65,535 connections". Wrong. A TCP connection is identified by its **four-tuple**:

```
(client IP, client port, server IP, server port)
(203.0.113.7, 51544, 10.0.0.5, 443)
(203.0.113.7, 51545, 10.0.0.5, 443)   ← same server port, different connection
(198.51.100.2, 51544, 10.0.0.5, 443)  ← even the same client port is fine from another IP
```

Every connection to your server shares server port 443. They differ in the client side of the tuple, so the server can hold millions.

Ports do run out on the **connecting** side when one machine opens many connections to the *same* destination. A load balancer or proxy talking to your backend at `10.0.0.5:3000` from one IP has only its ephemeral port range to vary: 32768 to 60999 by default on Linux, about 28,000 ports. That caps it at roughly 28,000 concurrent connections to that one backend address. Closed connections also hold their port for 60 seconds in `TIME_WAIT`. The fixes are more destination addresses (more backend instances or ports), more source IPs on the proxy, or a wider range:

```bash
cat /proc/sys/net/ipv4/ip_local_port_range     # 32768  60999
```

### Memory per connection

Each connection costs memory in two places:

- **The kernel**: send and receive buffers for the socket. They grow with traffic and shrink when idle.
- **Your process**: the library's objects and buffers for the socket, plus whatever state you attach (user id, subscriptions, a queue of unsent messages).

On one laptop, 5,000 idle `ws` connections added about 55 MB to a Node process, roughly 11 KB each, before any application state. Measure your own (see *Try it*); it decides how many connections one instance can take.

The dangerous case is a **slow consumer**. If a client reads more slowly than you write, unsent data piles up in your process. `ws.bufferedAmount` tells you how many bytes are queued for a socket. Set a ceiling (say 1 MB) and drop the client when it is crossed, or one stuck phone can grow without limit.

### The second machine

One instance eventually isn't enough, or you want two for availability. Now there is a new problem:

```
user A ──socket──▶ instance 1
user B ──socket──▶ instance 2

A saves a bookmark on instance 1 → B should hear about it
instance 1 doesn't hold B's socket.
```

Sticky sessions don't help: they keep *one* user on one instance, but the event and the recipient are still on different machines. Each instance needs to hear about every event that any of its connected users care about.

### Publish and subscribe

The standard answer is a **pub/sub backplane**. Every instance subscribes to a channel in a shared broker, usually Redis. Whoever produces an event publishes it once. Every instance receives it and delivers it to its own local connections:

```
worker / any instance ──PUBLISH linkbox:events {userId: 42, ...}──▶ Redis
                                                                    │
                        ┌───────────────────────────┬───────────────┘
                        ▼                           ▼
                   instance 1                  instance 2
                   (no sockets for user 42)    sockets for user 42 → write
```

```js
import Redis from "ioredis";

const sub = new Redis(process.env.REDIS_URL);   // a subscribed connection can't run other commands
const pub = new Redis(process.env.REDIS_URL);

await sub.subscribe("linkbox:events");
sub.on("message", (_channel, message) => {
  const event = JSON.parse(message);
  for (const res of connectionsByUser.get(event.userId) ?? []) writeEvent(res, event);
});

await pub.publish("linkbox:events", JSON.stringify({ userId: 42, type: "bookmark.enriched", data: {} }));
```

One shared channel, filtered on each instance, is the simplest design and works well up to a lot of traffic. At larger scale, use one channel per user or room so instances receive only what they need (Redis 7's sharded pub/sub spreads channels across a cluster).

### At most once, and catching up

Redis pub/sub is **fire and forget**. A message goes to whoever is subscribed at that instant and is then gone. Nothing is stored. So:

- If an instance's Redis connection blips, it misses everything published meanwhile.
- If a user is between reconnects, the event is published to nobody.
- If a subscriber falls too far behind, Redis disconnects it (the default `client-output-buffer-limit` for pub/sub is 32 MB hard, or 8 MB for 60 seconds).

That is **at-most-once** delivery: each message arrives zero or one times. For "someone is typing", that's fine. For "your export is ready", it isn't.

To catch up, give every event an id and keep a recent history:

1. When an event happens, append it to a log, then publish it. A **Redis Stream** works well: `XADD events:user:42 MAXLEN ~ 1000 * type bookmark.enriched data {...}` returns an id like `1731750000000-0` that only ever increases. A Postgres table works too.
2. Use that id as the SSE `id`.
3. On reconnect, read `Last-Event-ID` and replay everything newer: `XRANGE events:user:42 (1731750000000-0 +` (the `(` means "exclusive").
4. Register the connection for live events *before* reading the history. Hold back any live event that arrives while the replay is being written, then send the held events, skipping any whose id you already replayed. Registering second loses an event that lands between the two steps; sending live events during the replay delivers them out of order.

Delivery to the client is now **at least once**: after a reconnect the client may see an event twice. Make client handling idempotent: keep the last id seen and ignore anything not newer.

### Fan-out, and reconnect storms

**Fan-out** is one event becoming many deliveries. A message in a room with 10,000 members is 10,000 writes. The cost scales with recipients times message size, not with events, so watch your biggest rooms, batch where you can, and keep messages small (send an id and let clients fetch details).

A **reconnect storm** is fan-out in reverse. You deploy, and an instance holding 40,000 connections shuts down. 40,000 clients reconnect within the same second, all running the handshake, authentication and a history query at once, to the instances that are left. Those slow down, connections time out, clients retry, and the storm feeds itself.

Defences, on both sides:

- **Clients back off with jitter.** Wait a random time between zero and an exponentially growing cap: `delay = random(0, min(30 s, 1 s × 2^attempt))`. Randomness spreads the herd; the exponent stops a broken server being hammered.

  ```js
  const backoff = (attempt) => Math.random() * Math.min(30_000, 1_000 * 2 ** attempt);
  ```

- **Servers spread their own goodbyes.** On shutdown (lesson 16), close connections in batches over 30 to 60 seconds instead of all at once. For SSE, send each client a random `retry:` value.
- **Make reconnecting cheap.** Fast session checks (a cache, not a slow query), bounded history replay, and a limit on how many handshakes each instance accepts per second.

### Choosing a transport

| | Polling | Long polling | SSE | WebSocket |
|---|---|---|---|---|
| Direction | client asks | client asks | server → client | both ways |
| Latency | up to the interval | near instant | near instant | near instant |
| Cost when idle | a request per interval | one held request | one open connection | one open connection |
| Reconnect and resume | trivial | manual | built in (`Last-Event-ID`) | do it yourself |
| Works over plain HTTP infra | yes | yes | yes (turn off buffering) | needs `Upgrade` support |
| Best for | slow-changing data | fallback | notifications, feeds, progress, token streams | chat, games, collaboration |

Start with SSE when data flows one way. Reach for WebSockets when the client talks back often.

There is a fifth option, **WebTransport**: several independent streams, plus datagrams that may be lost, over one HTTP/3 connection. It has worked in every major browser since March 2026, when Safari added it. Consider it when one slow message must not hold up the others, as in games and live media. For notifications and chat it adds a lot of moving parts and little else.

## Try it

Make a folder, set `"type": "module"` (`npm init -y && npm pkg set type=module`) and `npm install ws`. Node 22 has `WebSocket` built in as a client.

**SSE with replay.** Save `sse.js`:

```js
import http from "node:http";

const clients = new Set();
const history = [];              // the last 100 events, so reconnecting clients can catch up
let nextId = 1;

function write(res, e) {
  res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
}

function publish(type, data) {
  const e = { id: nextId++, type, data };
  history.push(e);
  if (history.length > 100) history.shift();
  for (const res of clients) write(res, e);
}

http.createServer((req, res) => {
  if (req.url !== "/events") return res.writeHead(404).end();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write("retry: 3000\n\n");                       // reconnect after 3 s
  const lastId = Number(req.headers["last-event-id"] ?? 0);
  for (const e of history) if (e.id > lastId) write(res, e);
  clients.add(res);
  req.on("close", () => clients.delete(res));
}).listen(3000, () => console.log("http://localhost:3000/events"));

setInterval(() => publish("tick", { at: new Date().toISOString() }), 2000);
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 15000);
```

```bash
node sse.js
curl -N localhost:3000/events                         # -N: print as it arrives
curl -N -H "Last-Event-ID: 3" localhost:3000/events   # replays from id 4 onwards
```

**WebSocket handshake by hand.** Save the `ws` heartbeat server above as `ws-server.js`, run it, then:

```bash
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://localhost:8080/
# HTTP/1.1 101 Switching Protocols ... Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
```

Open two terminals with `node -e 'const ws = new WebSocket("ws://localhost:8080"); ws.onmessage = (m) => console.log(m.data); process.stdin.on("data", (d) => ws.send(String(d).trim()))'` and type into one. The other prints it.

**How many connections?** Save `many.js`:

```js
// Open N WebSocket connections and hold them. Usage: node many.js 5000
const n = Number(process.argv[2] ?? 1000);
let open = 0;
for (let i = 0; i < n; i++) {
  const ws = new WebSocket("ws://localhost:8080");
  ws.onopen = () => open++;
  ws.onerror = () => { console.error(`connection ${i} failed after ${open} opened`); process.exit(1); };
}
setInterval(() => console.log(`${open} open`), 2000);
```

Add `setInterval(() => console.log(wss.clients.size, Math.round(process.memoryUsage().rss / 1e6), "MB"), 2000);` to the server, then run `node many.js 1000`, `5000`, `10000` and work out the memory per connection.

Break it on purpose:

1. In the server's shell, run `ulimit -n 256`, restart it, and run `node many.js 1000`. Find the `EMFILE` error. (Linux and macOS.)
2. Open `http://localhost:3000/` in a browser (the empty 404 page is enough: it's the same origin) and run `new EventSource("/events").addEventListener("tick", (e) => console.log(e.lastEventId, e.data))` in the console. Restart `sse.js`. The tab reconnects by itself, but the ids start again at 1 and nothing is replayed. Why? (History and ids live in the process's memory.)
3. Comment out the `ws.on("pong", ...)` line and wait a minute. Every client is terminated. Why?
4. Start two copies of `sse.js` on different ports and connect to each. A `publish` on one never reaches the other. That's the problem pub/sub solves.

## Common mistakes

- **No heartbeat.** Half-open connections pile up, leak descriptors and memory, and swallow events. Ping every 30 seconds and terminate what doesn't answer; send SSE comments.
- **Treating Redis pub/sub as reliable.** It is at-most-once. Keep an event log with ids and replay on reconnect for anything users must not miss.
- **Not checking `Origin` on WebSocket upgrades.** Browsers send cookies to any WebSocket and CORS doesn't apply. Allowlist origins and authenticate during the handshake.
- **Reconnecting immediately and in step.** Fixed retry delays turn a deploy into a thundering herd. Use exponential backoff with full jitter, and drain connections gradually on shutdown.
- **A proxy that buffers the stream.** Events arrive in bursts or not at all behind nginx or compression middleware. Turn buffering and compression off for streaming routes.
- **Ignoring slow consumers.** Queued messages grow without limit for clients that can't keep up. Check `bufferedAmount` and drop clients over a ceiling.

## Build: Linkbox, step 21

When the enrichment job from lesson 11 finishes, tell the user's open tabs, on whichever instance they are connected to.

1. Add `GET /api/v1/events`, behind your auth middleware. In Fastify, call `reply.hijack()` and write to `reply.raw`: status 200, `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Keep a `Map` from user id to that user's open responses, and remove a response when its request closes.
2. In the enrichment worker, after saving the title and description: `XADD events:user:{userId} MAXLEN ~ 1000 * ...` with type `bookmark.enriched` and `{ bookmarkId, title }`, then `PUBLISH linkbox:events` with the stream id, user id, type and data.
3. In each web instance, subscribe once at startup on a dedicated Redis connection. On each message, write an SSE event (`id` = stream id) to that user's local connections.
4. On connect, register the response first and hold its live events, then replay from the stream with `XRANGE` after `Last-Event-ID`, then send the held events, skipping ids already sent.
5. Send `: ping` every 20 seconds. Send a random `retry:` between 1,000 and 5,000 ms per connection.
6. On SIGTERM (lesson 16), end the open streams in small batches before closing the server.

**Done when**, with two instances behind your load balancer (lesson 18), a client connected to one instance receives `bookmark.enriched` within a second of creating a bookmark through the other, and a client whose instance you kill reconnects and receives the events it missed.

## Check yourself

<details markdown="1">
<summary>10,000 clients poll every 5 seconds. How many requests per second is that, and what is the average delay before a client sees an event?</summary>

2,000 requests per second, nearly all returning nothing. Average delay is half the interval, 2.5 seconds (5 at worst). Halving the delay doubles the load.
</details>

<details markdown="1">
<summary>How does an SSE client avoid missing events after a dropped connection?</summary>

Each event carries an `id`. `EventSource` reconnects on its own and sends the last id in the `Last-Event-ID` header. The server replays every event after that id from a stored history.
</details>

<details markdown="1">
<summary>Why must browsers mask WebSocket frames, given that the key is sent in the same frame?</summary>

Masking isn't secrecy. It makes the bytes on the wire unpredictable to the page's script, so an attacker can't craft frames that look like HTTP requests to old proxies and poison their caches.
</details>

<details markdown="1">
<summary>Your server listens on port 443. Can it hold more than 65,535 connections?</summary>

Yes. A connection is identified by the four-tuple (client IP, client port, server IP, server port). All connections share server port 443 and differ on the client side. Port limits bite on the connecting side, such as a proxy opening many connections to one backend address.
</details>

<details markdown="1">
<summary>Your WebSocket server shows 30,000 open connections but only 18,000 users are online. What is likely happening and what fixes it?</summary>

Half-open connections: peers that vanished without closing (sleep, network loss, NAT timeouts). TCP won't notice for a long time. A ping/pong heartbeat that terminates connections which don't answer fixes it.
</details>

<details markdown="1">
<summary>A deploy restarts an instance with 40,000 connections and the rest of the cluster falls over. Why, and what helps?</summary>

All clients reconnect at the same moment, overloading the remaining instances with handshakes, auth and history queries: a reconnect storm. Use client-side exponential backoff with jitter, close connections gradually on shutdown, and make reconnects cheap.
</details>

## Go deeper

- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455): the handshake, framing, masking (section 10.3 explains the cache-poisoning attack) and close codes.
- [HTML Standard: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html): the exact event-stream format, reconnection and `Last-Event-ID`.
- [ws on GitHub](https://github.com/websockets/ws): the Node WebSocket library; its README covers heartbeats, broadcasting and authenticating clients during the upgrade.
- [Redis: Pub/Sub](https://redis.io/docs/latest/develop/pubsub/): delivery semantics ("at-most-once"), pattern subscriptions and sharded pub/sub.
- [AWS Architecture Blog: Exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/): simulations showing why full jitter beats plain backoff for herds of clients.
- [MDN: WebTransport API](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport_API): streams and datagrams over HTTP/3, with current browser support.
