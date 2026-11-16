import type { Scene } from "../types";

const URL_42 = "url: https://nodejs.org/";
const OLD_TITLE = "title: Node docs";
const NEW_TITLE = "title: New title";
const NOTES = "notes: read later";
const SAVED = "K: 201, bookmark 42";

/** Lesson 08, REST API design. */
export const scenes: Scene[] = [
  {
    type: "flow",
    after: "methods-and-their-semantics",
    title: "The same retry after a lost reply, for DELETE and for POST",
    actors: ["Client", "API"],
    steps: [
      [0, 1, "DELETE /bookmarks/42", "The client asks for bookmark 42 to be removed."],
      [1, 0, "204, lost on the way", "The bookmark is deleted, but the connection drops and the client never hears about it.", "err"],
      [0, 1, "DELETE /bookmarks/42, again", "The client can't tell what happened, so it retries."],
      [1, 0, "404 Not Found", "The response differs, but the server is in the same state as after one call: the bookmark is gone. That is what idempotent means.", "res"],
      [0, 1, "POST /bookmarks { url }", "Now the same accident with a create."],
      [1, 0, "201 bookmark 43, lost on the way", "The bookmark was created, and again the reply never arrives.", "err"],
      [0, 1, "POST /bookmarks { url }, again", "The same retry that was harmless for DELETE."],
      [1, 0, "201 bookmark 44", "Two bookmarks now exist for one action. POST is not idempotent, so it needs extra help before it can be retried.", "err"],
    ],
  },
  {
    type: "boxes",
    after: "put-versus-patch",
    title: "One title change sent as PUT, then as PATCH",
    boxes: ["Bookmark 42, stored", "Request body", "Bookmark 42, after"],
    frames: [
      {
        items: [[URL_42, OLD_TITLE, NOTES], [], []],
        label: "bookmark 42 has three fields",
        note: "The client wants to change only the title.",
      },
      {
        items: [[URL_42, OLD_TITLE, NOTES], [URL_42, NEW_TITLE], []],
        hot: [NEW_TITLE],
        label: "PUT /bookmarks/42",
        note: "PUT means the body is the complete new resource. This client sent the url and the new title, and forgot the notes.",
      },
      {
        items: [[URL_42, OLD_TITLE, NOTES], [URL_42, NEW_TITLE], [URL_42, NEW_TITLE]],
        hot: [NOTES],
        label: "PUT replaced everything: notes is gone",
        note: "Fields left out of a PUT are reset or removed, because the body replaces whatever was at this URL.",
        kind: "err",
      },
      {
        items: [[URL_42, OLD_TITLE, NOTES], [NEW_TITLE], []],
        hot: [NEW_TITLE],
        label: "PATCH /bookmarks/42",
        note: "Start again with PATCH. Its body describes changes, so sending one field is enough.",
      },
      {
        items: [[URL_42, OLD_TITLE, NOTES], [NEW_TITLE], [URL_42, NEW_TITLE, NOTES]],
        hot: [NEW_TITLE],
        label: "PATCH changed only the title",
        note: "In JSON Merge Patch a missing field means leave it alone, so url and notes are untouched.",
        kind: "res",
      },
      {
        items: [[URL_42, NEW_TITLE, NOTES], ["notes: null"], [URL_42, NEW_TITLE]],
        hot: ["notes: null", NOTES],
        label: "PATCH { \"notes\": null }",
        note: "null is not the same as missing: it means remove this field. That is how a client clears the notes on purpose.",
      },
    ],
  },
  {
    type: "boxes",
    after: "collections-pagination",
    title: "A bookmark is added between page 1 and page 2",
    boxes: ["Bookmark ids, newest first", "Offset client has seen", "Cursor client has seen"],
    frames: [
      {
        items: [["5", "4", "3", "2", "1"], [], []],
        label: "five bookmarks, read with limit=2",
        note: "Two clients page through the same list: one by offset, one by cursor.",
      },
      {
        items: [["5", "4", "3", "2", "1"], ["5", "4"], ["5", "4"]],
        hot: ["5", "4"],
        label: "page 1: both get 5 and 4",
        note: "The offset client will ask for offset=2 next. The cursor client remembers the last row it saw: id 4.",
      },
      {
        items: [["6", "5", "4", "3", "2", "1"], ["5", "4"], ["5", "4"]],
        hot: ["6"],
        label: "someone adds bookmark 6",
        note: "The new row lands at the top, and every older row moves down one position.",
      },
      {
        items: [["6", "5", "4", "3", "2", "1"], ["5", "4", "4 again", "3"], ["5", "4"]],
        hot: ["4 again"],
        label: "offset=2 returns 4 and 3",
        note: "Position 2 is now where bookmark 4 sits, so the offset client receives it twice. A delete would have made it skip a row instead.",
        kind: "err",
      },
      {
        items: [["6", "5", "4", "3", "2", "1"], ["5", "4", "4 again", "3"], ["5", "4", "3", "2"]],
        hot: ["3", "2"],
        label: "cursor: the two rows after id 4",
        note: "The cursor names a place in the sort order, not a count from the top, so a new row elsewhere can't shift it.",
        kind: "res",
      },
    ],
  },
  {
    type: "flow",
    after: "versioning",
    title: "An added field is harmless; a renamed field breaks old clients",
    actors: ["Old client", "/api/v1", "/api/v2"],
    steps: [
      [0, 1, "GET /api/v1/bookmarks/42", "A client that shipped a year ago and can't be updated today."],
      [1, 0, "{ id, title }", "It reads title and shows it.", "res"],
      [1, 1, "add an optional field: archived", "An additive change, made in place."],
      [1, 0, "{ id, title, archived }", "The old client ignores a field it doesn't know, so nothing breaks and no new version is needed.", "res"],
      [1, 1, "rename title to name, in place", "A rename takes away a field that clients depend on."],
      [1, 0, "{ id, name, archived }", "The old client looks for title and finds nothing. Every copy of it that shipped is now broken.", "err"],
      [2, 2, "put the rename in /api/v2 instead", "The breaking change goes into a new version, and /api/v1 keeps its shape for a published period."],
      [0, 1, "GET /api/v1/bookmarks/42", "The old client carries on calling the version it was built against."],
      [1, 0, "{ id, title, archived }", "It still gets title. New clients ask /api/v2 and get name.", "res"],
    ],
  },
  {
    type: "boxes",
    after: "idempotency-keys",
    title: "What the server stores under an idempotency key",
    boxes: ["Requests arriving", "Idempotency store", "Bookmarks"],
    frames: [
      {
        items: [["POST, key K"], [], []],
        label: "POST /api/v1/bookmarks, Idempotency-Key: K",
        note: "The client made one key for this logical operation and will send it with every attempt.",
      },
      {
        items: [["POST, key K"], ["K: in progress"], []],
        hot: ["K: in progress"],
        label: "store K as in progress",
        note: "The key is recorded, with a fingerprint of the body, before any work starts.",
      },
      {
        items: [["POST, key K", "early retry, key K"], ["K: in progress"], ["bookmark 42"]],
        hot: ["early retry, key K", "K: in progress"],
        label: "a retry while K is in progress: 409",
        note: "There is no stored response to replay yet, and running the handler again risks the duplicate. The client is told to try again shortly.",
        kind: "err",
      },
      {
        items: [[], [SAVED], ["bookmark 42"]],
        hot: [SAVED],
        label: "response saved under K, then lost on the way",
        note: "The server kept a copy of its 201, but the connection dropped. The client can't tell whether the bookmark exists.",
        kind: "err",
      },
      {
        items: [["retry, key K"], [SAVED], ["bookmark 42"]],
        hot: ["retry, key K", SAVED],
        label: "retry with K and the same body",
        note: "The key is found and the fingerprint matches, so the handler does not run a second time.",
      },
      {
        items: [[], [SAVED], ["bookmark 42"]],
        hot: ["bookmark 42"],
        label: "replay the stored 201",
        note: "The client receives the saved response, and there is still exactly one bookmark.",
        kind: "res",
      },
      {
        items: [["key K, a different url"], [SAVED], ["bookmark 42"]],
        hot: ["key K, a different url", SAVED],
        label: "K with a different body: 422",
        note: "The fingerprint doesn't match, so the key is being reused for another request. The server refuses instead of guessing.",
        kind: "err",
      },
    ],
  },
];
