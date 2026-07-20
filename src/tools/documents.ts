import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient, PaperlessClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { paginationParams } from "./pagination.js";
import { fetchNameMap } from "./relations.js";

// paperless-ngx Document objects carry a `content` field with the document's
// full OCR text, which is included by default. Without a cap, a broad list
// call can return dozens of documents' full text in one response, which can
// blow past the calling LLM's context/token budget.
const MAX_PAGE_SIZE = 100;

function clampPageSize(pageSize: number | undefined): number | undefined {
  if (pageSize === undefined) return undefined;
  return Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE);
}

type NameMaps = {
  correspondents: Map<number, string>;
  documentTypes: Map<number, string>;
  tags: Map<number, string>;
};

function collectRelationIds(documents: Record<string, unknown>[]) {
  const correspondentIds = new Set<number>();
  const documentTypeIds = new Set<number>();
  const tagIds = new Set<number>();
  for (const doc of documents) {
    if (typeof doc.correspondent === "number") correspondentIds.add(doc.correspondent);
    if (typeof doc.document_type === "number") documentTypeIds.add(doc.document_type);
    if (Array.isArray(doc.tags)) {
      for (const tagId of doc.tags) {
        if (typeof tagId === "number") tagIds.add(tagId);
      }
    }
  }
  return { correspondentIds, documentTypeIds, tagIds };
}

// Documents only carry correspondent/document_type/tags as bare ids.
// Without this, a tool-calling model has to make its own follow-up
// list_correspondents/list_document_types/list_tags calls -- unbatched,
// often pulling in far more than it needs -- just to know what a document
// actually is. Resolving up front costs at most 3 extra API calls total per
// list/get call, not per document.
async function resolveNameMaps(
  client: PaperlessClient,
  documents: Record<string, unknown>[],
): Promise<NameMaps> {
  const { correspondentIds, documentTypeIds, tagIds } = collectRelationIds(documents);
  const [correspondents, documentTypes, tags] = await Promise.all([
    fetchNameMap(client, "/api/correspondents/", [...correspondentIds]),
    fetchNameMap(client, "/api/document_types/", [...documentTypeIds]),
    fetchNameMap(client, "/api/tags/", [...tagIds]),
  ]);
  return { correspondents, documentTypes, tags };
}

// Strips fields that are pure noise or unresolvable for a tool-calling model,
// and adds a direct link to the document in the paperless-ngx web UI:
// - created_date duplicates created and is marked @deprecated by
//   paperless-ngx's own schema.
// - storage_path and custom_fields reference ids this plugin has no tool to
//   resolve or set (no storage-path/custom-field support), so they're opaque
//   numbers with nothing actionable to do with them.
// - owner/permissions are ACL metadata: not settable via
//   paperless_update_document, not relevant to document search/triage, and
//   better not dumped into the model's context unnecessarily.
// - url isn't part of the API response at all; paperless-ngx's frontend
//   route for a document is /documents/{id}/details (verified against a
//   live instance).
// correspondent/document_type/tags ids are kept as-is (paperless_update_document
// needs them back), with *_name siblings added wherever resolveNameMaps found
// a match.
function shapeDocument<T extends Record<string, unknown>>(
  baseUrl: string,
  maps: NameMaps,
  document: T,
): Record<string, unknown> {
  const {
    created_date: _createdDate,
    storage_path: _storagePath,
    custom_fields: _customFields,
    owner: _owner,
    permissions: _permissions,
    ...rest
  } = document;
  const id = document.id;
  const correspondent = document.correspondent;
  const documentType = document.document_type;
  const tags = document.tags;
  return {
    ...rest,
    ...(typeof id === "number" ? { url: `${baseUrl}/documents/${id}/details` } : {}),
    ...(typeof correspondent === "number" && maps.correspondents.has(correspondent)
      ? { correspondent_name: maps.correspondents.get(correspondent) }
      : {}),
    ...(typeof documentType === "number" && maps.documentTypes.has(documentType)
      ? { document_type_name: maps.documentTypes.get(documentType) }
      : {}),
    ...(Array.isArray(tags)
      ? {
          tag_names: tags
            .filter((tagId): tagId is number => typeof tagId === "number" && maps.tags.has(tagId))
            .map((tagId) => maps.tags.get(tagId)),
        }
      : {}),
  };
}

async function shapeSingleDocument(
  client: PaperlessClient,
  baseUrl: string,
  document: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const maps = await resolveNameMaps(client, [document]);
  return shapeDocument(baseUrl, maps, document);
}

// paperless-ngx's paginated list response always includes an `all` array of
// every matching document id, regardless of page_size or fields -- there's
// no query param to disable it (checked the OpenAPI schema). It's meant for
// "select all N results" bulk-action UI, not useful to a tool-calling model,
// and can be a few KB by itself on a large collection.
async function shapeDocumentList<T extends { all?: unknown; results?: unknown[] }>(
  client: PaperlessClient,
  baseUrl: string,
  response: T,
): Promise<Omit<T, "all">> {
  const { all: _all, results, ...rest } = response;
  const docs = Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
  const maps = await resolveNameMaps(client, docs);
  return {
    ...rest,
    results: docs.map((doc) => shapeDocument(baseUrl, maps, doc)),
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
      "Search or filter documents in paperless-ngx. Results include each document's OCR content by default, so a separate get call usually isn't needed just to read text -- but for large result sets, pass `fields` to omit `content` and save tokens. correspondent/document_type/tag ids are automatically resolved to correspondent_name/document_type_name/tag_names alongside the ids.",
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
      return toToolResult(await shapeDocumentList(client, baseUrl, result));
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
    description:
      "Fetch a single document by id, including its OCR content and metadata. correspondent/document_type/tag ids are automatically resolved to correspondent_name/document_type_name/tag_names alongside the ids.",
    parameters: getDocumentParams,
    execute: async (_toolCallId, params: Static<typeof getDocumentParams>) => {
      const { client, baseUrl } = await handlePromise;
      const result = unwrap(
        await client.GET("/api/documents/{id}/", {
          params: { path: { id: params.id }, query: { fields: params.fields } },
        }),
      );
      return toToolResult(await shapeSingleDocument(client, baseUrl, result));
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
      description:
        "Full replacement list of tag ids (not a delta against existing tags). Mutually exclusive with add_tag_ids/remove_tag_ids.",
    }),
  ),
  add_tag_ids: Type.Optional(
    Type.Array(Type.Integer(), {
      description:
        "Tag ids to add without disturbing the document's other tags. Mutually exclusive with `tags`.",
    }),
  ),
  remove_tag_ids: Type.Optional(
    Type.Array(Type.Integer(), {
      description:
        "Tag ids to remove without disturbing the document's other tags. Mutually exclusive with `tags`.",
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
      "Patch a document's title, correspondent, document type, tags, or created date. Only provided top-level fields are changed. Use `tags` to fully replace the tag list, or add_tag_ids/remove_tag_ids to adjust it without disturbing other tags. Does not touch storage_path.",
    parameters: updateDocumentParams,
    execute: async (_toolCallId, params: Static<typeof updateDocumentParams>) => {
      const { client, baseUrl } = await handlePromise;
      const {
        id,
        correspondent_id,
        document_type_id,
        tags,
        add_tag_ids,
        remove_tag_ids,
        fields,
        ...rest
      } = params;

      if ((add_tag_ids?.length || remove_tag_ids?.length) && tags !== undefined) {
        throw new Error(
          "paperless_update_document: pass either `tags` (full replace) or add_tag_ids/remove_tag_ids (delta), not both.",
        );
      }

      // paperless-ngx's tag replacement (PATCH tags: [...]) has no add/remove
      // mode, but its bulk_edit endpoint's modify_tags method does this
      // atomically server-side -- avoids a read-modify-write race against the
      // document's current tags.
      if (add_tag_ids?.length || remove_tag_ids?.length) {
        unwrap(
          await client.POST("/api/documents/bulk_edit/", {
            body: {
              documents: [id],
              method: "modify_tags",
              parameters: { add_tags: add_tag_ids ?? [], remove_tags: remove_tag_ids ?? [] },
            },
          }),
        );
      }

      const hasOtherChanges =
        Object.keys(rest).length > 0 ||
        tags !== undefined ||
        correspondent_id !== undefined ||
        document_type_id !== undefined;

      const result = hasOtherChanges
        ? unwrap(
            await client.PATCH("/api/documents/{id}/", {
              params: { path: { id } },
              body: {
                ...rest,
                ...(tags !== undefined ? { tags } : {}),
                // Tool params use the *_id naming convention shared with
                // paperless_list_documents; map back to the API's wire field names.
                correspondent: correspondent_id,
                document_type: document_type_id,
                // remove_inbox_tags has a server-side default but openapi-typescript
                // still requires it on the wire type; leave inbox-tag membership to
                // the `tags`/add_tag_ids/remove_tag_ids params instead.
                remove_inbox_tags: false,
              },
            }),
          )
        : // A pure tag-delta call (nothing else changed): bulk_edit already
          // applied it above but only returns { result: "OK" }, not a
          // document body, so fetch the current state to respond with.
          unwrap(await client.GET("/api/documents/{id}/", { params: { path: { id } } }));

      return toToolResult(pickFields(fields, await shapeSingleDocument(client, baseUrl, result)));
    },
  };
}
