import { afterEach, describe, expect, it, vi } from "vitest";
import { createPaperlessClient } from "../client.js";
import {
  createGetDocumentRangeTool,
  createGetDocumentTool,
  createGrepDocumentTool,
  createListDocumentsTool,
} from "./documents.js";

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
  stubFetch(routes);
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return Promise.resolve({ client, baseUrl: BASE_URL });
}

const documentsListRoute = (docs: Record<string, unknown>[]): Route => ({
  test: (pathname, method) => method === "GET" && pathname === "/api/documents/",
  handle: () => ({ count: docs.length, results: docs }),
});

const documentGetRoute = (docsById: Record<number, Record<string, unknown>>): Route => ({
  test: (pathname, method) => method === "GET" && /^\/api\/documents\/\d+\/$/.test(pathname),
  handle: (request) => {
    const id = Number(new URL(request.url).pathname.split("/")[3]);
    const doc = docsById[id];
    if (!doc) throw new Error(`test: no fixture for document id ${id}`);
    return doc;
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const FILLER_A = "A".repeat(300);
const FILLER_B = "B".repeat(300);
const MARKER = "INVOICE-2024-0042";
const SAMPLE_CONTENT = `${FILLER_A} ${MARKER} ${FILLER_B}`;

describe("paperless_list_documents content policy", () => {
  it("omits content by default when no search/query is given", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", {});
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    expect(doc.content).toBeUndefined();
    expect(doc.content_snippet).toBeUndefined();
    expect(doc.title).toBe("Doc 1");
  });

  it("includes full content when include_content is true", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", { include_content: true });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    expect(doc.content).toBe(SAMPLE_CONTENT);
    expect(doc.content_snippet).toBeUndefined();
  });

  it("adds a content_snippet around the search term when content is omitted", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", { search: MARKER });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    expect(doc.content).toBeUndefined();
    expect(typeof doc.content_snippet).toBe("string");
    expect(doc.content_snippet as string).toContain(MARKER);
    expect((doc.content_snippet as string).length).toBeLessThan(SAMPLE_CONTENT.length);
  });

  it("strips whoosh query syntax down to bare words when building a snippet from `query`", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", { query: `content:"${MARKER}" AND type:Invoice` });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    expect(doc.content_snippet as string).toContain(MARKER);
  });

  it("falls back to a leading excerpt when the search term isn't found in content", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", { search: "totally-absent-term" });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    expect(doc.content).toBeUndefined();
    const snippet = doc.content_snippet as string;
    expect(snippet.startsWith(FILLER_A.slice(0, 20))).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("paperless_get_document content policy", () => {
  it("omits content by default", async () => {
    const handle = setup([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBeUndefined();
    expect(doc.content_snippet).toBeUndefined();
  });

  it("includes content when include_content is true", async () => {
    const handle = setup([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, include_content: true });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBe(SAMPLE_CONTENT);
  });
});

const GREP_CONTENT = [
  "Policy Number: ABC-123",
  "Effective Date: 2024-01-01",
  "Premium: $500.00",
  "Coverage: Comprehensive",
  "Policy Number: XYZ-999",
  "End of document",
].join("\n");

describe("paperless_grep_document", () => {
  it("returns matching lines with surrounding context", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "Policy Number" });
    const details = result.details as {
      total_lines: number;
      total_matches: number;
      truncated: boolean;
      matches: { line_number: number; line: string; context: string }[];
    };
    expect(details.total_lines).toBe(6);
    expect(details.total_matches).toBe(2);
    expect(details.truncated).toBe(false);
    expect(details.matches).toHaveLength(2);
    expect(details.matches[0]?.line_number).toBe(1);
    expect(details.matches[0]?.line).toBe("Policy Number: ABC-123");
    // context_lines defaults to 2, clipped at the top of the document
    expect(details.matches[0]?.context).toBe(
      ["Policy Number: ABC-123", "Effective Date: 2024-01-01", "Premium: $500.00"].join("\n"),
    );
    expect(details.matches[1]?.line_number).toBe(5);
  });

  it("caps returned matches at max_matches and reports truncated", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", {
      id: 1,
      pattern: "Policy Number",
      max_matches: 1,
    });
    const details = result.details as {
      total_matches: number;
      matches: unknown[];
      truncated: boolean;
    };
    expect(details.matches).toHaveLength(1);
    expect(details.total_matches).toBe(2);
    expect(details.truncated).toBe(true);
  });

  it("is case-insensitive by default and honors ignore_case: false", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);

    const caseInsensitive = await tool.execute("call-1", { id: 1, pattern: "policy number" });
    expect((caseInsensitive.details as { total_matches: number }).total_matches).toBe(2);

    const caseSensitive = await tool.execute("call-2", {
      id: 1,
      pattern: "policy number",
      ignore_case: false,
    });
    expect((caseSensitive.details as { total_matches: number }).total_matches).toBe(0);
  });

  it("throws a clear error on an invalid regex pattern", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    await expect(tool.execute("call-1", { id: 1, pattern: "(" })).rejects.toThrow(
      /invalid pattern/,
    );
  });
});

describe("paperless_get_document_range", () => {
  const rangeContent = Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`).join("\n");

  it("defaults to the start of the document", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as {
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    };
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(10);
    expect(details.total_lines).toBe(10);
    expect(details.content).toBe(rangeContent);
  });

  it("returns an explicit line range", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 3, end_line: 5 });
    const details = result.details as { start_line: number; end_line: number; content: string };
    expect(details.start_line).toBe(3);
    expect(details.end_line).toBe(5);
    expect(details.content).toBe("Line 3\nLine 4\nLine 5");
  });

  it("returns an empty range past the end of the document", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 50 });
    const details = result.details as {
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    };
    expect(details.start_line).toBe(50);
    expect(details.end_line).toBe(49);
    expect(details.total_lines).toBe(10);
    expect(details.content).toBe("");
  });

  it("caps the requested span at 500 lines", async () => {
    const longContent = Array.from({ length: 600 }, (_, i) => `Line ${i + 1}`).join("\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 1, end_line: 1000 });
    const details = result.details as { start_line: number; end_line: number; content: string };
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(500);
    expect(details.content.split("\n")).toHaveLength(500);
  });
});
