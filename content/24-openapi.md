---
title: OpenAPI
part: Engineering practice
summary: One machine-readable file that describes every operation of an HTTP API, and the docs, mocks, clients, tests and agents built from it.
---

An HTTP API is a promise: send this, at this path, and you get that back. Usually that promise is written down nowhere a program can read. OpenAPI is the standard format for writing it down: one YAML or JSON file that describes every operation, its inputs and its outputs. Once the promise is a file, tools can read it, and a surprising amount of work you used to do by hand goes away.

## The first principle

Ask where the truth about one endpoint, say `POST /api/v1/bookmarks`, lives today. It lives in three places:

1. **The server code**: the route, the validation schema, the handler. This is what the API actually does.
2. **The documentation**: a README or wiki page someone wrote once. This is what the API did when they wrote it.
3. **The clients**: the frontend's `fetch` call, the mobile app, a partner's integration. This is what each of them *assumes* the API does.

Three copies of one fact will drift. Someone renames `notes` to `note` on the server. The docs still say `notes`. The frontend keeps sending `notes`, the server ignores the unknown field (or rejects it), and you find out from a bug report.

Inside one program this doesn't happen. When you call a function, its **signature** (name, parameter types, return type) is checked by the compiler or at least by your editor. Rename a parameter and every caller lights up red.

A remote call has no signature. Between the client and the server there is only a string of bytes over HTTP, and nothing checks that the two sides agree. What you need is a signature for the remote call: a description of each operation, precise enough for a machine to check, kept in one place, that every party reads from.

That is what OpenAPI is. One file becomes the source that docs, client code, server validation, mock servers, tests and linters are all generated from or checked against. The truth lives in one place, and the other copies become outputs.

```
                     ┌──▶ docs        (Swagger UI, Redoc, Scalar)
                     ├──▶ client types (openapi-typescript, oapi-codegen)
  openapi.yaml ──────┼──▶ mock server  (Prism)
  (the signature)    ├──▶ lint         (Spectral)
                     ├──▶ tests        (Schemathesis)
                     └──▶ AI agents    (tool definitions)
```

## Core ideas

### What OpenAPI is, and where it came from

The **OpenAPI Specification (OAS)** is a vendor-neutral format for describing HTTP APIs. It says nothing about how you build the server. It describes the interface: paths, methods, parameters, bodies, responses and security.

It started as **Swagger**, created by Tony Tam at Wordnik around 2010 to document Wordnik's own API. Swagger 2.0 (2014) became the most widely used API description format. In 2015 SmartBear, which had acquired Swagger, donated the specification to the new **OpenAPI Initiative** under the Linux Foundation, and it was renamed. "Swagger" today is the brand of SmartBear's tools (Swagger UI, Swagger Editor); "OpenAPI" is the specification.

| Version | Year | What changed |
|---|---|---|
| Swagger 2.0 / OAS 2.0 | 2014 | The format most older tools learned |
| OAS 3.0 | 2017 | `components`, `requestBody`, multiple `servers`, better content negotiation. Schemas are a dialect of JSON Schema |
| OAS 3.1 | 2021 | Schemas become real JSON Schema 2020-12 (`type: [string, "null"]` replaces `nullable`), top-level `webhooks`, `paths` optional |
| OAS 3.2 | Sept 2025 | Hierarchical tags (`parent`, `kind`), the `QUERY` method and `additionalOperations`, a `querystring` parameter location, `itemSchema` for streams such as server-sent events, OAuth device flow |

3.2 is backwards-compatible with 3.1, but tools take time to catch up. A year after its release, Spectral, Swagger UI (from 5.32) and Schemathesis read 3.2 documents, while Prism and openapi-typescript still list 3.1 as their newest. Use the newest version that your linter, mock server, generator, docs renderer and test tool all support. For the tools in this lesson that is still **3.1**, which is what Linkbox uses below.

Each line also gets patch releases that clarify the text without changing the format. The current ones are 3.1.2 (September 2025) and 3.2.1 (September 2026).

### The document, top to bottom

An OpenAPI document is a tree of objects. Here is the top of Linkbox's:

```yaml
openapi: 3.1.2
info:
  title: Linkbox API
  version: 1.0.0            # the version of *your API*, not of OpenAPI
  description: Save links with notes and tags, then find them again.
servers:
  - url: http://localhost:3000/api/v1
    description: Local development
security:
  - session: []             # every operation needs a session unless it says otherwise
paths:
  # ... next section
components:
  # ... reusable pieces
```

- **`openapi`**: which version of the specification this file follows. Tools read this first.
- **`info`**: title, your API's version, description, contact and licence. This becomes the header of your docs.
- **`servers`**: base URLs. Paths below are appended to these, so `/bookmarks` here means `http://localhost:3000/api/v1/bookmarks`.
- **`paths`**: the operations, which are most of the file.
- **`components`**: named, reusable schemas, parameters, responses and security schemes.
- **`security`**: which security scheme applies by default.

### Paths, operations and parameters

`paths` maps each URL template to a **Path Item**, and each Path Item maps HTTP methods to **Operations**. The router you built in lesson 03 is the same shape: (method, path) → handler.

```yaml
paths:
  /bookmarks/{id}:
    parameters:                     # shared by every method on this path
      - name: id
        in: path
        required: true              # path parameters must always say this
        schema: { type: string }
    get:
      operationId: getBookmark      # unique; becomes the function name in generated clients
      summary: Get one bookmark
      tags: [bookmarks]             # groups operations in the docs
      responses:
        "200":
          description: The bookmark.
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Bookmark" }
        "404": { $ref: "#/components/responses/NotFound" }
```

A **Parameter** has a `name`, a location (`in`) and a `schema`. The locations are `path`, `query`, `header` and `cookie` (3.2 adds `querystring`, for when the whole query string is one structured value). Query parameters carry the filters, sorting and paging from lesson 08:

```yaml
    get:
      operationId: listBookmarks
      parameters:
        - name: tag
          in: query
          schema: { type: string, maxLength: 50 }
        - name: limit
          in: query
          schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
        - name: cursor
          in: query
          description: Opaque cursor from the previous page's `nextCursor`.
          schema: { type: string }
```

`operationId` matters more than it looks. Code generators turn it into method names (`client.listBookmarks()`), and agents use it as a tool name. Give every operation one, and make it a verb phrase.

### Request bodies and responses

A body is described per media type, because one operation might accept JSON and form data:

```yaml
    post:
      operationId: createBookmark
      parameters:
        - name: Idempotency-Key
          in: header
          schema: { type: string, maxLength: 255 }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/BookmarkInput" }
      responses:
        "201":
          description: Created.
          headers:
            Location:
              schema: { type: string }
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Bookmark" }
        "400": { $ref: "#/components/responses/BadRequest" }
```

`responses` maps status codes (as quoted strings) to a description, optional headers and content. Every response needs a `description`. List the error responses too: a client generated from a file that only lists `200` has no idea a `400` with `application/problem+json` (lesson 13) can come back.

### Components and the Schema Object

Anything used twice goes in `components` and is referenced with `$ref`. Schemas are the main use:

```yaml
components:
  schemas:
    BookmarkInput:
      type: object
      required: [url]
      additionalProperties: false
      properties:
        url:   { type: string, format: uri, maxLength: 2048 }
        title: { type: string, maxLength: 200 }
        notes: { type: string, maxLength: 10000 }
        tags:
          type: array
          maxItems: 20
          items: { type: string, minLength: 1, maxLength: 50 }
    Bookmark:
      type: object
      required: [id, url, title, tags, createdAt]
      properties:
        id:          { type: string }
        url:         { type: string, format: uri }
        title:       { type: string }
        description: { type: [string, "null"] }   # 3.1: null is a type
        tags:        { type: array, items: { type: string } }
        createdAt:   { type: string, format: date-time }
  responses:
    NotFound:
      description: No such bookmark, or not yours.
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }
  securitySchemes:
    session:
      type: apiKey
      in: cookie
      name: sid
```

Since 3.1, a **Schema Object** is plain JSON Schema (draft 2020-12). That is the same language Fastify uses to validate requests (lessons 06 and 07), so the schemas you already wrote for your routes can move into this file almost unchanged.

Notice the separate input and output schemas. `BookmarkInput` has no `id` or `createdAt`, because the client doesn't send them. Reusing one schema for both is a common source of confusing docs.

### Security

`components.securitySchemes` names the ways a client can authenticate, and `security` (top level or per operation) says which ones each operation needs. The types are `apiKey` (in a header, query or cookie), `http` (`scheme: bearer` or `basic`), `oauth2`, `openIdConnect` and `mutualTLS`. Linkbox uses a session cookie (lesson 05), so its scheme is an `apiKey` in a cookie. An operation that needs no auth, like sign-up, overrides the default with `security: []`.

### Code-first and design-first

There are two ways to keep the file and the server in sync.

| | Code-first | Design-first |
|---|---|---|
| Source of truth | The server code; the file is generated from it | The file; the server is written (or stubbed) to match it |
| Examples | `@fastify/swagger` reading route schemas, FastAPI, ts-rest | Hand-written `openapi.yaml`, reviewed in a pull request |
| Good at | Never stale; one team owning both sides | Agreeing on the API before anyone codes; frontend and backend work in parallel against a mock |
| Risk | The API's shape is an accident of the code; breaking changes slip in with refactors | The file and the server drift unless something checks them |

Neither is wrong. Code-first suits an internal API with one consumer. Design-first suits a public API, several teams, or any API where changing the contract is expensive. Whichever you pick, **one side is generated and the other is checked in CI**. A file that nobody verifies is just docs again, with the same drift problem.

### The design-first pipeline: lint, mock, generate, test

**Lint.** [Spectral](https://github.com/stoplightio/spectral) checks the file against rules. The built-in `spectral:oas` ruleset catches structural errors and missing descriptions; you add your own conventions (every operation has an `operationId`, paths are kebab-case, every 4xx uses `application/problem+json`):

```yaml
# .spectral.yaml
extends: ["spectral:oas"]
rules:
  operation-operationId: error
  operation-tags: error
```

**Mock.** [Prism](https://github.com/stoplightio/prism) reads the file and serves a fake API that returns example responses and validates requests. The frontend team builds against it on day one, before the real handler exists.

**Generate.** [openapi-typescript](https://github.com/openapi-ts/openapi-typescript) turns the file into TypeScript types for every path, so a client calling `/bookmarks/{id}` with a misspelled field fails at compile time; its companion `openapi-fetch` gives you a typed `fetch`. In Go, [oapi-codegen](https://github.com/oapi-codegen/oapi-codegen) generates server interfaces and clients. Generators exist for almost every language. This is the remote-call signature from the first principle, finally checked by a compiler.

**Test.** [Schemathesis](https://github.com/schemathesis/schemathesis) reads the file and attacks the running server with generated requests: valid ones, edge cases, and nonsense. It reports any `500`, any response that doesn't match its documented schema, and any status code the file doesn't list. This closes the loop: the file says one thing, the server does another, and CI fails.

**Docs.** [Swagger UI](https://github.com/swagger-api/swagger-ui), [Redoc](https://github.com/Redocly/redoc) and [Scalar](https://github.com/scalar/scalar) all render the same file into a browsable reference, with "try it" consoles in Swagger UI and Scalar. Pick by taste; the file is the same.

One more check pays for itself: a **breaking-change diff** in CI (tools such as `oasdiff`) compares the file on your branch to `main` and fails if you removed a field or made an optional parameter required.

### GitHub, Stripe, and the standard

Big APIs work this way in public. GitHub publishes [OpenAPI descriptions for its whole REST API](https://github.com/github/rest-api-description), in 3.0 and 3.1 flavours, and Octokit's TypeScript types are generated from them. Stripe publishes [its OpenAPI spec](https://github.com/stripe/openapi) and says to use it to generate SDKs; its own client libraries are generated from an annotated variant of the same files. Both use vendor extensions (`x-` fields) for things the standard can't express, which the specification allows.

Open either repository and look at one operation. The structure is exactly what you just learned, at the scale of hundreds of endpoints.

### OpenAPI and AI agents

An AI agent that calls APIs needs the same thing a compiler needs: a list of operations, each with a name, a description and a JSON Schema for its input. That is an OpenAPI document. OpenAI's GPT Actions are defined by an OpenAPI schema; MCP tools describe their inputs with JSON Schema, and there are tools that generate an MCP server from an OpenAPI file. The OpenAPI Initiative's **Arazzo** specification goes one step further and describes multi-step workflows across operations.

For an agent, the `summary` and `description` fields are no longer decoration. They are how the model decides which operation to call and what to put in it. Write them for a reader who has never seen your product.

## Try it

Save the snippets above as one `openapi.yaml` (or start from the full Linkbox file you'll build below). Node 22+ and `npx` are enough; Schemathesis needs Python or `uv`. Since mid-2026 the Spectral and Prism packages report anonymous install statistics through a dependency called Scarf; run `export SCARF_ANALYTICS=false` first if you'd rather they didn't.

```bash
# 1. Lint it
printf 'extends: ["spectral:oas"]\n' > .spectral.yaml
npx @stoplight/spectral-cli lint openapi.yaml

# 2. Mock it, then call the mock in another terminal
npx @stoplight/prism-cli mock openapi.yaml           # serves on http://127.0.0.1:4010
curl -s localhost:4010/bookmarks/42 -H 'Cookie: sid=x'
curl -s -X POST localhost:4010/bookmarks -H 'Cookie: sid=x' \
  -H 'Content-Type: application/json' -d '{"url":"not a url"}'   # the documented 400
curl -si localhost:4010/bookmarks/42 | head -1                    # no cookie: 401

# 3. Generate types and read them
npx openapi-typescript openapi.yaml -o api.d.ts
grep -n "createBookmark" api.d.ts

# 4. Render docs to one HTML file
npx @redocly/cli build-docs openapi.yaml -o docs.html
```

Then point Schemathesis at your running Linkbox server:

```bash
uvx schemathesis run openapi.yaml --url http://localhost:3000/api/v1 \
  -H "Cookie: sid=<a session id from logging in>"
```

Break it on purpose:

1. Delete `required: true` from the `{id}` path parameter and lint again. What does Spectral say?
2. Rename `title` to `name` in `Bookmark` only in the YAML, then run Schemathesis against the unchanged server. Which check fails?
3. Make your server return `500` when `tags` has 21 items. How many requests does Schemathesis need to find it?

## Common mistakes

- **Writing the file once and never checking it.** It becomes stale docs within a month. Run Schemathesis, or generate the file from code, in CI on every pull request.
- **Documenting only the happy path.** If the file lists only `200`, generated clients and agents can't handle `400`, `401`, `404` or `409`. Document every status the server can return, with the problem+json schema.
- **One schema for input and output.** `Bookmark` with `id` marked required makes clients send an `id` on create. Split `BookmarkInput`, `BookmarkPatch` and `Bookmark`.
- **Missing or generic `operationId`s.** Generators fall back to names like `postBookmarks1`, and agents get tools with no meaning. Name every operation as a verb phrase.
- **Loose schemas.** `type: object` with no `properties` describes nothing. Add `required`, `maxLength`, `enum`, `format` and `additionalProperties: false`, the same rules as your validation (lesson 06).
- **Breaking changes merged without noticing.** Renaming a field is a one-line diff in YAML. Add a breaking-change check against `main` to CI.

## Build: Linkbox, step 24

Describe the whole Linkbox API in one file and make CI hold the server to it. This is design-first from now on: change the file, then the code.

1. Create `openapi.yaml` at the project root, `openapi: 3.1.2`. Cover every route: sign-up, log-in and log-out (with `security: []` where no session is needed), the five bookmark operations, search, attachments and the SSE stream (`text/event-stream`), plus `/health`.
2. Put shared pieces in `components`: `Bookmark`, `BookmarkInput`, `BookmarkPatch`, `Problem`, the pagination envelope, and `BadRequest`, `Unauthorized`, `NotFound` responses. Give every operation an `operationId`, `summary` and `tags`.
3. Add `.spectral.yaml` extending `spectral:oas` with `operation-operationId` and `operation-tags` as errors. Add `"lint:api": "spectral lint openapi.yaml"` to `package.json` and install `@stoplight/spectral-cli` as a dev dependency.
4. Serve docs at `/docs`: register `@fastify/swagger` in static mode pointing at `openapi.yaml`, then `@fastify/swagger-ui` with `routePrefix: "/docs"`. (Scalar's Fastify plugin works too.)
5. Start the server against a test database, log in, and run Schemathesis with the session cookie. Fix every failure, in the server or in the file, until it passes.
6. Add both checks (`npm run lint:api` and the Schemathesis run) to your test script. Lesson 26 wires them into CI.

**Done when** Spectral reports no errors, `/docs` shows every endpoint, and Schemathesis finds no `500`s and no response that disagrees with the file.

## Check yourself

<details markdown="1">
<summary>What problem does OpenAPI solve that a function signature solves inside one program?</summary>

A remote call has no compiler between caller and callee, so the server, docs and clients can disagree silently. An OpenAPI file is a machine-readable signature for each operation that every party can be generated from or checked against.
</details>

<details markdown="1">
<summary>What is the difference between Swagger and OpenAPI today?</summary>

OpenAPI is the specification, owned by the OpenAPI Initiative under the Linux Foundation since 2015. Swagger was its original name and is now the brand of SmartBear's tools, such as Swagger UI and Swagger Editor.
</details>

<details markdown="1">
<summary>How do you mark a field as nullable in OpenAPI 3.1, and why did it change from 3.0?</summary>

`type: [string, "null"]`. In 3.1 the Schema Object became standard JSON Schema 2020-12, which has a `null` type, so the 3.0-only `nullable: true` keyword was dropped.
</details>

<details markdown="1">
<summary>You choose design-first. What stops the server from drifting away from the file?</summary>

A check in CI that tests the running server against the file, such as Schemathesis, which fails on undocumented status codes and responses that don't match their schemas. Linting and a breaking-change diff guard the file itself.
</details>

<details markdown="1">
<summary>Why do <code>operationId</code> and <code>description</code> matter more when AI agents use your API?</summary>

Agents see each operation as a tool. The `operationId` becomes the tool's name and the descriptions are what the model reads to decide which tool to call and what arguments to send. Vague text leads to wrong calls.
</details>

## Go deeper

- [OpenAPI Specification 3.2.1](https://spec.openapis.org/oas/v3.2.1.html): the specification itself, in its latest patch release. Read the OpenAPI, Path Item, Operation and Parameter object sections.
- [Learn OpenAPI](https://learn.openapis.org/): the OpenAPI Initiative's own guide, from first document to upgrading between versions.
- [GitHub's REST API description](https://github.com/github/rest-api-description): a real, very large OpenAPI file, in bundled and dereferenced forms.
- [Spectral](https://github.com/stoplightio/spectral): rulesets and how to write custom rules for your own API style guide.
- [Schemathesis](https://schemathesis.readthedocs.io/): how property-based testing turns your OpenAPI file into thousands of test cases.
