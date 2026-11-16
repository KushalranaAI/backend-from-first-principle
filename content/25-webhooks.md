---
title: Webhooks
part: Engineering practice
summary: How one server tells another that something happened, and how both sides survive forgery, replays, duplicates, reordering and outages.
---

A webhook is an HTTP request that a server sends to *you* when something happens: a payment succeeded, a commit was pushed, a user signed up. You give the provider a URL, and it calls that URL with a JSON body. You will receive webhooks from Stripe, GitHub, Clerk and Shopify, and sooner or later your own product will need to send them. Both sides are harder than they look, because the network between two companies is the least reliable network there is.

## The first principle

Your app needs to know when something changes in another system. Say a customer pays through Stripe. How does your server find out?

The obvious answer is **polling**: ask, over and over.

```
you:    any new payments?   Stripe: no
you:    any new payments?   Stripe: no
you:    any new payments?   Stripe: no
you:    any new payments?   Stripe: yes, one
```

Polling is simple and you control it, but it is a bad trade. Poll every minute and you learn about payments up to a minute late. Poll every second and you send 86,400 requests a day per customer, nearly all of them answered "no". Multiply by thousands of integrations and the provider spends most of its capacity saying nothing has happened.

Flip the direction. The provider already knows the moment something happens. Let it **push**: you register a URL once, and the provider sends an HTTP request to it when there is news.

```
Stripe ──POST /webhooks/stripe──▶ you      (only when something happened)
       ◀──────── 200 ───────────
```

That is the whole idea. A webhook is a callback over HTTP: "call me back at this URL". It removes the latency and the wasted requests, and in exchange it creates every problem this lesson is about. Your endpoint is a public URL that anyone can POST to. The provider can't tell whether you got the message. Your server might be down when it calls. Two events might arrive in the wrong order, or the same event twice.

## Core ideas

### Where the name came from, and who sends them

Jeff Lindsay coined the term in a 2007 blog post, *Web hooks to revolutionize the web*. His idea was simple: just as Unix programs pipe output into each other, web apps should let users plug a URL into any event. It caught on. GitHub, Stripe, Shopify, Twilio, Slack, Clerk and most SaaS APIs send webhooks today, and the patterns they converged on are what you'll learn here.

### One delivery, end to end

Here is what a delivery from GitHub looks like on the wire:

```
POST /webhooks/github HTTP/1.1
Host: api.example.com
Content-Type: application/json
User-Agent: GitHub-Hookshot/a1b2c3d
X-GitHub-Event: push
X-GitHub-Delivery: 72d3162e-cc78-11e3-81ab-4c9367dc0958
X-Hub-Signature-256: sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17

{"ref":"refs/heads/main","repository":{...},"pusher":{...}}
```

Every webhook has the same parts: a **POST** with a JSON body, an **event type** (here in a header; Stripe puts it in the body), a **unique delivery id**, and a **signature**. The provider records each attempt: GitHub shows every delivery, its request, your response code and how long you took, in the repository's webhook settings, with a "Redeliver" button.

### Receiving a delivery: answer fast, work later

The provider waits for your response, but not for long. GitHub gives you **10 seconds**; the Standard Webhooks spec suggests senders use a timeout of 15 to 30 seconds. If you don't answer with a `2xx` in time, the delivery counts as failed and (with most providers) will be retried. GitHub is the exception: it never redelivers on its own, so a failed delivery stays failed until you redeliver it from the settings page or through the API.

So a receiver does as little as possible before it answers:

```
1. read the raw body          (bytes, size-limited)
2. verify the signature       → 401 if wrong
3. record the event id        → if seen before, answer 2xx and stop
4. enqueue the work           (BullMQ job, or a row in a table)
5. answer 2xx                 ← all of this in milliseconds
   ... a worker does the slow part later (lesson 11)
```

Sending an email, calling three APIs and updating five tables inside the request is how you end up timing out, getting the same event again, and doing all of it twice. Stripe says it plainly: return a `2xx` before any complex logic.

Status codes matter. `2xx` means "received". Anything else, including a redirect, means "failed, try again". Return `4xx` only when retrying can never help (a bad signature), and `5xx` when you want a retry (your database is down).

### Handshakes, and a tunnel to your laptop

Some providers check that you own a URL before they send real events to it. Slack's Events API sends a `url_verification` request with a `challenge` value and expects you to echo it back. GitHub sends a `ping` event when you create a hook. WebSub sends a `hub.challenge` query parameter. These **handshakes** stop someone from pointing a provider's traffic at a URL they don't control.

During development the provider needs to reach your laptop, which has no public address. A **tunnel** gives it one: `ngrok http 3000` or `cloudflared tunnel --url http://localhost:3000` prints a public HTTPS URL that forwards to your local port. Stripe's CLI does the same for Stripe events with `stripe listen --forward-to localhost:3000/webhooks/stripe`. Register the tunnel's URL with the provider, trigger an event, and watch it arrive.

### Proving who sent it

Your webhook URL is public. Anyone who finds it can POST a fake `payment_intent.succeeded` and get free goods. Before you act on a delivery, you need to know the provider sent it and nobody changed it. The options, weakest first:

| Method | How | Weakness |
|---|---|---|
| Secret in the URL | `/webhooks/stripe/9f8e7d...` | Leaks into logs; proves nothing about the body |
| Static header or Basic auth | `Authorization: Bearer <shared token>` | Same token on every request; a leaked request can be replayed and altered |
| IP allowlist | Accept only the provider's published IP ranges | Ranges change; useful only alongside a signature |
| Mutual TLS | The provider presents a client certificate | Strong, but painful to operate; rare |
| **HMAC signature** | The provider signs each body with a shared secret | The standard choice: proves sender *and* integrity |
| Asymmetric signature | The provider signs with a private key; you verify with its public key | No shared secret to leak; Standard Webhooks' `v1a` (ed25519) |

**HMAC** (RFC 2104) is a keyed hash: `HMAC-SHA256(secret, message)` produces a 32-byte tag that only someone with the secret can compute, and that changes completely if one byte of the message changes. The provider computes it over the body and sends it in a header. You compute it again with your copy of the secret and compare. If they match, the sender knew the secret and the body is exactly what was signed.

### What exactly is signed, and the raw-body trap

Each provider signs a precise string:

| Provider | Header | Signed content | Encoding |
|---|---|---|---|
| GitHub | `X-Hub-Signature-256: sha256=<hex>` | the raw body | hex |
| Stripe | `Stripe-Signature: t=<ts>,v1=<hex>` | `<ts>.<raw body>` | hex |
| Standard Webhooks | `webhook-signature: v1,<base64>` | `<id>.<ts>.<raw body>` | base64 |

The word *raw* is where everyone gets burned. The signature covers the exact bytes the provider sent. Most frameworks parse JSON for you before your handler runs. If you take that parsed object and call `JSON.stringify` on it, you get *different bytes*: whitespace is gone, Unicode escapes change, numbers may be rewritten. The HMAC no longer matches, and the bug looks like a wrong secret.

Verify the bytes you received, before any parsing. In Fastify, give the webhook routes their own JSON parser that keeps the buffer:

```js
// plugins/webhooks.js: registered as its own plugin, so other routes are unaffected
export default async function webhooks(app) {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, JSON.parse(body)); }
    catch (err) { err.statusCode = 400; done(err); }
  });
  app.post("/webhooks/stripe", async (req, reply) => { /* verify req.rawBody */ });
}
```

### Replays, and constant-time comparison

A valid signed request is valid forever, unless something says otherwise. An attacker who captures one delivery (from a log, a proxy, a misconfigured tunnel) can send it again and again: a **replay attack**. That's why Stripe and Standard Webhooks put a **timestamp** inside the signed content. You reject any delivery whose timestamp is more than a few minutes from your clock; Stripe's libraries default to 5 minutes. The attacker can't change the timestamp without breaking the signature. Inside the window, your event-id deduplication (below) catches repeats.

The comparison itself must not leak. `a === b` on strings stops at the first byte that differs, so a wrong guess that matches the first 10 characters takes slightly longer than one that matches none. With enough measurements an attacker can recover a valid signature byte by byte. Use a **constant-time comparison**, which always looks at every byte: `crypto.timingSafeEqual` in Node (it throws if lengths differ, so check length first).

Putting it together for the Standard Webhooks format:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

// secret is "whsec_" + base64 bytes; the signature is "v1," + base64(HMAC-SHA256).
export function sign(secret, id, timestamp, body) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const mac = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(body)                       // the exact bytes on the wire
    .digest("base64");
  return `v1,${mac}`;
}

export function verify(secret, headers, rawBody, toleranceSeconds = 300) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];
  if (!id || !timestamp || !signatures) return false;

  // Replay window: reject anything signed too long ago (or too far in the future).
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = Buffer.from(sign(secret, id, timestamp, rawBody));
  // The header may hold several signatures (secret rotation), separated by spaces.
  return signatures.split(" ").some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

The list of signatures is how secrets rotate without downtime: for a while the sender signs with both the old and the new secret, and either one verifies.

### Standard Webhooks

Every provider invented its own headers and signing scheme, so every receiver writes custom verification code. **Standard Webhooks** is an open, community-driven specification (Svix is one of its main backers) that settles the details: `webhook-id`, `webhook-timestamp` and `webhook-signature` headers; signed content `id.timestamp.body`; `whsec_` secrets of 24 to 64 random bytes; payloads shaped `{ "type", "timestamp", "data" }`; guidance on timeouts, retries and payload size (keep it under about 20 KB). It ships verification libraries for many languages. If you send webhooks, follow it; your users then verify with an off-the-shelf library instead of reading your docs. The code above is compatible with it.

### SSRF: the provider's own danger

Turn around and look from the sender's side. Your users type in a URL and your servers POST to it. What if the URL is `http://169.254.169.254/latest/meta-data/` (the cloud metadata service), `http://localhost:6379` (your Redis), or `http://10.0.3.7/admin`? You have built a **server-side request forgery** tool (lesson 17): an attacker uses your server to reach your private network.

Checking the URL when it's registered isn't enough. A hostname can resolve to a public IP today and a private one tomorrow (DNS rebinding), and a public endpoint can answer with a redirect to an internal one. Defences, in layers:

- Resolve the hostname **at send time** and refuse private, loopback, link-local and metadata addresses; connect to the IP you checked.
- Don't follow redirects. Treat a `3xx` as a failed delivery.
- Send webhooks from workers in a network segment that can't reach internal services, or through an egress proxy such as Stripe's open-source **Smokescreen**, which enforces the allowlist for you.
- Cap response size and time, and never show the response body to the user verbatim.

### At least once: idempotency and ordering

The provider sends a delivery; your server processes it and replies `200`; the reply is lost on the way back. From the provider's side this looks exactly like a failure, so it sends again. No protocol can fix this: a sender can never know for sure whether a message it didn't get an acknowledgement for was processed. So every webhook system chooses **at-least-once delivery**: duplicates are possible, losses are not (until retries run out).

The receiver's job is to make duplicates harmless. Each event carries a unique id (`X-GitHub-Delivery`, the Stripe event `id`, `webhook-id`). Record it in the same transaction as the work, behind a unique constraint:

```sql
CREATE TABLE processed_webhooks (
  event_id    text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- inside the transaction that applies the event:
INSERT INTO processed_webhooks (event_id) VALUES ($1)
ON CONFLICT DO NOTHING
RETURNING event_id;          -- no row back means "already done": commit and skip
```

This is the same idempotency you used for `Idempotency-Key` (lesson 08) and for queue jobs (lesson 11).

**Ordering** is not guaranteed either. Stripe says so in its docs: `invoice.paid` can arrive before `invoice.created`. Retries make it worse: event 1 fails and is retried in five minutes, event 2 succeeds now. Two ways to cope:

- **Compare versions.** Ignore an event older than the state you already have (`updated_at` or a version number on the resource).
- **Treat the event as a nudge.** On any `customer.updated`, fetch the customer's current state from the provider's API instead of trusting the snapshot in the payload. Stripe's *thin events* are designed this way: they carry an id, not a snapshot, and Stripe now recommends them for new integrations.

### Retries, backoff and jitter

When a delivery fails, the sender retries. Retrying immediately in a loop is the worst choice: if the receiver is down, you hammer it; when it comes back, a flood of queued retries knocks it over again. Two ideas fix this:

- **Exponential backoff.** Wait longer after each failure: 5 seconds, then minutes, then hours. The total retry window must be long enough to outlast a real outage. Stripe retries for up to three days; Svix makes 8 attempts over about 27 hours (immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h).
- **Jitter.** If a receiver was down for an hour, thousands of deliveries failed at nearly the same moment, and with identical backoff they all retry at the same moment again. Add randomness to every delay. AWS's well-known analysis compares variants; "full jitter" picks a random delay between 0 and the backoff ceiling: `delay = random(0, min(cap, base * 2^attempt))`.

This is the clock against the load: retries must be spread far enough apart to give the receiver time to recover, and randomised enough that they don't arrive as one wave. After the last attempt, mark the delivery failed, show it in a dashboard with a "resend" button, and after sustained failures disable the endpoint and email its owner. Honour `Retry-After` if the receiver sends one, and treat `410 Gone` as "stop sending to this URL".

### Building your own: the outbox

Now the producer side. When a bookmark is created, Linkbox must send `bookmark.created` to each URL the user registered. The naive version sends the request inside the API handler:

```js
await db.query("INSERT INTO bookmarks ...");
await fetch(endpoint.url, { ... });     // what if this fails? what if we crash right here?
```

This is a **dual write**: two systems (your database and someone else's server) that must both change, with no transaction covering both. If the insert commits and the process dies before the POST, the event is lost forever. If you POST first and the insert then fails, you announced a bookmark that doesn't exist. Enqueuing a BullMQ job instead of POSTing has the same problem, because Redis and Postgres don't share a transaction.

The **transactional outbox** removes the dual write. In the *same database transaction* as the change, insert a row describing the message into an outbox table. Either both commit or neither does. A separate process, the **dispatcher**, reads the outbox and does the sending.

```
API request ─▶ BEGIN
               INSERT INTO bookmarks ...
               INSERT INTO webhook_outbox ... (one row per endpoint)
               COMMIT                      ← the event exists iff the bookmark does

dispatcher ─▶ claim due rows ─▶ sign ─▶ POST ─▶ record result ─▶ schedule retry
```

### The dispatcher: sign, POST, record, retry

The dispatcher claims a batch of due rows with `FOR UPDATE SKIP LOCKED`, so several dispatcher processes never grab the same row, and pushes `next_attempt_at` forward as a **lease**: if the dispatcher crashes mid-send, the row becomes due again after two minutes and another process picks it up. That can cause a duplicate delivery, which is fine, because receivers deduplicate by `webhook-id`. At-least-once again. The full code is in the build step below.

### When a webhook is the wrong tool: syncing

Webhooks are good at "tell me when something happens so I can react": send a receipt, start a build, post to Slack. They are bad at "keep my copy of your data identical to yours". For syncing, every weakness adds up: a delivery that exhausted its retries during your weekend outage is gone; events arrive out of order; a bug that dropped events for a day leaves silent gaps you can't find. Clerk's own guide to syncing user data says it plainly: deliveries are not guaranteed, events can arrive out of order or more than once, and a webhook-fed copy is only eventually consistent.

### The event log: the right way to sync

The alternative is to let the consumer **pull from an ordered log of events**. The provider exposes `GET /events?after=<cursor>`, returning events in order with a cursor. The consumer stores the last cursor it processed and asks for everything after it. If it is down for a day, it catches up when it returns. If it has a bug, it rewinds the cursor and replays. Nothing is lost, and order is guaranteed by the log. Stripe's `/v1/events` endpoint lets you page through the last 30 days of events in this spirit, and Brandur Leach's essay on webhooks argues for it at length.

The two combine well: send a small webhook as a **nudge** ("there's something new"), and let the consumer pull the log to find out what. If a nudge is lost, the next one, or a periodic poll, catches everything up.

## Try it

Build a receiver and a sender with nothing but Node. Save the `sign` and `verify` functions above as `webhook-sign.mjs`, then this as `receiver.mjs`:

```js
import http from "node:http";
import { verify } from "./webhook-sign.mjs";

const SECRET = process.env.WEBHOOK_SECRET;
const seen = new Set();            // in-memory for the demo; use a table in real code
const queue = [];

http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/linkbox") return res.writeHead(404).end();
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > 256 * 1024) req.destroy();       // refuse huge bodies
    else chunks.push(c);
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks);           // verify the bytes, not a re-serialised object
    if (!verify(SECRET, req.headers, raw)) return res.writeHead(401).end();
    const id = req.headers["webhook-id"];
    if (!seen.has(id)) { seen.add(id); queue.push(JSON.parse(raw)); }
    res.writeHead(204).end();                    // answer fast; work later
  });
}).listen(4000, () => console.log("receiver on :4000"));

setInterval(() => {
  const event = queue.shift();
  if (event) console.log("processing", event.type, event.data);
}, 500);
```

And `send.mjs`, which plays the provider:

```js
import { randomUUID } from "node:crypto";
import { sign } from "./webhook-sign.mjs";

const id = process.argv[2] ?? `msg_${randomUUID()}`;
const timestamp = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  type: "bookmark.created",
  timestamp: new Date().toISOString(),
  data: { id: "42", url: "https://example.com" },
});

const res = await fetch("http://localhost:4000/webhooks/linkbox", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": sign(process.env.WEBHOOK_SECRET, id, timestamp, body),
  },
  body,
  signal: AbortSignal.timeout(15_000),
});
console.log(id, res.status);
```

```bash
export WEBHOOK_SECRET="whsec_$(node -p 'require("node:crypto").randomBytes(32).toString("base64")')"
node receiver.mjs &
node send.mjs                       # 204, processed once
node send.mjs msg_same              # 204, processed
node send.mjs msg_same              # 204, NOT processed again: duplicate id
WEBHOOK_SECRET=whsec_d3Jvbmc= node send.mjs     # 401: wrong secret
```

Break it on purpose:

1. In the receiver, replace `raw` with `Buffer.from(JSON.stringify(JSON.parse(raw), null, 2))` before verifying. Every delivery now fails. That is the raw-body trap.
2. In `send.mjs`, set `timestamp` to ten minutes ago. Which check rejects it?
3. Add `await new Promise(r => setTimeout(r, 20_000))` before `res.writeHead(204)`. The sender's 15-second timeout fires; the receiver still processes the event. What will a real provider do next, and why does the `seen` check save you?
4. Expose the receiver with `ngrok http 4000` or `cloudflared tunnel --url http://localhost:4000` and send to the public URL instead.

## Common mistakes

- **Verifying a re-serialised body.** The signature never matches, so someone "temporarily" turns verification off. Verify the raw bytes, before any JSON parsing.
- **Doing the work before answering.** The handler takes 12 seconds, the provider times out and retries, and the work runs twice. Verify, record the id, enqueue, answer `2xx`.
- **No deduplication.** A retried `payment.succeeded` ships the order twice. Store event ids under a unique constraint, in the same transaction as the effect.
- **Comparing signatures with `===`.** It leaks timing. Use `crypto.timingSafeEqual` after a length check.
- **Sending webhooks from the API handler.** A crash between commit and POST loses the event. Write to an outbox in the same transaction and dispatch separately.
- **POSTing to any URL a user types.** That is SSRF into your own network. Resolve and check addresses at send time, refuse redirects, and send from an isolated network or through an egress proxy.

## Build: Linkbox, step 25

Linkbox becomes a webhook *provider*: users register a URL and receive `bookmark.created`, signed with the Standard Webhooks scheme.

1. Add a migration with two tables:

```sql
CREATE TABLE webhook_endpoints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- match your users.id type
  url         text NOT NULL,
  secret      text NOT NULL,
  disabled_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_outbox (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- sent as webhook-id
  endpoint_id     bigint NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  failed_at       timestamptz,
  last_status     int,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_outbox_due ON webhook_outbox (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;
```

2. Add `POST /api/v1/webhook-endpoints` (body: `{ url }`). Validate the URL with your SSRF check from lesson 17, generate `whsec_` plus 32 random bytes in base64, store it, and return it **once** in the 201 response. Add `GET` (without secrets) and `DELETE`. Document all three in `openapi.yaml` (lesson 24).

3. In the bookmark service's create transaction, after the insert, fan out to the outbox:

```sql
INSERT INTO webhook_outbox (endpoint_id, event_type, payload)
SELECT id, 'bookmark.created', $2::jsonb
FROM webhook_endpoints
WHERE user_id = $1 AND disabled_at IS NULL;
```

4. Write `src/webhooks/dispatcher.js` and start it from `src/worker.js` (lesson 23), not from the web process:

```js
import { setTimeout as sleep } from "node:timers/promises";
import { pool } from "../db.js";
import { sign } from "./sign.js";
import { assertPublicUrl } from "../security/ssrf.js";   // your lesson 17 guard

const RETRY_DELAYS = [5, 300, 1800, 7200, 18000, 36000, 36000];  // seconds; 8 attempts in all

export function nextDelay(attempts) {
  const base = RETRY_DELAYS[attempts - 1];
  if (base === undefined) return null;                  // out of attempts
  return base * (0.8 + Math.random() * 0.4);            // ±20% jitter
}

const CLAIM = `
  UPDATE webhook_outbox o
  SET next_attempt_at = now() + interval '2 minutes'    -- a lease: if we crash, it comes back
  FROM webhook_endpoints e
  WHERE e.id = o.endpoint_id
    AND o.id IN (
      SELECT id FROM webhook_outbox
      WHERE delivered_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT 10
      FOR UPDATE SKIP LOCKED)
  RETURNING o.id, o.event_type, o.payload, o.attempts, o.created_at, e.url, e.secret`;

async function deliver(row) {
  const body = JSON.stringify({
    type: row.event_type, timestamp: row.created_at.toISOString(), data: row.payload,
  });
  const ts = Math.floor(Date.now() / 1000);
  try {
    await assertPublicUrl(row.url);                     // check at send time, not just at signup
    const res = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Linkbox-Webhooks/1.0",
        "webhook-id": row.id,
        "webhook-timestamp": String(ts),
        "webhook-signature": sign(row.secret, row.id, ts, body),
      },
      body,
      redirect: "manual",                               // a 3xx is a failure, never followed
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel();                           // we don't need the body; free the socket
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function record(row, r) {
  if (r.ok) {
    await pool.query(
      `UPDATE webhook_outbox SET delivered_at = now(), attempts = attempts + 1, last_status = $2
       WHERE id = $1`, [row.id, r.status]);
    return;
  }
  const delay = r.status === 410 ? null : nextDelay(row.attempts + 1);
  if (delay === null) {
    await pool.query(
      `UPDATE webhook_outbox SET failed_at = now(), attempts = attempts + 1,
         last_status = $2, last_error = $3 WHERE id = $1`, [row.id, r.status, r.error ?? null]);
  } else {
    await pool.query(
      `UPDATE webhook_outbox SET attempts = attempts + 1, last_status = $2, last_error = $3,
         next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
      [row.id, r.status, r.error ?? null, delay]);
  }
}

export async function runDispatcher(signal) {
  while (!signal.aborted) {
    const { rows } = await pool.query(CLAIM);
    await Promise.all(rows.map(async (row) => record(row, await deliver(row))));
    if (rows.length === 0) await sleep(1000, undefined, { signal }).catch(() => {});
  }
}
```

5. On `SIGTERM`, abort the dispatcher's signal and let the in-flight batch finish (lesson 16). Rows left mid-send come back after their lease.
6. Use the `receiver.mjs` from *Try it* as a test consumer: register `http://localhost:4000/webhooks/linkbox` (allow localhost only in development), create a bookmark, and watch it arrive. Stop the receiver, create another, start it again, and watch the retry land.

**Done when** creating a bookmark produces exactly one outbox row per active endpoint in the same transaction, a stopped receiver gets the event after it restarts, a wrong secret fails verification, and killing the worker mid-send never loses an event.

## Check yourself

<details markdown="1">
<summary>Why do providers deliver webhooks "at least once" instead of "exactly once"?</summary>

If the receiver's `2xx` is lost, the sender can't tell a processed delivery from a failed one, so it must retry or risk losing the event. Duplicates are the price; receivers make them harmless by deduplicating on the event id.
</details>

<details markdown="1">
<summary>Your HMAC check fails for every delivery, but the secret is right. What is the most likely cause?</summary>

You're signing a re-serialised body. The framework parsed the JSON and you called `JSON.stringify` on the result, which produces different bytes. Verify the raw request body before parsing.
</details>

<details markdown="1">
<summary>What does the timestamp in a signed webhook protect against, and why must it be inside the signed content?</summary>

Replay attacks: a captured delivery can't be re-sent after the tolerance window (often 5 minutes). If the timestamp weren't signed, an attacker could simply update it.
</details>

<details markdown="1">
<summary>Why add jitter to retry delays?</summary>

After an outage many deliveries failed at the same moment. With identical backoff they'd all retry at the same moment too and overload the recovering receiver. Randomising each delay spreads the load out.
</details>

<details markdown="1">
<summary>What problem does the transactional outbox solve that "enqueue a job after commit" does not?</summary>

The dual write. The database and the queue (or the receiver) can't commit together, so a crash between them loses or invents events. Writing the outbox row in the same transaction as the change guarantees the event exists exactly when the change does.
</details>

<details markdown="1">
<summary>A partner wants to keep a full copy of a user's bookmarks in their system. Are webhooks the right tool?</summary>

Not on their own. Lost deliveries, reordering and silent gaps make a webhook-fed copy drift. Give them an ordered event log (`GET /events?after=cursor`) to pull from, and use webhooks only as a nudge to pull sooner.
</details>

## Go deeper

- [Jeff Lindsay: Web hooks to revolutionize the web (2007)](https://progrium.github.io/blog/2007/05/03/web-hooks-to-revolutionize-the-web/): the post that named the idea, and the vision behind it.
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md): headers, signing, secrets, retries and SSRF guidance in one short document.
- [Stripe: Receive events in your webhook endpoint](https://docs.stripe.com/webhooks): a mature provider's rules on raw bodies, replay windows, ordering, duplicates and retries.
- [GitHub: Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries): `X-Hub-Signature-256` with code in several languages.
- [Brandur Leach: Should you build a webhooks API?](https://brandur.org/webhooks): why an event log beats webhooks for syncing, from an engineer who worked on Stripe's API.
- [AWS Builders' Library: Timeouts, retries and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/): why retries need backoff and jitter, with the reasoning behind each choice.
