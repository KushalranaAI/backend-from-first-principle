import type { Scene } from "../types";

const N42 = "42";
const NOT_URL = "\"nodejs org\"";
const JS_URL = "\"javascript:alert(1)\"";
const GOOD_URL = "\"https://nodejs.org\"";

/** Lesson 06, Validation and transformation. */
export const scenes: Scene[] = [
  {
    type: "boxes",
    after: "three-kinds-of-validation",
    title: "How far four url values get through the three checks",
    boxes: ["Sent as url", "Type: ok", "Syntactic: ok", "Semantic: ok"],
    frames: [
      {
        items: [[N42, NOT_URL, JS_URL, GOOD_URL], [], [], []],
        label: "four requests, four values for url",
        note: "Each check assumes the one before it passed, so they run in a fixed order: the kind of value, then its form, then its meaning.",
      },
      {
        items: [[N42], [NOT_URL, JS_URL, GOOD_URL], [], []],
        hot: [N42],
        label: "type: is it a string?",
        note: "42 is a number, so it stops here. There is no point asking whether a number is a well-formed URL.",
        kind: "err",
      },
      {
        items: [[N42], [NOT_URL], [JS_URL, GOOD_URL], []],
        hot: [NOT_URL],
        label: "syntactic: does it parse as a URL?",
        note: "\"nodejs org\" is a string, but it has no scheme and can't be parsed. javascript:alert(1) does parse, so it moves on.",
        kind: "err",
      },
      {
        items: [[N42], [NOT_URL], [JS_URL], [GOOD_URL]],
        hot: [JS_URL],
        label: "semantic: is the scheme http or https?",
        note: "A well-formed URL can still be one you must not store. Only the check on meaning catches the javascript: scheme.",
        kind: "err",
      },
      {
        items: [[N42], [NOT_URL], [JS_URL], [GOOD_URL]],
        hot: [GOOD_URL],
        label: "one value reaches the handler",
        note: "The other three requests end with a 400 before any of your logic runs.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "transformation-and-normalization",
    title: "Three typed tags become two stored tags",
    boxes: ["Tags in the request", "Being normalized", "Stored"],
    frames: [
      {
        items: [["\"Node\"", "\" node \"", "\"JS\""], [], []],
        label: "tags: [\"Node\", \" node \", \"JS\"]",
        note: "Three tags as a person typed them. Two of them mean the same thing.",
      },
      {
        items: [["\"Node\"", "\" node \"", "\"JS\""], [], ["\"Node\"", "\" node \"", "\"JS\""]],
        hot: ["\"Node\"", "\" node \""],
        label: "stored exactly as sent",
        note: "Without normalizing, the store holds two spellings of one tag, and a search for node matches neither of them.",
        kind: "err",
      },
      {
        items: [["\"Node\"", "\" node \"", "\"JS\""], ["\"Node\"", "\"node\"", "\"JS\""], []],
        hot: ["\"node\""],
        label: "trim",
        note: "Start again. Spaces at the ends are never meant, so they go first and every later check sees the real value.",
      },
      {
        items: [["\"Node\"", "\" node \"", "\"JS\""], ["\"node\"", "\"js\""], []],
        hot: ["\"node\"", "\"js\""],
        label: "lowercase, then deduplicate",
        note: "Lowercasing turns the first two tags into the same string, so the duplicate can be dropped.",
      },
      {
        items: [["\"Node\"", "\" node \"", "\"JS\""], ["\"node\"", "\"js\""], ["\"node\"", "\"js\""]],
        hot: ["\"node\"", "\"js\""],
        label: "check the pattern, then store",
        note: "The tag rule is checked against the values that will actually be stored, and every reader sees one canonical form.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "allowlist-and-limit-everything",
    title: "What an allowlist does with an extra key",
    boxes: ["Request body", "Fields the API defined", "Stored bookmark"],
    frames: [
      {
        items: [["url: https://a.dev", "isAdmin: true"], ["url", "title", "notes", "tags"], []],
        hot: ["isAdmin: true"],
        label: "POST /bookmarks with an extra key",
        note: "The body carries a key the API never defined.",
      },
      {
        items: [["url: https://a.dev", "isAdmin: true"], ["url", "title", "notes", "tags"], ["url: https://a.dev", "isAdmin: true"]],
        hot: ["isAdmin: true"],
        label: "Object.assign(bookmark, body)",
        note: "Copying the body onto the record stores every key the client chose to send. This is mass assignment.",
        kind: "err",
      },
      {
        items: [["url: https://a.dev", "isAdmin: true"], ["url", "title", "notes", "tags"], []],
        hot: ["url: https://a.dev", "url"],
        label: "url is on the list",
        note: "Start again with an allowlist. Each key in the body is compared with the fields the API defined, and url is one of them.",
        kind: "res",
      },
      {
        items: [["url: https://a.dev", "isAdmin: true"], ["url", "title", "notes", "tags"], []],
        hot: ["isAdmin: true"],
        label: "isAdmin is not an allowed field",
        note: "Nothing on the list matches, so the key is reported as an error and the request ends with a 400. Nothing is stored.",
        kind: "err",
      },
      {
        items: [["url: https://a.dev"], ["url", "title", "notes", "tags"], ["url: https://a.dev/", "ownerId: from the session"]],
        hot: ["url: https://a.dev/", "ownerId: from the session"],
        label: "sent again without it: stored",
        note: "The record is built from the validated fields only. Values such as ownerId are set by the server, never copied from the body.",
        kind: "res",
      },
    ],
  },
  {
    type: "flow",
    after: "client-side-and-server-side-validation",
    title: "curl walks past the form's checks",
    actors: ["Browser form", "curl", "Linkbox API"],
    steps: [
      [0, 0, "type=\"url\" refuses \"nodejs org\"", "The browser won't submit a value that isn't a URL. That is fast feedback for an honest user."],
      [1, 2, "POST {\"url\":\"javascript:alert(1)\",\"tags\":\"node\"}", "curl never loads the form, so none of the browser's checks run."],
      [2, 2, "no server check: store it", "A server that relies on the form saves whatever arrives.", "err"],
      [2, 1, "201 Created", "A javascript: link is now in the database, waiting to be shown in someone's browser.", "err"],
      [1, 2, "the same POST, to a server that validates", "Now the server checks every request itself, whoever sent it."],
      [2, 2, "validateBookmark(body)", "The scheme isn't http or https, and tags is a string where an array is expected."],
      [2, 1, "400 with field errors for url and tags", "The server's check is the one that can't be skipped, because every request goes through it.", "res"],
    ],
  },
];
