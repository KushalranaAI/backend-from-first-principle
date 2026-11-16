import type { Scene } from "../types";

/** Lesson 03, Routing. The reference file for writing a lesson's animations. */
export const scenes: Scene[] = [
  {
    type: "boxes",
    after: "static-and-dynamic-routes",
    title: "Matching /bookmarks/42 against a pattern, segment by segment",
    boxes: ["Pattern", "Request path", "params"],
    frames: [
      {
        items: [["bookmarks", ":id"], ["bookmarks", "42"], []],
        label: "GET /bookmarks/42",
        note: "The router splits both the pattern and the path at every slash, then compares them one segment at a time.",
      },
      {
        items: [["bookmarks", ":id"], ["bookmarks", "42"], []],
        hot: ["bookmarks"],
        label: "bookmarks === bookmarks",
        note: "A static segment must be exactly equal. It is, so the router moves on.",
        kind: "res",
      },
      {
        items: [["bookmarks", ":id"], ["bookmarks", "42"], ["id = \"42\""]],
        hot: [":id", "42", "id = \"42\""],
        label: ":id matches anything",
        note: "A segment starting with a colon accepts any value and stores it under that name. It is a string, not a number.",
        kind: "res",
      },
      {
        items: [["bookmarks", ":id"], ["bookmarks", "42", "tags"], ["id = \"42\""]],
        hot: ["tags"],
        label: "GET /bookmarks/42/tags",
        note: "A different request: three segments against a two-segment pattern. The lengths differ, so this route doesn't match.",
        kind: "err",
      },
    ],
  },
  {
    type: "boxes",
    after: "matching-order-and-specificity",
    title: "The same request under two matching rules",
    boxes: ["Routes, in registration order", "First match wins", "Most specific wins"],
    frames: [
      {
        items: [["/bookmarks/:id", "/bookmarks/search"], [], []],
        label: "GET /bookmarks/search",
        note: "Both routes match this path. Which handler runs depends on the kind of router.",
      },
      {
        items: [["/bookmarks/:id", "/bookmarks/search"], ["/bookmarks/:id"], []],
        hot: ["/bookmarks/:id"],
        label: "first match: getBookmark({ id: \"search\" })",
        note: "A first-match router stops at the first route that fits. The word “search” is treated as an id, which is a bug.",
        kind: "err",
      },
      {
        items: [["/bookmarks/:id", "/bookmarks/search"], ["/bookmarks/:id"], ["/bookmarks/search"]],
        hot: ["/bookmarks/search"],
        label: "most specific: searchBookmarks()",
        note: "A tree router prefers an exact segment over a parameter, whatever the registration order.",
        kind: "res",
      },
      {
        items: [["/bookmarks/search", "/bookmarks/:id"], ["/bookmarks/search"], ["/bookmarks/search"]],
        hot: ["/bookmarks/search"],
        label: "register the static route first",
        note: "With a first-match router the fix is ordering: put static routes before the parameter routes that could swallow them.",
        kind: "res",
      },
    ],
  },
  {
    type: "flow",
    after: "grouping-prefixes-and-versioning",
    title: "A group applies one rule to many routes",
    actors: ["Client", "/api/v1 group", "Auth check", "Handler"],
    steps: [
      [0, 1, "GET /api/v1/tags", "The prefix decides which group the request belongs to."],
      [1, 2, "every route in the group", "The group attached one login check to all of its routes, so no handler has to remember it."],
      [2, 3, "listTags()", "The check passed, and the request reaches its handler.", "res"],
      [3, 0, "200 OK", "The handler never had to know a check happened.", "res"],
      [0, 3, "GET /health", "This route sits outside the group, so it skips the check and stays public.", "req"],
      [3, 0, "200 { ok: true }", "A load balancer can call it without logging in.", "res"],
    ],
  },
];
