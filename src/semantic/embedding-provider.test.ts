import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingProviderHandle } from "./embedding-provider.js";

// Deterministic fake node-llama-cpp module -- no real model loading or
// downloading. Tracks call counts on getLlama/resolveModelFile/loadModel/
// createEmbeddingContext/dispose so tests can assert lazy-load, reuse, and
// idle-unload behavior without a real llama.cpp backend.
function fakeNodeLlamaCpp(options?: { vectorFor?: (text: string) => number[] }) {
  const calls = {
    getLlama: 0,
    resolveModelFile: 0,
    loadModel: 0,
    createEmbeddingContext: 0,
    contextDispose: 0,
    modelDispose: 0,
  };

  const context = {
    getEmbeddingFor: vi.fn(async (text: string) => ({
      vector: options?.vectorFor?.(text) ?? [text.length, 0, 0, 0],
    })),
    dispose: vi.fn(async () => {
      calls.contextDispose += 1;
    }),
  };

  const model = {
    createEmbeddingContext: vi.fn(async () => {
      calls.createEmbeddingContext += 1;
      return context;
    }),
    dispose: vi.fn(async () => {
      calls.modelDispose += 1;
    }),
  };

  const llama = {
    loadModel: vi.fn(async () => {
      calls.loadModel += 1;
      return model;
    }),
  };

  const loadModule = vi.fn(async () => ({
    getLlama: vi.fn(async () => {
      calls.getLlama += 1;
      return llama;
    }),
    resolveModelFile: vi.fn(async (_uri: string) => {
      calls.resolveModelFile += 1;
      return "/fake/cache/model.gguf";
    }),
  }));

  return { loadModule, calls, context, model, llama };
}

function makeHandle(
  loadModule: ReturnType<typeof fakeNodeLlamaCpp>["loadModule"],
  overrides?: Partial<{ dimensions: number; idleUnloadMs: number }>,
) {
  return new EmbeddingProviderHandle({
    model: "hf:fake/model.gguf",
    dimensions: overrides?.dimensions ?? 4,
    idleUnloadMs: overrides?.idleUnloadMs ?? 60_000,
    loadModule: loadModule as never,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddingProviderHandle", () => {
  it("does not load node-llama-cpp until first use (lazy load)", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule);
    expect(fake.loadModule).not.toHaveBeenCalled();
    await handle.embedQuery("hello");
    expect(fake.loadModule).toHaveBeenCalledTimes(1);
    expect(fake.calls.loadModel).toBe(1);
    expect(fake.calls.createEmbeddingContext).toBe(1);
  });

  it("reuses the same model/context across calls instead of reloading", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule);
    await handle.embedQuery("a");
    await handle.embedQuery("b");
    await handle.embedBatch(["c", "d"]);
    expect(fake.calls.loadModel).toBe(1);
    expect(fake.calls.createEmbeddingContext).toBe(1);
    expect(fake.context.getEmbeddingFor).toHaveBeenCalledTimes(4);
  });

  it("de-dupes concurrent first-use calls into a single model load", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule);
    await Promise.all([handle.embedQuery("a"), handle.embedQuery("b"), handle.embedQuery("c")]);
    expect(fake.calls.loadModel).toBe(1);
  });

  it("truncates to `dimensions` and L2-renormalizes (Matryoshka truncation)", async () => {
    const fake = fakeNodeLlamaCpp({ vectorFor: () => [3, 4, 0, 0, 99, 99] }); // native width 6
    const handle = makeHandle(fake.loadModule, { dimensions: 2 });
    const result = await handle.embedQuery("hello");
    // Truncated to the first 2 values [3, 4], then L2-renormalized: norm=5.
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
    // Renormalized vector is a unit vector.
    const norm = Math.sqrt(result.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("returns an all-zero truncation as-is rather than dividing by zero", async () => {
    const fake = fakeNodeLlamaCpp({ vectorFor: () => [0, 0, 0, 0] });
    const handle = makeHandle(fake.loadModule, { dimensions: 4 });
    const result = await handle.embedQuery("hello");
    expect(result).toEqual([0, 0, 0, 0]);
  });

  it("unloads (disposes context + model) after the idle period elapses", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule, { idleUnloadMs: 5_000 });
    await handle.embedQuery("hello");
    expect(fake.calls.contextDispose).toBe(0);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(fake.calls.contextDispose).toBe(1);
    expect(fake.calls.modelDispose).toBe(1);
  });

  it("resets the idle timer on every call, so activity keeps the model warm", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule, { idleUnloadMs: 5_000 });
    await handle.embedQuery("hello");
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.embedQuery("still active"); // resets the 5s timer
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.calls.contextDispose).toBe(0); // only 3s since the reset

    await vi.advanceTimersByTimeAsync(2_001);
    expect(fake.calls.contextDispose).toBe(1);
  });

  it("re-loads the model (but not the Llama backend) on next use after an idle unload", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule, { idleUnloadMs: 5_000 });
    await handle.embedQuery("hello");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fake.calls.loadModel).toBe(1);

    await handle.embedQuery("again");
    // Model reloaded (weights were freed on unload)...
    expect(fake.calls.loadModel).toBe(2);
    // ...but the native Llama backend itself was reused, not reinitialized.
    expect(fake.calls.getLlama).toBe(1);
  });

  it("dispose() unloads immediately regardless of the idle timer", async () => {
    const fake = fakeNodeLlamaCpp();
    const handle = makeHandle(fake.loadModule, { idleUnloadMs: 60_000 });
    await handle.embedQuery("hello");
    await handle.dispose();
    expect(fake.calls.contextDispose).toBe(1);
    expect(fake.calls.modelDispose).toBe(1);
  });

  it("propagates a model resolution failure rather than swallowing it", async () => {
    const loadModule = vi.fn(async () => ({
      getLlama: vi.fn(async () => ({ loadModel: vi.fn() })),
      resolveModelFile: vi.fn(async () => {
        throw new Error("model download failed");
      }),
    }));
    const handle = makeHandle(loadModule as never);
    await expect(handle.embedQuery("hello")).rejects.toThrow(/model download failed/);
  });
});
