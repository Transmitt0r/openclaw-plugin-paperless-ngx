import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient } from "../client.js";
import { createListTagsTool } from "./taxonomy.js";

const BASE_URL = "https://paperless.example.com";

function stubFetch(handle: (request: Request) => unknown) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    return new Response(JSON.stringify(handle(request)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paperless_list_tags page_size", () => {
  it("clamps page_size at 100, matching the document list tools' cap", async () => {
    const fetchMock = stubFetch(() => ({ count: 0, results: [] }));
    const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
    const tool = createListTagsTool(Promise.resolve({ client, baseUrl: BASE_URL }));
    await tool.execute("call-1", { page_size: 5000 });
    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("page_size")).toBe("100");
  });

  it("passes through a page_size within the cap unchanged", async () => {
    const fetchMock = stubFetch(() => ({ count: 0, results: [] }));
    const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
    const tool = createListTagsTool(Promise.resolve({ client, baseUrl: BASE_URL }));
    await tool.execute("call-1", { page_size: 25 });
    const request = fetchMock.mock.calls.at(-1)?.[0] as Request;
    const url = new URL(request.url);
    expect(url.searchParams.get("page_size")).toBe("25");
  });
});
