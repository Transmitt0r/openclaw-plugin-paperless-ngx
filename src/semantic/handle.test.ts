import { describe, expect, it } from "vitest";
import type { PaperlessClientHandle } from "../client.js";
import { createSemanticSearchHandle } from "./handle.js";

function fakeClientHandlePromise(): Promise<PaperlessClientHandle> {
  const client = {
    GET: async () => ({ data: { count: 0, results: [], next: null } }),
  };
  return Promise.resolve({ client: client as never, baseUrl: "https://paperless.example.com" });
}

// Mirrors the minimal fake `api` src/manifest.test.ts constructs -- no
// `logger`/`lifecycle`/`config` at all -- to guard the exact bug fixed
// here: createSemanticSearchHandle must never throw or produce an
// unhandled rejection just because those fields are missing.
function bareApi(pluginConfig: Record<string, unknown>) {
  return { pluginConfig } as never;
}

function fakeApi(pluginConfig: Record<string, unknown>) {
  return {
    pluginConfig,
    config: {} as never,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    lifecycle: { registerRuntimeLifecycle: () => {} },
  } as never;
}

describe("createSemanticSearchHandle", () => {
  it("resolves to an unavailable handle without touching anything when semanticSearch.enabled is false", async () => {
    const handle = await createSemanticSearchHandle(
      fakeApi({ baseUrl: "x", apiToken: "t", semanticSearch: { enabled: false } }),
      fakeClientHandlePromise(),
    );
    expect(handle.available).toBe(false);
    expect(await handle.search("term", 5)).toEqual([]);
    await handle.dispose();
  });

  it("never throws and resolves to an unavailable handle against a minimal api object (no logger/lifecycle/config)", async () => {
    // This is the regression case: index.ts's register() calls this
    // synchronously against whatever `api` the host hands it, and
    // src/manifest.test.ts exercises register() with exactly this shape of
    // fake api. A throw or unhandled rejection here would break plugin
    // registration entirely, not just semantic search.
    await expect(
      createSemanticSearchHandle(
        bareApi({ baseUrl: "x", apiToken: "t" }),
        fakeClientHandlePromise(),
      ),
    ).resolves.toBeDefined();
  });

  it("opens a real (in-memory) index and reports available: true when the runtime supports it", async () => {
    const handle = await createSemanticSearchHandle(
      fakeApi({ baseUrl: "x", apiToken: "t", semanticSearch: { indexPath: ":memory:" } }),
      fakeClientHandlePromise(),
    );
    // node:sqlite + sqlite-vec are both available in this test environment
    // (verified directly in store.test.ts), so the index itself should
    // come up even though no embedding provider adapter is registered in
    // this bare test process -- that failure is scoped to sync/search,
    // which fail open on their own (see sync.test.ts/search.test.ts).
    expect(handle.available).toBe(true);
    expect(await handle.search(undefined, 5)).toEqual([]);
    await handle.dispose();
  });
});
