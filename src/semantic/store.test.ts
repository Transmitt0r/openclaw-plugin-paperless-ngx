import { describe, expect, it } from "vitest";
import { SemanticIndexStore } from "./store.js";
import type { IndexIdentity } from "./types.js";

// Real node:sqlite + real sqlite-vec extension, in-memory -- no fake/mock
// here, since the whole point of this module is the SQL/vec0 query
// actually being correct. Only the embeddings themselves are synthetic.
async function openMemoryStore(dimensions = 4) {
  const opened = await SemanticIndexStore.open(":memory:", dimensions);
  if (!opened.available) {
    throw new Error(`test setup: sqlite-vec unavailable in this environment: ${opened.reason}`);
  }
  return opened.store;
}

const IDENTITY: IndexIdentity = {
  providerId: "local",
  model: "test-model",
  dimensions: 4,
  chunkTokens: 400,
  chunkOverlap: 80,
};

describe("SemanticIndexStore", () => {
  it("opens an in-memory store and reports no identity before first use", async () => {
    const store = await openMemoryStore();
    expect(store.getIdentity()).toBeUndefined();
    store.close();
  });

  it("rebuild() records the identity so a later open can detect drift", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    expect(store.getIdentity()).toEqual(IDENTITY);
    store.close();
  });

  it("upsertDocument stores chunks and their content hash, retrievable by document id", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertDocument(1, "hash-a", "2024-01-01T00:00:00Z", [
      {
        id: "1:1-5",
        startLine: 1,
        endLine: 5,
        text: "hello world",
        hash: "chunk-hash",
        embedding: [1, 0, 0, 0],
      },
    ]);
    expect(store.getDocumentContentHash(1)).toBe("hash-a");
    expect(store.documentCount()).toBe(1);
    store.close();
  });

  it("upsertDocument replaces previous chunks/vectors for the same document", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertDocument(1, "hash-a", "2024-01-01T00:00:00Z", [
      {
        id: "1:1-5",
        startLine: 1,
        endLine: 5,
        text: "old chunk",
        hash: "h1",
        embedding: [1, 0, 0, 0],
      },
    ]);
    store.upsertDocument(1, "hash-b", "2024-01-02T00:00:00Z", [
      {
        id: "1:1-3",
        startLine: 1,
        endLine: 3,
        text: "new chunk",
        hash: "h2",
        embedding: [0, 1, 0, 0],
      },
    ]);
    expect(store.getDocumentContentHash(1)).toBe("hash-b");
    const hits = store.knnSearch([0, 1, 0, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toBe("new chunk");
    store.close();
  });

  it("deleteDocument removes both chunk rows and their vectors", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertDocument(1, "hash-a", "2024-01-01T00:00:00Z", [
      { id: "1:1-5", startLine: 1, endLine: 5, text: "text", hash: "h1", embedding: [1, 0, 0, 0] },
    ]);
    store.deleteDocument(1);
    expect(store.getDocumentContentHash(1)).toBeUndefined();
    expect(store.documentCount()).toBe(0);
    expect(store.knnSearch([1, 0, 0, 0], 10)).toHaveLength(0);
    store.close();
  });

  it("rebuild() wipes all existing documents/chunks/vectors and the sync watermark", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertDocument(1, "hash-a", "2024-01-01T00:00:00Z", [
      { id: "1:1-5", startLine: 1, endLine: 5, text: "text", hash: "h1", embedding: [1, 0, 0, 0] },
    ]);
    store.setSyncState("2024-06-01T00:00:00Z", 1);

    store.rebuild({ ...IDENTITY, model: "different-model" });

    expect(store.documentCount()).toBe(0);
    expect(store.getSyncState()).toEqual({});
    expect(store.getIdentity()?.model).toBe("different-model");
    store.close();
  });

  it("knnSearch ranks chunks by cosine similarity, best first", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    store.upsertDocument(1, "hash-a", "2024-01-01T00:00:00Z", [
      {
        id: "1:1-1",
        startLine: 1,
        endLine: 1,
        text: "identical",
        hash: "h1",
        embedding: [1, 0, 0, 0],
      },
    ]);
    store.upsertDocument(2, "hash-b", "2024-01-01T00:00:00Z", [
      {
        id: "2:1-1",
        startLine: 1,
        endLine: 1,
        text: "close",
        hash: "h2",
        embedding: [0.9, 0.1, 0, 0],
      },
    ]);
    store.upsertDocument(3, "hash-c", "2024-01-01T00:00:00Z", [
      {
        id: "3:1-1",
        startLine: 1,
        endLine: 1,
        text: "orthogonal",
        hash: "h3",
        embedding: [0, 1, 0, 0],
      },
    ]);

    const hits = store.knnSearch([1, 0, 0, 0], 10);
    expect(hits.map((h) => h.documentId)).toEqual([1, 2, 3]);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
    expect(hits[2]?.score).toBeCloseTo(0, 5);
    // Scores strictly decrease down the ranked list.
    const scores = hits.map((h) => h.score);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? Number.NaN);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? Number.NaN);
    store.close();
  });

  it("knnSearch respects the limit", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    for (let i = 1; i <= 5; i++) {
      store.upsertDocument(i, `hash-${i}`, "2024-01-01T00:00:00Z", [
        {
          id: `${i}:1-1`,
          startLine: 1,
          endLine: 1,
          text: `doc ${i}`,
          hash: `h${i}`,
          embedding: [i, 0, 0, 0],
        },
      ]);
    }
    const hits = store.knnSearch([1, 0, 0, 0], 2);
    expect(hits).toHaveLength(2);
    store.close();
  });

  it("sync state round-trips watermark and checkpoint document id", async () => {
    const store = await openMemoryStore();
    store.rebuild(IDENTITY);
    expect(store.getSyncState()).toEqual({});
    store.setSyncState("2024-05-01T12:00:00Z", 42);
    expect(store.getSyncState()).toEqual({
      watermark: "2024-05-01T12:00:00Z",
      checkpointDocumentId: 42,
    });
    store.close();
  });

  it("rejects a non-positive-integer dimensions value", async () => {
    const opened = await SemanticIndexStore.open(":memory:", 0);
    expect(opened.available).toBe(false);
  });
});
