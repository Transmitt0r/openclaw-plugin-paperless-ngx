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

// Like `setup`, but also hands back the underlying fetch mock so a test can
// inspect the outgoing request (query params) rather than just the shaped
// response.
function setupWithSpy(routes: Route[]) {
  const fetchMock = stubFetch(routes);
  const client = createPaperlessClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return { handle: Promise.resolve({ client, baseUrl: BASE_URL }), fetchMock };
}

function lastRequestUrl(fetchMock: ReturnType<typeof stubFetch>): URL {
  const call = fetchMock.mock.calls.at(-1);
  const request = call?.[0] as Request;
  return new URL(request.url);
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

  it("matches a wildcard Whoosh query fragment when building a snippet", async () => {
    const handle = setup([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    // "INVOI*42" -- the literal wildcard would never match OCR text, but the
    // "INVOI" fragment (before the `*`) is a real substring of MARKER.
    const result = await tool.execute("call-1", { query: "INVOI*42" });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    const snippet = doc.content_snippet as string;
    expect(snippet).toContain(MARKER);
  });

  it("adds `content` to the outgoing `fields` request when include_content is true", async () => {
    const { handle, fetchMock } = setupWithSpy([
      documentsListRoute([{ id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    await tool.execute("call-1", { fields: ["id", "title"], include_content: true });
    const fields = lastRequestUrl(fetchMock).searchParams.get("fields");
    expect(fields?.split(",")).toEqual(expect.arrayContaining(["id", "title", "content"]));
  });

  it("keeps an emoji intact when it straddles a snippet boundary", async () => {
    // An emoji is a UTF-16 surrogate pair; place it so the snippet's
    // char-count boundary (SNIPPET_CONTEXT_CHARS = 160 after the match)
    // would fall between its two halves if slicing weren't surrogate-aware.
    const emoji = "\u{1F600}";
    const fillerLen = 159 - MARKER.length;
    const content = `${MARKER}${"x".repeat(fillerLen)}${emoji}${"y".repeat(50)}`;
    const handle = setup([documentsListRoute([{ id: 1, title: "Doc 1", content, tags: [] }])]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", { search: MARKER });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    const snippet = doc.content_snippet as string;
    expect(snippet).toContain(emoji);
    expect(snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("keeps an emoji intact when it straddles the leading-excerpt boundary", async () => {
    const emoji = "\u{1F600}";
    const fillerLen = 319;
    const content = `${"x".repeat(fillerLen)}${emoji}${"y".repeat(50)}`;
    const handle = setup([documentsListRoute([{ id: 1, title: "Doc 1", content, tags: [] }])]);
    const tool = createListDocumentsTool(handle);
    const result = await tool.execute("call-1", { search: "absent-term" });
    const doc = (result.details as { results: Record<string, unknown>[] }).results[0];
    const snippet = doc.content_snippet as string;
    expect(snippet).toContain(emoji);
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

  it("still returns content when include_content is true and fields omits it", async () => {
    // Regression test: `fields` is forwarded to the API as a server-side
    // sparse fieldset, so a `fields` list that omits "content" would
    // otherwise silently starve `include_content: true` of any content to
    // return, even though the fixture below has it.
    const handle = setup([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    const result = await tool.execute("call-1", {
      id: 1,
      fields: ["id", "title"],
      include_content: true,
    });
    const doc = result.details as Record<string, unknown>;
    expect(doc.content).toBe(SAMPLE_CONTENT);
  });
});

describe("outgoing request serialization", () => {
  it("list_documents sends `search` in the request query", async () => {
    const { handle, fetchMock } = setupWithSpy([documentsListRoute([])]);
    const tool = createListDocumentsTool(handle);
    await tool.execute("call-1", { search: "invoice" });
    expect(lastRequestUrl(fetchMock).searchParams.get("search")).toBe("invoice");
  });

  it("list_documents sends `fields` as given (without content) when include_content is false", async () => {
    const { handle, fetchMock } = setupWithSpy([
      documentsListRoute([{ id: 1, title: "Doc 1", tags: [] }]),
    ]);
    const tool = createListDocumentsTool(handle);
    await tool.execute("call-1", { fields: ["id", "title"], include_content: false });
    const fields = lastRequestUrl(fetchMock).searchParams.get("fields");
    expect(fields?.split(",")).toEqual(["id", "title"]);
  });

  it("get_document adds `content` to `fields` in the request when include_content is true", async () => {
    const { handle, fetchMock } = setupWithSpy([
      documentGetRoute({ 1: { id: 1, title: "Doc 1", content: SAMPLE_CONTENT, tags: [] } }),
    ]);
    const tool = createGetDocumentTool(handle);
    await tool.execute("call-1", { id: 1, fields: ["id", "title"], include_content: true });
    const fields = lastRequestUrl(fetchMock).searchParams.get("fields");
    expect(fields?.split(",")).toEqual(expect.arrayContaining(["id", "title", "content"]));
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

  it("rejects patterns with too many repetition operators (ReDoS guard)", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    const pathological = "a+".repeat(20);
    await expect(tool.execute("call-1", { id: 1, pattern: pathological })).rejects.toThrow(
      /too many repetition operators/,
    );
  });

  it("rejects patterns longer than the length cap", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    const tooLong = "a".repeat(501);
    await expect(tool.execute("call-1", { id: 1, pattern: tooLong })).rejects.toThrow(
      /longer than 500 characters/,
    );
  });

  it("normalizes CRLF line endings before matching", async () => {
    const crlfContent = GREP_CONTENT.split("\n").join("\r\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: crlfContent } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "Policy Number" });
    const details = result.details as {
      total_matches: number;
      matches: { line: string; context: string }[];
    };
    expect(details.total_matches).toBe(2);
    expect(details.matches[0]?.line).toBe("Policy Number: ABC-123");
    expect(details.matches[0]?.line).not.toContain("\r");
    expect(details.matches[0]?.context).not.toContain("\r");
  });

  it("reports content_status: null and skips the search when content is missing", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: null } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "anything" });
    const details = result.details as {
      total_lines: number;
      total_matches: number;
      matches: unknown[];
      content_status: string;
    };
    expect(details.content_status).toBe("null");
    expect(details.total_lines).toBe(0);
    expect(details.total_matches).toBe(0);
    expect(details.matches).toEqual([]);
  });

  it("reports content_status: present when a match is found", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "Policy Number" });
    expect((result.details as { content_status: string }).content_status).toBe("present");
  });

  it("reports content_status: empty when content is an empty string", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: "" } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "anything" });
    const details = result.details as { content_status: string; total_matches: number };
    expect(details.content_status).toBe("empty");
    expect(details.total_matches).toBe(0);
  });

  it("returns zero matches (not an error) when the pattern matches nothing", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: GREP_CONTENT } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "no-such-term-xyz" });
    const details = result.details as {
      content_status: string;
      total_matches: number;
      matches: unknown[];
      truncated: boolean;
    };
    expect(details.content_status).toBe("present");
    expect(details.total_matches).toBe(0);
    expect(details.matches).toEqual([]);
    expect(details.truncated).toBe(false);
  });

  it("handles a single very long line with no newlines", async () => {
    const longLine = `prefix ${"word ".repeat(2000)}needle ${"word ".repeat(2000)}suffix`;
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longLine } })]);
    const tool = createGrepDocumentTool(handle);
    const result = await tool.execute("call-1", { id: 1, pattern: "needle" });
    const details = result.details as {
      total_lines: number;
      total_matches: number;
      matches: { line_number: number; line: string }[];
    };
    expect(details.total_lines).toBe(1);
    expect(details.total_matches).toBe(1);
    expect(details.matches[0]?.line_number).toBe(1);
    expect(details.matches[0]?.line).toBe(longLine);
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

  it("normalizes CRLF line endings before slicing", async () => {
    const crlfContent = rangeContent.split("\n").join("\r\n");
    const handle = setup([documentGetRoute({ 1: { id: 1, content: crlfContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1, start_line: 3, end_line: 5 });
    const details = result.details as { content: string };
    expect(details.content).toBe("Line 3\nLine 4\nLine 5");
    expect(details.content).not.toContain("\r");
  });

  it("reports content_status: null and returns empty content when content is missing", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: null } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as {
      total_lines: number;
      content: string;
      content_status: string;
    };
    expect(details.content_status).toBe("null");
    expect(details.total_lines).toBe(0);
    expect(details.content).toBe("");
  });

  it("reports content_status: present for a normal range", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    expect((result.details as { content_status: string }).content_status).toBe("present");
  });

  it("throws a clear error on an inverted range (end_line before start_line)", async () => {
    const handle = setup([documentGetRoute({ 1: { id: 1, content: rangeContent } })]);
    const tool = createGetDocumentRangeTool(handle);
    await expect(tool.execute("call-1", { id: 1, start_line: 10, end_line: 2 })).rejects.toThrow(
      /end_line \(2\) is before start_line \(10\)/,
    );
  });

  it("handles a single very long line with no newlines", async () => {
    const longLine = "word ".repeat(5000).trim();
    const handle = setup([documentGetRoute({ 1: { id: 1, content: longLine } })]);
    const tool = createGetDocumentRangeTool(handle);
    const result = await tool.execute("call-1", { id: 1 });
    const details = result.details as {
      start_line: number;
      end_line: number;
      total_lines: number;
      content: string;
    };
    expect(details.total_lines).toBe(1);
    expect(details.start_line).toBe(1);
    expect(details.end_line).toBe(1);
    expect(details.content).toBe(longLine);
  });
});
