import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient } from "../client.js";
import { SemanticIndexStore } from "./store.js";
import { runIncrementalSync } from "./sync.js";
import type { IndexIdentity } from "./types.js";

const BASE_URL = "https://paperless.example.com";

type Route = {
  test: (pathname: string, method: string) => boolean;
  handle: (request: Request) => unknown;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(routes: Route[]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const route = routes.find((r) => r.test(url.pathname, request.method));
    if (!route) {
      throw new Error(`Unhandled request in test: ${request.method} ${url.pathname}`);
    }
    return jsonResponse(route.handle(request));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setup(routes: Route[]) {
  const fetchMock = stubFetch(routes);
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return { client, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function memoryStore(identity: IndexIdentity) {
  const opened = await SemanticIndexStore.open(":memory:", identity.dimensions);
  if (!opened.available) throw new Error(`test setup failed: ${opened.reason}`);
  opened.store.rebuild(identity);
  return opened.store;
}

const IDENTITY: IndexIdentity = {
  providerId: "local",
  model: "test-model",
  dimensions: 4,
  chunkTokens: 400,
  chunkOverlap: 80,
};

function fakeEmbeddingProvider(opts?: { embedBatch?: (texts: string[]) => Promise<number[][]> }) {
  return {
    embedBatch: vi.fn(
      opts?.embedBatch ?? (async (texts: string[]) => texts.map(() => [1, 0, 0, 0])),
    ),
  };
}

const baseConfig = {
  chunkTokens: 400,
  chunkOverlap: 80,
  maxDocumentsPerSync: 200,
  embedConcurrency: 2,
};

const documentsListRoute = (
  docs: { id: number; modified: string; content: string }[],
  hasNext = false,
): Route => ({
  test: (pathname, method) => method === "GET" && pathname === "/api/documents/",
  handle: () => ({
    count: docs.length,
    next: hasNext ? `${BASE_URL}/api/documents/?page=2` : null,
    results: docs,
  }),
});

// Unlike documentsListRoute, actually honors page_size -- needed for tests
// that assert on how many documents a single (possibly maxDocumentsPerSync-
// capped) request fetches, which a fixture that always returns everything
// regardless of page_size can't exercise faithfully.
const paginatedDocumentsListRoute = (
  docs: { id: number; modified: string; content: string }[],
): Route => ({
  test: (pathname, method) => method === "GET" && pathname === "/api/documents/",
  handle: (request) => {
    const url = new URL(request.url);
    const pageSize = Number(url.searchParams.get("page_size") ?? docs.length);
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * pageSize;
    const slice = docs.slice(start, start + pageSize);
    const hasNext = start + pageSize < docs.length;
    return {
      count: docs.length,
      next: hasNext ? `${BASE_URL}/api/documents/?page=${page + 1}` : null,
      results: slice,
    };
  },
});

describe("runIncrementalSync", () => {
  it("embeds and stores every document on a first (full backfill) pass", async () => {
    const { client } = setup([
      documentsListRoute([
        { id: 1, modified: "2024-01-02T00:00:00Z", content: "first document body" },
        { id: 2, modified: "2024-01-01T00:00:00Z", content: "second document body" },
      ]),
    ]);
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    expect(summary.processed).toBe(2);
    expect(summary.skippedUnchanged).toBe(0);
    expect(summary.failed).toBe(0);
    expect(store.documentCount()).toBe(2);
    store.close();
  });

  it("sends modified__gt from the stored watermark on a subsequent pass", async () => {
    const store = await memoryStore(IDENTITY);
    store.setSyncState("2024-01-01T00:00:00Z", 1);
    const { client, fetchMock } = setup([documentsListRoute([])]);
    const embeddingProvider = fakeEmbeddingProvider();

    await runIncrementalSync({
      client,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    const request = fetchMock.mock.calls[0]?.[0];
    if (!request) throw new Error("test setup: no request captured");
    const requestUrl = new URL((request as Request).url);
    expect(requestUrl.searchParams.get("modified__gt")).toBe("2024-01-01T00:00:00Z");
    expect(requestUrl.searchParams.get("ordering")).toBe("-modified");
    store.close();
  });

  it("short-circuits re-embedding when the content hash is unchanged (tag-only edit)", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();
    const { client: client1 } = setup([
      documentsListRoute([{ id: 1, modified: "2024-01-01T00:00:00Z", content: "same body" }]),
    ]);
    await runIncrementalSync({
      client: client1,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });
    expect(embeddingProvider.embedBatch).toHaveBeenCalledTimes(1);

    // Reset the watermark so the "modified" doc is refetched, simulating a
    // tag edit that bumped `modified` without touching OCR content.
    store.setSyncState(undefined, undefined);
    const { client: client2 } = setup([
      documentsListRoute([{ id: 1, modified: "2024-02-01T00:00:00Z", content: "same body" }]),
    ]);
    const summary = await runIncrementalSync({
      client: client2,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    expect(summary.skippedUnchanged).toBe(1);
    expect(summary.processed).toBe(0);
    // Still only the one embedBatch call from the first pass -- the second
    // pass's unchanged-hash document never reached the embedding provider.
    expect(embeddingProvider.embedBatch).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("re-embeds when the content hash changed even though modified also changed", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();
    const { client: client1 } = setup([
      documentsListRoute([{ id: 1, modified: "2024-01-01T00:00:00Z", content: "original body" }]),
    ]);
    await runIncrementalSync({
      client: client1,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    store.setSyncState(undefined, undefined);
    const { client: client2 } = setup([
      documentsListRoute([{ id: 1, modified: "2024-02-01T00:00:00Z", content: "edited body" }]),
    ]);
    const summary = await runIncrementalSync({
      client: client2,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    expect(summary.processed).toBe(1);
    expect(summary.skippedUnchanged).toBe(0);
    expect(embeddingProvider.embedBatch).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("continues past a single document's embedding failure and counts it as failed", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider({
      embedBatch: async (texts) => {
        if (texts.some((t) => t.includes("poison"))) {
          throw new Error("embedding provider exploded");
        }
        return texts.map(() => [1, 0, 0, 0]);
      },
    });
    const { client } = setup([
      documentsListRoute([
        { id: 1, modified: "2024-01-02T00:00:00Z", content: "poison document" },
        { id: 2, modified: "2024-01-01T00:00:00Z", content: "healthy document" },
      ]),
    ]);

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    expect(summary.failed).toBe(1);
    expect(summary.processed).toBe(1);
    expect(store.getDocumentContentHash(2)).toBeDefined();
    expect(store.getDocumentContentHash(1)).toBeUndefined();
    store.close();
  });

  it("stops once maxDocumentsPerSync is reached and reachedEnd stays false", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();
    const docs = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      modified: `2024-01-${String(10 - i).padStart(2, "0")}T00:00:00Z`,
      content: `document ${i + 1}`,
    }));
    const { client } = setup([paginatedDocumentsListRoute(docs)]);

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider: embeddingProvider as never,
      config: { ...baseConfig, maxDocumentsPerSync: 3 },
    });

    expect(summary.processed + summary.skippedUnchanged + summary.failed).toBeLessThanOrEqual(3);
    expect(summary.reachedEnd).toBe(false);
    store.close();
  });

  it("advances the watermark to the oldest document's modified timestamp in the page", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();
    const { client } = setup([
      documentsListRoute([
        { id: 2, modified: "2024-03-01T00:00:00Z", content: "newer" },
        { id: 1, modified: "2024-01-01T00:00:00Z", content: "older" },
      ]),
    ]);

    await runIncrementalSync({
      client,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    expect(store.getSyncState().watermark).toBe("2024-01-01T00:00:00Z");
    store.close();
  });

  it("reports reachedEnd: true when the corpus is exhausted before the cap", async () => {
    const store = await memoryStore(IDENTITY);
    const embeddingProvider = fakeEmbeddingProvider();
    const { client } = setup([
      documentsListRoute([{ id: 1, modified: "2024-01-01T00:00:00Z", content: "only doc" }], false),
    ]);

    const summary = await runIncrementalSync({
      client,
      store,
      embeddingProvider: embeddingProvider as never,
      config: baseConfig,
    });

    expect(summary.reachedEnd).toBe(true);
    store.close();
  });
});
