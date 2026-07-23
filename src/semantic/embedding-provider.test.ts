import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingProviderHandle } from "./embedding-provider.js";

// Deterministic fake adapter/provider -- no real model loading. Tracks
// create()/close() calls so tests can assert lazy-load and idle-unload
// behavior without a real embedding backend.
function fakeAdapter() {
  let createCalls = 0;
  let closeCalls = 0;
  const provider = {
    id: "local",
    model: "test-model",
    embedQuery: vi.fn(async (text: string) => [text.length, 0, 0, 0]),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((t) => [t.length, 0, 0, 0])),
    close: vi.fn(async () => {
      closeCalls += 1;
    }),
  };
  const adapter = {
    id: "local",
    create: vi.fn(async () => {
      createCalls += 1;
      return { provider };
    }),
  };
  return {
    adapter,
    provider,
    getCreateCalls: () => createCalls,
    getCloseCalls: () => closeCalls,
  };
}

function makeHandle(
  resolveAdapter: ReturnType<typeof fakeAdapter>["adapter"] | undefined,
  idleUnloadMs = 60_000,
) {
  return new EmbeddingProviderHandle({
    config: {} as never,
    providerId: "local",
    model: "test-model",
    dimensions: 4,
    idleUnloadMs,
    resolveAdapter: () => resolveAdapter,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EmbeddingProviderHandle", () => {
  it("does not create the provider until first use (lazy load)", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter);
    expect(fake.getCreateCalls()).toBe(0);
    await handle.embedQuery("hello");
    expect(fake.getCreateCalls()).toBe(1);
  });

  it("reuses the same provider instance across calls instead of recreating it", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter);
    await handle.embedQuery("a");
    await handle.embedQuery("b");
    await handle.embedBatch(["c", "d"]);
    expect(fake.getCreateCalls()).toBe(1);
  });

  it("de-dupes concurrent first-use calls into a single create()", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter);
    await Promise.all([handle.embedQuery("a"), handle.embedQuery("b"), handle.embedQuery("c")]);
    expect(fake.getCreateCalls()).toBe(1);
  });

  it("unloads (calls provider.close()) after the idle period elapses", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter, 5_000);
    await handle.embedQuery("hello");
    expect(fake.getCloseCalls()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_001);
    expect(fake.getCloseCalls()).toBe(1);
  });

  it("resets the idle timer on every call, so activity keeps the model warm", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter, 5_000);
    await handle.embedQuery("hello");
    await vi.advanceTimersByTimeAsync(3_000);
    await handle.embedQuery("still active"); // resets the 5s timer
    await vi.advanceTimersByTimeAsync(3_000);
    expect(fake.getCloseCalls()).toBe(0); // only 3s since the reset

    await vi.advanceTimersByTimeAsync(2_001);
    expect(fake.getCloseCalls()).toBe(1);
  });

  it("re-creates the provider on next use after an idle unload", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter, 5_000);
    await handle.embedQuery("hello");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fake.getCloseCalls()).toBe(1);

    await handle.embedQuery("again");
    expect(fake.getCreateCalls()).toBe(2);
  });

  it("dispose() unloads immediately regardless of the idle timer", async () => {
    const fake = fakeAdapter();
    const handle = makeHandle(fake.adapter, 60_000);
    await handle.embedQuery("hello");
    await handle.dispose();
    expect(fake.getCloseCalls()).toBe(1);
  });

  it("throws a clear error when no adapter is registered for the configured provider id", async () => {
    const handle = makeHandle(undefined);
    await expect(handle.embedQuery("hello")).rejects.toThrow(
      /no embedding provider adapter registered/,
    );
  });
});
