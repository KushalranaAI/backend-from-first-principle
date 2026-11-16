---
title: Validation and transformation
part: The request
summary: Check every input at the edge of your server, turn it into clean values once, and fail with errors a client can act on.
---

Every byte that reaches your server was chosen by someone else. Validation is the step that decides whether a request's data is acceptable before any of your logic touches it; transformation turns what was sent into the clean values your code expects. Together they are the cheapest defence you have against crashes, bad data and a long list of security bugs.

## The first principle

Your handler for `POST /bookmarks` was written with a picture in mind: `url` is a string that is a web address, `title` is a short string, `tags` is a list of words. Now look at what can actually arrive:

```json
{ "url": "javascript:alert(1)", "title": 42, "tags": "node", "isAdmin": true }
```

Feed that straight into your code and one of four things happens:

1. **It crashes.** `body.tags.map(...)` throws because `tags` is a string. The client gets a 500 for its own mistake.
2. **Bad data is stored.** A title of `42`, a 5 MB note, a URL that isn't one. Every reader of that data now has to cope with it, forever.
3. **It becomes a hole.** `isAdmin: true` gets copied onto a user record. A `javascript:` URL ends up as a link in someone's browser.
4. **It fails somewhere far away.** The database rejects a value deep inside a transaction, and the error the client sees says nothing useful.

The fix is to stop trusting shape and start checking it, once, at the door. Treat the request as untrusted text. Describe the input you accept, check the request against that description, convert it into your own clean values, and reject everything else with a clear message. After that point, the rest of your code can trust its inputs.

> Validate at the boundary, once, and hand the rest of the system values it no longer has to doubt.

## Core ideas

### Three kinds of validation

| Kind | Question | Bookmark examples |
|---|---|---|
| **Type** | Is it the right kind of value? | `url` is a string; `tags` is an array of strings; `limit` is an integer |
| **Syntactic** | Does it have the right form? | `url` parses as a URL; a tag matches `^[a-z0-9-]+$`; a date is `YYYY-MM-DD` |
| **Semantic** | Does it make sense? | the URL is `http` or `https`; at most 20 tags; a reminder date is in the future; `endDate` after `startDate` |

They run in that order, because each assumes the one before passed: there is no point checking the format of something that isn't a string.

There is a fourth kind that doesn't belong in the validator: **rules that need state**. "You already saved this URL" or "this tag name is taken" need a database lookup, so they live in the service layer and usually come back as `409 Conflict` rather than `400`.

### Where validation sits in the pipeline

```
request ─► route match ─► parse body (lesson 04) ─► auth (lesson 05)
                                                         │
               ┌─────────────────────────────────────────┘
               ▼
       validate + transform ──fail──► 400 with field errors
               │ ok: clean, typed values
               ▼
       handler / service ─► repository ─► database
```

Validate after the body has been parsed (malformed JSON is already a 400 from lesson 04) and usually after authentication, so anonymous traffic can't probe your rules. Validate before the handler runs. Path parameters, query strings and headers are inputs too: `/bookmarks/abc` and `?limit=-5` deserve the same treatment as the body.

A useful mindset is **parse, don't validate**: the validator's output is not a yes or no, it's a new value of a known shape. Code after it receives `{ url, title, tags }` that are guaranteed clean, and never looks at the raw body again.

### Transformation and normalization

Raw input often means the right thing in the wrong form. Transformation fixes the form so the rest of the system sees one canonical value:

| Raw | Transformed | Why |
|---|---|---|
| `"  https://NodeJS.org "` | `"https://nodejs.org/"` | trim, and let `new URL()` canonicalize the host and path |
| `["Node", " node ", "JS"]` | `["node", "js"]` | trim, lowercase, deduplicate |
| `?limit=20` | `20` (a number) | query strings are always strings |
| missing `limit` | `20` | apply a default |
| `"Alice@Example.COM "` | `"alice@example.com"` | case-insensitive in practice; compare consistently |
| `"é"` (e + combining accent) | `"é"` | Unicode NFC, so equal-looking strings compare equal |

Order matters: trim before checking length, or `"   "` passes a "not empty" check. And be careful with JavaScript's loose conversions, which accept far more than you mean:

```js
Number("")        // 0
Number(" 12 ")    // 12
Number("0x10")    // 16
Number("1e3")     // 1000
parseInt("12abc") // 12
new Date("2025-02-30")  // 2 March 2025 in V8, no error
```

For integers, check the string against `/^\d+$/` first, then convert. For dates, parse and then check the result round-trips to the same day.

### Allowlist, and limit everything

Describe what you accept, not what you refuse. A list of forbidden characters always misses one; a pattern of allowed ones can't.

- **Fields:** reject (or drop) any key you didn't define. Copying unknown keys onto a model is how `isAdmin: true` becomes real. This is called *mass assignment*.
- **Sizes:** every string has a maximum length, every array a maximum count, every number a range. Unbounded input is a denial-of-service waiting to happen.
- **Enums:** `sort` is one of `created`, `-created`, `title`. Not "any string".

### Client-side and server-side validation

Both, for different reasons:

| | Client (browser, app) | Server |
|---|---|---|
| Purpose | Fast feedback, fewer wasted requests | Correctness and security |
| Can be bypassed? | Yes: DevTools, `curl`, a script | No, if every path goes through it |
| Needed? | Nice to have | Always |

`<input type="url" required maxlength="2048">` gives users instant hints. It does nothing against `curl -d '{"url":"javascript:alert(1)"}'`. Some teams share one schema between frontend and backend so the two can't drift; the server check still runs.

### Validation is not sanitization

Validation decides whether input is acceptable. It does not make data safe for every place it will go later. A valid note can still contain `<script>`, which only matters when you put it in HTML, so you escape it *there*. A valid title can still contain `'`, which only matters in SQL, so you use parameterized queries (lesson 17). Validate on the way in; encode for the destination on the way out.

### Failing with clear 400 errors

A good validation error lets the client fix the request without reading your code:

```json
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8

{
  "error": {
    "code": "validation_failed",
    "message": "The bookmark has 2 invalid fields",
    "fields": [
      { "field": "url",  "message": "must be an http or https URL" },
      { "field": "tags", "message": "must have at most 20 tags" }
    ]
  }
}
```

The rules behind it:

- **Report all errors at once**, not one per round trip.
- **Name the field** with a path the client can map to a form input (`tags`, or `tags[3]`).
- **Keep machine codes stable** and messages human. Clients branch on codes; people read messages.
- **Don't leak internals**: no stack traces, no SQL, no library error dumps.
- Use **400** for invalid input. Some APIs use **422 Unprocessable Content** when the JSON is well-formed but its values are wrong; either is fine if you are consistent. Keep **413** for oversized bodies and **415** for wrong `Content-Type` (lesson 04).

Lesson 08 moves this into the standard `application/problem+json` format.

### Hand-written or a library?

Writing a validator once by hand, as below, shows you exactly what one does. In real projects you describe the shape as a schema and let a library check it: **Zod** (schemas in JavaScript/TypeScript), **Ajv** (JSON Schema), or the JSON Schema validation built into Fastify (lesson 07). The same bookmark rules in Zod 4:

```js
import { z } from "zod";

const Bookmark = z.strictObject({                       // unknown keys are errors
  url: z.string().trim().pipe(z.httpUrl()),
  title: z.string().trim().max(200).nullish(),
  tags: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,29}$/))
    .max(20).default([]),
});

const result = Bookmark.safeParse(body);   // { success, data } or { success, error }
```

A schema is also documentation, and lesson 24 turns the same idea into an OpenAPI description.

## Try it

Save this validator as `validate.mjs`. It is the one you will reuse for Linkbox:

```js
const FIELDS = new Set(["url", "title", "notes", "tags"]);
const TAG = /^[a-z0-9][a-z0-9-]{0,29}$/;

export function validateBookmark(body, { partial = false } = {}) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { errors: [{ field: "(body)", message: "must be a JSON object" }] };
  }
  const errors = [];
  const value = {};
  const fail = (field, message) => errors.push({ field, message });

  for (const key of Object.keys(body)) {
    if (!FIELDS.has(key)) fail(key, "is not an allowed field");
  }

  // url: required on create; trimmed, must parse, http(s) only, stored in canonical form
  if (body.url === undefined) {
    if (!partial) fail("url", "is required");
  } else {
    const raw = typeof body.url === "string" ? body.url.trim() : "";
    const url = URL.canParse(raw) ? new URL(raw) : null;
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      fail("url", "must be an http or https URL");
    } else if (url.href.length > 2048) {
      fail("url", "must be at most 2048 characters");
    } else {
      value.url = url.href;
    }
  }

  // title and notes: optional strings, trimmed; null clears them
  for (const [field, max] of [["title", 200], ["notes", 5000]]) {
    const v = body[field];
    if (v === undefined) continue;
    if (v === null) { value[field] = null; continue; }
    if (typeof v !== "string") { fail(field, "must be a string or null"); continue; }
    const text = v.trim().normalize("NFC");
    if (text.length > max) fail(field, `must be at most ${max} characters`);
    else value[field] = text || null;
  }

  // tags: up to 20; each trimmed, lowercased, deduplicated
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((t) => typeof t !== "string")) {
      fail("tags", "must be an array of strings");
    } else {
      const tags = [...new Set(body.tags.map((t) => t.trim().toLowerCase()))];
      const bad = tags.find((t) => !TAG.test(t));
      if (tags.length > 20) fail("tags", "must have at most 20 tags");
      else if (bad !== undefined) fail("tags", `"${bad}" must be 1-30 of a-z, 0-9 and -`);
      else value.tags = tags;
    }
  }

  return errors.length ? { errors } : { value };
}
```

`partial: true` is for `PATCH`, where every field is optional. Now feed it the inputs from the first principle. Save as `try.mjs` and run `node try.mjs`:

```js
import { validateBookmark } from "./validate.mjs";

const cases = [
  { url: "  https://NodeJS.org  ", title: " Node docs ", tags: ["Node", " node ", "JS"] },
  { url: "javascript:alert(1)" },
  { title: 42, tags: "node", isAdmin: true },
  [],
];
for (const c of cases) console.log(JSON.stringify(validateBookmark(c)));
```

The first comes back clean: `{"url":"https://nodejs.org/","title":"Node docs","tags":["node","js"]}`. The third reports four errors at once, including `isAdmin`.

Then see why client-side checks are not enough. Make a form with `<input type="url" required>`, notice the browser blocks a bad value, and send the same value with `curl` instead:

```bash
curl -i localhost:3000/api/v1/bookmarks -H "Content-Type: application/json" \
  -d '{"url":"javascript:alert(1)","tags":"node"}'
```

Before you finish this lesson's build step, that request is stored. After it, it's a 400.

Break it on purpose:

1. Remove `.trim()` from the title and send `"title": "   "`. What gets stored?
2. Change the tag regex to `/[a-z0-9-]+/` (no `^` and `$`). Which bad tag now passes?
3. Delete the unknown-field loop and send `{"url":"https://a.dev","isAdmin":true}`. Where could that key end up if a later handler does `Object.assign(bookmark, body)`?
4. Send 10,000 tags. Which check stops it, and how much work happened before it did? Could you check the count before mapping?

## Common mistakes

- **Validating only in the frontend.** Every client-side check can be skipped. The server validates every request, including ones from your own app.
- **Copying the body onto a model.** `Object.assign(user, req.body)` lets clients set `role`, `ownerId` or `createdAt`. Build the object from the validated fields only.
- **Checking before trimming.** `"   "` passes "not empty", `" Node"` and `"node"` become two tags. Normalize first, then check.
- **Loose number parsing.** `parseInt("10abc")` is `10` and `Number("")` is `0`. Match a strict pattern, then convert, then range-check.
- **One error at a time, or a 500.** Users fix one field, resubmit, hit the next. Collect every error and return a single 400 with all of them; never let a `TypeError` from bad input become a 500.
- **Blocklists.** Stripping `<script>` or `DROP TABLE` from input misses the next variant and mangles honest data. Allowlist on input, encode on output, parameterize queries.

## Build: Linkbox, step 6

Lesson 05 added users and an owner check. Now make sure nothing invalid gets past the edge.

1. Add `src/validation/bookmark.js` with `validateBookmark(body, { partial })` from *Try it*. It returns either `{ value }` or `{ errors }`.
2. In `POST /api/v1/bookmarks`, run it with `partial: false`; in `PATCH /api/v1/bookmarks/:id`, with `partial: true`. Also reject an empty `PATCH` body (`{}`) with a 400.
3. On errors, respond `400` with `{ "error": { "code": "validation_failed", "message": ..., "fields": [...] } }` through your `send` helper from lesson 04.
4. Pass only `value` to the repository. Set `ownerId`, `id`, `createdAt` and `updatedAt` on the server, never from the body.
5. Validate the rest of the input too: `:id` must match your id format (404 if it doesn't), `?limit=` must be an integer from 1 to 100 (default 20), and `?tag=` must match the tag pattern after trimming and lowercasing.
6. Add a small `node:test` file with one passing case and one failing case per field, and run it with `node --test`.

**Done when** the `curl` from *Try it* returns `400` listing both `url` and `tags`; `"tags": [" Node ", "node"]` is stored as `["node"]`; `"isAdmin": true` is rejected; `?limit=abc` and `?limit=500` return `400`; and `node --test` passes.

## Check yourself

<details markdown="1">
<summary>Classify each check as type, syntactic or semantic: <code>tags</code> is an array; a date matches <code>YYYY-MM-DD</code>; the end date is after the start date.</summary>

Type, syntactic, semantic. The first checks the kind of value, the second its form, the third whether it makes sense.
</details>

<details markdown="1">
<summary>The frontend already validates the form. Why validate again on the server?</summary>

Because the frontend runs on the user's machine. Anyone can skip it with DevTools, `curl` or a script. Client checks are for user experience; server checks are for correctness and security.
</details>

<details markdown="1">
<summary>"This URL is already in your bookmarks." Does that check belong in the validator?</summary>

No. It needs the database, so it belongs in the service layer, and it usually returns `409 Conflict`. The validator only checks what can be decided from the request itself.
</details>

<details markdown="1">
<summary>Why trim and lowercase tags before checking them, not after?</summary>

So the checks run on the value you will actually store. Checking first lets `"   "` pass a non-empty check and lets `"Node"` and `" node"` be stored as different tags.
</details>

<details markdown="1">
<summary>What should a validation error response contain?</summary>

A 400 (or a consistent 422) with a stable error code, a human message, and every invalid field with its own message, all at once. No stack traces or internal details.
</details>

## Go deeper

- [OWASP Input Validation Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html): syntactic versus semantic validation, allowlists, and why validation is not output encoding.
- [OWASP Mass Assignment Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html): how copying request bodies onto models goes wrong, and the allowlist fix.
- [Alexis King: Parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/): the essay behind "turn input into typed values once, at the edge".
- [MDN: Client-side form validation](https://developer.mozilla.org/en-US/docs/Learn_web_development/Extensions/Forms/Form_validation): what the browser can check for you, and its own warning that it is not a security measure.
- [Zod](https://zod.dev/): schema validation and transformation for JavaScript, with the error formats used above.
- [RFC 9457: Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457): the standard error format Linkbox adopts in lesson 08, including its pattern for per-field validation errors.
