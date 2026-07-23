import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { createPaperlessClient } from "./client.js";
import {
  createGetDocumentTool,
  createReadDocumentTool,
  createSearchDocumentContentTool,
  createSearchDocumentsTool,
  createUpdateDocumentTool,
} from "./tools/documents.js";
import { createCreateTaxonomyTermTool, createListTaxonomyTool } from "./tools/taxonomy.js";

// Guards against the class of bug fixed here: index.ts registered
// paperless_grep_document/paperless_get_document_range via api.registerTool(),
// but openclaw.plugin.json's contracts.tools list -- which OpenClaw actually
// uses to decide what's exposed to the agent -- was never updated to
// include them, so both tools were silently unavailable at runtime despite
// being fully implemented and tested.
describe("openclaw.plugin.json contracts.tools", () => {
  it("declares every tool the plugin implements", () => {
    const handle = Promise.resolve({
      client: createPaperlessClient({ baseUrl: "https://paperless.example.com", apiToken: "x" }),
      baseUrl: "https://paperless.example.com",
    });
    const implementedNames = [
      createSearchDocumentsTool(handle),
      createGetDocumentTool(handle),
      createReadDocumentTool(handle),
      createSearchDocumentContentTool(handle),
      createUpdateDocumentTool(handle),
      createListTaxonomyTool(handle),
      createCreateTaxonomyTermTool(handle),
    ].map((tool) => tool.name);

    expect(new Set(manifest.contracts.tools)).toEqual(new Set(implementedNames));
  });
});
