import type { Scene } from "../types";

const VAR_1 = "currentRequestId = req-1";
const VAR_2 = "currentRequestId = req-2";

/** Lesson 07, Controllers, services, repositories and middleware. */
export const scenes: Scene[] = [
  {
    type: "flow",
    after: "services-the-business-logic",
    title: "A NotFoundError travels up to the one error handler",
    actors: ["Client", "Controller", "Service", "Repository", "Error handler"],
    steps: [
      [0, 1, "GET /api/v1/bookmarks/<id>, as Bo", "Bo asks for a bookmark that belongs to Ana."],
      [1, 2, "service.get(req.user.id, req.params.id)", "The controller pulls plain values out of the request and calls one service method."],
      [2, 3, "findForOwner(id, ownerId)", "The service asks for the bookmark by id and owner, without knowing how it is stored."],
      [3, 2, "null", "No bookmark with that id belongs to Bo.", "res"],
      [2, 2, "throw new NotFoundError(\"bookmark\")", "The service decides this is a failure and says so in its own terms. It never touches the reply.", "err"],
      [2, 4, "the error passes straight through the controller", "The controller has no try/catch for this, so the error travels up to the one place that handles all of them.", "err"],
      [4, 4, "NotFoundError becomes a 404", "Only here does the error turn into an HTTP response, in the same shape for every route."],
      [4, 0, "404 { error, requestId }", "A worker or a test calling the same service gets the same error and never needs to know about HTTP.", "err"],
    ],
  },
  {
    type: "boxes",
    after: "middleware-code-that-runs-around-every-handler",
    title: "The middleware chain fills up, then unwinds",
    boxes: ["Not called yet", "Started, not finished", "Console"],
    frames: [
      {
        items: [["logger", "auth", "handler"], [], []],
        label: "compose([logger, auth], handler)",
        note: "The three functions are chained so that each one decides whether to call the next.",
      },
      {
        items: [["auth", "handler"], ["logger"], ["→ logger in"]],
        hot: ["logger", "→ logger in"],
        label: "logger: note the start, await next()",
        note: "The logger does its work for the way in, then pauses until everything inside it has finished.",
      },
      {
        items: [["handler"], ["logger", "auth"], ["→ logger in", "→ auth"]],
        hot: ["auth", "→ auth"],
        label: "auth: set ctx.user, await next()",
        note: "The credential is there, so auth adds the user and passes the request on. Two functions are now paused.",
      },
      {
        items: [[], ["logger", "auth", "handler"], ["→ logger in", "→ auth", "→ handler"]],
        hot: ["handler", "→ handler"],
        label: "handler: ctx.status = 200",
        note: "The innermost function does the real work while the others wait at their await.",
      },
      {
        items: [[], ["logger"], ["→ logger in", "→ auth", "→ handler"]],
        hot: ["logger"],
        label: "handler returns, then auth returns",
        note: "The chain unwinds in the reverse order: each await next() resumes where it stopped.",
        kind: "res",
      },
      {
        items: [[], [], ["→ logger in", "→ auth", "→ handler", "← logger out: 200"]],
        hot: ["← logger out: 200"],
        label: "logger: the code after await next()",
        note: "Code after await next() runs on the way out, so one logger sees the final status and the time taken by everything inside it.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "order-matters",
    title: "One rejected request under two registration orders",
    boxes: ["Registered in this order", "Ran", "Access log"],
    frames: [
      {
        items: [["logger", "auth", "handler"], [], []],
        label: "GET /api/v1/bookmarks, no cookie",
        note: "A request without a session arrives. The logger is registered before auth.",
      },
      {
        items: [["logger", "auth", "handler"], ["logger", "auth"], []],
        hot: ["auth"],
        label: "auth replies 401 and does not call next()",
        note: "Auth stops the request, so the handler never runs. The logger is still waiting around it.",
      },
      {
        items: [["logger", "auth", "handler"], ["logger", "auth"], ["401 GET /api/v1/bookmarks"]],
        hot: ["logger", "401 GET /api/v1/bookmarks"],
        label: "logger records the 401 on the way out",
        note: "Because the logger wraps auth, it sees the rejection and how long it took.",
        kind: "res",
      },
      {
        items: [["auth", "logger", "handler"], [], []],
        hot: ["auth", "logger"],
        label: "swap them: auth registered first",
        note: "The same request again, with the two middleware in the other order.",
      },
      {
        items: [["auth", "logger", "handler"], ["auth"], []],
        hot: ["auth"],
        label: "auth replies 401 before the logger starts",
        note: "The chain stops at its first link. The logger was never called, so there is nothing for it to record on the way out.",
        kind: "err",
      },
      {
        items: [["auth", "logger", "handler"], ["auth"], []],
        hot: ["logger"],
        label: "access log: empty",
        note: "Rejected requests never reach the logs, and those are exactly the requests you want to see during an attack.",
        kind: "err",
      },
    ],
  },
  {
    type: "boxes",
    after: "request-context",
    title: "Two overlapping requests log their request ids",
    boxes: ["One module variable", "Request 1", "Request 2", "Log"],
    frames: [
      {
        items: [[VAR_1], ["start"], [], ["[req-1] start"]],
        hot: [VAR_1],
        label: "request 1 sets the variable",
        note: "The naive way to share a request id: a module-level variable that every function can read.",
      },
      {
        items: [[VAR_1], ["awaiting query"], [], ["[req-1] start"]],
        hot: ["awaiting query"],
        label: "request 1 awaits its query",
        note: "While request 1 waits for the database, Node is free to start another request.",
      },
      {
        items: [[VAR_2], ["awaiting query"], ["start"], ["[req-1] start", "[req-2] start"]],
        hot: [VAR_2, "[req-2] start"],
        label: "request 2 overwrites the variable",
        note: "There is only one variable, and it now holds request 2's id.",
      },
      {
        items: [[VAR_2], ["query finished"], ["awaiting query"], ["[req-1] start", "[req-2] start", "[req-2] query finished"]],
        hot: ["query finished", "[req-2] query finished"],
        label: "request 1 resumes and logs the wrong id",
        note: "Request 1's query finished, but its log line says req-2. A module-level variable is shared by every concurrent request.",
        kind: "err",
      },
      {
        items: [[], ["store: req-1", "awaiting query"], ["store: req-2", "awaiting query"], []],
        hot: ["store: req-1", "store: req-2"],
        label: "als.run({ requestId }, fn)",
        note: "Start again with AsyncLocalStorage. Each request gets its own store, which follows that request through every await.",
        kind: "res",
      },
      {
        items: [[], ["store: req-1", "query finished"], ["store: req-2", "awaiting query"], ["[req-1] query finished"]],
        hot: ["store: req-1", "[req-1] query finished"],
        label: "als.getStore() after the await",
        note: "Request 1 resumes and reads its own store, however the two requests interleave.",
        kind: "res",
      },
      {
        items: [[], ["store: req-1", "done"], ["store: req-2", "query finished"], ["[req-1] query finished", "[req-2] query finished"]],
        hot: ["store: req-2", "[req-2] query finished"],
        label: "request 2 logs its own id too",
        note: "Nothing was passed down as an argument. Each function asked the context which request it was running for.",
        kind: "res",
      },
    ],
  },
];
