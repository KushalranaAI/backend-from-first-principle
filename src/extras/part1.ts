import type { Extra } from "./types";

/** Lessons 01–13: orientation, the request, data, and the first production lesson. Keyed by lesson number. */
export const PART1: Record<string, Extra> = {
  "01": {
    analogy: {
      title: "A restaurant",
      text: "You sit in the dining room, read the menu and order. You never walk into the kitchen. The kitchen has the ingredients, the recipes and the rules, and it serves every table at once. A backend is the kitchen: the part you don't see, where the real work and the real rules live.",
      map: [
        ["Dining room and menu", "Frontend: what runs on your device"],
        ["Waiter carrying orders", "HTTP requests and responses"],
        ["Kitchen", "Backend server"],
        ["Recipes and house rules", "Business logic"],
        ["Pantry and cold store", "Database"],
      ],
    },
    uses: [
      ["Ordering on a food delivery app", "Your phone shows the price, but the server calculates it. If the phone decided, anyone could edit the total."],
      ["Checking your bank balance", "The app only displays a number. The bank's servers own it, and every phone you log in from sees the same one."],
      ["An online multiplayer game", "The server decides who hit whom. Players' devices only send inputs, so nobody can award themselves a win."],
    ],
    flow: {
      title: "One page load, end to end",
      actors: ["You", "Browser", "DNS", "Server", "Database"],
      steps: [
        [0, 1, "linkbox.app/bookmarks", "You type an address. Everything after this happens in well under a second."],
        [1, 2, "Where is linkbox.app?", "The browser asks DNS to turn the name into an IP address."],
        [2, 1, "203.0.113.10", "DNS answers. The browser now knows which machine to talk to.", "res"],
        [1, 3, "TCP + TLS handshake", "A reliable, encrypted connection is opened before any data is sent."],
        [1, 3, "GET /bookmarks", "The actual request: a method, a path and some headers."],
        [3, 4, "SELECT … WHERE owner = you", "The server checks who you are, then asks the database for your rows only."],
        [4, 3, "12 rows", "The database returns the data.", "res"],
        [3, 1, "200 OK + JSON", "The server turns the rows into a response.", "res"],
        [1, 0, "Page drawn", "The browser renders it. The frontend showed the data; the backend decided what the data was.", "res"],
      ],
    },
  },

  "02": {
    analogy: {
      title: "A counter with strict manners",
      text: "Imagine an office counter where every request must be on a standard form. The clerk reads the form, stamps a reply and forgets you completely. Come back a minute later and you must show your ticket again. HTTP works like that: every request is complete on its own, and the server remembers nothing between them unless you hand it something to recognise you by.",
      map: [
        ["The standard form", "Request line and headers"],
        ["What you ask for at the counter", "Method: GET, POST, PATCH, DELETE"],
        ["The stamp on the reply", "Status code: 200, 404, 500"],
        ["Your cloakroom ticket", "Cookie or token"],
        ["A sealed envelope", "TLS (the S in HTTPS)"],
      ],
    },
    uses: [
      ["The padlock in the address bar", "TLS has encrypted the connection and proved the server owns that domain."],
      ["A page that reloads instantly", "The browser asked “has this changed?” and the server replied 304 Not Modified with no body."],
      ["“Blocked by CORS policy” in the console", "A page on one origin called an API on another, and the API did not say that origin was allowed."],
    ],
    flow: {
      title: "A cross-origin request, then a cached one",
      actors: ["Browser (app.example)", "API (api.example)"],
      steps: [
        [0, 1, "OPTIONS /bookmarks", "A preflight. The browser asks permission before sending a cross-origin POST with JSON."],
        [1, 0, "204 + Access-Control-Allow-Origin", "The API says this origin, method and header are allowed.", "res"],
        [0, 1, "POST /bookmarks", "Now the real request is sent."],
        [1, 0, "201 Created", "A new resource exists. The status code says so without the client parsing the body.", "res"],
        [0, 1, "GET /bookmarks/42", "A plain read."],
        [1, 0, "200 OK, ETag: \"v7\"", "The response carries a version tag the browser can keep.", "res"],
        [0, 1, "GET, If-None-Match: \"v7\"", "Later, the browser asks again and mentions the version it already has."],
        [1, 0, "304 Not Modified", "Nothing changed, so no body is sent. The browser reuses its copy.", "res"],
      ],
    },
  },

  "03": {
    analogy: {
      title: "A reception desk",
      text: "You walk into a large building and tell reception two things: what you want to do and who it concerns. The receptionist checks the directory and sends you to exactly one room. If the room doesn't exist you are told so. If it exists but doesn't offer that service, you are told what it does offer.",
      map: [
        ["What you want to do", "HTTP method"],
        ["Who or what it concerns", "Path"],
        ["The directory", "Route table"],
        ["The room you are sent to", "Handler function"],
        ["“No such room”", "404 Not Found"],
        ["“That room doesn't do that”", "405 Method Not Allowed"],
      ],
    },
    uses: [
      ["A search page at /search?q=shoes", "/search is the route. q=shoes is a query parameter telling that one handler what to look for."],
      ["github.com/nodejs/node", "Two path parameters, an owner and a repository, matched by a single route pattern."],
      ["A mistyped link", "No route matched the path, so the server answered 404 with its “page not found” screen."],
    ],
    flow: {
      title: "Three requests, three outcomes",
      actors: ["Client", "Router", "Handler"],
      steps: [
        [0, 1, "GET /bookmarks/42", "The router receives the method and the path."],
        [1, 1, "match GET /bookmarks/:id", "It compares them against the route table and extracts id = \"42\"."],
        [1, 2, "getBookmark({ id: \"42\" })", "Exactly one handler runs."],
        [2, 0, "200 { id: 42 }", "The handler's result becomes the response.", "res"],
        [0, 1, "DELETE /health", "The path exists, but not with this method."],
        [1, 0, "405, Allow: GET", "The router says which methods would work.", "err"],
        [0, 1, "GET /nope", "No route has this path at all."],
        [1, 0, "404 Not Found", "Nothing matched.", "err"],
      ],
    },
  },

  "04": {
    analogy: {
      title: "Flat-pack furniture",
      text: "You can't post an assembled wardrobe through a letterbox. So it is taken apart, packed flat with an instruction sheet, shipped, and put back together at the other end. Objects in a program's memory are the same: they can't travel as they are. They are flattened into bytes in an agreed format, sent, and rebuilt on the other side.",
      map: [
        ["The assembled wardrobe", "An object in memory"],
        ["Taking it apart and boxing it", "Serialization"],
        ["The flat box", "JSON text (or Protobuf bytes)"],
        ["The instruction sheet", "Schema"],
        ["Reassembly", "Deserialization (parsing)"],
        ["A missing screw", "A parse or validation error"],
      ],
    },
    uses: [
      ["A weather app updating", "It received a JSON document and rebuilt it into objects it can draw."],
      ["A time shown a few hours off", "JSON has no date type. The date travelled as text, and one side forgot the time zone."],
      ["An ID whose last digits changed", "JavaScript numbers lose precision above 2^53, which is why many APIs send large ids as strings."],
    ],
    flow: {
      title: "An object crossing the wire and back",
      actors: ["Client object", "Bytes on the wire", "Server object"],
      steps: [
        [0, 0, "{ title, tags, savedAt: Date }", "In memory, the client has a real object with a real Date."],
        [0, 1, "JSON.stringify", "It becomes text. The Date turns into an ISO 8601 string."],
        [1, 2, "POST body", "Only bytes travel. Neither side shares memory with the other."],
        [2, 2, "JSON.parse", "The server rebuilds an object. savedAt is a string now, not a Date."],
        [2, 2, "check shape, convert types", "The server confirms the shape and converts fields before trusting them."],
        [2, 1, "serialize the response", "The reply is flattened the same way.", "res"],
        [1, 0, "parse", "The client rebuilds it. Both sides agreed on the format, so it works.", "res"],
      ],
    },
  },

  "05": {
    analogy: {
      title: "Checking into a hotel",
      text: "At the front desk you prove who you are once, with a passport. You get a key card. For the rest of your stay nobody asks for the passport again: the card is enough. And the card opens your room and the gym, but not other guests' rooms. Proving who you are is authentication. What your card opens is authorization.",
      map: [
        ["Showing your passport", "Logging in with a password"],
        ["The key card", "Session cookie or access token"],
        ["The front desk's guest list", "Session store"],
        ["The card expiring at checkout", "Session or token expiry"],
        ["Your room only", "Ownership check"],
        ["A staff master key", "Admin role"],
      ],
    },
    uses: [
      ["“Sign in with Google”", "OAuth and OpenID Connect. The app learns who you are without ever seeing your Google password."],
      ["Still logged in the next day", "A cookie holds a session id, and the server still has that session."],
      ["A six-digit code from an app", "A second factor: something you have, on top of something you know."],
      ["“You need access” on a shared document", "You are logged in (authenticated) but not allowed (authorized). That is a 403."],
    ],
    flow: {
      title: "Log in once, then be recognised",
      actors: ["Browser", "API", "Session store"],
      steps: [
        [0, 1, "POST /login", "Email and password, sent over TLS."],
        [1, 1, "hash and compare", "The server hashes the password and compares it, in constant time, with the stored hash."],
        [1, 2, "create session k8Jf… → user 7", "A random id is stored on the server, pointing at the user."],
        [1, 0, "Set-Cookie: sid=k8Jf…; HttpOnly", "Only the random id goes to the browser. Scripts on the page can't read it.", "res"],
        [0, 1, "GET /bookmarks/42 + cookie", "The browser attaches the cookie automatically."],
        [1, 2, "who is k8Jf…?", "The API looks the session up."],
        [2, 1, "user 7", "Authentication done: the server knows who is asking.", "res"],
        [1, 1, "does user 7 own bookmark 42?", "Authorization: a separate check, on every request."],
        [1, 0, "200 OK", "Both checks passed.", "res"],
      ],
    },
  },

  "06": {
    analogy: {
      title: "The airport check-in desk",
      text: "Your bag is weighed and your passport checked at the desk, not halfway across the ocean. If something is wrong you are told exactly what, while it can still be fixed. The desk also tidies things up: it prints a tag and puts your bag in a standard tray. Validation rejects bad input at the door. Transformation puts good input into one standard shape.",
      map: [
        ["Is this a passport at all?", "Type check"],
        ["Is it still in date?", "Range and format check"],
        ["Does the name match the ticket?", "Semantic check"],
        ["Tagging and traying the bag", "Normalization: trim, lowercase"],
        ["“Your bag is 3 kg over”", "400 with an error per field"],
      ],
    },
    uses: [
      ["“Password must be at least 12 characters”", "A length rule. The form shows it early, and the server enforces it again."],
      ["Logging in with “ Me@Mail.com ”", "The server trims and lowercases the email, so it matches the account you created."],
      ["A form that looks fine but still fails", "Browser checks are a convenience. The server never trusts them, because a request can skip the form."],
    ],
    flow: {
      title: "Bad input stops at the door",
      actors: ["Client", "Validation", "Service", "Database"],
      steps: [
        [0, 1, "{ url: \"nodejs.org\", tags: \"js\" }", "A request arrives with two problems."],
        [1, 1, "check every field", "No scheme on the URL, and tags is a string where an array is expected."],
        [1, 0, "400 with two field errors", "All problems are reported at once. Nothing deeper ever ran.", "err"],
        [0, 1, "{ url: \" HTTPS://NodeJS.org \", tags: [\"JS \"] }", "The client fixes it and tries again."],
        [1, 1, "trim, lowercase", "Valid. The value is also put into one standard shape."],
        [1, 2, "{ url: \"https://nodejs.org/\", tags: [\"js\"] }", "Only the cleaned value moves on."],
        [2, 3, "INSERT", "The service and database can assume the data is well formed."],
        [2, 0, "201 Created", "Saved.", "res"],
      ],
    },
  },

  "07": {
    analogy: {
      title: "A restaurant kitchen brigade",
      text: "A host checks your reservation before you get near a table. A waiter takes the order in your words and translates it for the kitchen. The chef decides how the dish is made. A pantry clerk fetches the ingredients. Each person has one job, and the order ticket travels with the dish the whole way.",
      map: [
        ["Host at the door", "Middleware"],
        ["Waiter", "Controller (handler)"],
        ["Chef", "Service: the business rules"],
        ["Pantry clerk", "Repository: talks to the database"],
        ["The order ticket", "Request context: id, user, deadline"],
      ],
    },
    uses: [
      ["Every log line for one request sharing an id", "Middleware created a request id and the context carried it into every layer."],
      ["“Please log in” before any page loads", "Auth middleware ran first and stopped the request before a controller saw it."],
      ["The website and a nightly import creating the same records", "Both call the same service. Only the controller in front of it differs."],
    ],
    flow: {
      title: "One request through the layers",
      actors: ["Middleware", "Controller", "Service", "Repository", "Postgres"],
      steps: [
        [0, 0, "request id, cookie → user", "Middleware runs first: it labels the request and works out who sent it."],
        [0, 1, "request + context", "The controller receives a request that is already identified."],
        [1, 1, "validate the body", "The controller speaks HTTP: it reads input and chooses what to call."],
        [1, 2, "create(ownerId, input)", "The service gets plain values. It knows nothing about HTTP."],
        [2, 2, "apply the rules", "Quotas, duplicates, defaults: the decisions live here."],
        [2, 3, "insert(bookmark)", "The service asks for storage without writing SQL itself."],
        [3, 4, "INSERT … RETURNING *", "Only the repository knows the table."],
        [4, 2, "row", "The result travels back up.", "res"],
        [2, 1, "bookmark", "The service returns a plain object.", "res"],
        [1, 0, "201 + JSON", "The controller turns it into an HTTP response.", "res"],
      ],
    },
  },

  "08": {
    analogy: {
      title: "A public library",
      text: "Every book has a call number, and every library files them the same way. There are only a few things you can do: look a book up, add one, replace one, amend its record, remove it. Because the system is the same everywhere, you can walk into a library you have never visited and find what you need without training.",
      map: [
        ["A call number", "URI: /bookmarks/42"],
        ["A shelf", "Collection: /bookmarks"],
        ["Look up, add, amend, remove", "GET, POST, PATCH, DELETE"],
        ["“Next shelf along”", "Pagination cursor"],
        ["The same filing in every library", "Uniform interface"],
      ],
    },
    uses: [
      ["Infinite scroll", "Each batch is a request for the next page, usually with a cursor that marks where the last one ended."],
      ["Double-clicking “Pay” and being charged once", "The client sent an idempotency key, so the server recognised the retry."],
      ["Using Stripe's or GitHub's API from the docs alone", "They follow the same conventions, so what you learned on one applies to the other."],
    ],
    flow: {
      title: "Create, retry safely, page, change, delete",
      actors: ["Client", "API"],
      steps: [
        [0, 1, "POST /bookmarks, Idempotency-Key: k1", "Create a resource in the collection."],
        [1, 0, "201 Created, Location: /bookmarks/42", "The response says where the new resource lives.", "res"],
        [0, 1, "POST again, same key", "The client never saw the reply, so it retries."],
        [1, 0, "201, the same bookmark", "The key was seen before. No duplicate is created.", "res"],
        [0, 1, "GET /bookmarks?limit=2", "Read the collection, a page at a time."],
        [1, 0, "200 { data, nextCursor }", "Two items and a marker for where to continue.", "res"],
        [0, 1, "PATCH /bookmarks/42 { title }", "Change one field. The rest is left alone."],
        [1, 0, "200 + the updated bookmark", "The response shows the resource as it is now.", "res"],
        [0, 1, "DELETE /bookmarks/42", "Remove it."],
        [1, 0, "204 No Content", "Done, and there is nothing to send back.", "res"],
      ],
    },
  },

  "09": {
    analogy: {
      title: "A ledger office",
      text: "Every form has fixed boxes, and the clerk refuses one with a required box left empty. Card indexes at the front mean nobody reads every ledger to find a name. A transfer between two accounts is written as two entries that are both recorded or neither. And once the clerk says “done”, it stays done even if the lights go out.",
      map: [
        ["A form with fixed boxes", "Table schema"],
        ["Refusing an incomplete form", "Constraints: NOT NULL, UNIQUE, foreign keys"],
        ["The card index", "Index"],
        ["Both entries or neither", "Transaction (atomicity)"],
        ["“Done” survives a power cut", "Durability"],
      ],
    },
    uses: [
      ["A bank transfer", "Money leaves one account and arrives in another inside one transaction. It can never do just half."],
      ["“That username is taken”", "A unique constraint. The database enforces it even when two people sign up in the same millisecond."],
      ["Your order history showing product names", "A join: orders hold product ids, and the database follows them to the products table."],
    ],
    flow: {
      title: "One transaction, from pool to disk",
      actors: ["App", "Pool", "Postgres", "Disk"],
      steps: [
        [0, 1, "borrow a connection", "Connections are expensive, so a few are kept open and shared."],
        [0, 2, "BEGIN", "Start a transaction: everything until COMMIT counts as one change."],
        [0, 2, "INSERT INTO bookmarks ($1, $2)", "Values travel separately from the SQL text, so they can never be run as SQL."],
        [2, 2, "check constraints", "NOT NULL, the foreign key to users, the unique URL per owner."],
        [0, 2, "INSERT tags, link them", "A second and third write, still in the same transaction."],
        [0, 2, "COMMIT", "Make it permanent."],
        [2, 3, "flush the write-ahead log", "The change is on disk before Postgres answers."],
        [2, 0, "ok", "All three writes exist. A crash before this point would have left none of them.", "res"],
        [0, 1, "release the connection", "It goes back to the pool for the next request."],
      ],
    },
  },

  "10": {
    analogy: {
      title: "Your desk and the archive",
      text: "You keep the files you use every day on your desk. Everything else is in the basement archive, a slow walk away. If a file isn't on the desk you fetch it and keep a copy. But a copy can go out of date, so you write “check again after Friday” on it, and you throw it away the moment you hear the original changed.",
      map: [
        ["Your desk", "Cache (Redis, memory, a CDN)"],
        ["The basement archive", "Database or slow service"],
        ["Not on the desk", "Cache miss"],
        ["An out-of-date copy", "Stale data"],
        ["“Check again after Friday”", "TTL"],
        ["Binning the copy when the original changes", "Invalidation"],
        ["A full desk", "Eviction: LRU, LFU"],
      ],
    },
    uses: [
      ["A site that loads faster the second time", "The browser kept images, scripts and styles from the first visit."],
      ["Your old profile photo lingering after you changed it", "A cache somewhere is still serving the previous copy until it expires."],
      ["A like count that lags by a few seconds", "The number is cached with a short TTL, because exact freshness isn't worth a query per view."],
    ],
    flow: {
      title: "Cache-aside: miss, fill, hit, invalidate",
      actors: ["API", "Redis", "Postgres"],
      steps: [
        [0, 1, "GET bookmark:42", "Always try the cache first."],
        [1, 0, "nil", "A miss: nothing is stored under that key.", "err"],
        [0, 2, "SELECT … WHERE id = 42", "Fall back to the source of truth."],
        [2, 0, "row, a few milliseconds", "The slow path.", "res"],
        [0, 1, "SET bookmark:42 … EX 300", "Keep a copy for five minutes."],
        [0, 1, "GET bookmark:42", "The next request for the same bookmark."],
        [1, 0, "hit, well under a millisecond", "No database query at all.", "res"],
        [0, 2, "UPDATE bookmarks …", "Someone edits the bookmark."],
        [0, 1, "DEL bookmark:42", "Delete the copy so nobody reads the old version."],
      ],
    },
  },

  "11": {
    analogy: {
      title: "A café counter",
      text: "The cashier takes your order, hands you a number and turns to the next customer. A barista works through the tickets on the rail. If a drink is spilled it is made again. A ticket that keeps going wrong is set aside for the manager. The queue of people keeps moving because taking an order and making it are separate jobs.",
      map: [
        ["Cashier taking the order", "API handler (producer)"],
        ["Your order number", "202 or 201 returned straight away"],
        ["The ticket rail", "Queue (broker)"],
        ["Barista", "Worker"],
        ["Remaking a spilled drink", "Retry with backoff"],
        ["Tickets set aside for the manager", "Dead-letter queue"],
      ],
    },
    uses: [
      ["“We'll email you when your export is ready”", "The request only queued a job. A worker builds the file later."],
      ["A video “processing” after upload", "Transcoding is slow, so it runs in the background while you carry on."],
      ["A receipt email arriving seconds after you pay", "Sending email was pushed to a queue so a slow mail server can't delay checkout."],
    ],
    flow: {
      title: "A job that fails once and succeeds on retry",
      actors: ["Client", "API", "Queue", "Worker", "Website"],
      steps: [
        [0, 1, "POST /bookmarks", "Save a link."],
        [1, 2, "add job: enrich(42)", "The slow part, fetching the page title, is queued."],
        [1, 0, "201 Created", "The client gets its answer without waiting for that fetch.", "res"],
        [2, 3, "enrich(42), attempt 1", "A worker picks the job up."],
        [3, 4, "GET the page", "It calls a site you don't control."],
        [4, 3, "timeout", "The site is slow today.", "err"],
        [3, 2, "failed: retry in 2 s", "The job goes back with a delay that doubles each attempt."],
        [2, 3, "enrich(42), attempt 2", "Running it twice must be harmless: the job is idempotent."],
        [4, 3, "200 <title>…", "This time it works.", "res"],
        [3, 2, "completed", "The bookmark now has a title and description."],
      ],
    },
  },

  "12": {
    analogy: {
      title: "The index at the back of a book",
      text: "To find every mention of “cache” you don't reread the whole book. You turn to the index, find the word and get a list of pages. The index also files “caching” and “cached” under the same entry and leaves out words like “the”. A search engine builds that index for your data, so a query is a lookup, not a read of everything.",
      map: [
        ["Rereading every page", "LIKE '%cache%' (a full scan)"],
        ["The index at the back", "Inverted index (GIN in Postgres)"],
        ["One entry for cache, caching, cached", "Stemming"],
        ["Leaving out “the” and “of”", "Stop words"],
        ["Most relevant pages first", "Ranking: ts_rank, BM25"],
      ],
    },
    uses: [
      ["Searching mail for “invoice” and finding “invoices”", "Both words were reduced to the same stem when the index was built."],
      ["Shop results with the best match on top", "Each result is scored for relevance, and the list is sorted by that score."],
      ["Results that appear as you type", "The index answers in milliseconds, so the app can search on every keystroke."],
    ],
    flow: {
      title: "Index a document, then search it",
      actors: ["Document", "Analyzer", "Index", "Search box"],
      steps: [
        [0, 1, "“Caching in Redis, explained”", "A bookmark's title is saved."],
        [1, 1, "lowercase, split, drop “in”, stem", "The text is reduced to the terms that carry meaning."],
        [1, 2, "cach, redi, explain → doc 42", "Each term now points at the documents that contain it."],
        [3, 1, "“redis caches”", "A user searches. The query goes through the same analyzer."],
        [1, 2, "look up redi, cach", "Two lookups in the index. No table scan."],
        [2, 2, "rank the matches", "Doc 42 contains both terms, doc 7 only one."],
        [2, 3, "doc 42, then doc 7", "Results come back in order of relevance.", "res"],
      ],
    },
  },

  "13": {
    analogy: {
      title: "A fuse box",
      text: "When one appliance shorts, a fuse cuts that circuit so the rest of the house keeps its power. Emergency lights come on so you can still find your way. And an electrician finds the fault from a labelled fuse, not by opening every wall. A backend handles failure the same way: contain it, keep the rest working, and leave a clear record of what broke.",
      map: [
        ["A fuse tripping", "Circuit breaker"],
        ["Emergency lighting", "Fallback and graceful degradation"],
        ["Resetting and trying again", "Retry with backoff"],
        ["A labelled fuse", "Typed error with a request id"],
        ["Not telling visitors your wiring plan", "No stack traces in responses"],
      ],
    },
    uses: [
      ["“Something went wrong. Reference: 8f3a…”", "You get a safe message and an id. The full detail is in the logs under that id."],
      ["A shop page that loads without its recommendations", "One service failed, so that section was left out and everything else still works."],
      ["“Reconnecting…” with growing pauses", "A client retrying with backoff, so a struggling server isn't flooded."],
    ],
    flow: {
      title: "One dependency fails, the request survives",
      actors: ["Client", "API", "Error handler", "Metadata site"],
      steps: [
        [0, 1, "POST /bookmarks", "Save a link and look up its title."],
        [1, 3, "fetch, timeout 3 s", "Every outbound call has a deadline."],
        [3, 1, "no answer", "The other site is down.", "err"],
        [1, 1, "retry after 200 ms, then 400 ms", "A few spaced attempts, in case the fault was brief."],
        [1, 1, "five failures: open the circuit", "Stop calling the site for a while so requests fail fast."],
        [1, 0, "201, saved without a title", "Degraded, not broken. The title can be filled in later.", "res"],
        [0, 1, "GET /bookmarks/abc", "A different request, with a bad id."],
        [1, 2, "throw ValidationError", "Code throws a typed error and doesn't build a response itself."],
        [2, 0, "400 problem+json", "One place turns every error into the same shape, with no internals.", "err"],
      ],
    },
  },
};
