---
title: Serialization
part: The request
summary: How objects in memory become bytes on the wire and back, and why JSON is easy to use and easy to get wrong.
---

Your server holds data as objects in memory. The network, the disk, Redis and Postgres only carry bytes. **Serialization** turns an object into bytes; **deserialization** turns bytes back into an object. It happens at every edge of a backend, many times per request, and most of the subtle data bugs you will meet (lost precision, wrong dates, missing fields, leaked secrets) happen right there.

## The first principle

A JavaScript object in memory is not a thing you can send. It is a set of pointers into your process's heap: `bookmark.tags` is an address, meaningful only inside that one process, on that one machine, right now. Send those addresses to another machine and they mean nothing.

So before data can leave a process, it must be flattened into a sequence of bytes that stands on its own. And the receiver has to turn those bytes back into its own objects, possibly in another language: your Node API talks to a Swift app, a Python worker and a Go service.

That only works if both sides agree, in advance, on a **format**:

- which data types exist (string, number, list, map, true/false, nothing),
- how each one is written as bytes,
- how to tell where one value ends and the next begins.

A format is a shared contract between two programs that never share memory. JSON is one such contract. Protocol Buffers is another. Choosing one is choosing the trade-off between "humans can read it" and "machines can read it fast".

> Serialization is not a JSON detail. It is the price of crossing any boundary: network, disk, cache, queue or another process.

## Core ideas

### Where serialization happens

Follow one `POST /api/v1/bookmarks` through Linkbox and count the boundaries:

```
client object ──serialize──► JSON bytes ──HTTP──► deserialize ──► your object
                                                                     │
                     Postgres row ◄── SQL parameters ◄───────────────┤
                     Redis string ◄── JSON.stringify ◄───────────────┤
                     job payload  ◄── JSON.stringify ◄───────────────┤
                     log line     ◄── JSON.stringify ◄───────────────┤
client object ◄── deserialize ◄── JSON bytes ◄── serialize ◄─────────┘
```

Each arrow is a place where a type can change. A `Date` becomes a string. A 64-bit id becomes a rounded float. A `Set` becomes `{}`. Your code must decide what happens at each one, rather than hoping.

### Text formats and binary formats

| | JSON | XML | Protocol Buffers | MessagePack |
|---|---|---|---|---|
| Kind | text | text | binary | binary |
| Human-readable | yes | yes | no | no |
| Needs a schema | no | optional (XSD) | yes (`.proto`) | no |
| Field names on the wire | yes | yes, twice (open and close tags) | no, field numbers | yes |
| Typical use | web APIs, config, logs | older enterprise APIs, SOAP, RSS, documents | service-to-service (gRPC), mobile | caches, queues, compact JSON-like data |

The same bookmark, `{"id":42,"url":"https://nodejs.org","tags":["node","docs"]}`, measures:

- **JSON**: 59 bytes
- **MessagePack**: 44 bytes (same structure, but lengths and types are binary markers)
- **Protocol Buffers**: 34 bytes (no field names at all, only field numbers from the schema)

Text formats win on debuggability: you can read them in `curl`, logs and browser DevTools, and every language parses JSON. Binary formats win on size and parsing speed, and Protocol Buffers adds a schema that both sides compile into code. For a public web API, JSON is the right default. Reach for a binary format when you control both ends and measure that JSON is your bottleneck, which is rarer than people expect, especially once responses are compressed (lesson 02).

A Protocol Buffers schema looks like this:

```proto
syntax = "proto3";

message Bookmark {
  int64 id = 1;            // the number, not the name, goes on the wire
  string url = 2;
  repeated string tags = 3;
}
```

Newer schemas may start with `edition = "2024";` instead of a `syntax` line. Editions replace the proto2/proto3 split with per-feature settings. They change the generated code, not the bytes on the wire.

### JSON's rules

JSON (RFC 8259) is small enough to learn completely. It has six types:

| Type | Example | Notes |
|---|---|---|
| object | `{"url": "https://nodejs.org"}` | keys are always double-quoted strings |
| array | `["node", "docs"]` | ordered |
| string | `"héllo é"` | double quotes only, Unicode, escapes with `\` |
| number | `42`, `-1.5`, `2e10` | no `NaN`, no `Infinity`, no leading zeros, no hex |
| boolean | `true`, `false` | |
| null | `null` | |

What is *not* in JSON: comments, trailing commas, single quotes, `undefined`, dates, binary data, integers distinct from floats. JSON exchanged between systems must be UTF-8. Duplicate keys are allowed by the grammar but the result is undefined; JavaScript keeps the last one, other parsers keep the first or fail.

Also note that any JSON value is a valid document. `null`, `42` and `"hi"` all parse. "The body parsed" does not mean "the body is an object" (lesson 06).

### JSON pitfalls in JavaScript

**Numbers are 64-bit floats.** JSON doesn't limit number size, but `JSON.parse` turns every number into a JavaScript `number`, which is exact only up to `Number.MAX_SAFE_INTEGER` (2^53 − 1 = 9,007,199,254,740,991). Beyond that, digits change silently:

```js
JSON.parse('{"id": 9007199254740993}').id;   // 9007199254740992
```

Twitter famously added `id_str` next to `id` for this reason. Rule: send 64-bit ids (Postgres `bigint`, Snowflake ids) as **strings**. For money, never use floats (`0.1 + 0.2` is `0.30000000000000004`); send integer minor units (`"amountCents": 1999`) or a decimal string (`"1999.00"`). If you must read a big number as a number, Node 21+ and every current browser pass the raw text to a reviver: `JSON.parse(text, (key, value, { source }) => key === "id" ? BigInt(source) : value)`.

**There is no date type.** `JSON.stringify(new Date())` calls `Date.prototype.toJSON` and gives an ISO 8601 string such as `"2026-03-01T09:30:00.000Z"`. `JSON.parse` gives you back a *string*, not a `Date`. Send timestamps as ISO 8601 / RFC 3339 strings in UTC (with the `Z`), and convert them deliberately on the way in. Avoid epoch numbers (seconds or milliseconds?) and local times without an offset (which time zone?). The newer `Temporal` API (built into Node 26 and later) is strict about this: `Temporal.Instant.from("2026-03-01T09:30:00")` throws because the string has no offset, where `new Date` would quietly assume local time.

**Some values vanish or change.** `JSON.stringify` is lossy without warning:

| Input | Output |
|---|---|
| `{ note: undefined }` | `{}` (key dropped) |
| `[undefined, () => 1]` | `[null,null]` |
| `NaN`, `Infinity` | `null` |
| `new Map(...)`, `new Set(...)` | `{}` |
| `10n` (BigInt) | throws `TypeError: Do not know how to serialize a BigInt` |
| `new Date(...)` | ISO string |
| an object with a cycle | throws `TypeError` |

For the BigInt row, `JSON.rawJSON(String(id))` (available wherever the reviver's `source` is) makes `JSON.stringify` write the digits as an exact JSON number. A JavaScript client reading it with plain `JSON.parse` still rounds it, so a string remains the safer wire format.

The `undefined` case matters for APIs: if a field is missing the client can't tell "not set" from "you forgot to send it". Decide on `null` for "no value" and always include the key.

**Parsing untrusted JSON.** `JSON.parse` itself is safe: it never runs code. The dangers are around it. A huge body costs memory and CPU, so cap the size before parsing. And a key named `__proto__` becomes a normal own property, which a naive deep-merge function will then copy onto `Object.prototype` (prototype pollution, lesson 17). Never merge request bodies into objects blindly.

### Serialize at the boundary, explicitly

The easiest way to leak data is to serialize your internal objects directly:

```js
// user came from the database, with passwordHash, email, isAdmin...
res.end(JSON.stringify(user));   // ships passwordHash to the client
```

Instead, write one small function per resource that builds the outgoing shape field by field:

```js
export const toBookmarkResponse = (b) => ({
  id: String(b.id),                       // bigint → string
  url: b.url,
  title: b.title ?? null,                 // always present, null if unknown
  tags: [...b.tags],                      // Set → array
  createdAt: b.createdAt.toISOString(),   // Date → ISO 8601, UTC
});
```

This is the *serialization layer* of your API. New database columns don't leak by accident, types are converted on purpose, and the public shape stays stable when the internals change. The inbound side mirrors it: parse the bytes, then validate and convert into your own types (lesson 06). Never trust that the parsed object has the shape you expect.

Also keep the **envelope** the same for every response, so clients can handle all of them with one code path. A simple choice:

```json
{ "data": { "id": "42", "url": "https://nodejs.org" } }
{ "error": { "code": "invalid_json", "message": "Body is not valid JSON" } }
```

Lesson 08 replaces the error half with the standard `application/problem+json`.

### Content-Type ties bytes to a format

The receiver can't guess a format from the bytes. HTTP labels the body with `Content-Type: application/json; charset=utf-8` (or `application/x-protobuf`, `application/msgpack`, `application/xml`). A server should check `Content-Type` before parsing and answer `415 Unsupported Media Type` when it isn't one it supports. Content negotiation (lesson 02) lets one endpoint serve several formats.

### Schemas and evolution

A format says how to write values. A **schema** says which values a message must contain: `url` is a required string, `tags` is an array of strings, at most 20. With JSON the schema is optional and lives outside the data (JSON Schema, OpenAPI in lesson 24). With Protocol Buffers it is required and compiled into code for each language.

Schemas matter most when data outlives the code that wrote it: messages sitting in a queue during a deploy, cache entries, old mobile apps that never update. The safe rules are the same in every format:

- **Add** new fields as optional, with a default. Old readers ignore them; new readers handle their absence.
- **Never change** the meaning or type of an existing field. Add a new one instead.
- **Never reuse** a removed field's name (or, in protobuf, its number).
- Readers should ignore fields they don't know (the *tolerant reader* rule).

## Try it

See the pitfalls with your own eyes. Save as `pitfalls.mjs` and run `node pitfalls.mjs`:

```js
const bookmark = {
  id: 9007199254740993n,            // a BigInt id from the database
  url: "https://nodejs.org",
  createdAt: new Date("2026-03-01T09:30:00Z"),
  note: undefined,                  // not set yet
  score: NaN,
  tags: new Set(["node", "docs"]),
};

try {
  JSON.stringify(bookmark);
} catch (err) {
  console.log("1.", err.message);
}

const { id, ...rest } = bookmark;
const text = JSON.stringify(rest);
console.log("2.", text);

const back = JSON.parse(text);
console.log("3.", typeof back.createdAt, back.createdAt);
console.log("4.", JSON.parse('{"id": 9007199254740993}').id);
console.log("5.", 0.1 + 0.2);
console.log("6.", JSON.parse('{"role":"user","role":"admin"}'));
```

Before running it, predict every line. You should see the BigInt error, `note` gone, `score` as `null`, `tags` as `{}`, the date coming back as a string, the id off by one, and the duplicate key won by `"admin"`.

Then compare sizes with a binary format:

```bash
mkdir ser && cd ser && npm init -y && npm i @msgpack/msgpack
node -e '
const { encode } = require("@msgpack/msgpack");
const b = { id: 42, url: "https://nodejs.org", tags: ["node", "docs"] };
console.log("json", Buffer.byteLength(JSON.stringify(b)), "msgpack", encode(b).length);
'
```

Break it on purpose:

1. Add `toJSON() { return "hidden"; }` to the `bookmark` object (and remove the BigInt). What does `JSON.stringify` output now? Why is this the hook `Date` uses?
2. `JSON.parse("{'a': 1}")`, `JSON.parse('{"a": 1,}')`, `JSON.parse("NaN")`. Read each error message.
3. Make an object point at itself (`const a = {}; a.self = a;`) and stringify it.
4. Fix the off-by-one id in line 4 using the reviver's third argument shown above.

## Common mistakes

- **Large integers as JSON numbers.** Ids above 2^53 get silently rounded in JavaScript clients. Send them as strings.
- **Floats for money.** Rounding errors pile up and totals stop matching. Use integer cents or decimal strings, and `numeric` in Postgres.
- **Dates without a time zone.** `"2026-03-01 09:30"` means a different moment on every server. Store and send UTC ISO 8601 with `Z`; convert to local time only for display.
- **`JSON.stringify(row)` straight from the database.** It leaks password hashes, internal flags and every column added next year. Map to an explicit response shape.
- **Parsing without a size limit or `Content-Type` check.** A 1 GB body will be buffered into memory. Reject large bodies with 413 and wrong types with 415 before parsing.
- **Breaking the contract silently.** Renaming `title` to `name` breaks every client and every queued job written before the deploy. Add the new field, migrate, and remove the old one later.

## Build: Linkbox, step 4

Give the routes from lesson 03 real bodies and a real (in-memory) store. Still no framework.

1. Write `readJson(req)` in `src/http/body.js`:

   ```js
   const LIMIT = 100 * 1024; // 100 KB is plenty for a bookmark

   export async function readJson(req) {
     const type = req.headers["content-type"] ?? "";
     if (!/^application\/json\b/i.test(type)) {
       throw new HttpError(415, "unsupported_media_type", "Send Content-Type: application/json");
     }
     if (Number(req.headers["content-length"]) > LIMIT) {
       throw new HttpError(413, "body_too_large", `Body must be under ${LIMIT} bytes`);
     }
     const chunks = [];
     let size = 0;
     for await (const chunk of req) {           // also catches chunked bodies with no length
       size += chunk.length;
       if (size > LIMIT) throw new HttpError(413, "body_too_large", `Body must be under ${LIMIT} bytes`);
       chunks.push(chunk);
     }
     try {
       return JSON.parse(Buffer.concat(chunks).toString("utf8"));
     } catch {
       throw new HttpError(400, "invalid_json", "Body is not valid JSON");
     }
   }
   ```

   `HttpError` is a small `Error` subclass with `status` and `code` fields. Catch it in your request handler and turn it into the error envelope; let anything else become a 500.
2. Write `send(res, status, payload, headers = {})` that stringifies once, sets `Content-Type: application/json; charset=utf-8` and `Content-Length: Buffer.byteLength(body)`, and adds any extra headers. When `payload` is `undefined` (a `204`), send no body at all. Every other response goes through it, as `{ "data": ... }` or `{ "error": { "code", "message" } }`.
3. Store bookmarks in a `Map` keyed by id inside a `bookmarks.repository.js` module, with `create`, `get`, `list`, `update` and `remove`. Keep `createdAt` and `updatedAt` as `Date` objects inside.
4. Write `toBookmarkResponse(b)` and use it for every bookmark that leaves the server: id as a string, dates as ISO 8601 UTC, `tags` as an array, missing values as `null`.
5. Wire `POST /api/v1/bookmarks` (201 with the created bookmark), `GET` one and list, `PATCH` and `DELETE` (204) to the store. Don't validate fields yet beyond "the body is an object"; that is lesson 06.

**Done when** `POST` with good JSON returns `201` and a bookmark whose `createdAt` ends in `Z`; malformed JSON returns `400` with `invalid_json`; a form-encoded body returns `415`; a 200 KB body returns `413`; and every response, success or error, has the same envelope.

## Check yourself

<details markdown="1">
<summary>Why can't a server just send its in-memory object to the client?</summary>

An in-memory object is a structure of pointers into one process's memory. They mean nothing anywhere else. The object must be written out as self-contained bytes in a format both sides agree on.
</details>

<details markdown="1">
<summary>A Postgres <code>bigint</code> id of 9007199254740993 reaches a browser as 9007199254740992. What happened, and what is the fix?</summary>

JavaScript parses JSON numbers as 64-bit floats, which are exact only up to 2^53 − 1, so the value was rounded. Send such ids as strings.
</details>

<details markdown="1">
<summary>What does <code>JSON.stringify({ a: undefined, b: NaN, c: new Set([1]) })</code> return?</summary>

`{"b":null,"c":{}}`. `undefined` properties are dropped, `NaN` becomes `null`, and a `Set` has no enumerable own properties so it becomes `{}`.
</details>

<details markdown="1">
<summary>When would you choose Protocol Buffers over JSON?</summary>

For internal service-to-service traffic where you control both ends and want a compiled schema, smaller messages and faster parsing, typically with gRPC. For public web APIs, JSON's readability and universal support usually win.
</details>

<details markdown="1">
<summary>Why map database rows through a <code>toBookmarkResponse</code> function instead of returning them directly?</summary>

It decides the public shape explicitly: no leaked internal columns, deliberate type conversions (bigint, dates, sets), and a stable contract even when the database schema changes.
</details>

## Go deeper

- [RFC 8259: The JSON Data Interchange Format](https://www.rfc-editor.org/rfc/rfc8259): the whole spec in a few pages, including the notes on number precision and duplicate keys.
- [MDN: JSON.stringify()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify): every rule for `toJSON`, replacers, and which values are dropped or converted.
- [Protocol Buffers: Encoding](https://protobuf.dev/programming-guides/encoding/): how field numbers, varints and lengths become bytes, which explains why protobuf is small.
- [Martin Kleppmann: Schema evolution in Avro, Protocol Buffers and Thrift](https://martin.kleppmann.com/2012/12/05/schema-evolution-in-avro-protocol-buffers-thrift.html): how binary formats encode the same record and how each handles changing schemas.
- [Understanding JSON Schema](https://json-schema.org/understanding-json-schema/): the readable guide to describing JSON shapes, which you will use again in lessons 06 and 24.
- [MessagePack](https://msgpack.org/): the format's spec and the list of implementations per language.
