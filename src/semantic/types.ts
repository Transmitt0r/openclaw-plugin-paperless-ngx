// Shared types for the plugin-owned semantic search backend (see
// src/semantic/handle.ts for how these are wired together, and the seam
// comment atop src/tools/documents.ts for how this integrates with
// paperless_search_documents).

// The agent-facing contract paperless_search_documents merges into its
// lexical results. Intentionally the same shape the seam in
// src/tools/documents.ts already declared -- this module is what makes it
// real instead of a stub.
export type SemanticMatch = {
  documentId: number;
  snippet: string;
  score: number;
};

// One markdown-chunked span of a document's OCR content, with line numbers
// relative to the same CRLF/CR-normalized text paperless_read_document
// numbers against (see normalizeLineEndings in documents.ts). `id` is a
// stable per-chunk key (`${documentId}:${chunkIndex}`) used as the vec0
// table's primary key.
export type ChunkRecord = {
  id: string;
  documentId: number;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

// A chunk-level hit from the vector index, before doc-level dedup/fusion.
export type ChunkHit = {
  chunkId: string;
  documentId: number;
  startLine: number;
  endLine: number;
  text: string;
  // Cosine similarity in [-1, 1] (higher is better) -- already converted
  // from sqlite-vec's distance metric, never a raw distance, so callers
  // never have to remember which direction "better" points.
  score: number;
};

// Canonical fingerprint of "what produced this index". Compared against
// what's stored on disk on every startup; any mismatch means the stored
// vectors were produced by a different model/dimensionality/chunking
// scheme and can't be mixed with new ones, so the index is wiped and
// rebuilt from scratch instead.
export type IndexIdentity = {
  providerId: string;
  model: string;
  dimensions: number;
  chunkTokens: number;
  chunkOverlap: number;
};

export function identitiesMatch(a: IndexIdentity, b: IndexIdentity): boolean {
  return (
    a.providerId === b.providerId &&
    a.model === b.model &&
    a.dimensions === b.dimensions &&
    a.chunkTokens === b.chunkTokens &&
    a.chunkOverlap === b.chunkOverlap
  );
}

// Tuned for the reference deployment (2 vCPU / 4GB RAM, no GPU, 600-6000
// documents) called out in the design brief, not for the 100k-document
// envelope the architecture merely has to not fall over under.
export type SemanticSearchConfig = {
  enabled: boolean;
  providerId: string;
  model: string;
  dimensions: number;
  chunkTokens: number;
  chunkOverlap: number;
  indexPath: string;
  // How long the embedding model is allowed to sit warm in memory (~400-500MB
  // RSS for EmbeddingGemma-300m) after its last use before being unloaded.
  idleUnloadMs: number;
  // How often a background incremental sync pass runs.
  syncIntervalMs: number;
  // Upper bound on documents processed in a single sync pass, so one pass
  // can't monopolize a 2 vCPU box indefinitely -- the checkpoint watermark
  // makes it safe to pick up the rest on the next pass.
  maxDocumentsPerSync: number;
  // Bounds concurrent embedBatch calls during sync (runWithConcurrency).
  embedConcurrency: number;
  // Fail-open budget for a single query-time embed + KNN scan.
  queryTimeoutMs: number;
};

export const DEFAULT_SEMANTIC_SEARCH_CONFIG: Omit<SemanticSearchConfig, "indexPath"> = {
  enabled: true,
  providerId: "local",
  // Matches openclaw's own DEFAULT_LOCAL_MODEL (EmbeddingGemma-300m, GGUF,
  // CPU-only) -- kept as a literal default here (rather than importing the
  // constant at module load) so this module never has a hard load-time
  // dependency on the embedding-provider host module; embedding-provider.ts
  // reconciles the two at resolve time.
  model: "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf",
  dimensions: 256,
  chunkTokens: 400,
  chunkOverlap: 80,
  idleUnloadMs: 5 * 60_000,
  syncIntervalMs: 15 * 60_000,
  maxDocumentsPerSync: 200,
  embedConcurrency: 2,
  queryTimeoutMs: 3_000,
};
