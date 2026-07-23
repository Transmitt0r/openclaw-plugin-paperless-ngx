# Proposal: AI Embedding Semantic Search

Status: **draft / for discussion** — nothing in this document is implemented yet.

## Motivation

Today the plugin's retrieval story is entirely lexical: `paperless_list_documents` wraps
paperless-ngx's Whoosh full-text `search`/`query`, and `paperless_grep_document` /
`paperless_get_document_range` drill into a single document. That works well when the user's
words appear in the OCR text, and fails when they don't:

- "find my car insurance policy" misses a German "KFZ-Haftpflicht Versicherungsschein"
- "what did the landlord say about the deposit" misses "Kaution" / "security deposit refund"
- OCR noise ("lnvoice", broken ligatures) silently defeats exact term matching
- "documents about my knee surgery" has no single keyword at all

Embedding-based semantic search fixes exactly this class of failure: queries and document
chunks are compared in vector space, so synonyms, cross-language phrasing, and OCR-mangled
terms still land near each other. For an agent doing RAG over a personal document archive,
this is the difference between "retrieval works if the user guesses the right words" and
"retrieval works".

## Constraints and prior art

Three facts shape the design:

1. **paperless-ngx exposes no semantic-search API to delegate to.** The REST API (see
   `src/generated/paperless-schema.d.ts`) exposes lexical search only. paperless-ngx
   v3.0.0 (July 2026) did introduce built-in, opt-in **Paperless AI**
   ([PR #10319](https://github.com/paperless-ngx/paperless-ngx/pull/10319)): LLM-based
   suggestions and a document-chat/RAG feature backed by a server-side LlamaIndex +
   FAISS embedding index — but that index is internal (persisted under the server's
   `LLM_INDEX_DIR`), surfaced only through the chat streaming view and the suggestions
   endpoint, and there is no retrieval/similarity endpoint an agent tool could query.
   If upstream ever exposes one, the tool contract proposed here could delegate to it
   and drop the local index — worth watching. Third-party sidecars (paperless-ai,
   paperless-gpt) exist but bring their own deployment, auth, and API surface; depending
   on one would make the plugin useless for everyone who doesn't run it.
2. **OpenClaw already ships the entire embedding + vector-index toolchain, exposed to
   plugins.** The host's memory subsystem (`memory-core`) indexes markdown/session files
   into a SQLite database using `node:sqlite` + the `sqlite-vec` extension, with hybrid
   FTS5 + vector retrieval, an embedding cache, and pluggable embedding providers (local
   model via node-llama-cpp, or remote OpenAI/Gemini/Voyage-style APIs). Critically, the
   plugin SDK re-exports the building blocks:
   - `openclaw/plugin-sdk/embedding-providers` — `getEmbeddingProvider(id, cfg)` /
     `listEmbeddingProviders(cfg)` resolving to an `EmbeddingProvider` with
     `embed(input, { inputType: "query" | "document" })`, `embedBatch(...)`,
     `dimensions`, `maxInputTokens`, plus an index-identity contract
     (`EmbeddingProviderIndexIdentity`) for detecting "the index was built with a
     different model".
   - `openclaw/plugin-sdk/memory-core-host-engine-storage` — `requireNodeSqlite()`,
     `loadSqliteVecExtension(...)`, `chunkMarkdown(content, { tokens, overlap })`,
     `hashText`, `cosineSimilarity`, `runWithConcurrency`, `ensureDir`.
   - `api.registerService({ id, start(ctx), stop(ctx) })` — a host-managed background
     service with a per-plugin `ctx.stateDir` for persistent local state.
3. **This plugin deliberately mirrors the API, not workflows.** Whatever we add should be
   more generic tools an agent composes, not a monolithic "RAG pipeline" — consistent with
   the existing grep/range tools that exist to feed an agent targeted context.

## Options considered

| Option | Verdict |
| --- | --- |
| **A. Delegate to paperless-ngx server-side AI** | v3.0.0's Paperless AI has an embedding index, but no retrieval/similarity API endpoint — only chat streaming and suggestions. Nothing to build an agent search tool against today; revisit if upstream exposes retrieval. |
| **B. Require a sidecar (paperless-ai, external vector DB like Qdrant/Chroma)** | Extra infrastructure every user must deploy and secure; couples the plugin to a third project's API stability. Poor fit for the "install plugin, paste token" UX this plugin has. |
| **C. Query-time-only embeddings (embed the top-N lexical results and rerank)** | Cheap and index-free, but it can only *reorder* what keyword search already found — it cannot recover documents lexical search missed, which is the main motivation. Worth having later as a reranker, not as the core. |
| **D. Plugin-owned local index: chunk + embed documents into SQLite (sqlite-vec + FTS5) under the plugin's state dir, using OpenClaw's embedding providers** | **Recommended.** Zero extra infrastructure, reuses the exact stack the host's own memory search uses, works with a local embedding model for privacy, degrades cleanly when disabled. |

The rest of this document details option D.

## Architecture overview

```mermaid
flowchart LR
    subgraph paperless["paperless-ngx"]
        API["REST API"]
    end

    subgraph plugin["plugin"]
        SYNC["indexer service<br/>(registerService)"]
        DB[("semantic-index.sqlite<br/>docs / chunks / vec0 / fts5 / cache")]
        QT["paperless_semantic_search tool"]
    end

    subgraph host["OpenClaw host"]
        EP["embedding provider<br/>(local or remote)"]
    end

    API -- "changed docs<br/>(modified__gt, fields=…)" --> SYNC
    SYNC -- "chunk + embedBatch<br/>(inputType: document)" --> EP
    SYNC -- upsert --> DB
    QT -- "embed query<br/>(inputType: query)" --> EP
    QT -- "KNN + BM25 → RRF" --> DB
    QT -- "doc ids + line ranges + snippets" --> AGENT["agent → paperless_get_document_range / grep for full context"]
```

Four pieces, each described below:

1. an **index store** (one SQLite file in the plugin's state dir),
2. an **indexer** (incremental sync from paperless-ngx → chunks → embeddings),
3. a **query path** (new agent tools),
4. **configuration** (opt-in, provider selection, privacy posture).

### 1. Index store

One SQLite database at `<stateDir>/semantic-index.sqlite` (the `stateDir` handed to the
plugin's registered service), opened via `requireNodeSqlite()` with the `sqlite-vec`
extension loaded through `loadSqliteVecExtension(...)` — both already shipped by the host
for memory-core, so the plugin adds **no native dependencies**.

Schema (plugin-owned, versioned):

```sql
-- one row per paperless document we have indexed
CREATE TABLE docs (
  id            INTEGER PRIMARY KEY,   -- paperless document id
  modified      TEXT NOT NULL,         -- paperless `modified` timestamp at index time
  checksum      TEXT,                  -- paperless source checksum
  content_hash  TEXT NOT NULL,         -- hashText(normalized OCR content)
  title         TEXT,
  correspondent_id  INTEGER,
  document_type_id  INTEGER,
  tag_ids       TEXT NOT NULL DEFAULT '[]',  -- JSON array, for filter pushdown
  created       TEXT,                  -- for date-range filters
  indexed_at    TEXT NOT NULL
);

-- one row per chunk; line spans let results chain into the existing range/grep tools
CREATE TABLE chunks (
  id          INTEGER PRIMARY KEY,
  doc_id      INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  text        TEXT NOT NULL            -- chunk text, kept for snippets + FTS (see privacy note)
);

-- sqlite-vec virtual table; rowid = chunks.id
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding float[{dims}]);

-- FTS5 over chunk text for the hybrid keyword leg; rowid = chunks.id
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');

-- content-addressed embedding cache: hash(model ⊕ text) → vector
CREATE TABLE embedding_cache (
  key     TEXT PRIMARY KEY,
  vector  BLOB NOT NULL
);

-- single-row index identity + sync checkpoint
CREATE TABLE meta (
  schema_version INTEGER,
  provider TEXT, model TEXT, provider_key TEXT, dims INTEGER,
  chunk_tokens INTEGER, chunk_overlap INTEGER,
  last_sync_started TEXT, last_sync_completed TEXT,
  sync_checkpoint TEXT                 -- max `modified` fully processed
);
```

Design points:

- **Chunk-level, not document-level vectors.** A 40-page contract averaged into one vector
  matches nothing well. Chunking (default ~400 tokens, ~80 overlap, via the SDK's
  `chunkMarkdown`) is what makes results precise enough to feed RAG: each hit carries a
  `doc_id + start_line..end_line` span the agent can pull with
  `paperless_get_document_range`.
- **Index identity mirrors memory-core.** `meta` records provider/model/dims (and the
  provider's `EmbeddingProviderIndexIdentity.cacheKeyData`). On startup, a mismatch —
  user switched embedding model — marks the index stale and triggers a full rebuild
  rather than silently mixing vector spaces.
- **Embedding cache** keyed by `hashText(model + "\0" + chunkText)` makes rebuilds and
  re-syncs of unchanged text nearly free, and dedupes identical chunks across documents
  (letterheads, footers).
- **`content_hash` short-circuit:** a document whose `modified` changed but whose OCR
  content hash is unchanged (e.g. tag edits — which paperless bumps `modified` for) only
  updates the metadata columns; no re-chunking, no embedding calls.

### 2. Indexer (sync)

Registered as a background service:

```ts
api.registerService({
  id: "paperless-ngx-semantic-index",
  start(ctx) { /* open DB in ctx.stateDir, schedule sync loop */ },
  stop(ctx)  { /* abort in-flight sync, close DB */ },
});
```

Sync algorithm (incremental, resumable):

1. **Changed docs:** `GET /api/documents/?ordering=modified&modified__gt=<checkpoint>&fields=id,modified,checksum,title,correspondent,document_type,tags,created` —
   paginated, metadata-only (no `content`), so a no-op sync is one cheap request.
2. Per changed doc: fetch `fields=id,content`, normalize line endings (reusing the
   existing `normalizeLineEndings` logic in `src/tools/documents.ts`), compare
   `content_hash`; on change, re-chunk and `embedBatch` the cache-missing chunks with
   `inputType: "document"`, bounded by `runWithConcurrency` and the provider's
   `maxInputTokens`. Upsert `docs`/`chunks`/`chunks_vec`/`chunks_fts` in one transaction
   per document, then advance the checkpoint — a crash mid-sync resumes where it left off.
3. **Deletions:** periodically (and on manual sync) fetch the full id set with
   `fields=id&page_size=…` and delete index rows for ids that no longer exist. (The list
   endpoint's `all` id array — which `shapeDocumentList` strips for agents — is exactly
   this sweep for free on any list call the indexer makes.)
4. Loop on a configurable interval (default e.g. 15 min) with jitter; every paperless call
   goes through the existing typed client, inheriting its 30 s timeout behavior.

**MVP shortcut:** phase 1 (below) can ship without the background loop — sync runs on
demand via a `paperless_semantic_index_sync` tool and lazily when a semantic query finds
the index missing/stale. That keeps the first PR small; the service is additive.

### 3. Query path — new tools

**`paperless_semantic_search`** (the headline):

- Params: `query` (natural language), `top_k` (default 10, capped), optional metadata
  filters mirroring `paperless_list_documents` (`correspondent_id`, `document_type_id`,
  `tag_id`, `created_from`/`created_to`), optional `mode: "semantic" | "hybrid"`
  (default hybrid).
- Execution: embed the query (`inputType: "query"`) → KNN over `chunks_vec` → BM25 over
  `chunks_fts` → fuse with Reciprocal Rank Fusion → apply metadata filters via the `docs`
  join → group chunks by document, keep each document's best chunks.
- Response per document: `id`, `title`, resolved `correspondent_name` /
  `document_type_name` / `tag_names` (reusing `resolveNameMaps`), web-UI `url`, `score`,
  and matched chunks as `{ start_line, end_line, snippet }` — deliberately shaped so the
  agent's next move is the existing `paperless_get_document_range` /
  `paperless_grep_document`, keeping context budgets small. Also `index_status`
  (`last_sync_completed`, docs indexed vs. total) so the agent can caveat stale results.
- Errors are actionable: not-enabled → points at config; index empty → points at the sync
  tool; provider unavailable → surfaces the provider's setup error.

**`paperless_semantic_index_sync`** — trigger a sync (`full: true` forces a rebuild);
returns counts (scanned / re-embedded / deleted / duration).

**`paperless_semantic_index_status`** — index size, checkpoint, provider/model identity,
staleness; cheap observability for both agents and humans debugging.

Hybrid ranking matters for this corpus: invoice numbers, IBANs, policy numbers, and names
are things exact matching wins on, while the vector leg wins on paraphrase. RRF is the
standard, tuning-free fusion and both legs live in the same SQLite file. Paperless's own
Whoosh search stays available through `paperless_list_documents` untouched.

```mermaid
sequenceDiagram
    participant A as Agent
    participant T as paperless_semantic_search
    participant E as Embedding provider
    participant S as semantic-index.sqlite
    A->>T: query "landlord deposit refund", top_k 8
    T->>E: embed(query, inputType: query)
    T->>S: KNN (chunks_vec) + BM25 (chunks_fts)
    S-->>T: chunk hits → RRF fuse → filter → group by doc
    T-->>A: docs + line spans + snippets + scores
    A->>A: paperless_get_document_range(id, start_line, end_line)
```

### 4. Configuration

All new config lives under one optional key; **absent = feature off = zero behavior
change** for existing installs (semver: `feat`, minor).

**Decision: the default embedding provider is `local`.** The host's local provider runs
EmbeddingGemma-300m (`hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF`, the SDK's
`DEFAULT_LOCAL_MODEL`) in-process via node-llama-cpp: a ~300 MB quantized multilingual
encoder — no GPU, no API key, no OCR text leaving the machine. Remote providers remain a
config change away for users who want higher throughput.

```jsonc
{
  "plugins": {
    "entries": {
      "paperless-ngx": {
        "config": {
          "baseUrl": "https://paperless.example.com",
          "apiToken": { /* SecretRef */ },
          "semanticSearch": {
            "enabled": true,
            "embedding": {
              "provider": "local",       // default; any host embedding provider id works: local, openai, gemini, voyage, …
              "model": "…",              // optional; defaults to the host's DEFAULT_LOCAL_MODEL (EmbeddingGemma-300m Q8_0)
              "dimensions": 256,         // default 256 via Matryoshka truncation (see hardware sizing)
              "apiKey": { /* SecretRef, for remote providers, reusing the existing resolveApiToken pattern */ }
            },
            "chunking": { "tokens": 400, "overlap": 80 },
            "sync": { "intervalMinutes": 15, "concurrency": 1 },
            "idleUnloadMinutes": 10,     // release the local model's memory when unused
            "storeChunkText": true       // false = no OCR text at rest in the index (see below)
          }
        }
      }
    }
  }
}
```

Provider resolution goes through `getEmbeddingProvider(id, api.config)`, so anything the
host supports — including embedding providers registered by *other* plugins — works here
without this plugin knowing about it.

## Hardware sizing and scale envelope

Two distinct requirements, kept separate:

- **Reference deployment:** a small home-server box (2 vCPU, 4 GB RAM, no GPU) that also
  runs the OpenClaw gateway, serving realistic personal archives — ~600 documents (light
  user) to ~6 000 (heavy user). The *defaults* are tuned for this.
- **Architectural envelope:** the design must not hit a wall before **100 000 documents**
  — not on the reference box, but on hardware proportionate to an archive that size
  (several cores, ≥16 GB). The *architecture* must scale there without a redesign.

Numbers below are for the default local model (EmbeddingGemma-300m, Q8_0), assuming a
mixed archive averaging ~2 500 tokens/document → ~8 chunks/document at the default
chunking (400-token chunks, 80 overlap; text-heavy archives run closer to 15
chunks/document).

| | 600 docs | 6 000 docs | 100 000 docs (envelope) |
| --- | --- | --- | --- |
| Chunks (typical / text-heavy) | ~5k / 9k | ~48k / 90k | ~800k / 1.5M |
| Vector table, 256 d float32 | ~5 MB | ~50 MB | ~820 MB |
| Vector table, 768 d float32 | ~15 MB | ~150 MB | ~2.4 GB |
| Whole DB incl. chunk text + FTS | ~20 MB | ~200 MB | ~3–4 GB |
| KNN scan per query (256 d, warm) | <1 ms | ~5–15 ms | ~100–300 ms (2 vCPU) |
| Initial backfill (1–3 chunks/s local) | ~30–80 min | ~5–13 h | ~3–9 days |
| Incremental sync per new doc | ~3–8 s | ~3–8 s | ~3–8 s |

**On the reference box:** 600 docs is a non-event — indexed within the hour, everything
cached, instant queries. 6 000 docs is the design center — overnight backfill, vectors
permanently in page cache, ~10 ms queries, no caveats. The reference box is *not*
expected to host 100k documents.

**At the 100k envelope (on proportionate hardware):** nothing in the design breaks —
SQLite is comfortable at multi-GB scale, the incremental sync cost is unchanged (it
scales with *changed* documents, not archive size), and per-query brute-force scan of
~820 MB of vectors sits in page cache on a 16 GB machine at well under 200 ms. Two levers
exist before any architectural change would be needed:

- **Scan cost:** int8 quantization (sqlite-vec supports int8 and bit vectors natively)
  cuts the vector table 4× (~205 MB) and scan bandwidth with it — this is the phase-2
  option if query latency ever matters at the high end, and it also happens to rescue
  memory-constrained boxes.
- **Backfill time:** the local encoder is the bottleneck (days at 800k chunks at
  1–3 chunks/s; more cores help linearly). Options that fit the design unchanged: a
  remote embedding provider for the one-time build (config choice, with the privacy
  trade-off made explicit), or building elsewhere — the index file is **portable**: same
  model + same dims = same index identity, so the initial backfill can run on any faster
  machine pointed at the same paperless instance and `semantic-index.sqlite` copied to
  the serving box, which then only ever does incremental syncs.

**Memory.**
- Model weights + inference context: roughly 400–500 MB RSS while loaded. That is
  affordable within 4 GB but not free, so the provider is loaded **lazily** (first embed
  call) and released via the provider's `close()` after `idleUnloadMinutes` without use.
  Steady state with no search activity: ~0 extra memory. The cost is a cold-start of a
  few seconds on the first query after idle — acceptable for an agent tool call, and the
  status tool reports whether the model is currently resident.

**CPU / throughput.**
- Embedding a ~400-token chunk is one encoder forward pass; on 2 CPU threads expect
  order-of **1–3 chunks/second**. Initial-index cost scales linearly with the table
  above; checkpointing makes the pass resumable, and afterwards syncs touch only changed
  documents.
- To keep the gateway responsive while indexing on 2 vCPUs: `sync.concurrency` defaults
  to **1** (one document at a time, serial `embedBatch` calls) and the sync loop yields
  between documents. Indexing throughput is deliberately sacrificed for interactivity.
- **Newest-first backfill:** the initial pass processes documents in `-modified` order,
  so recently added/edited documents become semantically searchable within minutes of
  enabling the feature, while the long tail of old archives fills in behind. Combined
  with honest `index_status` in query results ("62 % indexed, backfill running"), the
  feature is useful long before the first full pass completes.
- Query cost is one single-chunk embed (sub-second warm) + the KNN/FTS scan — negligible
  at reference scale, ~100–300 ms warm at the 100k envelope (pre-quantization).

**What this rules out:** larger local models (e.g. 0.6 B+ embedding models) and
re-embedding the corpus casually. The index-identity rebuild on model change is correct
but expensive here — another reason the default model is pinned and stable rather than
"whatever the host's latest default is" (the identity check uses the provider's
`EmbeddingProviderIndexIdentity`, so an intentional model change still rebuilds cleanly).

### Why brute-force KNN, not ANN

An approximate-nearest-neighbor index is a cost, not an upgrade, until scan time actually
hurts: it adds build cost on every insert (competing with embedding on 2 vCPUs), resident
memory for the graph (HNSW typically adds 100–400 bytes/vector — tens to hundreds of MB
here), recall loss, and tuning parameters that become support burden. Meanwhile a brute
cosine scan is exact, zero-maintenance, and — per the table — stays in the tens of
milliseconds through the design center and ~100–300 ms at the 100k envelope. sqlite-vec's
`vec0` is a SIMD brute-force scanner anyway; adopting ANN would mean a separate vector
store, i.e. exactly the infrastructure option B rejected. The escalation path if the
envelope is ever exceeded is: int8 quantization (4×) → bit vectors (32×) → only then ANN.

### Considered and rejected: storing vectors in paperless custom fields

An appealing idea for durability: write each document's embeddings back into a paperless
custom field, so vectors survive loss of the plugin's state dir and "reindex" becomes
"read the field, load into SQLite". It is technically feasible since v2.19.0 — the
`longtext` custom field type has no length limit (the older `string` type caps at 128
chars), so a JSON envelope would fit:

```jsonc
// custom field "openclaw:semantic-index" (longtext), one per document
{ "v": 1, "provider": "local", "model": "embeddinggemma-300m…", "dims": 256,
  "chunking": { "tokens": 400, "overlap": 80 }, "content_hash": "…",
  "chunks": [ { "s": 1, "e": 42, "vec": "<base64 float32…>" }, … ] }
```

Rejected, for reasons that compound:

- **It's a backup of a cache.** Embeddings are derived, reproducible data; the source of
  truth (OCR content) already lives in paperless and is already backed up. Losing the
  index costs re-embed time (~an hour at 600 docs, overnight at 6k), not data.
- **It turns the strictly read-only indexer into a writer of every document** — a stated
  design property lost. A search-only deployment could no longer run on a read-only
  token, and an indexer bug could now spam or corrupt the archive it's supposed to serve.
- **Payload in the wrong database.** ~11 KB/doc typical (8 chunks × ~1.4 KB base64) ≈
  66 MB at 6k docs, ~1 GB at the 100k envelope — stored in paperless's DB, included in
  its exports, and echoed to **every** API consumer that fetches full documents (this
  plugin strips `custom_fields` from responses; other clients don't).
- **It feeds garbage into paperless's own AI.** v3.0's Paperless AI embeds custom fields
  and notes as part of its document representation — base64 blobs would pollute the
  server's own index, plus `custom_fields__icontains` filtering and the UI (longtext
  fields render on the document detail page).
- **Sync-signal churn.** Writing a field per document during the initial build risks
  bumping every document's `modified` timestamp (needs verification against a live
  instance — custom field instances are a separate model, so it may not), which would
  invalidate the incremental-sync watermark for this plugin *and* every other
  paperless-watching tool the user runs.
- **Stale-vector debt.** Vectors are only valid for one (model, dims, chunking) identity.
  A model change strands ~N documents' worth of stale blobs in people's archives until a
  mass rewrite — days of API writes at the envelope.
- **It can't replace the local store anyway.** KNN needs the vectors in the sqlite-vec
  table regardless; custom fields could only ever be a second copy requiring
  consistency maintenance, and restoring from them (N API reads of base64) is slower
  than the alternatives below for every archive size.

**What addresses the durability concern instead:**

1. **The index is self-healing by construction.** After any loss, the normal sync path
   rebuilds from paperless content — resumable, newest-first, usable while it fills.
2. **Back up one file.** `semantic-index.sqlite` in the plugin state dir is the entire
   derived state; anyone backing up their OpenClaw state dir already has it. Phase 2 can
   add a periodic `VACUUM INTO` snapshot (SQLite's crash-consistent copy) next to the
   live DB so file-level backup tools never capture a mid-write image.
3. **The index file is portable** (same model + dims = same identity) — the same
   property that lets the initial build run on a faster machine doubles as the
   restore path.

Precedent check: the community has asked for machine-readable data in custom fields
before ([discussion #5946](https://github.com/paperless-ngx/paperless-ngx/discussions/5946))
and the answers pointed at notes instead, with the same UI-pollution objections; the
request was closed for lack of support. Nothing suggests upstream wants custom fields
used as a blob store.

### Why 256 dimensions, not the native 768

EmbeddingGemma is Matryoshka-trained: vector prefixes are explicitly optimized to remain
good embeddings, so truncating 768 → 256 costs only ~1–2 % relative retrieval quality —
not a naive lossy projection. In exchange: 3× smaller vector table and 3× less scan
bandwidth — on the reference box that's the difference between "always in page cache"
and "competing with everything else for 4 GB", and at the 100k envelope it keeps the
vector table (~820 MB vs ~2.4 GB) cache-resident on ordinary hardware.
The quality delta is further masked by this architecture: semantic search only has to get
the right document into the top-k (the agent then verifies via grep/range), and the
hybrid BM25 leg recovers borderline orderings via RRF. Note there is no cheap "store 768,
scan 256" middle ground — sqlite-vec scans whole blobs, so that would mean two vector
tables — and `dimensions` is part of the index identity, so changing it later is a full
re-embed (hours to days here). Defaulting small is the choice that stays revisable
upward on bigger hardware via config.

## Privacy & security

This corpus is people's tax records, medical letters, and contracts, so the defaults must
be conservative:

- **Remote embedding providers ship OCR text to a third party.** The README must say so
  explicitly. The default is the host's **local** embedding provider (EmbeddingGemma-300m
  via node-llama-cpp; no data leaves the machine) — semantic search then adds no new data
  egress at all. Remote providers are strictly opt-in.
- **`storeChunkText: false`** mode keeps only hashes, line spans, and vectors at rest;
  snippets are then fetched on demand from paperless per result (a few extra API calls per
  query) and the FTS leg is disabled. For users whose threat model includes the OpenClaw
  state dir, this bounds what the index leaks to "which line ranges of which docs exist".
- **Visibility scope:** the index sees exactly what the configured API token sees — same
  scope as every existing tool. Worth one README sentence: on a shared gateway, semantic
  results (like all the plugin's tools) reflect that one token's permissions.
- The API token continues to support SecretRef; the embedding `apiKey` uses the same
  mechanism.
- No new write paths to paperless-ngx: the indexer is strictly read-only.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Node runtime lacks `node:sqlite` / sqlite-vec fails to load | Semantic tools register but return a clear "unavailable on this runtime" error; the rest of the plugin is unaffected. (`requireNodeSqlite` already produces the right error; note `engines` allows Node 20, where `node:sqlite` is missing.) |
| Embedding provider down mid-sync | Sync aborts without advancing the checkpoint; index keeps serving the last good state; status tool reports the error. |
| paperless-ngx unreachable | Query path still works (index is local); results carry `index_status` staleness. |
| Model/provider changed in config | Index identity mismatch detected at startup → full rebuild (embedding cache makes unchanged-provider rebuilds cheap; model changes are inherently full-cost — see hardware sizing). |
| Huge archives (tens of thousands of docs) | First index is the only expensive pass; it is resumable, runs newest-first, and reports progress via `index_status`. Per-sync cost afterwards is proportional to changed docs. `sync.concurrency: 1` keeps the 2-vCPU gateway responsive throughout. |
| Memory pressure on a 4 GB box | Local model is lazy-loaded and unloaded after `idleUnloadMinutes`; steady-state overhead without activity is just the SQLite file. |
| State dir lost (disk failure, migration) | Index rebuilds from paperless content via the normal sync path — newest-first, resumable, usable while it fills. Backup story: the single `semantic-index.sqlite` file (optionally via a phase-2 `VACUUM INTO` snapshot); see "Considered and rejected: storing vectors in paperless custom fields". |

## Testing

Same style as the existing suite (vitest, colocated):

- Fake `EmbeddingProvider` with deterministic vectors (e.g. hashed bag-of-words) → chunk /
  upsert / KNN / RRF / filter logic tested end-to-end against a real in-memory SQLite,
  no network, no model.
- Mocked paperless client (as in `documents.test.ts`) for sync: incremental checkpointing,
  `content_hash` short-circuit, deletion sweep, crash-resume.
- Tool contract tests: manifest lists the new tools (extending `manifest.test.ts`),
  params validate, error messages for disabled/empty/unavailable states.

## Rollout plan

**Phase 1 — core (one PR):** index store + on-demand sync (`paperless_semantic_index_sync`)
+ `paperless_semantic_search` (vector-only) + `paperless_semantic_index_status` + config +
README. Feature-flagged off by default.

**Phase 2 — quality & autonomy:** hybrid FTS5 + RRF, embedding cache, background service
with interval sync + deletion sweep, `storeChunkText: false` mode.

**Phase 3 — RAG polish:**
- Update the `paperless-search` skill: try `paperless_semantic_search` first for
  concept-shaped queries, fall back to lexical for exact identifiers; keep the existing
  "broaden, then drill in with grep/range" procedure.
- `paperless_similar_documents(id)` — "more like this" via the document's stored chunk
  vectors; useful for the ingest skill ("which existing docs is this like → inherit their
  correspondent/type/tags"), turning the index into an auto-filing assist, not just search.
- Optional query-time reranking of lexical results (option C) as a cheap booster where
  the index is disabled.

## Out of scope (explicitly)

- Embedding images/scans directly (multimodal embeddings): OCR text is the corpus; the
  provider contract already supports multimodal parts if this is ever wanted.
- Answer synthesis / summarization tools: the agent composes retrieval + existing range
  tools; this plugin stays a retrieval surface.
- Writing anything back to paperless-ngx from the semantic layer.
- A delete tool (unchanged from the plugin's existing stance).

## Resolved decisions

1. **Default embedding provider: `local`**, pinned to the host's default
   EmbeddingGemma-300m Q8_0 GGUF — CPU-only friendly, multilingual (matters for mixed
   German/English archives), no data egress. Sized for a 2 vCPU / 4 GB reference box; see
   the hardware-sizing section.
2. **Default vector dimensions: 256** (Matryoshka truncation) to keep index size and KNN
   scan cost proportionate to that hardware.

## Open questions

1. Should hybrid mode's keyword leg use local FTS5 (self-contained, works offline) or
   paperless's Whoosh search fused at query time (no text at rest, but couples query
   latency to paperless)? (Proposal: FTS5, with Whoosh fusion considered for
   `storeChunkText: false` mode.)
2. Interval sync vs. reacting to paperless's document-consumption webhooks (paperless
   supports outbound webhooks via workflows) — webhooks would need `registerHttpRoute`
   and reachable ingress; polling is the safe default.
