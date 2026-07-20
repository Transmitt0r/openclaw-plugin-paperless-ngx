import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { paginationParams } from "./pagination.js";

// paperless-ngx Document objects carry a `content` field with the document's
// full OCR text, which is included by default. Without a cap, a broad list
// call can return dozens of documents' full text in one response, which can
// blow past the calling LLM's context/token budget.
const MAX_PAGE_SIZE = 100;

function clampPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  return Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
}

// Strips fields that are pure noise for a tool-calling model and adds a
// direct link to the document in the paperless-ngx web UI:
// - created_date duplicates created and is marked @deprecated by
//   paperless-ngx's own schema.
// - url isn't part of the API response at all; paperless-ngx's frontend
//   route for a document is /documents/{id}/details (verified against a
//   live instance).
// Only touches fields that are actually present, so a `fields`-narrowed
// response (e.g. without `id`) isn't corrupted.
function shapeDocument<T extends Record<string, unknown>>(
  baseUrl: string,
  document: T,
): Omit<T, "created_date"> & { url?: string } {
  const { created_date: _createdDate, ...rest } = document;
  const id = document.id;
  return {
    ...rest,
    ...(typeof id === "number" ? { url: `${baseUrl}/documents/${id}/details` } : {}),
  };
}

// paperless-ngx's paginated list response always includes an `all` array of
// every matching document id, regardless of page_size or fields -- there's
// no query param to disable it (checked the OpenAPI schema). It's meant for
// "select all N results" bulk-action UI, not useful to a tool-calling model,
// and can be a few KB by itself on a large collection.
function shapeDocumentList<T extends { all?: unknown; results?: unknown[] }>(
  baseUrl: string,
  response: T,
): Omit<T, "all"> {
  const { all: _all, results, ...rest } = response;
  return {
    ...rest,
    results: Array.isArray(results)
      ? results.map((doc) => shapeDocument(baseUrl, doc as Record<string, unknown>))
      : results,
  } as Omit<T, "all">;
}

const fieldsParam = Type.Optional(
  Type.Array(Type.String(), {
    description:
      "Sparse fieldset: only return these Document fields. Omit 'content' when you don't need the full OCR text -- it's included by default and can be large.",
  }),
);

const listDocumentsParams = Type.Object({
  search: Type.Optional(
    Type.String({
      description: "Free-text search across OCR content and metadata (fuzzy, ranked).",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Advanced structured filter using paperless-ngx's Whoosh-based query syntax (different from " +
        "`search`, which is free-text/OCR ranking). Field names are: type, tag, correspondent, created, " +
        "added, modified, content, title -- NOT the REST filter names (`document_type` and `tags` do NOT " +
        "work here). Supports AND/OR with parentheses, quoted phrases, wildcards (produ*name), and date " +
        "ranges/relatives (created:[2005 to 2009], created:yesterday). Example: 'correspondent:\"Foo\" AND type:Invoice'.",
    }),
  ),
  ids: Type.Optional(
    Type.Array(Type.Integer(), {
      description: "Return exactly these document ids (batch get). Ignores other filters.",
    }),
  ),
  correspondent_id: Type.Optional(Type.Integer({ description: "Filter by correspondent id." })),
  document_type_id: Type.Optional(Type.Integer({ description: "Filter by document type id." })),
  tag_id: Type.Optional(
    Type.Integer({ description: "Only return documents carrying this tag id." }),
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
  ...paginationParams,
  page_size: Type.Optional(
    Type.Integer({
      description: `Results per page, capped at ${MAX_PAGE_SIZE} regardless of what's requested. Defaults to the server's page size if omitted.`,
    }),
  ),
  fields: fieldsParam,
});

export function createListDocumentsTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_list_documents",
    label: "List paperless-ngx documents",
    description:
      "Search or filter documents in paperless-ngx. Results include each document's OCR content by default, so a separate get call usually isn't needed just to read text -- but for large result sets, pass `fields` to omit `content` and save tokens.",
    parameters: listDocumentsParams,
    execute: async (_toolCallId, params: Static<typeof listDocumentsParams>) => {
      const { client, baseUrl } = await handlePromise;
      const result = unwrap(
        await client.GET("/api/documents/", {
          params: {
            query: {
              search: params.search,
              query: params.query,
              id__in: params.ids,
              correspondent__id: params.correspondent_id,
              document_type__id: params.document_type_id,
              tags__id: params.tag_id,
              title__icontains: params.title_contains,
              created__date__gte: params.created_from,
              created__date__lte: params.created_to,
              ordering: params.ordering,
              page: params.page,
              page_size: clampPageSize(params.page_size),
              fields: params.fields,
            },
          },
        }),
      );
      return toToolResult(shapeDocumentList(baseUrl, result));
    },
  };
}

const getDocumentParams = Type.Object({
  id: Type.Integer({ description: "Document id." }),
  fields: fieldsParam,
});

export function createGetDocumentTool(handlePromise: Promise<PaperlessClientHandle>): AnyAgentTool {
  return {
    name: "paperless_get_document",
    label: "Get paperless-ngx document",
    description: "Fetch a single document by id, including its OCR content and metadata.",
    parameters: getDocumentParams,
    execute: async (_toolCallId, params: Static<typeof getDocumentParams>) => {
      const { client, baseUrl } = await handlePromise;
      const result = unwrap(
        await client.GET("/api/documents/{id}/", {
          params: { path: { id: params.id }, query: { fields: params.fields } },
        }),
      );
      return toToolResult(shapeDocument(baseUrl, result));
    },
  };
}

const updateDocumentParams = Type.Object({
  id: Type.Integer({ description: "Document id to update." }),
  title: Type.Optional(Type.String({ description: "New title." })),
  correspondent_id: Type.Optional(
    Type.Union([Type.Integer(), Type.Null()], {
      description:
        "Correspondent id, or null to clear it. Same id space as paperless_list_documents' correspondent_id filter.",
    }),
  ),
  document_type_id: Type.Optional(
    Type.Union([Type.Integer(), Type.Null()], {
      description:
        "Document type id, or null to clear it. Same id space as paperless_list_documents' document_type_id filter.",
    }),
  ),
  tags: Type.Optional(
    Type.Array(Type.Integer(), {
      description: "Full replacement list of tag ids (not a delta/patch against existing tags).",
    }),
  ),
  created: Type.Optional(Type.String({ description: "Document date in YYYY-MM-DD format." })),
  fields: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Only return these fields in the response (`id` and `url` are always included). paperless-ngx's " +
        "update endpoint doesn't support a server-side sparse fieldset like list/get do, so this trims the " +
        "response after the fact -- pass it to avoid getting the full document (including OCR `content`) " +
        "echoed back when you only care that the update succeeded.",
    }),
  ),
});

function pickFields<T extends Record<string, unknown>>(
  fields: string[] | undefined,
  obj: T,
): Partial<T> {
  if (!fields || fields.length === 0) return obj;
  const keep = new Set(["id", "url", ...fields]);
  return Object.fromEntries(Object.entries(obj).filter(([key]) => keep.has(key))) as Partial<T>;
}

export function createUpdateDocumentTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_update_document",
    label: "Update paperless-ngx document",
    description:
      "Patch a document's title, correspondent, document type, tags, or created date. Only provided top-level fields are changed; `tags`, if provided, fully replaces the document's tag list rather than adding to it. Does not touch storage_path.",
    parameters: updateDocumentParams,
    execute: async (_toolCallId, params: Static<typeof updateDocumentParams>) => {
      const { client, baseUrl } = await handlePromise;
      const { id, correspondent_id, document_type_id, fields, ...rest } = params;
      const result = unwrap(
        await client.PATCH("/api/documents/{id}/", {
          params: { path: { id } },
          body: {
            ...rest,
            // Tool params use the *_id naming convention shared with
            // paperless_list_documents; map back to the API's wire field names.
            correspondent: correspondent_id,
            document_type: document_type_id,
            // remove_inbox_tags has a server-side default but openapi-typescript
            // still requires it on the wire type; leave inbox-tag membership to
            // the `tags` replacement array instead.
            remove_inbox_tags: false,
          },
        }),
      );
      return toToolResult(pickFields(fields, shapeDocument(baseUrl, result)));
    },
  };
}
