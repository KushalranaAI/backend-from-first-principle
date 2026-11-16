import type { Scene } from "../types";

/** Lesson 15, Logging, monitoring and observability. */
export const scenes: Scene[] = [
  {
    type: "boxes",
    after: "correlation-ids",
    title: "One request id joins log lines from two processes",
    boxes: ["API log", "Worker log", "Search for 7f3c"],
    frames: [
      {
        items: [["POST /bookmarks", "GET /tags", "query failed", "request completed"], ["job 812 started", "fetch timed out"], []],
        hot: ["query failed", "fetch timed out"],
        label: "a user reports a problem with a save",
        note: "The lines are all there, but several requests ran at the same moment and nothing says which line belongs to which.",
        kind: "err",
      },
      {
        items: [
          ["7f3c POST /bookmarks", "a91e GET /tags", "a91e query failed", "7f3c request completed"],
          ["7f3c job 812 started", "7f3c fetch timed out"],
          [],
        ],
        label: "every line carries its request's id",
        note: "request.log stamps the id on each API line. The job data carries it to the worker, whose child logger does the same.",
      },
      {
        items: [
          ["7f3c POST /bookmarks", "a91e GET /tags", "a91e query failed", "7f3c request completed"],
          ["7f3c job 812 started", "7f3c fetch timed out"],
          ["7f3c POST /bookmarks", "7f3c request completed"],
        ],
        hot: ["7f3c POST /bookmarks", "7f3c request completed"],
        label: "search the API's lines for the user's id",
        note: "Two lines of four. The failed query belonged to somebody else's request, and this save completed.",
        kind: "res",
      },
      {
        items: [
          ["7f3c POST /bookmarks", "a91e GET /tags", "a91e query failed", "7f3c request completed"],
          ["7f3c job 812 started", "7f3c fetch timed out"],
          ["7f3c POST /bookmarks", "7f3c request completed", "7f3c job 812 started", "7f3c fetch timed out"],
        ],
        hot: ["7f3c job 812 started", "7f3c fetch timed out"],
        label: "the same search finds the worker's lines",
        note: "The bookmark was saved; the background fetch of its title is what timed out. One id told the whole story.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "metrics-and-their-types",
    title: "A histogram's buckets filling up",
    boxes: ["le=\"0.1\"", "le=\"0.25\"", "le=\"0.5\"", "le=\"+Inf\""],
    frames: [
      {
        items: [["count 1"], ["count 1"], ["count 1"], ["count 1"]],
        hot: ["count 1"],
        label: "an 80 ms request: observe(0.08)",
        note: "A histogram keeps counts, not durations. 80 ms fits under every limit here, so every bucket goes up by one.",
      },
      {
        items: [["count 1"], ["count 1"], ["count 2"], ["count 2"]],
        hot: ["count 2"],
        label: "a 300 ms request: observe(0.3)",
        note: "300 ms is over the 0.1 and 0.25 limits, so only the last two buckets go up. Each bucket counts everything at or under its limit.",
      },
      {
        items: [["count 1"], ["count 1"], ["count 2"], ["count 3"]],
        hot: ["count 3"],
        label: "a 2 s request: observe(2)",
        note: "Only +Inf has room for it. That bucket counts every request, so it is also the total.",
      },
      {
        items: [["count 62"], ["count 90"], ["count 97"], ["count 100"]],
        label: "later: 100 requests observed",
        note: "Say the counts now look like this. Four numbers describe a hundred requests, and a million requests would still take four numbers.",
      },
      {
        items: [["count 62"], ["count 90"], ["count 97"], ["count 100"]],
        hot: ["count 62"],
        label: "p50: where is the 50th request?",
        note: "62 requests took at most 0.1 s, so the 50th is among them. The typical request takes 100 ms or less.",
        kind: "res",
      },
      {
        items: [["count 62"], ["count 90"], ["count 97"], ["count 100"]],
        hot: ["count 90", "count 97"],
        label: "p95: where is the 95th request?",
        note: "90 fit under 0.25 s and 97 under 0.5 s, so the 95th took between 250 and 500 ms. Buckets give a range, not an exact value.",
        kind: "res",
      },
      {
        items: [["count 62"], ["count 90"], ["count 97"], ["count 100"]],
        hot: ["count 100"],
        label: "p99: somewhere above 0.5 s",
        note: "With only these limits, the histogram cannot say how slow the 99th request was. That is why the real one adds buckets at 1, 2.5 and 5 s.",
        kind: "err",
      },
    ],
  },
  {
    type: "flow",
    after: "distributed-tracing",
    title: "One trace follows a bookmark from the API to the worker",
    actors: ["Client", "API", "Queue", "Worker", "example.com"],
    steps: [
      [0, 1, "POST /api/v1/bookmarks", "No traceparent header arrives, so the API starts a new trace, 4bf9…, and opens its first span."],
      [1, 1, "child span: pg INSERT, 21 ms", "The query is timed as its own span. Its parent is the request's span."],
      [1, 2, "add enrich job, trace context inside", "The trace id and the current span id travel with the job. That is context propagation."],
      [1, 0, "201 Created after 182 ms", "The request's span ends here, but the trace is not finished.", "res"],
      [2, 3, "enrich job, same trace id", "The worker reads the context and starts its span as a child of the API's span."],
      [3, 4, "GET with traceparent: 00-4bf9…", "Over HTTP the context is a header: the same trace id, with the worker's span as the new parent."],
      [4, 3, "200 after 1.3 s", "The outbound fetch is one more child span.", "res"],
      [3, 3, "enrich job span ends: 1.4 s", "One tree now covers two processes, and it shows the slow part was the other site."],
    ],
  },
  {
    type: "boxes",
    after: "alerting-on-symptoms",
    title: "A page for symptoms, a dashboard for causes",
    boxes: ["What the metrics show", "Pages a person", "On the dashboard"],
    frames: [
      {
        items: [["CPU at 85%"], ["CPU at 85%"], []],
        hot: ["CPU at 85%"],
        label: "a cause alert: CPU above 80%",
        note: "Someone is woken at 3 a.m. Requests are fast and succeeding, so there is nothing for them to do.",
        kind: "err",
      },
      {
        items: [["CPU at 85%"], [], ["CPU at 85%"]],
        hot: ["CPU at 85%"],
        label: "move the cause to a dashboard",
        note: "High CPU with happy users is not an emergency. The number is still recorded for when it is needed.",
      },
      {
        items: [["CPU at 85%", "5xx rate 4%"], ["5xx rate 4%"], ["CPU at 85%"]],
        hot: ["5xx rate 4%"],
        label: "a symptom alert: error rate over its target",
        note: "Users are failing right now, so a person is paged. This alert means real impact every time it fires.",
        kind: "res",
      },
      {
        items: [
          ["CPU at 85%", "5xx rate 4%", "pool: 20 of 20 in use"],
          ["5xx rate 4%"],
          ["CPU at 85%", "pool: 20 of 20 in use"],
        ],
        hot: ["pool: 20 of 20 in use"],
        label: "the dashboard answers why",
        note: "After the page, the person on call looks at the causes. The connection pool is full: that is the resource behind the errors.",
        kind: "res",
      },
    ],
  },
];
