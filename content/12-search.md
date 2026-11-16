---
title: Full-text search
part: Data
summary: Why LIKE is not search, how an inverted index finds and ranks documents, and when Postgres is enough.
---

Users don't type exact values. They type "postgres indexing tips" and expect the bookmark titled "How Postgres uses B-tree indexes" at the top. That is **full-text search**: find documents that match the *meaning* of some words, and order them by how well they match. The tools for it, from Postgres's built-in search to Elasticsearch and OpenSearch, all rest on one data structure, the inverted index. Understand it and the rest is configuration.

## The first principle

The first thing everyone writes is:

```sql
select * from bookmarks where title ilike '%index%';
```

It works on a laptop. Then it fails in four ways:

1. **No index can help.** A B-tree is sorted by the start of the value. A pattern that starts with `%` can begin anywhere, so Postgres reads every row and scans every string. Ten million bookmarks means ten million string scans per search.
2. **It matches characters, not words.** `%run%` matches "brunch" and "prune". It doesn't match "ran". `%index%` doesn't match "indices".
3. **No ranking.** Rows come back in no useful order. A title that *is* about indexing and a note that mentions "index" once in passing look the same.
4. **No multi-word queries.** "postgres indexing" as one pattern only matches that exact phrase. Splitting into `and` clauses makes each one a full scan, and you still have no ranking.

Look at how a book solves this. You don't read every page to find "B-tree". You turn to the **index** at the back: an alphabetical list of terms, each with the pages it appears on. Someone did the work once, ahead of time, so every lookup is fast.

Search engines do the same:

1. **Split each document into terms**, and normalize them so "Running", "runs" and "run" become one term.
2. **Build a map from each term to the documents that contain it.** This is the **inverted index**: inverted because a document maps to words, and this maps words back to documents.
3. **At query time**, normalize the query the same way, look up each term, combine the document lists, and **score** each document by how well it matches.

> Search is a lookup in a precomputed index plus a ranking function. All the work of "understanding" text happens when you build the index, not when you query it.

## Core ideas

### Tokenization and analysis

Turning text into index terms is called **analysis**. An **analyzer** is a pipeline with three kinds of steps:

```
"The Runners were RUNNING to the café!"
   │ character filters    strip HTML, map characters
   │ tokenizer            split into words: The | Runners | were | RUNNING | to | the | café
   │ token filters        lowercase, remove stop words, fold accents, stem
   ▼
   runner | run | cafe
```

- **Tokenizer**: splits text into tokens, usually on whitespace and punctuation. Languages without spaces between words (Chinese, Japanese, Thai) need special tokenizers.
- **Lowercasing**: "Postgres" and "postgres" become the same term.
- **Stop words**: very common words ("the", "a", "to") carry little meaning and appear everywhere. Dropping them shrinks the index.
- **Stemming**: cutting words to a root, so "running", "runs" and "run" become `run`. Stemmers are rule-based and language-specific (the Snowball stemmers are the common ones) and produce roots that aren't real words: "quickly" becomes `quick`, "indexing" becomes `index`, "database" becomes `databas`. That's fine; nobody sees them.
- **Other filters**: accent folding ("café" → "cafe"), synonyms ("js" → "javascript"), n-grams for partial-word and typo matching.

The rule that matters most: **analyze the query with the same analyzer as the documents.** If documents are stemmed and the query isn't, "running" in the query won't find `run` in the index.

### The inverted index

After analysis, the index is a sorted dictionary of terms, each with a **postings list**: the documents that contain the term, often with positions and counts.

```
doc 1: "Indexing in Postgres"
doc 2: "Cooking pasta"            notes: "mentions postgres once"
doc 3: "Postgres full-text search"

term        postings (doc: positions)
cook    →   2:1
index   →   1:1
pasta   →   2:2
postgr  →   1:3   2:4   3:1
search  →   3:4
```

A query for "postgres index" becomes the terms `postgr` and `index`. Look up both lists and combine them: intersect for AND (doc 1), union for OR (docs 1, 2, 3). The cost depends on the length of the lists for the query's terms, not on the size of the whole collection. Positions let the engine answer phrase queries ("full text" means `full` immediately followed by `text`).

Building and updating the index is the expensive part. That's the trade: slower, larger writes for fast reads.

### Relevance: TF-IDF and BM25

Finding matches is half the job. Ranking them is the other half. Three intuitions:

- **Term frequency (TF)**: a document that mentions "postgres" five times is more likely about Postgres than one that mentions it once. But the tenth mention adds less than the second.
- **Inverse document frequency (IDF)**: rare terms matter more. If "postgres" appears in 2% of documents and "guide" in 40%, a match on "postgres" says much more.
- **Length normalization**: one mention in a 5-word title means more than one mention in a 5,000-word article.

**TF-IDF** multiplies term frequency by inverse document frequency. **BM25** (Okapi BM25) refines it and is the default in Lucene, so in Elasticsearch, OpenSearch and Solr. For each query term:

```
score += IDF(term) × tf × (k1 + 1) / (tf + k1 × (1 − b + b × docLength / avgDocLength))
```

- `k1` (default 1.2) controls **saturation**: how quickly extra repetitions stop adding score.
- `b` (default 0.75) controls how much document length is penalized.

You rarely tune these. What you will tune is **field boosts** (a match in the title counts three times as much as one in the notes) and business signals (newer or more popular documents rank higher).

### Postgres full-text search

Postgres has all of the above built in. Two types:

- `tsvector`: an analyzed document, a sorted list of terms with positions.
- `tsquery`: an analyzed query, terms joined by `&` (and), `|` (or), `!` (not) and `<->` (followed by).

```sql
select to_tsvector('english', 'The runners were running quickly');
-- 'quick':5 'run':4 'runner':2

select websearch_to_tsquery('english', 'postgres -cooking "full text"');
-- 'postgr' & !'cook' & 'full' <-> 'text'
```

`'english'` is the **text search configuration**: its parser, stop words and Snowball stemmer. Use `'simple'` for no stemming (names, codes), and pick the configuration per language.

Four ways to build a query:

| Function | Input | Notes |
|---|---|---|
| `to_tsquery` | Query syntax: `run & index` | Raises a syntax error on plain user input. Don't pass user text to it |
| `plainto_tsquery` | Plain text | ANDs all words |
| `phraseto_tsquery` | Plain text | Words must appear in order |
| `websearch_to_tsquery` | Web-style: `"phrase"`, `or`, `-word` | Never raises a syntax error. Use this for search boxes |

`@@` is the match operator. To make it fast, store the `tsvector` in a column and index it with **GIN** (Generalized Inverted Index), which is an inverted index inside Postgres:

```sql
alter table bookmarks add column search tsvector
  generated always as (
    setweight(to_tsvector('english', title), 'A') ||
    setweight(to_tsvector('english', description), 'B') ||
    setweight(to_tsvector('english', notes), 'C')
  ) stored;

create index bookmarks_search_idx on bookmarks using gin (search);
```

The generated column keeps itself in sync on every insert and update; no trigger or application code needed. It must be `stored`: Postgres 18 makes generated columns virtual by default, and virtual columns can't be indexed. `setweight` labels terms by field, A (highest) to D, so ranking can prefer title matches.

Query and rank:

```sql
select id, title,
       ts_rank(search, query) as rank
from bookmarks, websearch_to_tsquery('english', $2) as query
where user_id = $1 and search @@ query
order by rank desc, created_at desc
limit 20;
```

- `ts_rank` scores by how often the terms occur, weighted by A to D. `ts_rank_cd` also rewards terms that appear close together.
- `ts_headline(config, text, query)` returns a snippet with the matched words marked. It re-analyzes the text, so run it only on the 20 rows you return, not on every match.

Know the limits before you promise too much:

- **Ranking has no IDF.** The Postgres docs say it plainly: the ranking functions "do not use any global information". A common word and a rare one weigh the same.
- **Ranking is computed per match.** Postgres must read the `tsvector` of every matching row to rank it, then sort. A query that matches 500,000 rows is slow even with `limit 20`.
- **No typo tolerance.** "postgress" finds nothing. The `pg_trgm` extension adds trigram similarity (`similarity()`, `word_similarity()` and the `%` and `<%` operators) and GIN trigram indexes that also make `ilike '%x%'` indexable; use it for fuzzy matching on short fields like titles and names.
- Extensions such as `pg_search` (ParadeDB) and `pg_textsearch` add BM25 ranking inside Postgres if you outgrow `ts_rank` but don't want a second database.
- **It matches words, not meaning.** A search for "car" won't find "automobile" unless you maintain synonyms. *Semantic* search stores a vector (an embedding from a language model) for each document and returns the nearest ones to the query's vector; the `pgvector` extension adds that to Postgres, and Elasticsearch and OpenSearch have it built in. Current practice is *hybrid* search: run the keyword query and the vector query, then merge the two ranked lists. Keyword search stays the base, because it is exact, cheap and easy to explain.

For per-user search over thousands to a few million rows, which is Linkbox, built-in search is usually enough.

### Elasticsearch and OpenSearch

**Elasticsearch** is a search server built on Apache Lucene. **OpenSearch** is the Apache-licensed fork that AWS started in 2021 after Elastic changed its license; the two have since drifted apart but share the core ideas and most of the query language. In 2024 Elastic added the open-source AGPLv3 as a license option for Elasticsearch, and AWS handed OpenSearch to the Linux Foundation. You talk to both over HTTP with JSON.

What they give you over Postgres:

- **BM25 ranking with real collection statistics**, field boosts and function scoring (recency, popularity).
- **A large analyzer toolbox**: dozens of languages, synonyms, n-grams, phonetic matching.
- **Fuzzy queries** (`"fuzziness": "AUTO"` allows one or two character edits), autocomplete and "did you mean".
- **Aggregations** for faceted search: "show counts by tag, by year, by site" next to the results.
- **Horizontal scale**: an index is split into **shards** spread across nodes, each with **replicas**, so search scales by adding machines.

How they work underneath: each shard is a Lucene index made of immutable **segments**. New documents go into an in-memory buffer and become searchable when a **refresh** writes a new segment, every second by default. So search is **near real-time**: a document you just indexed may not appear in results for about a second. (A shard that has had no search for 30 seconds stops these background refreshes until the next search arrives.) Small segments are merged into bigger ones in the background.

The cost is the important part. Elasticsearch is a **second datastore**:

- Another cluster to run, monitor, upgrade, secure and back up, with real memory needs (the JVM heap and the OS page cache for segments).
- Its data is a **copy**. Postgres stays the source of truth, and you must keep the copy in sync, forever.
- No transactions with your database, and permission checks (whose bookmark is this?) must be repeated as filters in every search query.

Reach for it when you need relevance tuning, fuzzy matching, facets or language features Postgres can't give you, or when search load and data size outgrow the main database. Don't reach for it just because a tutorial did.

### Keeping the index in sync

The moment search lives outside Postgres, every write must reach two systems. Options, from worst to best:

| Approach | How | Problem |
|---|---|---|
| Dual write in the request | Write Postgres, then call Elasticsearch | If the second call fails or the process dies between them, the copies disagree, silently |
| Queue a reindex job | After commit, enqueue `index bookmark 7` (lesson 11) | Good. The job loads the current row and indexes it; retries cover failures. A crash between commit and enqueue still loses the job |
| Outbox table | Insert an outbox row in the same transaction; a worker forwards it (lesson 25) | No gap: the event exists if and only if the write committed |
| Change data capture | Read Postgres's write-ahead log with logical replication (Debezium and similar) | Captures every change, even from scripts and migrations. More infrastructure |

Rules that hold whichever you choose:

- **Index by id, load the current row.** The job says "bookmark 7 changed", and the worker reads the latest row. Out-of-order or duplicate jobs then converge on the right result. Use the Postgres id as the document `_id`, so indexing twice overwrites instead of duplicating.
- **Handle deletes.** If the row is gone, delete the document.
- **Be able to rebuild from scratch.** Mappings change and bugs corrupt indexes. Write a backfill script that reindexes everything from Postgres into a new index, then switch an **alias** from the old index to the new one, with no downtime.
- **Check drift.** Periodically compare counts or recent ids between Postgres and the index.

The Postgres generated column above has none of these problems: the index updates in the same transaction as the row. That is the main reason to start there.

## Try it

Start Postgres and load a few bookmarks:

```bash
docker run --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 -d postgres:18
docker exec -it pg psql -U postgres
```

```sql
select to_tsvector('english', 'The runners were running quickly, indexes and indexing');
select websearch_to_tsquery('english', 'postgres -cooking "full text"');

create table docs (id int primary key, title text not null, body text not null default '');
insert into docs values
  (1, 'Indexing in Postgres', 'How B-tree indexes work'),
  (2, 'Cooking pasta', 'Mentions postgres once, then brunch'),
  (3, 'Postgres full-text search', 'Ranking with ts_rank'),
  (4, 'Running fast', 'Marathon training');

alter table docs add column search tsvector generated always as (
  setweight(to_tsvector('english', title), 'A') ||
  setweight(to_tsvector('english', body), 'B')) stored;
create index docs_search_idx on docs using gin (search);

select id, title, ts_rank(search, q) as rank
from docs, websearch_to_tsquery('english', 'postgres') q
where search @@ q
order by rank desc;
```

Doc 2 ranks last: its match is in the body (weight B), the others match in the title (weight A).

Compare with `ilike`, and see the index get used on a bigger table:

```sql
select title from docs where title ilike '%run%' or body ilike '%run%';   -- "brunch" matches too
select title from docs where search @@ websearch_to_tsquery('english', 'ran');  -- stemming has limits

insert into docs (id, title, body)
select g, 'Note ' || g, md5(g::text) from generate_series(5, 200000) g;
analyze docs;
explain analyze select id from docs where search @@ websearch_to_tsquery('english', 'postgres');
```

The plan shows a `Bitmap Index Scan on docs_search_idx`.

Optional: run Elasticsearch locally (security off, for development only) and watch an analyzer work:

```bash
docker run --name es -p 9200:9200 -e discovery.type=single-node -e xpack.security.enabled=false \
  -e ES_JAVA_OPTS="-Xms512m -Xmx512m" -d elasticsearch:9.5.5

curl -s localhost:9200/_analyze -H 'Content-Type: application/json' \
  -d '{"analyzer": "english", "text": "The runners were running quickly"}'
```

Break it on purpose:

1. Search for `postgress` (typo). Nothing. Run `create extension pg_trgm;` and try `select title, word_similarity('postgress', title) from docs where 'postgress' <% title;`.
2. Pass `running indexes` to `to_tsquery` instead of `websearch_to_tsquery`. Read the error. What would a search box do with it?
3. Build the `tsvector` with `'simple'` instead of `'english'` and search for `run`. What is found now, and what is lost?
4. Drop the GIN index and rerun the `explain analyze`. How much slower is it?

## Common mistakes

- **`ilike '%term%'` as a search feature.** It scans every row, matches fragments of words and can't rank. Use full-text search, or `pg_trgm` if you really need substring matching.
- **`to_tsquery` on raw user input.** Any stray `&` or `(` raises an error and the user gets a 500. Use `websearch_to_tsquery` or `plainto_tsquery`.
- **Different analysis at index and query time.** Indexing with `'english'` and querying with `'simple'` (or the server default) finds almost nothing. Always pass the configuration explicitly on both sides.
- **Computing `to_tsvector` in the `where` clause.** `where to_tsvector('english', title) @@ q` can't use an index on a different expression and re-analyzes every row. Store it in an indexed generated column, or index that exact expression.
- **Dual writes to a search engine.** A failed second write leaves the index silently out of date. Sync through a queue or an outbox, index by id from the current row, and keep a full reindex script.
- **Forgetting authorization in search.** A search endpoint that doesn't filter by `user_id` leaks everyone's bookmarks. Apply the owner filter inside the query, in Postgres and in Elasticsearch.

## Build: Linkbox, step 12

Add search over title, description (from lesson 11) and notes.

1. Add `migrations/003_bookmark_search.sql` with the weighted, stored `search` column and the GIN index from *Core ideas* (title A, description B, notes C).
2. Add `GET /api/v1/bookmarks/search?q=...`. Trim `q` and reject empty or very long queries with 400 (lesson 06).
3. In the repository, query with `websearch_to_tsquery('english', $2)`, filter by `user_id = $1`, order by `ts_rank(search, query) desc, created_at desc`, and limit to 20. Return the same bookmark shape as the list endpoint, plus `rank`.
4. Add a `snippet` field with `ts_headline` computed only for the returned rows (wrap the ranked query in a subquery, then call `ts_headline` in the outer `select`).
5. Seed a few thousand bookmarks and confirm with `explain analyze` that the GIN index is used.
6. Optional: run Elasticsearch or OpenSearch, create a `bookmarks` index with `english` analyzers, and keep it in sync with a BullMQ job (`index-bookmark`, job id from the bookmark id) enqueued after every create, update and delete. Search with a `bool` query that filters `user_id` and runs a `multi_match` over `title^3`, `description^2` and `notes` with `"fuzziness": "AUTO"`. Compare results and latency with Postgres for the same queries, and write down what the second system cost you.

**Done when** searching "running postgres" finds a bookmark titled "Run Postgres in Docker", title matches rank above notes-only matches, a query with stray quotes or `&` returns results instead of a 500, and one user never sees another user's bookmarks.

## Check yourself

<details markdown="1">
<summary>Name three reasons <code>where title ilike '%index%'</code> is not real search.</summary>

A B-tree index can't help a leading `%`, so it scans every row; it matches character fragments rather than words ("brunch" for `run`) and misses other forms ("indices"); and it has no relevance ranking or sensible multi-word handling.
</details>

<details markdown="1">
<summary>What is an inverted index, and why is it fast?</summary>

A map from each normalized term to the list of documents (and positions) containing it. A query looks up only its own terms and combines their lists, so the cost depends on those lists, not on the size of the whole collection. The work is done once at index time.
</details>

<details markdown="1">
<summary>Why must the query be analyzed with the same analyzer as the documents?</summary>

The index holds analyzed terms (lowercased, stemmed, stop words removed). If the query goes through different steps, its terms won't match: "Running" unstemmed won't find the indexed term `run`.
</details>

<details markdown="1">
<summary>What does IDF add to ranking, and does Postgres's <code>ts_rank</code> use it?</summary>

IDF gives rare terms more weight than common ones, because matching a rare term says more about a document. `ts_rank` doesn't use it: it ranks from each document's own term frequencies and weights, with no statistics about the whole collection. BM25 in Elasticsearch and OpenSearch does use it.
</details>

<details markdown="1">
<summary>Why is writing to Postgres and then to Elasticsearch in the same request a bad way to keep them in sync?</summary>

The two writes aren't atomic. If the second fails or the process dies between them, the index silently disagrees with the database. Sync through a retried queue job or an outbox written in the same transaction, index by id from the current row, and keep a full reindex script for repairs.
</details>

<details markdown="1">
<summary>When is Elasticsearch or OpenSearch worth the extra system?</summary>

When you need things Postgres search does poorly: BM25 relevance tuning, typo tolerance, autocomplete, facets, many languages, or search load and data volume too large for the main database. Not for basic keyword search over a modest per-user dataset.
</details>

## Go deeper

- [PostgreSQL: Full Text Search](https://www.postgresql.org/docs/current/textsearch.html): the complete chapter on `tsvector`, `tsquery`, configurations, ranking and GIN indexes.
- [PostgreSQL: Controlling Text Search](https://www.postgresql.org/docs/current/textsearch-controls.html): parsing queries, `ts_rank` and `ts_rank_cd`, weights, normalization and `ts_headline`, with their limits stated plainly.
- [PostgreSQL: pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html): trigram similarity for typo tolerance and indexes that make `ilike '%x%'` fast.
- [Elastic: Practical BM25, the algorithm and its variables](https://www.elastic.co/blog/practical-bm25-part-2-the-bm25-algorithm-and-its-variables): BM25 explained term by term, including `k1` and `b`.
- [Elastic: Text analysis](https://www.elastic.co/docs/manage-data/data-store/text-analysis): character filters, tokenizers and token filters, and how to build a custom analyzer.
- [OpenSearch documentation](https://docs.opensearch.org/latest/): the open-source fork's docs for indexing, queries and running a cluster.
