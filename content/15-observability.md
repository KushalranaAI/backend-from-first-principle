---
title: Logging, monitoring and observability
part: Production
summary: How logs, metrics and traces let you answer questions about a running system, and how to add all three to a Node service.
---

Once your code runs on a server, you can't attach a debugger or add a `console.log` and rerun. The only things you can know about production are the things your service reports about itself. Observability is designing those reports so that when something goes wrong, at 3 a.m., on a request you've never seen, you can find out what happened without shipping new code.

## The first principle

A user writes: "Saving a bookmark failed around 14:05." You have a bare server. What can you find out? Nothing. You don't know if the request arrived, which instance got it, how long it took or what it called.

So you add `console.log` lines. Now you have text, millions of lines of it, on several machines. Three new problems appear:

1. **You can't search it.** `"saved bookmark 42 for kim"` is easy for you to read and hard for a machine to filter. You want every log line where `userId = 17` and `status >= 500`.
2. **You can't connect lines.** Fifty requests run at once, so their lines interleave. Which `"query failed"` belongs to the user's request?
3. **Logs don't show trends.** "Is the error rate higher than yesterday? Is p95 latency creeping up?" You'd have to count millions of lines every time you ask.

And a fourth, once you have more than one service: the request went API → queue → worker → external site, and each wrote its own logs. Which line on which machine caused the failure?

Each problem asks for a different kind of data:

| Signal | Question it answers | Shape |
|---|---|---|
| **Logs** | What exactly happened in this one event? | One structured record per event, with full detail |
| **Metrics** | How much, how often, how fast, across everything? | Numbers aggregated over time, cheap to store and graph |
| **Traces** | Where did this one request spend its time, across services? | A tree of timed spans linked by one trace id |

**Monitoring** is watching known numbers and alerting when they cross a line: you decided in advance what to look at. **Observability** is being able to ask *new* questions of the data after the fact, like "is it only users on the free plan, only on instance 3, only for URLs from one domain?" Monitoring tells you *that* something is wrong. Observability helps you find out *why*.

## Core ideas

### Structured logging

Write logs as data, not prose. One JSON object per line, with the facts as fields:

```
before: 2026-11-16 14:05:12 ERROR failed to save bookmark for kim: timeout
after:  {"level":50,"time":1794837912000,"reqId":"7f3c…","userId":17,"route":"/api/v1/bookmarks",
         "err":{"type":"TimeoutError","message":"..."},"msg":"failed to save bookmark"}
```

Now a log store (Loki, Elasticsearch, CloudWatch, Datadog) can filter by any field. The message stays short and constant (`"failed to save bookmark"`), and the variables go in fields. A constant message also lets you count how often each kind of event happens.

In Node, use **pino**. It writes JSON to stdout fast, and Fastify uses it as its built-in logger. Your app writes to stdout and nothing else; shipping logs to storage is the platform's job (Docker, Kubernetes, a collector agent). Don't write log files from the app, and don't make network calls to a log service from the request path.

For reading logs locally, pipe them through `pino-pretty`. Keep JSON in production.

### Log levels

| Level (pino number) | Use it for | Example |
|---|---|---|
| `fatal` (60) | The process is about to exit | uncaught exception, bad config |
| `error` (50) | A request or job failed and it's our fault | 500, job failed after all retries |
| `warn` (40) | Something odd that didn't fail yet | retry succeeded on attempt 3, fallback served |
| `info` (30) | Normal significant events | request completed, server started, job done |
| `debug` (20) | Detail for diagnosing a problem | SQL text, cache hit or miss |
| `trace` (10) | Very fine detail | function entry and exit |

Production usually runs at `info`. Make the level configurable (lesson 14), so you can raise it to `debug` temporarily without a code change. Log a client's mistake (a 400 or 404) at `info`, not `error`: if every validation failure is an "error", the real ones drown.

### Correlation ids

Give every request an id at the edge, attach it to every log line made while handling that request, return it in a response header, and pass it along to anything the request triggers.

```
client ──X-Request-Id: 7f3c…──▶ API ──job data { requestId }──▶ worker ──▶ external fetch
                                 │                               │
                     every log line has reqId=7f3c…   every log line has reqId=7f3c…
```

Fastify already gives every request an id and a child logger (`request.log`) that stamps it on each line. Two settings make it useful: accept the id from an upstream proxy if it looks valid, and send it back to the client.

```js
import { randomUUID } from "node:crypto";
import Fastify from "fastify";

const app = Fastify({
  logger: {
    level: config.logLevel,
    redact: ["req.headers.authorization", "req.headers.cookie", "*.password"],
  },
  // Reuse the caller's id if it looks sane, otherwise make a new one.
  genReqId: (req) => {
    const id = req.headers["x-request-id"];
    return typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? id : randomUUID();
  },
});
app.addHook("onSend", async (request, reply) => { reply.header("x-request-id", request.id); });
```

The regex matters: the header comes from outside, and a value with newlines or a megabyte of text would end up in every log line. When you enqueue a job, put `requestId: request.id` in the job data, and have the worker log with `logger.child({ requestId, jobId: job.id })`. Now one search finds the API request and the background job it caused.

### What not to log

Logs get copied to more places, kept longer and read by more people than your database. Never log:

- **Secrets**: passwords, session ids, API keys, `Authorization` and `Cookie` headers, connection strings.
- **Personal data you don't need**: email addresses, full names, IPs if your privacy rules forbid them, anything covered by GDPR or similar laws. Log the user id, not the user.
- **Whole request or response bodies**: they will contain one of the above sooner or later.

pino's `redact` option removes fields by path before the line is written (it prints `"[Redacted]"`). It's a safety net, not a strategy: the better habit is to log chosen fields instead of whole objects.

### Metrics and their types

A metric is a number with a name and some labels, sampled over time. Prometheus, the standard open-source metrics system, defines the types every client library copies:

| Type | Goes | Use for | Linkbox example |
|---|---|---|---|
| **Counter** | only up (resets on restart) | things that happen | `bookmarks_created_total`, `http_requests_total` |
| **Gauge** | up and down | current state | jobs waiting in the queue, open DB connections |
| **Histogram** | counts per bucket | distributions, mostly durations | `http_request_duration_seconds` |
| Summary | precomputed quantiles | rarely; histograms aggregate across instances, summaries don't | |

You almost never read a counter's raw value. You ask for its **rate**: requests per second over the last 5 minutes. And never use the average for latency: one 10-second request hides behind a thousand fast ones. Use percentiles from a histogram: p50 (typical), p95 and p99 (the slow tail your unhappiest users feel).

The histogram in the table is the classic kind: you choose the bucket limits, and a percentile read from it is only as precise as the buckets around it. Prometheus 3.8 (December 2025) made [native histograms](https://prometheus.io/docs/specs/native_histograms/) a stable feature: one time series whose buckets are laid out automatically at a resolution you set. prom-client exposes classic buckets, so that is what you write in this lesson, but expect to meet native histograms in newer client libraries and dashboards.

**Labels** split a metric: `{method="GET", route="/api/v1/bookmarks/:id", status_code="200"}`. Each unique combination of label values is a separate time series that costs memory. Use the route *pattern*, never the raw URL, and never put user ids, bookmark ids or emails in labels. One label with a million values can take down your metrics server.

### RED, USE and the golden signals

Which numbers to collect? Two short checklists cover most of it.

**RED**, for anything that serves requests (Tom Wilkie):

- **Rate**: requests per second
- **Errors**: failed requests per second
- **Duration**: the latency distribution

**USE**, for resources like CPU, memory, a connection pool or a queue (Brendan Gregg):

- **Utilization**: how busy it is (pool: 18 of 20 connections in use)
- **Saturation**: how much work is waiting (requests queued for a connection)
- **Errors**: failures (connection timeouts)

Google's SRE book names four **golden signals**: latency, traffic, errors and saturation. That is RED plus saturation. RED tells you users are hurting; USE tells you which resource is why.

### SLIs and SLOs

A metric becomes a promise when you write down a target:

- **SLI** (service level indicator): a measurement of user experience, such as the fraction of requests that succeed, or that finish in under 300 ms.
- **SLO** (service level objective): the target for the SLI over a window. "99.9% of `GET /api/v1/bookmarks` requests succeed over 30 days."
- **Error budget**: what the SLO allows to fail. 99.9% over 30 days is 0.1% of the time, about 43 minutes. While budget remains, ship features. When it's spent, work on reliability.

An SLO turns "is it good enough?" from an argument into a number. Pick SLIs that users would notice. CPU at 90% is not an SLI; slow page loads are.

### Distributed tracing

A trace follows one request through every service and records where time went. It is a tree of **spans**. Each span is one timed operation (an HTTP request, a SQL query, a fetch) with a start, a duration, attributes and a parent.

```
trace 4bf92f35…  POST /api/v1/bookmarks                      ████████████████ 182 ms
  ├─ span  pg: INSERT INTO bookmarks                          ███ 21 ms
  ├─ span  redis: DEL tagcounts:17                            ▌ 2 ms
  └─ span  bullmq: add enrich                                 █ 6 ms
        └─ span (worker) enrich job                                 ████████████ 1.4 s
              └─ span  GET https://example.com                      ███████████ 1.3 s
```

For the worker's span to join the same trace, the trace id has to travel with the work. That is **context propagation**. Over HTTP it travels in the W3C `traceparent` header:

```
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             │  │                                │                └ flags (01 = sampled)
             │  │                                └ parent span id (16 hex)
             │  └ trace id (32 hex), same for the whole request
             └ version
```

Each service reads the header, creates its span as a child of that parent, and sends a new `traceparent` with its own span id downstream. Because it's a standard, services in different languages and vendors join the same trace.

Tracing everything is expensive, so systems **sample**: keep, say, 10% of traces, or keep all traces that contain an error. Put the trace id in your log lines too, and you can jump from a slow trace to its exact logs.

### OpenTelemetry

You don't want to write spans by hand or lock yourself to one vendor's agent. **OpenTelemetry (OTel)** is the vendor-neutral standard: one API and SDK per language for traces, metrics and logs, and one wire protocol (OTLP). Its auto-instrumentation patches common libraries (`http`, `pg`, `ioredis`, `undici`) so you get spans with no code changes. Data goes to an OTel Collector or straight to a backend.

For an ES-module app in Node, the zero-code setup is two packages and a few environment variables:

```bash
npm i @opentelemetry/api @opentelemetry/auto-instrumentations-node
OTEL_SERVICE_NAME=linkbox-api \
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
node --experimental-loader=@opentelemetry/instrumentation/hook.mjs \
     --import @opentelemetry/auto-instrumentations-node/register src/server.js
```

The loader flag is what lets OTel see ES module imports. Node's own documentation now discourages `--experimental-loader` in favour of hooks registered from an `--import`ed file, and OpenTelemetry says its setup will move the same way. As of November 2026 the flag is still what the [OpenTelemetry JS guide to ES modules](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md) tells you to use, so check that page before you copy the command.

### The tools

| Signal | Open source | What it does |
|---|---|---|
| Metrics | **Prometheus** | Pulls (`scrapes`) `/metrics` from each instance every few seconds, stores time series, query language PromQL, alert rules |
| Logs | **Loki** | Stores logs cheaply by indexing only labels; query with LogQL. Elasticsearch/OpenSearch is the heavier full-text alternative |
| Traces | **Jaeger**, **Tempo** | Store and show traces; both accept OTLP |
| Dashboards | **Grafana** | One UI over Prometheus, Loki and Tempo; jump from a metric spike to logs to a trace |
| Collection | **OTel Collector** | Receives, batches, filters and forwards all three signals |

Hosted products (Datadog, Grafana Cloud, Honeycomb, New Relic) do all of this as a service. With OTel in your code you can switch between them.

### Alerting on symptoms

An alert wakes a person. It should fire only when users are hurting now, or will be soon, and a human must act. So alert on **symptoms** (the RED numbers and your SLOs: error rate up, p99 latency up, error budget burning fast), not on **causes** (CPU at 85%, one pod restarted). High CPU with happy users is not an emergency; happy-looking CPU with failing requests is.

Causes still go on dashboards, where you look *after* a symptom alert fires. Every alert should link to a runbook that says what to check first. An alert that fires often and needs no action trains people to ignore alerts.

## Try it

In a folder with `"type": "module"`, run `npm i fastify prom-client` and save `app.js`:

```js
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import client from "prom-client";

const app = Fastify({
  logger: { redact: ["req.headers.cookie", "*.password"] },
  genReqId: (req) => {
    const id = req.headers["x-request-id"];
    return typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? id : randomUUID();
  },
});
app.addHook("onSend", async (request, reply) => { reply.header("x-request-id", request.id); });

client.collectDefaultMetrics(); // event loop lag, heap, GC, CPU
const httpDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});
app.addHook("onResponse", async (request, reply) => {
  httpDuration.observe({
    method: request.method,
    route: request.routeOptions.url ?? "unmatched", // the pattern, never the raw URL
    status_code: reply.statusCode,
  }, reply.elapsedTime / 1000);
});
app.get("/metrics", async (request, reply) => {
  reply.type(client.register.contentType);
  return client.register.metrics();
});

app.get("/bookmarks/:id", async (request) => {
  await new Promise((r) => setTimeout(r, Math.random() * 300)); // fake work
  request.log.info({ bookmarkId: request.params.id, user: { id: 17, password: "hunter2" } }, "bookmark loaded");
  if (request.params.id === "13") throw new Error("unlucky");
  return { id: request.params.id };
});
await app.listen({ port: 3000 });
```

Run `node app.js | npx pino-pretty` in one terminal, then:

```bash
curl -i -H "x-request-id: test-123" localhost:3000/bookmarks/42   # same id in the response header and the logs
for i in $(seq 1 200); do curl -s localhost:3000/bookmarks/$((RANDOM % 20)) > /dev/null; done
curl -s localhost:3000/metrics | grep http_request_duration_seconds_count
curl -s localhost:3000/metrics | grep 'route="/bookmarks/:id",status_code="200"' | grep bucket
```

Read the buckets: each `le="0.1"` line counts requests that took at most 0.1 s. Estimate p50 and p95 by eye. Check the log line for `bookmark loaded`: the password shows `[Redacted]`.

Optional, to see a trace: start Jaeger with `docker run --rm -p 16686:16686 -p 4318:4318 cr.jaegertracing.io/jaegertracing/jaeger:2.23.0`, install the OpenTelemetry packages and run the app with the command from the OpenTelemetry section. Make a few requests and open `http://localhost:16686`.

Now break it on purpose:

1. Change the `route` label to `request.url`, send 200 requests and count the series in `/metrics`. Now imagine a million bookmark ids.
2. Send `-H "x-request-id: $(printf 'a%.0s' {1..500})"`. Which id ends up in the logs, and why is that good?
3. Remove `redact` and request `/bookmarks/42` again. Where did the password go?
4. Request `/bookmarks/13`. Find the error in the logs by its request id and check the `status_code="500"` series in `/metrics`.

## Common mistakes

- **Logging strings instead of fields.** `log.info("user " + id + " saved " + url)` can't be filtered. Use `log.info({ userId, url }, "bookmark saved")`.
- **Logging secrets or personal data.** Tokens and cookies in logs are a breach waiting to be found. Log ids, redact by path, never dump whole request objects.
- **High-cardinality labels.** User ids, raw URLs or error messages as metric labels explode memory. Labels take a small, fixed set of values.
- **Averages for latency.** The mean hides the slow tail. Use histograms and look at p95 and p99.
- **Alerting on causes.** Paging on CPU or a single restart creates noise; page on error rate, latency and SLO burn, and keep causes on dashboards.
- **No id linking the pieces.** Without a request id in every log line, the job data and the response header, you can't follow one user's problem through the system.

## Build: Linkbox, step 15

Linkbox logs already (Fastify turns pino on). Make the logs useful and add metrics.

1. Configure the Fastify logger from `config.logLevel` (lesson 14), with `redact` paths for `authorization`, `cookie`, `password` and anything else secret in your bodies.
2. Accept a valid `X-Request-Id` from the caller or generate a UUID, and return it on every response. Include it in the problem+json body (lesson 13 already does).
3. Pass `requestId` into BullMQ job data, and give the worker a child logger with `requestId` and `jobId`. Log job start, success and failure with duration.
4. Add `prom-client`: default metrics plus `http_request_duration_seconds` labelled by method, route pattern and status. Expose them at `GET /metrics`.
5. Add two Linkbox-specific metrics: a counter `linkbox_bookmarks_created_total` and a counter for enrichment results with a `result` label (`ok`, `failed`, `timeout`).
6. Optional: run the app with OpenTelemetry auto-instrumentation and Jaeger, and find the span for a slow SQL query.

**Done when** you can take one request id from a curl response and find every log line it produced in the API and the worker, and `/metrics` shows the request count, error count and latency buckets per route.

## Check yourself

<details markdown="1">
<summary>Logs, metrics and traces: which one answers "is p99 latency worse than yesterday"?</summary>

Metrics. They are aggregated numbers over time, built for trends and percentiles across all requests. Logs and traces describe individual events and requests.
</details>

<details markdown="1">
<summary>Why is <code>route</code> a good metric label but <code>userId</code> a bad one?</summary>

Each unique combination of label values is its own time series. Route patterns are a small fixed set; user ids are unbounded, so the number of series (and memory) grows with your user count.
</details>

<details markdown="1">
<summary>What do the four fields of a <code>traceparent</code> header carry?</summary>

Version, the trace id (shared by every span in the request), the parent span id (the caller's span) and flags such as whether the trace is sampled.
</details>

<details markdown="1">
<summary>What is the difference between the RED and USE methods?</summary>

RED (rate, errors, duration) describes services from the user's side: how many requests, how many fail, how slow. USE (utilization, saturation, errors) describes resources like CPU, pools and queues. RED tells you something is wrong; USE helps find which resource is the cause.
</details>

<details markdown="1">
<summary>Your SLO is 99.9% availability over 30 days. Roughly how much downtime is that?</summary>

0.1% of 30 days, about 43 minutes. That is the error budget.
</details>

<details markdown="1">
<summary>Why alert on the error rate rather than on CPU usage?</summary>

Error rate is a symptom users feel. High CPU may be harmless, and users can suffer while CPU looks normal. Alerting on symptoms means every page is about real impact; causes go on dashboards for diagnosis.
</details>

## Go deeper

- [Google SRE book: Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/): the four golden signals, symptoms versus causes, and what makes a good alert.
- [Google SRE book: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/): SLIs, SLOs and error budgets from the people who named them.
- [Prometheus: Metric types](https://prometheus.io/docs/concepts/metric_types/) and [Histograms and summaries](https://prometheus.io/docs/practices/histograms/): counters, gauges, histograms and how to choose buckets.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/): the `traceparent` and `tracestate` headers, field by field.
- [OpenTelemetry: Signals](https://opentelemetry.io/docs/concepts/signals/): traces, metrics, logs and context propagation in OTel's own words.
- [Brendan Gregg: The USE Method](https://www.brendangregg.com/usemethod.html): the resource checklist, with examples of what to measure for each resource.
