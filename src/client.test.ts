import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient, unwrap } from "./client.js";

describe("unwrap", () => {
  it("returns data on success", () => {
    expect(unwrap({ data: { id: 1 } })).toEqual({ id: 1 });
  });

  it("throws on error", () => {
    expect(() => unwrap({ error: { detail: "not found" } })).toThrow(/not found/);
  });

  it("throws when data is missing", () => {
    expect(() => unwrap({})).toThrow(/no data/);
  });
});

describe("createPaperlessClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token as an Authorization header and strips trailing slashes from baseUrl", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ count: 0, results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createPaperlessClient({
      baseUrl: "https://paperless.example.com/",
      apiToken: "test-token",
    });
    await client.GET("/api/documents/", { params: { query: {} } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://paperless.example.com/api/documents/");
    expect(request.headers.get("authorization")).toBe("Token test-token");
  });
});
