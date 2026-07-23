import type { EmbeddingProviderHandle } from "./embedding-provider.js";
import type { SemanticIndexStore } from "./store.js";
import type { SemanticMatch } from "./types.js";

export type SearchDeps = {
  store: SemanticIndexStore;
  embeddingProvider: EmbeddingProviderHandle;
  queryTimeoutMs: number;
  logger?: { warn: (message: string) => void };
};

// Oversample chunk-level KNN hits before deduping to one row per document,
// so a document doesn't get dropped just because its single best-matching
// chunk didn't make it into a `limit`-sized raw scan.
const CANDIDATE_OVERSAMPLE = 4;

// The real fetchSemanticMatches implementation: embeds `searchTerm`
// (query-time embedding -- documents were embedded ahead of time, at sync
// time), does a chunk-level KNN scan, and collapses it to the single
// best-scoring chunk per document. Never throws -- any embedding-provider
// or SQLite error, or a call that overruns `queryTimeoutMs`, resolves to
// `[]` so paperless_search_documents always still returns its lexical
// results untouched (fail open).
export async function searchSemantic(
  deps: SearchDeps,
  searchTerm: string | undefined,
  limit: number,
): Promise<SemanticMatch[]> {
  // No-op on empty term: filter-only browsing has nothing to embed, and
  // embedding an empty/undefined string would just be wasted work (or a
  // provider error) for a query that structurally can't match semantically.
  if (!searchTerm) return [];

  try {
    return await withTimeout(runQuery(deps, searchTerm, limit), deps.queryTimeoutMs);
  } catch (err) {
    deps.logger?.warn(
      `semantic search: query failed, falling back to lexical-only results: ${describeError(err)}`,
    );
    return [];
  }
}

async function runQuery(
  deps: SearchDeps,
  searchTerm: string,
  limit: number,
): Promise<SemanticMatch[]> {
  const queryEmbedding = await deps.embeddingProvider.embedQuery(searchTerm);
  const hits = deps.store.knnSearch(queryEmbedding, Math.max(limit, 1) * CANDIDATE_OVERSAMPLE);

  const bestPerDocument = new Map<number, { snippet: string; score: number }>();
  for (const hit of hits) {
    const existing = bestPerDocument.get(hit.documentId);
    if (!existing || hit.score > existing.score) {
      bestPerDocument.set(hit.documentId, { snippet: hit.text, score: hit.score });
    }
  }

  return [...bestPerDocument.entries()]
    .map(([documentId, { snippet, score }]) => ({ documentId, snippet, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`semantic query timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
