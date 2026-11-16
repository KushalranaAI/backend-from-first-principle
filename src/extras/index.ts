import { PART1 } from "./part1";
import { PART2 } from "./part2";
import type { Extra, FlowData } from "./types";

export type { BoxesData, Extra, FlowData, Frame, Kind, Scene, Step } from "./types";

/** The relatable layer for each lesson, keyed by lesson number ("03"). Lessons 00 and 27 have none. */
export const EXTRAS: Record<string, Extra> = { ...PART1, ...PART2 };

/** The home page's map of the course: one request, and the lesson behind each hop. */
export const COURSE_FLOW: FlowData = {
  title: "One request, and the lesson behind every hop",
  actors: ["Client", "Edge", "API", "Cache", "Postgres", "Queue"],
  steps: [
    [0, 1, "HTTPS request", "HTTP: methods, headers, status codes, caching and TLS.", "req", "02-http"],
    [1, 2, "pick an instance", "Scaling: load balancers and stateless servers.", "req", "18-scaling"],
    [2, 2, "which handler?", "Routing: a method and a path choose one function.", "req", "03-routing"],
    [2, 2, "who is this, and is the input valid?", "Authentication, authorization and validation.", "req", "05-authentication"],
    [2, 3, "seen this before?", "Caching: skip the slow work when the answer is already known.", "req", "10-caching"],
    [2, 4, "read and write", "Postgres: schemas, indexes and transactions.", "req", "09-postgres"],
    [2, 5, "do the slow part later", "Task queues: background jobs with retries.", "req", "11-task-queues"],
    [2, 0, "response", "REST API design: the right status, shape and errors.", "res", "08-rest-api-design"],
    [2, 2, "and when it fails?", "Error handling, observability and graceful shutdown keep it running.", "err", "13-error-handling"],
  ],
};
