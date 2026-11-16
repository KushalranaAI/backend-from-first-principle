import type { Extra } from "./types";

/** Lessons 14–26: production, scale and engineering practice. Keyed by lesson number. */
export const PART2: Record<string, Extra> = {
  "14": {
    analogy: {
      title: "The dials on a coffee machine",
      text: "A café chain buys the same machine for every shop. What differs is on the dials: cup size, strength, water hardness. Nobody rebuilds the machine to change them. And the code for the safe is never written on the machine itself. Configuration is the dials: the values that differ between places the same code runs. Secrets are the safe code.",
      map: [
        ["The machine", "Your code: identical everywhere"],
        ["The dials", "Configuration: port, URLs, limits"],
        ["Each shop's settings", "Environments: local, staging, production"],
        ["The safe code", "Secrets: keys, passwords"],
        ["A machine that won't start with a dial missing", "Validating config at startup"],
      ],
    },
    uses: [
      ["A shop taking test cards on its staging site", "Same code, different payment key, read from that environment's configuration."],
      ["A feature that only some users see", "A feature flag: a config value checked at run time, changed without a deploy."],
      ["A leaked key being revoked within minutes", "Secrets pushed to a public repository are scanned for and found fast, which is why they never belong in code."],
    ],
    flow: {
      title: "Start-up: read, validate, then run",
      actors: ["Environment", "Config module", "App", "Database"],
      steps: [
        [0, 1, "DATABASE_URL, PORT, SESSION_SECRET", "Values arrive from outside the code."],
        [1, 1, "parse and validate every value", "Types are converted and required values are checked, once."],
        [1, 2, "one frozen config object", "The rest of the app reads config from one place and never touches process.env."],
        [2, 3, "connect", "The app starts with values it knows are good.", "res"],
        [0, 1, "PORT=abc", "Now a deploy with a typo."],
        [1, 1, "PORT must be a number", "Validation catches it immediately."],
        [1, 2, "exit 1", "The app refuses to start. A failed deploy is far cheaper than a failure at 3 a.m.", "err"],
      ],
    },
  },

  "15": {
    analogy: {
      title: "A car's dashboard, logbook and GPS trace",
      text: "The dashboard gauges tell you at a glance that something is wrong: the engine is hot. The logbook tells you what happened and when. The GPS trace of one journey shows where the time went, turn by turn. You need all three to go from “something is wrong” to “this is why”.",
      map: [
        ["Dashboard gauges", "Metrics: rate, errors, duration"],
        ["The logbook", "Structured logs"],
        ["One journey's GPS trace", "Distributed trace"],
        ["A warning light", "Alert on a symptom"],
        ["The trip number written on everything", "Request id or trace id"],
      ],
    },
    uses: [
      ["A status page saying “elevated error rates”", "A metric crossed a threshold and someone was paged."],
      ["Support asking for the reference on your error page", "That id finds every log line your request produced."],
      ["“It got slow after Tuesday's release”", "A latency graph by version answers that in seconds. Without metrics it is a guess."],
    ],
    flow: {
      title: "One request, three signals",
      actors: ["API", "Postgres", "Logs", "Metrics", "Traces"],
      steps: [
        [0, 0, "trace id 4bf9…, start the clock", "The request is labelled the moment it arrives."],
        [0, 2, "{ level, reqId, msg }", "A structured log line: fields a machine can search, not a sentence."],
        [0, 1, "SELECT … (38 ms)", "The database call is timed as its own span."],
        [0, 4, "handler 45 ms → db 38 ms", "The trace shows where the time went inside this one request."],
        [0, 3, "requests +1, duration: 50 ms bucket", "Metrics count every request cheaply, without storing each one."],
        [3, 3, "p99 above the target", "A dashboard shows the trend, and an alert fires on what users feel.", "err"],
        [3, 4, "from the alert to a slow trace", "The same id links the graph to a trace and the trace to its logs."],
      ],
    },
  },

  "16": {
    analogy: {
      title: "Closing a shop for the night",
      text: "At closing time you flip the sign to “Closed” so nobody new comes in. You serve the customers who are already at the till. You cash up and lock the safe. Then you switch off the lights. Pulling the shutters down on people mid-purchase is the other way to close, and it is what happens to a server that ignores its shutdown signal.",
      map: [
        ["“We close in five minutes”", "SIGTERM"],
        ["Flipping the sign", "Readiness check starts failing"],
        ["Serving people already inside", "Draining in-flight requests"],
        ["Cashing up", "Closing pools, flushing logs"],
        ["Lights off", "exit 0"],
        ["Shutters down on everyone", "SIGKILL"],
      ],
    },
    uses: [
      ["An app that updates without logging you out", "Old servers finished their requests before stopping, while new ones took the new traffic."],
      ["An upload that survives a deploy", "The server holding it was given time to finish before it exited."],
      ["A cloud platform's “30 second grace period”", "The time between SIGTERM and SIGKILL. Your shutdown has to fit inside it."],
    ],
    flow: {
      title: "A deploy replaces a running server",
      actors: ["Platform", "Load balancer", "App", "Postgres"],
      steps: [
        [0, 2, "SIGTERM", "A polite request to stop. The process can catch it."],
        [2, 1, "/health/ready → 503", "The app says it shouldn't receive new work."],
        [1, 1, "stop routing here", "New requests go to other instances."],
        [2, 2, "finish 12 in-flight requests", "Requests already started are allowed to complete."],
        [2, 3, "pool.end()", "Connections are closed cleanly once nothing is using them."],
        [2, 0, "exit 0", "A clean exit, well inside the grace period.", "res"],
        [0, 2, "SIGKILL after 30 s", "If the app had hung, it would be killed without warning. This one can't be caught.", "err"],
      ],
    },
  },

  "17": {
    analogy: {
      title: "A bank branch",
      text: "A locked front door is not what keeps a bank safe. The teller checks ID for every withdrawal, however friendly the customer. A note that says “give me everything” is read as a note, not obeyed as an order. There is a daily limit, a camera and a time lock as well, so one failure is never enough. Security is the same habit: trust nothing that comes through the door, and never rely on one layer.",
      map: [
        ["ID checked on every withdrawal", "Authorization on every request"],
        ["A note is read, not obeyed", "Parameterized queries: data is never code"],
        ["A daily withdrawal limit", "Rate limiting"],
        ["Vault, camera and time lock together", "Defence in depth"],
        ["Not storing customers' PINs in a drawer", "Hashing passwords with a slow, salted algorithm"],
      ],
    },
    uses: [
      ["“Too many attempts. Try again in 15 minutes”", "Rate limiting on login, which makes guessing passwords impractical."],
      ["A breach notice saying passwords were hashed", "The attackers got hashes, not passwords. With a slow salted hash, cracking each one is expensive."],
      ["Changing a number in a URL and seeing someone else's order", "A missing ownership check. It is the most common serious API flaw, and the fix is one comparison."],
    ],
    flow: {
      title: "Two attacks, and why they fail",
      actors: ["Attacker", "API", "Postgres"],
      steps: [
        [0, 1, "?q=' OR '1'='1", "Input crafted to be read as SQL."],
        [1, 2, "\"… WHERE title = '\" + q + \"'\"", "Vulnerable: the query is built by joining strings, so the input becomes part of the code.", "err"],
        [2, 0, "every row in the table", "The condition is always true. This is SQL injection.", "err"],
        [1, 2, "WHERE title = $1, with q as a value", "Fixed: the SQL text and the value travel separately."],
        [2, 1, "0 rows", "The input was only ever compared as text. It can't change the query.", "res"],
        [0, 1, "GET /bookmarks/43", "A second attack: a valid login, but someone else's bookmark."],
        [1, 1, "is 43 owned by this user?", "The check that is easiest to forget."],
        [1, 0, "404 Not Found", "It doesn't reveal that the bookmark exists.", "res"],
      ],
    },
  },

  "18": {
    analogy: {
      title: "Supermarket checkouts",
      text: "When queues build up you can train one cashier to scan faster, which has a limit, or open more tills. With several tills you need someone pointing shoppers at the shortest queue. Queues stay short while tills are half busy, then grow suddenly when they are nearly always busy. And one trolley with two hundred items makes a few people wait a long time while the average looks fine.",
      map: [
        ["A faster cashier", "Vertical scaling: a bigger machine"],
        ["More tills", "Horizontal scaling: more instances"],
        ["The person directing shoppers", "Load balancer"],
        ["Queues exploding near 100% busy", "The utilization and latency curve"],
        ["The unlucky few behind the big trolley", "p99 latency"],
        ["Any till can serve anyone", "Stateless servers"],
      ],
    },
    uses: [
      ["“You are in a queue” on a ticket sale", "Demand exceeded capacity, so requests are held and admitted at a rate the system can serve."],
      ["A site that is fast for you and slow for a friend", "Averages hide this. The slowest 1% of requests is what percentiles measure."],
      ["A site that feels local from another continent", "A CDN served the content from a machine near you."],
    ],
    flow: {
      title: "Where the load goes",
      actors: ["Users", "Load balancer", "App ×3", "Cache", "Database"],
      steps: [
        [0, 1, "1,000 requests a second", "More than one instance can handle."],
        [1, 2, "least connections", "Each request goes to the instance with the fewest in progress."],
        [2, 2, "no state kept in memory", "Any instance can serve any user, so adding a fourth is trivial."],
        [2, 3, "hot reads", "The most common reads never reach the database."],
        [3, 2, "most are hits", "The hit ratio decides how much load the cache removes.", "res"],
        [2, 4, "the rest", "Only misses and writes reach the database."],
        [4, 4, "replicas read, the primary writes", "Reads are spread over copies. The database is usually the last thing to scale."],
        [2, 0, "measure p50 and p99", "Check the slow tail, not the average, before and after every change.", "res"],
      ],
    },
  },

  "19": {
    analogy: {
      title: "One chef, many pots",
      text: "A good chef doesn't stand watching pasta boil. While it cooks they chop vegetables and stir a sauce: one person, many dishes in progress, because most of cooking is waiting. That is concurrency. Chopping is different. It needs hands, so to chop twice as fast you need a second chef. That is parallelism. And two chefs who both salt the same soup without talking have a race condition.",
      map: [
        ["Waiting for pasta to boil", "I/O-bound work: a query, a network call"],
        ["Chopping", "CPU-bound work: hashing, image resizing"],
        ["One chef switching between pots", "Concurrency: the event loop"],
        ["A second chef", "Parallelism: threads, worker_threads"],
        ["Both salting the soup", "Race condition"],
        ["“I've got the soup”", "A lock, or a transaction"],
      ],
    },
    uses: [
      ["A chat server holding thousands of quiet connections", "Idle connections cost almost nothing when nothing blocks while waiting."],
      ["An app that freezes during a heavy calculation", "CPU-bound work ran on the one thread that also handles everything else."],
      ["Two people buying the last ticket in the same instant", "A race. Both read “1 left” before either wrote “0”, unless the database makes them take turns."],
    ],
    flow: {
      title: "Two requests on one thread",
      actors: ["Request A", "Request B", "Event loop", "Postgres"],
      steps: [
        [0, 2, "handler A starts", "The single thread begins work on A."],
        [2, 3, "query A (await)", "A is now waiting on the network. The thread is free."],
        [1, 2, "handler B starts", "B runs while A waits. Nothing was blocked."],
        [2, 3, "query B (await)", "Both requests are in progress on one thread."],
        [3, 2, "A's rows", "The loop resumes A where it paused.", "res"],
        [2, 0, "response A", "A finishes first, although both were in progress together.", "res"],
        [3, 2, "B's rows", "The loop picks B up the same way.", "res"],
        [2, 1, "response B", "Two requests overlapped without two threads.", "res"],
        [2, 2, "a 2-second CPU loop", "This would freeze both. CPU-heavy work belongs in a worker thread.", "err"],
      ],
    },
  },

  "20": {
    analogy: {
      title: "A coat check",
      text: "You hand over your coat and get a ticket. You don't know which rail it hangs on and don't need to. The cloakroom can add rails forever without you noticing. For a heavy delivery there is a better arrangement: the venue gives a courier a signed, time-limited pass to the loading dock, so the boxes never go through the front office at all.",
      map: [
        ["Your coat", "An object: the file's bytes"],
        ["The ticket", "The object's key"],
        ["A note pinned to the coat", "Metadata: type, size, your own tags"],
        ["A cloakroom that never fills", "A bucket"],
        ["A signed pass to the loading dock", "Pre-signed URL"],
        ["Bringing boxes in several trips", "Multipart upload"],
      ],
    },
    uses: [
      ["Uploading a profile photo", "Your browser usually sends the file straight to object storage. The app's server only hands out permission."],
      ["Jumping to the middle of a video", "A range request fetches just those bytes, so nothing before them is downloaded."],
      ["A download link that expires", "A pre-signed URL: valid for a set time, then useless."],
    ],
    flow: {
      title: "An upload that never touches your server",
      actors: ["Browser", "API", "Object store", "Postgres"],
      steps: [
        [0, 1, "POST /attachments { name, size, type }", "The browser asks for permission to upload."],
        [1, 3, "row: status = pending", "The API records its intent before any bytes move."],
        [1, 0, "pre-signed PUT URL, 5 min", "A URL that allows exactly one upload to exactly one key, for a short time.", "res"],
        [0, 2, "PUT the file", "The bytes go straight to storage. The API's memory and bandwidth are untouched."],
        [2, 0, "200 + ETag", "Storage confirms it has every byte, with a fingerprint of the content.", "res"],
        [0, 1, "POST /attachments/7/confirm", "The browser says it has finished."],
        [1, 2, "HEAD: does it exist, right size?", "The API checks for itself and doesn't take the client's word."],
        [1, 3, "status = confirmed", "Now the file is real to the rest of the app. Uploads still pending later are cleaned up."],
      ],
    },
  },

  "21": {
    analogy: {
      title: "Waiting for a parcel",
      text: "You could phone the depot every five minutes: mostly “no news”, and a lot of wasted calls. You could ask them to hold the line until there is news. You could sign up for text updates, where they message you and you only listen. Or you could keep a call open where either of you can speak at any moment. Those are the four ways a server gets news to a client.",
      map: [
        ["Phoning every five minutes", "Polling"],
        ["“Hold the line until there's news”", "Long polling"],
        ["Text updates, one way", "Server-sent events"],
        ["An open call, both ways", "WebSocket"],
        ["A switchboard passing news between depots", "Pub/sub between servers"],
        ["“The last update I got was number 118”", "Last-Event-ID"],
      ],
    },
    uses: [
      ["“typing…” in a chat app", "Tiny messages in both directions over one open connection."],
      ["Live scores or a moving delivery map", "The server pushes each update. The page never asks."],
      ["A notification badge that updates without a refresh", "One long-lived connection carrying occasional small events."],
    ],
    flow: {
      title: "A live update across two servers",
      actors: ["Browser", "API 1", "Redis", "API 2", "Worker"],
      steps: [
        [0, 1, "GET /events", "A request whose response stays open."],
        [1, 2, "SUBSCRIBE user:7", "This server asks to hear about anything for this user."],
        [4, 2, "PUBLISH user:7 enriched(42)", "A background job finishes on a different machine."],
        [2, 1, "message", "Redis delivers it to whichever server holds the user's connection."],
        [1, 0, "event: bookmark.enriched, id: 118", "The browser gets it at once, without having asked.", "res"],
        [0, 0, "connection drops", "Networks fail. Mobile ones fail often.", "err"],
        [0, 3, "reconnect, Last-Event-ID: 118", "The browser reconnects by itself, and lands on another server."],
        [3, 0, "everything after 118", "Missed events are replayed, so nothing is lost.", "res"],
      ],
    },
  },

  "22": {
    analogy: {
      title: "Checks before a flight",
      text: "Parts are tested on a bench, one at a time: quick and cheap. Then systems are tested wired together. Then, rarely, the whole aircraft is flown. There are thousands of bench tests and a handful of test flights. Pilots practise in a simulator, which stands in for the real thing where the real thing is too slow or too risky. And every check is repeated after each change, so an old fault can't quietly return.",
      map: [
        ["Bench test of one part", "Unit test"],
        ["Systems wired together", "Integration test"],
        ["A full test flight", "End-to-end test"],
        ["Many bench tests, few flights", "The test pyramid"],
        ["A flight simulator", "Test double: stub, mock, fake"],
        ["Repeating checks after every change", "Regression suite in CI"],
      ],
    },
    uses: [
      ["A red cross on a pull request", "A test failed in CI, so the change can't be merged until it is fixed."],
      ["A bug that never comes back", "Someone wrote a test that fails when it does."],
      ["“It works on my machine”", "The test depended on something local. Running it in a clean container removes that."],
    ],
    flow: {
      title: "Red, green, refactor",
      actors: ["You", "Test", "Code", "Test database"],
      steps: [
        [0, 1, "write a test first", "Describe the behaviour you want: parseLimit(\"abc\") should fall back to 20."],
        [1, 2, "run it", "The test calls code that doesn't handle this yet."],
        [2, 1, "NaN, expected 20", "Red. You have proof the test can fail.", "err"],
        [0, 2, "the smallest fix", "Write just enough to make it pass."],
        [2, 1, "pass", "Green.", "res"],
        [0, 2, "refactor", "Tidy the code. The test tells you at once if you broke it."],
        [1, 3, "integration test: real SQL", "A throwaway Postgres catches what mocks can't, such as a constraint or a typo in a query."],
        [3, 1, "pass", "Now the query itself is covered, not a guess about it.", "res"],
      ],
    },
  },

  "23": {
    analogy: {
      title: "A franchise kitchen",
      text: "A franchise can open a new branch in a week because every kitchen is built to the same plan. There is one recipe book. The ingredient list is exact. Local details such as supplier phone numbers are on a card by the door, not printed in the book. Any supplier can be swapped. And any cook can leave mid-shift, because nothing important lives only in their head.",
      map: [
        ["One recipe book", "I. One codebase"],
        ["An exact ingredient list", "II. Declared dependencies"],
        ["The card by the door", "III. Config in the environment"],
        ["Swappable suppliers", "IV. Backing services"],
        ["Cooks who can leave mid-shift", "VI and IX. Stateless, disposable processes"],
        ["The practice kitchen matches the real one", "X. Dev/prod parity"],
      ],
    },
    uses: [
      ["Deploying with a single git push", "Platforms that do this assume your app follows these rules. Heroku wrote them down in 2011."],
      ["The same container on a laptop and in the cloud", "Dependencies are declared and config is outside the code, so nothing is special about either place."],
      ["Scaling by moving a slider", "It only works when processes keep no state of their own."],
    ],
    flow: {
      title: "Build, release, run",
      actors: ["Code", "Build", "Release", "Run"],
      steps: [
        [0, 1, "commit a1b2c3", "One codebase, tracked in version control."],
        [1, 1, "install exact dependencies", "The same inputs always give the same image."],
        [1, 2, "image + this environment's config", "A release is a build combined with config. It gets a number and never changes."],
        [2, 3, "web ×3, worker ×1", "The same image runs as different process types."],
        [3, 3, "logs to stdout, state in Postgres", "Processes keep nothing locally, so any of them can be replaced."],
        [2, 3, "one-off: migrate", "Admin tasks run from the same release, as their own short-lived process."],
        [3, 2, "roll back to v41", "A bad release is undone by running the previous one. Nothing is rebuilt.", "err"],
      ],
    },
  },

  "24": {
    analogy: {
      title: "A building's blueprint",
      text: "The electrician, the plumber and the inspector never need to phone the architect, because they all read the same drawing. Change the drawing and everyone's work follows from it. An OpenAPI file is the drawing for an API: one description that documentation, client code, mock servers and tests are all produced from.",
      map: [
        ["The drawing", "openapi.yaml"],
        ["Rooms and doors", "Paths and operations"],
        ["Measurements", "Schemas for requests and responses"],
        ["The inspector with the drawing in hand", "Contract tests"],
        ["A scale model for clients", "Mock server"],
        ["Building regulations", "Lint rules"],
      ],
    },
    uses: [
      ["A “Try it out” button in API docs", "The page was generated from an OpenAPI file, so it knows every parameter."],
      ["Autocomplete for an API in your editor", "The client library's types were generated from the same file."],
      ["An AI assistant calling a service it has never seen", "It read the description to learn which operations exist and what they need."],
    ],
    flow: {
      title: "One file, many tools",
      actors: ["openapi.yaml", "Linter", "Docs", "Client types", "Contract tests"],
      steps: [
        [0, 1, "lint", "Rules check the description before anything is built from it."],
        [1, 0, "GET /bookmarks/{id} has no 404", "A gap in the contract, caught in review and not by a user.", "err"],
        [0, 2, "render", "Reference pages that can't drift from the API, because nobody writes them by hand."],
        [0, 3, "generate", "Types for every request and response, so a wrong field is a compile error."],
        [0, 4, "generate requests", "A tool builds test requests for every operation from the schemas."],
        [4, 4, "response has a field the file doesn't list", "The server and its description disagree.", "err"],
        [4, 0, "fix one, rerun", "Either the code or the file is wrong. The test makes you decide which.", "res"],
      ],
    },
  },

  "25": {
    analogy: {
      title: "“Don't call us, we'll call you”",
      text: "Your car is at the garage. You could ring every hour to ask if it is ready. Or you leave your number and they ring you. That is a webhook: you give a service a URL, and it calls you when something happens. Since anyone could ring pretending to be the garage, you agree a password in advance. And since they will ring again if the line drops, you make sure a second call does no harm.",
      map: [
        ["Ringing every hour", "Polling"],
        ["Leaving your number", "Registering a webhook URL"],
        ["Them ringing you", "An HTTP POST to your server"],
        ["The agreed password", "HMAC signature with a shared secret"],
        ["Ringing again if the line dropped", "Retries: at-least-once delivery"],
        ["“Yes, you already told me”", "Idempotency by event id"],
      ],
    },
    uses: [
      ["A shop confirming your order the moment you pay", "The payment provider called the shop's server to say the payment succeeded."],
      ["Tests starting seconds after you push code", "The code host sent a webhook to the CI service."],
      ["A chat channel announcing a new support ticket", "One tool posting to a URL the other tool gave it."],
    ],
    flow: {
      title: "Send, fail, retry, verify",
      actors: ["Linkbox", "Outbox", "Dispatcher", "Your server"],
      steps: [
        [0, 1, "INSERT bookmark + event", "One transaction: the event exists if and only if the bookmark does."],
        [2, 1, "claim pending events", "A separate process picks up work, so a slow receiver can't slow the API."],
        [2, 2, "sign body + timestamp", "HMAC-SHA256 with a secret only the two sides know."],
        [2, 3, "POST /hooks", "The delivery, with the signature in a header."],
        [3, 2, "timeout", "The receiver was restarting.", "err"],
        [2, 2, "retry in 5 s, 30 s, 2 min", "Growing gaps with some randomness, so retries don't arrive in a wave."],
        [2, 3, "POST again, same event id", "The same delivery, sent a second time."],
        [3, 3, "verify signature, check the id", "Verify on the raw body, then check the event hasn't been handled already."],
        [3, 2, "200", "Acknowledge fast and do the real work afterwards.", "res"],
      ],
    },
  },

  "26": {
    analogy: {
      title: "Shipping containers",
      text: "Before containers, every cargo was loaded by hand in its own way, and things broke and went missing. A standard steel box changed that: the same box fits any ship, crane, train or lorry, and nobody handling it needs to know what is inside. A container image is that box for software. The pipeline around it is an assembly line with inspection points, so a change reaches users in minutes and a bad one is pulled back as fast.",
      map: [
        ["The standard box", "Container image"],
        ["The packing list", "Dockerfile"],
        ["The depot", "Registry"],
        ["The assembly line with inspections", "CI pipeline"],
        ["The port scheduling ships and cranes", "Orchestrator: Kubernetes"],
        ["Sending a few boxes first to check", "Canary release"],
      ],
    },
    uses: [
      ["Apps that update several times a day", "Small changes go through an automatic pipeline, with no “maintenance tonight” window."],
      ["A bad release gone within minutes", "The previous image is still in the registry, so rolling back is a redeploy."],
      ["A public write-up after an outage", "A blameless postmortem: what happened, why, and what changes so it can't repeat."],
    ],
    flow: {
      title: "From commit to users",
      actors: ["Git", "CI", "Registry", "Cluster", "Users"],
      steps: [
        [0, 1, "push to main", "Every change starts the same pipeline."],
        [1, 1, "lint, test, build the image", "If any step fails, nothing ships."],
        [1, 2, "push linkbox:a1b2c3", "The image is tagged with the commit it was built from."],
        [2, 3, "deploy", "The cluster pulls the new image and starts new instances beside the old."],
        [3, 3, "readiness probe passes", "New instances get no traffic until they say they are ready."],
        [3, 4, "shift traffic gradually", "Old instances drain and stop. Users notice nothing.", "res"],
        [3, 3, "error rate up? roll back", "The same mechanism, run with the previous image.", "err"],
      ],
    },
  },
};
