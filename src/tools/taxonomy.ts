import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient } from "../client.js";
import { unwrap } from "../client.js";

const listParams = Type.Object({
  name_contains: Type.Optional(
    Type.String({ description: "Case-insensitive name substring filter." }),
  ),
  page: Type.Optional(Type.Integer({ description: "Page number, 1-indexed." })),
  page_size: Type.Optional(
    Type.Integer({ description: "Results per page. Defaults to the server's page size." }),
  ),
});

export function createListTagsTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_list_tags",
    label: "List paperless-ngx tags",
    description: "List existing tags, optionally filtered by name.",
    parameters: listParams,
    execute: async (_toolCallId, params: Static<typeof listParams>) => {
      const result = unwrap(
        await client.GET("/api/tags/", {
          params: {
            query: {
              name__icontains: params.name_contains,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

export function createListCorrespondentsTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_list_correspondents",
    label: "List paperless-ngx correspondents",
    description: "List existing correspondents, optionally filtered by name.",
    parameters: listParams,
    execute: async (_toolCallId, params: Static<typeof listParams>) => {
      const result = unwrap(
        await client.GET("/api/correspondents/", {
          params: {
            query: {
              name__icontains: params.name_contains,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

export function createListDocumentTypesTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_list_document_types",
    label: "List paperless-ngx document types",
    description: "List existing document types, optionally filtered by name.",
    parameters: listParams,
    execute: async (_toolCallId, params: Static<typeof listParams>) => {
      const result = unwrap(
        await client.GET("/api/document_types/", {
          params: {
            query: {
              name__icontains: params.name_contains,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const createNamedParams = Type.Object({
  name: Type.String({ description: "Name of the new entry." }),
});

export function createCreateCorrespondentTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_create_correspondent",
    label: "Create paperless-ngx correspondent",
    description:
      "Create a new correspondent. Check paperless_list_correspondents first to avoid creating a near-duplicate of an existing one.",
    parameters: createNamedParams,
    execute: async (_toolCallId, params: Static<typeof createNamedParams>) => {
      const result = unwrap(
        await client.POST("/api/correspondents/", {
          body: { name: params.name },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

export function createCreateDocumentTypeTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_create_document_type",
    label: "Create paperless-ngx document type",
    description:
      "Create a new document type. Check paperless_list_document_types first to avoid creating a near-duplicate of an existing one.",
    parameters: createNamedParams,
    execute: async (_toolCallId, params: Static<typeof createNamedParams>) => {
      const result = unwrap(
        await client.POST("/api/document_types/", {
          body: { name: params.name },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

export function createCreateTagTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_create_tag",
    label: "Create paperless-ngx tag",
    description:
      "Create a new tag. Check paperless_list_tags first to avoid creating a near-duplicate of an existing one.",
    parameters: createNamedParams,
    execute: async (_toolCallId, params: Static<typeof createNamedParams>) => {
      const result = unwrap(
        await client.POST("/api/tags/", {
          body: { name: params.name },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
