import type { Scene } from "../types";

/** Lesson 12, Full-text search. */
export const scenes: Scene[] = [
  {
    type: "boxes",
    after: "tokenization-and-analysis",
    title: "One sentence through an English analyzer",
    boxes: ["Tokens", "Dropped", "Index terms", "Query term"],
    frames: [
      {
        items: [["The", "Runners", "were", "RUNNING", "quickly"], [], [], []],
        label: "tokenizer: split on spaces and punctuation",
        note: "“The Runners were RUNNING quickly” becomes five tokens. So far they are exactly as typed.",
      },
      {
        items: [["the", "runners", "were", "running", "quickly"], [], [], []],
        hot: ["the", "runners", "running"],
        label: "lowercase",
        note: "“RUNNING” and “running” are now the same token, whatever capitals the writer used.",
      },
      {
        items: [["runners", "running", "quickly"], ["the", "were"], [], []],
        hot: ["the", "were"],
        label: "remove stop words",
        note: "“the” and “were” appear in nearly every document, so they can't tell one document from another.",
      },
      {
        items: [["runners", "running", "quickly"], ["the", "were"], ["runner", "run", "quick"], []],
        hot: ["runner", "run", "quick"],
        label: "stem: runners → runner, running → run",
        note: "Each word is cut to a root. These three terms are all the index stores for this sentence.",
        kind: "res",
      },
      {
        items: [["runners", "running", "quickly"], ["the", "were"], ["runner", "run", "quick"], ["Running"]],
        hot: ["Running"],
        label: "a query for “Running”, not analyzed",
        note: "The raw query word is not in the index. “Running” is not equal to “run”, so the search finds nothing.",
        kind: "err",
      },
      {
        items: [["runners", "running", "quickly"], ["the", "were"], ["runner", "run", "quick"], ["run"]],
        hot: ["run"],
        label: "the query through the same analyzer",
        note: "Lowercased and stemmed like the document was, the query term now equals an index term.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "the-inverted-index",
    title: "Building an inverted index from three documents",
    boxes: ["Indexing now", "Term → documents", "Query terms", "Result"],
    frames: [
      {
        items: [["1: Indexing in Postgres"], ["index → 1", "postgr → 1"], [], []],
        hot: ["index → 1", "postgr → 1"],
        label: "doc 1 → index, postgr",
        note: "The analyzer drops “in” and stems the rest. Each term gets a list that holds this document's number.",
      },
      {
        items: [["2: Cooking pasta"], ["cook → 2", "index → 1", "pasta → 2", "postgr → 1, 2"], [], []],
        hot: ["cook → 2", "pasta → 2", "postgr → 1, 2"],
        label: "doc 2 → cook, pasta, and postgr from its notes",
        note: "New terms get new lists. “postgr” already exists, so doc 2 is appended to its list. The terms stay sorted.",
      },
      {
        items: [["3: Postgres full-text search"], ["cook → 2", "index → 1", "pasta → 2", "postgr → 1, 2, 3", "search → 3"], [], []],
        hot: ["postgr → 1, 2, 3", "search → 3"],
        label: "doc 3 → postgr, search",
        note: "Three documents in, the list for “postgr” names all three. Like the table above, this shows five of the terms.",
      },
      {
        items: [[], ["cook → 2", "index → 1", "pasta → 2", "postgr → 1, 2, 3", "search → 3"], ["postgr", "index"], []],
        hot: ["postgr", "index", "postgr → 1, 2, 3", "index → 1"],
        label: "query “postgres index” → postgr, index",
        note: "The query is analyzed the same way. Each of its terms is then one lookup in the sorted dictionary.",
      },
      {
        items: [[], ["cook → 2", "index → 1", "pasta → 2", "postgr → 1, 2, 3", "search → 3"], ["postgr", "index"], ["doc 1"]],
        hot: ["doc 1"],
        label: "AND: intersect the two lists",
        note: "Only doc 1 is in both lists. No document was read to find that out.",
        kind: "res",
      },
      {
        items: [[], ["cook → 2", "index → 1", "pasta → 2", "postgr → 1, 2, 3", "search → 3"], ["postgr", "index"], ["doc 1", "doc 2", "doc 3"]],
        hot: ["doc 2", "doc 3"],
        label: "OR: union of the two lists",
        note: "Either way, the cost depended on the length of two lists, not on how many documents exist.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "relevance-tf-idf-and-bm25",
    title: "Two documents match. Which one ranks first?",
    boxes: ["Doc A", "Doc B", "Ranked"],
    frames: [
      {
        items: [["matches “postgres”"], ["matches “guide”"], []],
        label: "query: postgres guide",
        note: "Each document contains one of the two query words. Counting matched words gives a tie.",
      },
      {
        items: [["matches “postgres”", "rare word: counts a lot"], ["matches “guide”", "common word: counts little"], []],
        hot: ["rare word: counts a lot", "common word: counts little"],
        label: "IDF: postgres is in 2% of docs, guide in 40%",
        note: "A match on a rare term says much more about a document than a match on a word found everywhere.",
      },
      {
        items: [
          ["matches “postgres”", "rare word: counts a lot"],
          ["matches “guide”", "common word: counts little", "5 mentions: a little more"],
          [],
        ],
        hot: ["5 mentions: a little more"],
        label: "TF: Doc B says “guide” five times",
        note: "Repeats add score, but each one adds less than the one before. Five mentions are not five times better.",
      },
      {
        items: [
          ["matches “postgres”", "rare word: counts a lot", "5-word title: counts more"],
          ["matches “guide”", "common word: counts little", "5 mentions: a little more", "5,000 words: counts less"],
          [],
        ],
        hot: ["5-word title: counts more", "5,000 words: counts less"],
        label: "length: a short title against a long article",
        note: "One mention in five words is a far bigger share of the document than five mentions in five thousand.",
      },
      {
        items: [
          ["matches “postgres”", "rare word: counts a lot", "5-word title: counts more"],
          ["matches “guide”", "common word: counts little", "5 mentions: a little more", "5,000 words: counts less"],
          ["1. Doc A", "2. Doc B"],
        ],
        hot: ["1. Doc A", "2. Doc B"],
        label: "BM25 adds it up: Doc A first",
        note: "BM25 turns the three signals into one score per query term, sums them for each document and sorts by the total.",
        kind: "res",
      },
    ],
  },
  {
    type: "boxes",
    after: "postgres-full-text-search",
    title: "ts_rank puts a title match above a notes match",
    boxes: ["bookmarks", "search column", "Matches postgr", "Ordered by rank"],
    frames: [
      {
        items: [["7: Run Postgres in Docker", "9: Cooking pasta"], [], [], []],
        label: "bookmark 9 says “postgres” only in its notes",
        note: "Two bookmarks. One is about Postgres. The other mentions it once in passing.",
      },
      {
        items: [["7: Run Postgres in Docker", "9: Cooking pasta"], ["7: run:A postgr:A docker:A", "9: cook:A pasta:A postgr:C"], [], []],
        hot: ["7: run:A postgr:A docker:A", "9: cook:A pasta:A postgr:C"],
        label: "setweight: 'A' for title, 'C' for notes",
        note: "The generated column stores each term with the letter of the field it came from.",
      },
      {
        items: [
          ["7: Run Postgres in Docker", "9: Cooking pasta"],
          ["7: run:A postgr:A docker:A", "9: cook:A pasta:A postgr:C"],
          ["bookmark 7", "bookmark 9"],
          [],
        ],
        hot: ["bookmark 7", "bookmark 9"],
        label: "search @@ websearch_to_tsquery('english', $2)",
        note: "The GIN index finds both rows for the term postgr. Matching is yes or no, so both are in.",
      },
      {
        items: [
          ["7: Run Postgres in Docker", "9: Cooking pasta"],
          ["7: run:A postgr:A docker:A", "9: cook:A pasta:A postgr:C"],
          ["bookmark 7", "bookmark 9"],
          ["1. bookmark 7 (weight A)", "2. bookmark 9 (weight C)"],
        ],
        hot: ["1. bookmark 7 (weight A)", "2. bookmark 9 (weight C)"],
        label: "order by ts_rank(search, query) desc",
        note: "ts_rank reads the letters: by default an A term counts 1.0 and a C term 0.2, so the title match comes first.",
        kind: "res",
      },
    ],
  },
  {
    type: "flow",
    after: "keeping-the-index-in-sync",
    title: "A dual write, then the same change through a queue",
    actors: ["API", "Postgres", "Queue", "Worker", "Elasticsearch"],
    steps: [
      [0, 1, "update bookmarks … where id = 7; commit", "The title changes in the source of truth."],
      [0, 4, "index bookmark 7", "Dual write: the request itself calls the search engine next."],
      [4, 0, "timeout", "The second write fails. Postgres has the new title, the index has the old one, and nothing will retry.", "err"],
      [0, 2, "add job: index-bookmark 7", "The fix: after the commit, the request only queues a small job that carries the id."],
      [2, 3, "index-bookmark 7", "A worker picks it up."],
      [3, 1, "select … where id = 7", "It loads the current row, so a late or duplicate job still indexes the latest version."],
      [3, 4, "PUT bookmarks/_doc/7", "The Postgres id is the document _id, so indexing twice overwrites and never duplicates."],
      [4, 3, "timeout", "The same failure as before.", "err"],
      [3, 2, "failed: retry with backoff", "This time the queue remembers the work."],
      [3, 4, "PUT bookmarks/_doc/7 → 200", "The retry succeeds, and the two copies agree again.", "res"],
    ],
  },
];
