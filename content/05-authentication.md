---
title: Authentication and authorization
part: The request
summary: How a server learns who is calling, remembers it across requests, and decides what that caller may do.
---

Every request that reaches your server comes from a stranger. Authentication is how the server finds out who that stranger is; authorization is how it decides what they may do. Get either one wrong and users read each other's data, which is the most common serious bug in real APIs. Almost every endpoint you write will depend on both.

## The first principle

HTTP is stateless (lesson 02). Each request arrives on its own, with no memory of the one before. If Ana logs in with request 1, request 2 knows nothing about it. So a server that wants to treat Ana as Ana has two separate problems:

1. **Proving identity once.** Ana shows something only she should have: a password she knows, a phone she holds, a fingerprint she is. These are the three classic *factors*: something you know, something you have, something you are.
2. **Remembering it on every later request.** Asking for the password on every click is unusable, and sending the password with every request spreads it everywhere. So after the proof, the server hands Ana a **credential**: a value she sends back with each request that says "I am the one who logged in a minute ago."

Once the server knows who is calling, a third problem appears:

3. **Deciding what they may do.** Ana may read her own bookmarks, not Bo's. An admin may delete any account; a member may not.

Steps 1 and 2 are **authentication** (authn): *who are you?* Step 3 is **authorization** (authz): *are you allowed to do this?* Everything in this lesson is a way of solving one of those three steps: password hashing for step 1, sessions, tokens, cookies and API keys for step 2, roles and ownership checks for step 3.

> Authentication answers "who". Authorization answers "may they". A system can get the first right and the second badly wrong, and attackers know it.

## Core ideas

### A short history: passwords, sessions, tokens

The tools you will use today each fixed a problem the previous one left behind.

- **Passwords (1960s).** MIT's time-sharing system CTSS gave each user a password. They sat in a plain file, and more than once that file leaked.
- **Hashed and salted passwords (1970s).** Unix stored a one-way *hash* instead of the password; Morris and Thompson's 1979 paper "Password Security: A Case History" describes it, salt included.
- **Tickets (1980s).** MIT's Kerberos let you prove your identity once and receive a time-limited *ticket* for other services: the ancestor of today's tokens.
- **Cookies and sessions (1990s).** Netscape added cookies in 1994. Servers kept "who is logged in" on their side and gave the browser only a random session id.
- **Tokens and delegation (2010s).** OAuth 2.0 (2012) let users grant an app limited access without sharing a password, OpenID Connect (2014) built "Sign in with Google" on it, and JWTs (2015) standardized signed, self-contained tokens.
- **Passkeys (now).** WebAuthn (2019) replaces the shared secret with a key pair on the user's device that can't be phished. Its third version (Level 3) became a W3C Recommendation in August 2026.

None of these replaced the others completely. A modern backend uses hashed passwords, sessions, tokens and OAuth side by side.

### Storing passwords: hash, salt, and make it slow

The first rule: **never store a password you could read back.** Not in plain text, not encrypted. If your database leaks (and many do), the attacker should get nothing they can log in with, here or on any other site where the user reused the password.

So you store a **hash**: the output of a one-way function. At login you hash what the user typed and compare. You can check a password without ever being able to recover it.

But a plain hash is not enough, for two reasons.

**Identical passwords give identical hashes.** Attackers precompute hashes of millions of common passwords (a *rainbow table*) and look yours up. The fix is a **salt**: 16 random bytes generated per user and stored next to the hash. The same password now hashes differently for every user, and precomputed tables are useless.

**General-purpose hashes are too fast.** SHA-256 was built to be fast. Even plain JavaScript on one laptop core computes close to a million SHA-256 hashes a second; a single modern GPU does billions. An attacker with your salted SHA-256 hashes can still try every common password against every user in hours. The fix is a **password hashing function**: one that is deliberately slow and uses a lot of memory, so each guess costs real time and RAM, and GPUs lose most of their advantage.

| Algorithm | Status | OWASP minimum settings |
|---|---|---|
| **Argon2id** | First choice | 19 MiB memory, 2 iterations, parallelism 1 |
| **scrypt** | Use if Argon2id isn't available | N = 2^17 (128 MiB), r = 8, p = 1 |
| **bcrypt** | Legacy systems | cost 10 or more; only the first 72 bytes of the password count |
| **PBKDF2** | When FIPS-140 compliance is required | 600,000 iterations of HMAC-SHA-256 |
| SHA-256, SHA-1, MD5 | Never for passwords | Too fast, no memory cost |

Node has `crypto.scrypt` built in, so that is what Linkbox uses. Node 24.7 added `crypto.argon2`; if you run 24.7 or newer, Argon2id is a fine swap: `argon2("argon2id", { message: password, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32 }, callback)`, with `memory` counted in KiB. Store the algorithm and its parameters with the hash (`scrypt$131072$8$1$salt$hash`) so you can raise the cost later and re-hash each user's password the next time they log in.

Two more rules from current guidance (NIST SP 800-63B, OWASP): allow long passwords and passphrases (at least 64 characters), and check new passwords against lists of breached passwords instead of forcing "one capital, one symbol" rules or periodic changes.

The minimum length went up in revision 4 of the NIST guideline, final since July 2025. When a password is the only factor, require at least 15 characters. Eight is acceptable only when a second factor is also required. OWASP's cheat sheet now says the same.

### Stateful sessions

After a successful login, the classic approach is a **server-side session**:

```
1. POST /login  {email, password}
2. server checks the hash, creates   sessions["k8Jf2..."] = { userId: 7, expiresAt: ... }
3. response:    Set-Cookie: sid=k8Jf2...; HttpOnly; Secure; SameSite=Lax
4. every later request:  Cookie: sid=k8Jf2...
5. server looks up sid → userId 7
```

The session id is just a random key: 32 bytes from a cryptographically secure generator (`crypto.randomBytes`), long enough that nobody can guess one. It means nothing on its own. All the facts (which user, when it expires) live on the server, in memory at first, later in Postgres or Redis (lessons 09 and 10).

That is why it's called **stateful**: the server holds state for each logged-in user. The cost is a lookup on every request and a shared store once you run several servers. The big benefit is **control**. To log a user out, delete the row. To log them out everywhere after a password change, delete all their rows. It takes effect on the very next request.

Two session rules worth remembering: issue a **new** session id at login (never reuse one that existed before, which prevents *session fixation*), and give sessions both an idle timeout and an absolute lifetime.

### Cookies and their flags

A cookie is a small name and value the server asks the browser to store (`Set-Cookie`) and send back automatically on later requests to the same site (`Cookie`). That automatic sending is what makes sessions work without any client code, and also what makes cookies dangerous, so the flags matter:

| Attribute | What it does | Why you want it |
|---|---|---|
| `HttpOnly` | JavaScript can't read the cookie (`document.cookie` hides it) | An XSS bug can't steal the session id |
| `Secure` | Sent only over HTTPS | Nobody on the network can sniff it. Chrome, Firefox and curl still accept it on `http://localhost` for development |
| `SameSite=Lax` | Not sent on cross-site sub-requests (forms posted from other sites, images, fetches); sent when the user follows a link to you | Blocks most cross-site request forgery (CSRF). `Strict` is tighter; `None` requires `Secure` and turns the protection off |
| `Max-Age` / `Expires` | When the browser deletes it | Without one, it's a "session cookie" that lives until the browser closes |
| `Path` / `Domain` | Which URLs get the cookie | Leave `Domain` unset so subdomains don't receive it |
| `__Host-` name prefix | The browser rejects the cookie unless it is `Secure`, `Path=/` and has no `Domain` | Locks the cookie to exactly your host |

A good session cookie looks like `Set-Cookie: __Host-sid=k8Jf2...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`. Chrome treats a cookie with no `SameSite` as `Lax`, but other browsers differ, so always set it. CSRF in depth is lesson 17.

### Stateless tokens and JWTs

Sessions need a lookup on every request. Some systems want to skip it: many services that all need to know the user, or a token issued by one company and checked by another. The idea is a **self-contained token**: put the facts (user id, expiry) *inside* the credential and sign it, so any server holding the key can check it without a database.

The common format is the **JSON Web Token** (JWT, RFC 7519). It is three base64url strings joined by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 . eyJzdWIiOiI0MiIsImV4cCI6MTc2... . 3qT0...
         header                                payload (claims)                  signature
{"alg":"HS256","typ":"JWT"}      {"sub":"42","exp":1763290000,"iss":"..."}
```

- The **header** names the signing algorithm.
- The **payload** holds *claims*: `sub` (subject, the user), `exp` (expiry, in seconds since 1970), `iat` (issued at), `iss` (issuer), `aud` (audience, who it's meant for).
- The **signature** is computed over the first two parts with a key. With **HS256** it's an HMAC with a shared secret: whoever can verify can also sign. With **RS256**, **ES256** or **EdDSA** a private key signs and a public key verifies, so many services can check tokens that only one can issue.

Two facts trip people up:

1. **A JWT is signed, not encrypted.** Anyone can base64-decode the payload and read it (paste one into jwt.io). Never put secrets or personal data in it.
2. **Verification is your job and has rules.** Pin the algorithms you accept (the old `"alg": "none"` trick and algorithm-confusion attacks rely on servers that trust the header). Check `exp`, `iss` and `aud`. Use a maintained library such as `jose` instead of writing your own. RFC 8725 lists the rules.

### Why you can't easily revoke a JWT, and refresh tokens

The strength of a stateless token is also its weakness. The server checks the signature and the expiry, and that's it. If a token is stolen, or the user logs out, or an admin bans them, the token stays valid until `exp`. There is no row to delete.

The usual answer is two tokens:

| | Access token | Refresh token |
|---|---|---|
| Lifetime | Short: 5–15 minutes | Long: days or weeks |
| Sent with | Every API request | Only to the token endpoint, to get a new access token |
| Checked how | Signature and claims, no lookup | Looked up in the database |
| Revocable | No, it just expires soon | Yes, delete or mark it |

Logging out deletes the refresh token, so at worst the user stays logged in for a few more minutes. Good systems also **rotate** refresh tokens: each use returns a new one and invalidates the old one, and if an old one is ever presented again, the server assumes theft and revokes the whole family.

Notice what happened: to make JWTs revocable, you added a database table of refresh tokens. That's state again. Other fixes (a deny-list of revoked token ids, `jti`, or a per-user "tokens before this time are invalid" timestamp) also need a lookup.

### Sessions or JWTs?

| | Server-side session | JWT |
|---|---|---|
| Where the facts live | Server store | Inside the token |
| Per-request cost | One lookup (fast in Redis) | Signature check, no I/O |
| Logout and ban | Immediate | Waits for expiry, or needs extra state |
| Size on the wire | ~45-character id | Often 300+ bytes, on every request |
| Good fit | A browser app and its own backend | Service-to-service calls, tokens issued by an identity provider, OAuth access tokens |

For a web app talking to its own API, a session id in an `HttpOnly` cookie is the simpler and safer default. Reach for JWTs when a token must be checked by parties that don't share your session store. Don't store either one in `localStorage`: any XSS bug can read it.

### API keys

Some callers aren't people: a script, a partner's server, a CI job. They can't do an interactive login, so you give them an **API key**: a long random secret they send in a header.

```
Authorization: Bearer lbx_live_7f3kQ9...     (or a custom header such as X-API-Key)
```

How to issue them well:

- Generate 32 random bytes and add a recognizable prefix (`lbx_live_`). Stripe's `sk_live_` keys work this way, and the prefix lets secret scanners spot leaked keys on GitHub.
- **Show the key once, store only its hash.** Here a fast hash such as SHA-256 is fine: the key is random with 256 bits of entropy, so there is nothing to guess. Slow hashing is for low-entropy human passwords.
- Give each key a name, an owner, scopes (read-only, bookmarks only) and a last-used time, and let users revoke and rotate keys.

### OAuth 2.0: letting an app act for you

Suppose a reading-list app wants to import your Linkbox bookmarks. The bad old way: give the app your Linkbox password. Now it can do anything you can, forever, and you can't take it back without changing your password.

**OAuth 2.0** (RFC 6749) solves *delegation*. Instead of your password, the app gets an **access token** that is limited in **scope** (`bookmarks:read`), limited in time, and revocable, and you approve it on Linkbox's own login page. The roles:

- **Resource owner**: you.
- **Client**: the reading-list app.
- **Authorization server**: the service that logs you in and issues tokens (Linkbox, Google, Auth0, Keycloak).
- **Resource server**: the API holding your data.

The flow to use today is the **authorization code flow with PKCE** (pronounced "pixie", RFC 7636):

```
Client app                     Authorization server                    You
   │ 1. make random code_verifier;
   │    code_challenge = base64url(SHA-256(code_verifier))
   │ 2. redirect browser ──────────▶ /authorize?client_id&redirect_uri
   │                                  &scope&state&code_challenge
   │                                         │ 3. log in, approve scopes ◀──▶
   │ 4. ◀──── redirect to redirect_uri?code=abc&state=...
   │ 5. POST /token  code=abc + code_verifier ─▶ hashes the verifier, compares to challenge
   │ 6. ◀──── { access_token, refresh_token, expires_in }
   │ 7. GET /api/bookmarks  Authorization: Bearer <access_token> ──▶ resource server
```

Why each piece exists:

- The **code** in step 4 travels through the browser's address bar, where it could leak. It is useless on its own: it is short-lived, single-use, and must be exchanged in a direct server-to-server call (step 5).
- **PKCE** proves that whoever exchanges the code is the same app that started the flow. An attacker who steals the code doesn't have the `code_verifier`, which never left the app.
- **`state`** is a random value the client checks when the browser comes back, so an attacker can't splice their own login into your session.

Older flows are deprecated. The *implicit* flow put tokens straight in the URL, and the *password* grant had the app collect your password, the very thing OAuth was made to avoid. RFC 9700 (OAuth 2.0 Security Best Current Practice, 2025) says to use authorization code with PKCE for every kind of client. OAuth 2.1, still an IETF draft in late 2026, writes the same rules into the core specification: PKCE is required, and the implicit and password grants are gone. For machine-to-machine calls with no user, there is the **client credentials** grant.

### OpenID Connect: logging in with someone else's account

OAuth is about *authorization*: "this app may read your bookmarks." It doesn't say who you are. Apps abused it for login anyway, and each did it differently, sometimes insecurely. **OpenID Connect** (OIDC) is a thin standard layer on top of OAuth for exactly that.

Add the `openid` scope to the same authorization code flow, and the token response includes an **ID token**: a JWT signed by the provider that says who logged in.

```json
{ "iss": "https://accounts.google.com", "sub": "1098...", "aud": "your-client-id",
  "email": "ana@example.com", "nonce": "n-0S6...", "exp": 1763290000 }
```

Your backend verifies the signature with the provider's public keys (published at a well-known URL), checks `iss`, `aud` (must be *your* client id), `exp` and the `nonce` it sent, and then treats `iss` + `sub` as the stable user identity. Not the email: emails change and get reused. This is what "Sign in with Google" does under the hood. In practice you use a certified library or a hosted provider rather than implementing the flow by hand.

### Multi-factor authentication

Passwords get phished, reused and leaked. **MFA** asks for a second factor of a different kind, so one stolen secret isn't enough. From weakest to strongest:

- **SMS codes**: better than nothing, but vulnerable to SIM swapping and phishing.
- **TOTP apps** (Google Authenticator, 1Password): a 6-digit code computed from a shared secret and the current 30-second window (RFC 6238). Can still be phished by a fake login page that relays the code.
- **Passkeys and security keys** (WebAuthn): the device signs a challenge with a private key bound to your domain. A fake site gets a signature for the wrong domain, which is useless. This is the phishing-resistant option.

On the backend, MFA is a second step after the password check: the session is marked "password ok, second factor pending" until the code or signature is verified.

### Authorization models

Once you know who the caller is, every request needs a rule that says yes or no. Three common models:

- **RBAC (role-based).** Users get roles (`admin`, `editor`, `member`); roles get permissions (`bookmarks:delete:any`). Simple, easy to audit, and enough for most apps. It breaks down when rules depend on the data itself.
- **ABAC (attribute-based).** Decisions use attributes of the user, the resource and the context: "editors may edit documents in their own department during office hours." Flexible but harder to reason about. Policy engines such as OPA or Cedar help.
- **Ownership and relationships (ReBAC).** "You may edit this bookmark because you own it", or "because it's in a folder shared with you." Google's Zanzibar paper describes the large-scale version; most apps start with a single `owner_id` column.

Whatever the model, the rules are the same: check on the **server**, on **every** request, and **deny by default**. Hiding the delete button in the UI is not authorization.

The most common real-world bug here is a missing ownership check. `GET /bookmarks/42` loads bookmark 42 for any logged-in user, and Bo changes the number to read Ana's data. OWASP calls this **Broken Object Level Authorization** (BOLA) and ranks it the number one API security risk. The fix is boring and must be everywhere: load the object, then compare its owner with the caller, or better, put the owner in the query itself (`WHERE id = $1 AND owner_id = $2`).

### 401 versus 403

| Status | Name in the spec | Means | Client should |
|---|---|---|---|
| `401` | Unauthorized | "I don't know who you are": no credential, or an invalid or expired one | Log in or refresh the token, then retry |
| `403` | Forbidden | "I know who you are, and you may not do this" | Not retry with the same credential |
| `404` | Not Found | Often used instead of 403 to hide that a resource exists | |

The name "Unauthorized" for 401 is a historical mistake: it means *unauthenticated*. RFC 9110 says a 401 response must include a `WWW-Authenticate` header naming how to authenticate, for example `WWW-Authenticate: Bearer`.

For objects that belong to someone else, many APIs (GitHub among them) answer **404**, not 403, so an attacker can't even learn that bookmark 42 exists. Linkbox does the same.

### Generic error messages and timing attacks

Your login endpoint can leak which emails have accounts. That list is valuable to attackers: they know exactly whom to phish or credential-stuff.

**Leak 1: the message.** "No account with that email" versus "Wrong password" tells an attacker which emails are real. Always answer the same thing: `401 invalid email or password`. Password reset should say "If that email has an account, we've sent a link." Sign-up is harder to hide; rate limits and confirming by email help.

**Leak 2: the timing.** Even with the same message, a naive login returns in 1 ms when the email doesn't exist (no hash to compute) and 300 ms when it does (scrypt ran). Measure a few hundred requests and the difference is obvious. The fix is to **always do the same work**: if the user doesn't exist, verify the password against a dummy hash anyway.

**Leak 3: the comparison.** `a === b` on strings stops at the first byte that differs, so comparing a secret this way leaks, in theory, how many leading bytes were right. For hashes, tokens and signatures, use a constant-time compare: `crypto.timingSafeEqual(a, b)` in Node. It takes two buffers of the same length and always looks at every byte.

Finally, slow down guessing: rate-limit login by account and by IP (lesson 17).

## Try it

**1. Why fast hashes are dangerous.** Save as `hash-speed.mjs` and run it:

```js
import { createHash, scrypt, randomBytes } from "node:crypto";
import { promisify } from "node:util";
const scryptAsync = promisify(scrypt);

let t = performance.now();
for (let i = 0; i < 1_000_000; i++) createHash("sha256").update("hunter2" + i).digest();
console.log("SHA-256: 1,000,000 hashes in", Math.round(performance.now() - t), "ms");

t = performance.now();
await scryptAsync("hunter2", randomBytes(16), 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
console.log("scrypt (N=2^17): 1 hash in", Math.round(performance.now() - t), "ms");
```

On a laptop you'll see something like a million SHA-256 hashes in about 1.5 seconds, and one scrypt hash in about 300 ms. The attacker pays that 300 ms (and 128 MiB of RAM) for every single guess.

**2. Build and break a JWT by hand.** Save as `jwt.mjs`:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = "dev-only-secret-use-32-random-bytes";
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const sign = (data) => createHmac("sha256", SECRET).update(data).digest("base64url");

function issue(payload) {
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url(payload);
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

function verify(token) {
  const [head, body, sig = ""] = token.split(".");
  const header = JSON.parse(Buffer.from(head, "base64url"));
  if (header.alg !== "HS256") throw new Error("unexpected alg");   // pin the algorithm
  const good = Buffer.from(sign(`${head}.${body}`));
  const given = Buffer.from(sig);
  if (good.length !== given.length || !timingSafeEqual(good, given)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url"));
  if (claims.exp <= Date.now() / 1000) throw new Error("expired");
  return claims;
}

const now = Math.floor(Date.now() / 1000);
const token = issue({ sub: "42", role: "member", iat: now, exp: now + 900 });
console.log(token, verify(token));

const [h, , s] = token.split(".");   // keep the header and signature, swap the payload
const forged = `${h}.${b64url({ sub: "42", role: "admin", iat: now, exp: now + 900 })}.${s}`;
try { verify(forged); } catch (e) { console.log("forged token:", e.message); }
```

Run it, then paste the printed token into [jwt.io](https://jwt.io/) and read the payload without any key. This is for learning only; in real code use a library such as `jose`.

Break it on purpose:

1. Change `exp: now + 900` to `exp: now - 1`. Which check fails?
2. Build a token whose header says `{"alg":"none"}` and whose signature is empty. Remove the `header.alg` check and see whether anything else stops it. Put the check back.
3. Change one character of `SECRET` between `issue` and `verify`. This is what happens when two servers have different keys.
4. In `hash-speed.mjs`, drop `maxmem`. Node refuses: the default limit is 32 MiB, and N = 2^17 with r = 8 needs 128 MiB.

## Common mistakes

- **Fast or unsalted password hashes.** `sha256(password)` falls to a GPU in hours. Use Argon2id, scrypt or bcrypt with a per-user salt, and store the parameters so you can raise them later.
- **Trusting a JWT you didn't verify properly.** Decoding is not verifying. Pin the algorithm, check `exp`, `iss` and `aud`, and use a library. Keep access tokens short-lived, since you can't revoke them.
- **Tokens in `localStorage` or URLs.** Any XSS reads `localStorage`; URLs end up in logs and `Referer` headers. Use `HttpOnly`, `Secure`, `SameSite` cookies for browser sessions and the `Authorization` header for API clients.
- **Checking that the user is logged in, but not that they own the object.** This is BOLA, the top API risk. Scope every query by owner, or check ownership after loading.
- **Different answers for "no such user" and "wrong password".** Different messages, status codes or response times all leak which accounts exist. Same message, same work, constant-time comparisons.
- **Not invalidating sessions.** Logout must delete the session on the server, and a password change should end all of the user's other sessions.

## Build: Linkbox, step 5

Linkbox gets users. Everything stays in memory (Postgres arrives in lesson 09), and you keep the `node:http` server, router and JSON helpers from lessons 03 and 04. The snippets below call them `readJson(req)` and `send(res, status, body, headers)`; adapt the names to yours.

1. Create `auth.js` with password hashing. The stored string carries its own parameters:

   ```js
   import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
   import { promisify } from "node:util";

   const scryptAsync = promisify(scrypt);
   const N = 2 ** 17, r = 8, p = 1;                       // OWASP minimum for scrypt
   const opts = (N, r, p) => ({ N, r, p, maxmem: 256 * N * r });

   export async function hashPassword(password) {
     const salt = randomBytes(16);
     const hash = await scryptAsync(password, salt, 64, opts(N, r, p));
     return ["scrypt", N, r, p, salt.toString("base64"), hash.toString("base64")].join("$");
   }

   export async function verifyPassword(password, stored) {
     const [, n, rr, pp, salt, hash] = stored.split("$");
     const expected = Buffer.from(hash, "base64");
     const actual = await scryptAsync(password, Buffer.from(salt, "base64"),
       expected.length, opts(+n, +rr, +pp));
     return timingSafeEqual(actual, expected);             // same length, every byte compared
   }

   // Checked when the email doesn't exist, so both paths take the same time.
   export const DUMMY_HASH = await hashPassword(randomBytes(16).toString("hex"));
   ```

2. Create `sessions.js`: a `Map` from a random session id to `{ userId, expiresAt }`, plus cookie helpers:

   ```js
   import { randomBytes } from "node:crypto";

   const TTL_MS = 7 * 24 * 60 * 60 * 1000;               // 7 days
   const sessions = new Map();

   export function createSession(userId) {
     const id = randomBytes(32).toString("base64url");
     sessions.set(id, { userId, expiresAt: Date.now() + TTL_MS });
     return id;
   }

   export function getSession(id) {
     const s = id && sessions.get(id);
     if (!s) return null;
     if (s.expiresAt < Date.now()) { sessions.delete(id); return null; }
     return s;
   }

   export const destroySession = (id) => sessions.delete(id);

   export function readCookie(req, name) {
     for (const pair of (req.headers.cookie ?? "").split(";")) {
       const [k, ...v] = pair.trim().split("=");
       if (k === name) return v.join("=");
     }
     return null;
   }

   export const sessionCookie = (id) =>
     `sid=${id}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TTL_MS / 1000}`;
   export const clearCookie = "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";
   ```

3. Add three routes under `/api/v1/auth`. `POST /signup` takes `{ email, password }`, lowercases the email, requires a password of 15–128 characters (it is Linkbox's only factor), stores `{ id, email, passwordHash }` in a `users` map and returns `201` without the hash. `POST /login` does the same work whether or not the user exists:

   ```js
   const user = users.get(String(email ?? "").trim().toLowerCase());
   const ok = await verifyPassword(String(password ?? ""), user?.passwordHash ?? DUMMY_HASH);
   if (!user || !ok) return send(res, 401, { error: { code: "invalid_credentials", message: "Invalid email or password" } });
   send(res, 204, undefined, { "Set-Cookie": sessionCookie(createSession(user.id)) });
   ```

   `POST /logout` calls `destroySession(readCookie(req, "sid"))` and sends `clearCookie`.
4. Before any bookmark route runs, look up `getSession(readCookie(req, "sid"))`. No session: `401` with `WWW-Authenticate: Cookie realm="linkbox"` (there is no standard scheme name for cookies; the header just tells the client to authenticate). Otherwise pass `userId` to the handler.
5. Store `ownerId` on every new bookmark. `GET /bookmarks` returns only the caller's bookmarks. `GET`, `PATCH` and `DELETE /bookmarks/:id` return `404` when the bookmark is missing **or** belongs to someone else. One shared helper does that check so no route can forget it.
6. Try it with two users and cookie jars:

   ```bash
   B=localhost:3000/api/v1; J='Content-Type: application/json'
   curl -i -X POST $B/auth/signup -H "$J" -d '{"email":"ana@example.com","password":"correct horse battery"}'
   curl -i -X POST $B/auth/signup -H "$J" -d '{"email":"bo@example.com","password":"correct horse battery"}'
   curl -i -c ana.txt -X POST $B/auth/login -H "$J" -d '{"email":"ana@example.com","password":"correct horse battery"}'
   curl -s -c bo.txt  -X POST $B/auth/login -H "$J" -d '{"email":"bo@example.com","password":"correct horse battery"}'
   curl -i -b ana.txt -X POST $B/bookmarks -H "$J" -d '{"url":"https://nodejs.org"}'   # note the id
   curl -i -b bo.txt  $B/bookmarks/<id>                                                # 404
   curl -i $B/bookmarks                                                                # 401
   ```

**Done when** Bo gets `404` for Ana's bookmark, requests without a cookie get `401`, logout makes the old cookie stop working, and a login with an unknown email takes about as long as one with a wrong password (`time curl ...`).

## Check yourself

<details markdown="1">
<summary>What is the difference between authentication and authorization?</summary>

Authentication establishes *who* the caller is (password, session, token). Authorization decides whether that caller *may* perform this action on this resource (roles, ownership). A request can be perfectly authenticated and still forbidden.
</details>

<details markdown="1">
<summary>Your database of SHA-256 password hashes, each with a unique salt, leaks. Why are users still in trouble?</summary>

Salts stop precomputed tables and make identical passwords look different, but SHA-256 is fast: a GPU tries billions of guesses a second, so common passwords fall quickly, one user at a time. A slow, memory-hard function such as Argon2id or scrypt makes each guess cost hundreds of milliseconds and many megabytes.
</details>

<details markdown="1">
<summary>A user clicks "log out everywhere". How does that work with sessions, and with JWTs?</summary>

With sessions, delete all of that user's session rows; every cookie stops working on the next request. With JWTs, already-issued access tokens stay valid until they expire. You delete the user's refresh tokens and wait out the short access-token lifetime, or add a deny-list check, which means a lookup again.
</details>

<details markdown="1">
<summary>In the OAuth authorization code flow, what does PKCE protect against?</summary>

Someone stealing the authorization code (from a redirect, a log or a malicious app) and exchanging it for tokens. The token endpoint requires the `code_verifier`, whose hash was sent at the start; only the app that began the flow has it.
</details>

<details markdown="1">
<summary>Bo, logged in, requests Ana's bookmark. Should Linkbox answer 401, 403 or 404?</summary>

Not 401: Bo is authenticated. 403 would be correct but confirms the bookmark exists. Linkbox answers 404, as GitHub does for private repositories, so ids can't be probed.
</details>

<details markdown="1">
<summary>Why does the login handler verify against a dummy hash when the email doesn't exist?</summary>

So both paths do the same slow scrypt work. Otherwise unknown emails return in about a millisecond and real ones take hundreds, and an attacker can tell which accounts exist by timing alone, even if the error message is identical.
</details>

## Go deeper

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html): login, error messages, MFA and account recovery, as a checklist.
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): the source for the algorithm table above, with salts, peppers and upgrading old hashes.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): session id length, cookie attributes, timeouts and fixation.
- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725): the known JWT attacks and how to verify tokens correctly. A revision that will replace it was awaiting publication in late 2026.
- [OAuth 2.0 Simplified](https://www.oauth.com/): Aaron Parecki's readable guide to every OAuth flow, PKCE and OpenID Connect.
- [PortSwigger: Access control vulnerabilities](https://portswigger.net/web-security/access-control): how broken authorization is found and exploited, with free labs.
