import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient } from "../client.js";
import { unwrap } from "../client.js";

const listDocumentsParams = Type.Object({
  search: Type.Optional(
    Type.String({ description: "Free-text search term across title and content." }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Advanced search query string (paperless-ngx query syntax, e.g. 'correspondent:Foo type:Invoice').",
    }),
  ),
  correspondent_id: Type.Optional(Type.Integer({ description: "Filter by correspondent id." })),
  document_type_id: Type.Optional(Type.Integer({ description: "Filter by document type id." })),
  tag_id: Type.Optional(
    Type.Integer({ description: "Only return documents carrying this tag id." }),
  ),
  is_in_inbox: Type.Optional(
    Type.Boolean({ description: "Filter to (or exclude) documents still tagged as inbox." }),
  ),
  title_contains: Type.Optional(Type.String({ description: "Case-insensitive title substring." })),
  created_from: Type.Optional(
    Type.String({ description: "Only documents with created date >= this ISO date (YYYY-MM-DD)." }),
  ),
  created_to: Type.Optional(
    Type.String({ description: "Only documents with created date <= this ISO date (YYYY-MM-DD)." }),
  ),
  ordering: Type.Optional(
    Type.String({ description: "Result ordering, e.g. '-created' for newest first." }),
  ),
  page: Type.Optional(Type.Integer({ description: "Page number, 1-indexed." })),
  page_size: Type.Optional(
    Type.Integer({ description: "Results per page. Defaults to the server's page size." }),
  ),
});

export function createListDocumentsTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_list_documents",
    label: "List paperless-ngx documents",
    description:
      "Search or filter documents in paperless-ngx. Returns paginated results including each document's OCR content, so a separate get call usually isn't needed just to read text.",
    parameters: listDocumentsParams,
    execute: async (_toolCallId, params: Static<typeof listDocumentsParams>) => {
      const result = unwrap(
        await client.GET("/api/documents/", {
          params: {
            query: {
              search: params.search,
              query: params.query,
              correspondent__id: params.correspondent_id,
              document_type__id: params.document_type_id,
              tags__id: params.tag_id,
              is_in_inbox: params.is_in_inbox,
              title__icontains: params.title_contains,
              created__date__gte: params.created_from,
              created__date__lte: params.created_to,
              ordering: params.ordering,
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

const getDocumentParams = Type.Object({
  id: Type.Integer({ description: "Document id." }),
});

export function createGetDocumentTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_get_document",
    label: "Get paperless-ngx document",
    description: "Fetch a single document by id, including its OCR content and metadata.",
    parameters: getDocumentParams,
    execute: async (_toolCallId, params: Static<typeof getDocumentParams>) => {
      const result = unwrap(
        await client.GET("/api/documents/{id}/", {
          params: { path: { id: params.id } },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

const updateDocumentParams = Type.Object({
  id: Type.Integer({ description: "Document id to update." }),
  title: Type.Optional(Type.String({ description: "New title." })),
  correspondent: Type.Optional(
    Type.Union([Type.Integer(), Type.Null()], {
      description: "Correspondent id, or null to clear it.",
    }),
  ),
  document_type: Type.Optional(
    Type.Union([Type.Integer(), Type.Null()], {
      description: "Document type id, or null to clear it.",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.Integer(), {
      description: "Full replacement list of tag ids (not a delta/patch against existing tags).",
    }),
  ),
  created: Type.Optional(Type.String({ description: "Document date in YYYY-MM-DD format." })),
});

export function createUpdateDocumentTool(client: PaperlessClient): AnyAgentTool {
  return {
    name: "paperless_update_document",
    label: "Update paperless-ngx document",
    description:
      "Patch a document's title, correspondent, document type, tags, or created date. Only provided fields are changed. Does not touch storage_path.",
    parameters: updateDocumentParams,
    execute: async (_toolCallId, params: Static<typeof updateDocumentParams>) => {
      const { id, ...body } = params;
      const result = unwrap(
        await client.PATCH("/api/documents/{id}/", {
          params: { path: { id } },
          // remove_inbox_tags has a server-side default but openapi-typescript
          // still requires it on the wire type; leave inbox-tag membership to
          // the `tags` replacement array instead.
          body: { ...body, remove_inbox_tags: false },
        }),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}
