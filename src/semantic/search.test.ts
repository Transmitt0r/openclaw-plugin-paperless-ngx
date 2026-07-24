import { describe, expect, it, vi } from "vitest";
import { searchSemantic } from "./search.js";
import type { ChunkHit } from "./types.js";

function fakeStore(hits: ChunkHit[]) {
  return {
    knnSearch: vi.fn((_embedding: number[], _limit: number) => hits),
  };
}

function fakeEmbeddingProvider(opts?: { embedQuery?: (text: string) => Promise<number[]> }) {
  return {
    embedQuery: vi.fn(opts?.embedQuery ?? (async () => [1, 0, 0, 0])),
  };
}

describe("searchSemantic", () => {
  it("no-ops on an undefined search term without calling the embedding provider", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = fakeStore([]);
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      undefined,
      10,
    );
    expect(result).toEqual([]);
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
    expect(store.knnSearch).not.toHaveBeenCalled();
  });

  it("no-ops on an empty-string search term", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = fakeStore([]);
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "",
      10,
    );
    expect(result).toEqual([]);
    expect(embeddingProvider.embedQuery).not.toHaveBeenCalled();
  });

  it("dedupes chunk-level hits to the single best-scoring chunk per document", async () => {
    const hits: ChunkHit[] = [
      {
        chunkId: "1:1-5",
        documentId: 1,
        startLine: 1,
        endLine: 5,
        text: "weaker chunk",
        score: 0.5,
      },
      {
        chunkId: "1:6-10",
        documentId: 1,
        startLine: 6,
        endLine: 10,
        text: "stronger chunk",
        score: 0.9,
      },
      {
        chunkId: "2:1-5",
        documentId: 2,
        startLine: 1,
        endLine: 5,
        text: "doc 2 chunk",
        score: 0.7,
      },
    ];
    const store = fakeStore(hits);
    const embeddingProvider = fakeEmbeddingProvider();
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "term",
      10,
    );
    expect(result).toEqual([
      { documentId: 1, snippet: "stronger chunk", score: 0.9 },
      { documentId: 2, snippet: "doc 2 chunk", score: 0.7 },
    ]);
  });

  it("caps results at `limit`, best-scoring documents first", async () => {
    const hits: ChunkHit[] = Array.from({ length: 5 }, (_, i) => ({
      chunkId: `${i}:1-1`,
      documentId: i,
      startLine: 1,
      endLine: 1,
      text: `doc ${i}`,
      score: i / 10,
    }));
    const store = fakeStore(hits);
    const embeddingProvider = fakeEmbeddingProvider();
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "term",
      2,
    );
    expect(result).toHaveLength(2);
    expect(result[0]?.documentId).toBe(4);
    expect(result[1]?.documentId).toBe(3);
  });

  it("fails open (returns []) when the embedding provider throws", async () => {
    const embeddingProvider = fakeEmbeddingProvider({
      embedQuery: async () => {
        throw new Error("model not loaded");
      },
    });
    const store = fakeStore([]);
    const warn = vi.fn();
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
        logger: { warn },
      },
      "term",
      10,
    );
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("fails open (returns []) when the store's KNN scan throws", async () => {
    const embeddingProvider = fakeEmbeddingProvider();
    const store = {
      knnSearch: vi.fn(() => {
        throw new Error("sqlite busy");
      }),
    };
    const result = await searchSemantic(
      {
        store: store as never,
        embeddingProvider: embeddingProvider as never,
        queryTimeoutMs: 1000,
      },
      "term",
      10,
    );
    expect(result).toEqual([]);
  });

  it("fails open (returns []) when the query overruns queryTimeoutMs", async () => {
    const embeddingProvider = fakeEmbeddingProvider({
      embedQuery: () => new Promise((resolve) => setTimeout(() => resolve([1, 0, 0, 0]), 50)),
    });
    const store = fakeStore([]);
    const result = await searchSemantic(
      { store: store as never, embeddingProvider: embeddingProvider as never, queryTimeoutMs: 5 },
      "term",
      10,
    );
    expect(result).toEqual([]);
  });
});
