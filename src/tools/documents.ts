import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient, PaperlessClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { clampPageSize, paginationParams } from "./pagination.js";
import { fetchNameMap } from "./relations.js";

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

// How much of a document's OCR content to keep in a shaped response.
// `snippetTerm` (a `search`/`query` string) is only used when `includeContent`
// is false: it locates the term in the content and keeps a short window
// around it instead of either the full text or nothing.
type ContentOptions = {
  includeContent: boolean;
  snippetTerm?: string;
};

const SNIPPET_CONTEXT_CHARS = 160;

// `String.slice` operates on UTF-16 code units, so a boundary computed by
// character count can land inside a surrogate pair (emoji, some CJK) and
// split it into two unpaired/replacement-rendering halves. These nudge a
// slice boundary outward by one unit rather than through it when that
// happens, so snippet edges never bisect a code point.
function backAwayFromLowSurrogate(str: string, index: number): number {
  const code = str.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}
function forwardPastHighSurrogate(str: string, index: number): number {
  const code = str.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

// Best-effort preview around the first place `term` occurs in `content`.
// `term` may be a `search` string (free text) or a `query` string
// (paperless-ngx's Whoosh syntax, e.g. `correspondent:"Foo" AND type:Invoice`)
// -- field prefixes/operators/quotes are stripped down to bare words since
// none of that syntax appears literally in OCR text. Falls back to a leading
// excerpt when no word from `term` is found (e.g. the match was on metadata,
// not content) or when `term` is omitted.
function extractSnippet(content: string, term: string | undefined): string {
  const trimmed = content.trim();
  const leadingExcerpt = () => {
    if (trimmed.length <= SNIPPET_CONTEXT_CHARS * 2) return trimmed;
    const cut = forwardPastHighSurrogate(trimmed, SNIPPET_CONTEXT_CHARS * 2);
    return `${trimmed.slice(0, cut)}…`;
  };

  if (!term) return leadingExcerpt();

  // `*` (Whoosh wildcard, e.g. `produ*name`) never appears literally in OCR
  // text, so it's turned into a word boundary rather than stripped outright:
  // splitting "produ*name" into "produ"/"name" lets indexOf below match
  // either fragment as a substring of the real word instead of never matching.
  const words = term
    .replace(/[A-Za-z_]+:/g, " ")
    .replace(/["()]/g, " ")
    .replace(/\*/g, " ")
    .split(/\s+/)
    .filter((word) => word && !/^(AND|OR|NOT|TO)$/i.test(word));

  const lowerContent = content.toLowerCase();
  let matchIndex = -1;
  for (const word of words) {
    const idx = lowerContent.indexOf(word.toLowerCase());
    if (idx !== -1) {
      matchIndex = idx;
      break;
    }
  }
  if (matchIndex === -1) return leadingExcerpt();

  const start = backAwayFromLowSurrogate(content, Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS));
  const end = forwardPastHighSurrogate(
    content,
    Math.min(content.length, matchIndex + SNIPPET_CONTEXT_CHARS),
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

// `content` is opt-in (see getDocumentParams' `include_content` -- list never
// returns it at all, and update only via `fields`): full OCR text is dropped
// unless explicitly requested and even then capped (see MAX_RANGE_LINES
// below), since a broad list call returning dozens of documents' full text,
// or even one very long document, can blow past the calling LLM's
// context/token budget. When a search/query term is known and content was
// dropped, a short content_snippet around the match is kept instead so
// results stay useful without the full text -- for anything more,
// paperless_grep_document and paperless_get_document_range fetch targeted
// excerpts on demand.
function applyContentPolicy(
  document: Record<string, unknown>,
  options: ContentOptions,
): Record<string, unknown> {
  const { content, ...rest } = document;
  if (options.includeContent) return document;
  if (typeof content === "string" && options.snippetTerm !== undefined) {
    return { ...rest, content_snippet: extractSnippet(content, options.snippetTerm) };
  }
  return rest;
}

// Also the cap applied to paperless_get_document/paperless_update_document's
// optional full-content read -- one definition of "how much content fits in
// a bounded read" shared by every tool in this file, rather than each
// growing its own separately-tuned cap that can drift out of sync.
const MAX_RANGE_LINES = 500;
const DEFAULT_RANGE_LINES = 200;

// paperless-ngx OCR content is not guaranteed to use `\n` line endings --
// normalize CRLF/CR before splitting so a trailing `\r` doesn't leak into
// every returned line/context string.
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Caps `content` at `maxLines` lines, the same bound paperless_get_document_range
// enforces per call -- used by paperless_get_document/paperless_update_document
// so a "give me the whole document" read is bounded the same way a "give me a
// range" read already is, instead of being a second, unbounded path.
function capContentForResponse(
  content: string,
  maxLines: number,
): { content: string; totalLines: number; truncated: boolean } {
  const normalized = normalizeLineEndings(content);
  const lines = normalized.split("\n");
  if (lines.length <= maxLines) {
    return { content: normalized, totalLines: lines.length, truncated: false };
  }
  return {
    content: lines.slice(0, maxLines).join("\n"),
    totalLines: lines.length,
    truncated: true,
  };
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
  contentOptions: ContentOptions,
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
  return applyContentPolicy(
    {
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
    },
    contentOptions,
  );
}

async function shapeSingleDocument(
  client: PaperlessClient,
  baseUrl: string,
  document: Record<string, unknown>,
  contentOptions: ContentOptions,
): Promise<Record<string, unknown>> {
  const maps = await resolveNameMaps(client, [document]);
  return shapeDocument(baseUrl, maps, document, contentOptions);
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
  contentOptions: ContentOptions,
): Promise<Omit<T, "all">> {
  const { all: _all, results, ...rest } = response;
  const docs = Array.isArray(results) ? (results as Record<string, unknown>[]) : [];
  const maps = await resolveNameMaps(client, docs);
  return {
    ...rest,
    results: docs.map((doc) => shapeDocument(baseUrl, maps, doc, contentOptions)),
  } as Omit<T, "all">;
}

// Shared by list/get/update's `fields` params. `content` is never returned
// unless the tool's own content option asks for it (get_document's
// `include_content: true`, update_document's `fields` including "content")
// -- listing "content" here alone never gets it back.
const fieldsParam = Type.Optional(
  Type.Array(Type.String(), {
    description:
      "Sparse fieldset: only return these Document fields. `content` is only included if the " +
      "tool's own content option asks for it (paperless_get_document's `include_content: true`, " +
      'or paperless_update_document\'s `fields` explicitly listing "content") -- listing it here ' +
      "alone doesn't get it back.",
  }),
);

// paperless-ngx's `fields` query param is a server-side sparse fieldset: if
// it's set and omits "content", the API never returns content in the first
// place, so `include_content: true` would otherwise be silently defeated
// (see PR #6 review). Widening `fields` here -- not just relying on the
// client-side content policy -- keeps `include_content` authoritative
// regardless of what `fields` was given.
function withContentField(
  fields: string[] | undefined,
  includeContent: boolean,
): string[] | undefined {
  if (!includeContent || !fields || fields.includes("content")) return fields;
  return [...fields, "content"];
}

const getDocumentIncludeContentParam = Type.Optional(
  Type.Boolean({
    description:
      `Include the document's OCR \`content\`, capped at the first ${MAX_RANGE_LINES} lines ` +
      "(response includes `content_truncated`/`content_total_lines` if the document is longer -- " +
      "follow up with paperless_get_document_range for the rest). Defaults to false. Prefer " +
      "paperless_grep_document (pattern search within a document) or paperless_get_document_range " +
      "(a specific line range) over this when you're hunting for a specific detail rather than " +
      "reading the whole document. Note this only controls what's returned to you -- paperless-ngx " +
      "itself still fetches the document's full OCR content server-side either way, so this saves " +
      "your context budget, not the server's work.",
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
  fields: fieldsParam,
});

export function createListDocumentsTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_list_documents",
    label: "List paperless-ngx documents",
    description:
      "Search or filter documents in paperless-ngx. OCR `content` is never included in list " +
      "results -- when a `search`/`query` term was given, each result gets a short " +
      "`content_snippet` around the match instead, enough to judge relevance without the full " +
      "text. To read a specific document's content, use paperless_get_document (the whole " +
      "document, capped), paperless_grep_document (pattern search), or " +
      "paperless_get_document_range (a specific line range). correspondent/document_type/tag ids " +
      "are automatically resolved to correspondent_name/document_type_name/tag_names alongside the ids.",
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
      const contentOptions: ContentOptions = {
        includeContent: false,
        snippetTerm: params.search ?? params.query,
      };
      return toToolResult(await shapeDocumentList(client, baseUrl, result, contentOptions));
    },
  };
}

const getDocumentParams = Type.Object({
  id: Type.Integer({ description: "Document id." }),
  fields: fieldsParam,
  include_content: getDocumentIncludeContentParam,
});

export function createGetDocumentTool(handlePromise: Promise<PaperlessClientHandle>): AnyAgentTool {
  return {
    name: "paperless_get_document",
    label: "Get paperless-ngx document",
    description:
      `Fetch a single document by id and its metadata. OCR \`content\` is omitted by default -- ` +
      `pass \`include_content: true\` to get it, capped at the first ${MAX_RANGE_LINES} lines. ` +
      "Prefer paperless_grep_document or paperless_get_document_range over include_content when " +
      "you're after a specific detail rather than the whole document. correspondent/document_type/" +
      "tag ids are automatically resolved to correspondent_name/document_type_name/tag_names " +
      "alongside the ids.",
    parameters: getDocumentParams,
    execute: async (_toolCallId, params: Static<typeof getDocumentParams>) => {
      const { client, baseUrl } = await handlePromise;
      const includeContent = params.include_content ?? false;
      const result = unwrap(
        await client.GET("/api/documents/{id}/", {
          params: {
            path: { id: params.id },
            query: { fields: withContentField(params.fields, includeContent) },
          },
        }),
      );

      let documentForShaping: Record<string, unknown> = result;
      let contentMeta: { content_truncated: true; content_total_lines: number } | undefined;
      if (includeContent && typeof result.content === "string") {
        const capped = capContentForResponse(result.content, MAX_RANGE_LINES);
        documentForShaping = { ...result, content: capped.content };
        if (capped.truncated) {
          contentMeta = { content_truncated: true, content_total_lines: capped.totalLines };
        }
      }

      const contentOptions: ContentOptions = { includeContent };
      const shaped = await shapeSingleDocument(client, baseUrl, documentForShaping, contentOptions);
      return toToolResult(contentMeta ? { ...shaped, ...contentMeta } : shaped);
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
        `response after the fact. OCR \`content\` is omitted from the response unless this list ` +
        `explicitly includes "content", capped at the first ${MAX_RANGE_LINES} lines just like ` +
        "paperless_get_document's include_content.",
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
      'Patch a document\'s title, correspondent, document type, tags, or created date. Only provided top-level fields are changed. Use `tags` to fully replace the tag list, or add_tag_ids/remove_tag_ids to adjust it without disturbing other tags. Does not touch storage_path. OCR `content` is omitted from the response unless `fields` explicitly includes "content".',
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

      // Unlike list/get, update has no separate include_content param --
      // content is omitted by default and only included (capped, same as
      // paperless_get_document) when `fields` explicitly asks for it.
      const wantsContent = fields?.includes("content") ?? false;
      let documentForShaping: Record<string, unknown> = result;
      let contentMeta: { content_truncated: true; content_total_lines: number } | undefined;
      if (wantsContent && typeof result.content === "string") {
        const capped = capContentForResponse(result.content, MAX_RANGE_LINES);
        documentForShaping = { ...result, content: capped.content };
        if (capped.truncated) {
          contentMeta = { content_truncated: true, content_total_lines: capped.totalLines };
        }
      }

      const updateContentOptions: ContentOptions = { includeContent: wantsContent };
      const shaped = pickFields(
        fields,
        await shapeSingleDocument(client, baseUrl, documentForShaping, updateContentOptions),
      );
      return toToolResult(contentMeta ? { ...shaped, ...contentMeta } : shaped);
    },
  };
}

// Fetches only id+content for a document -- used by paperless_grep_document
// and paperless_get_document_range, neither of which need the metadata
// shapeSingleDocument resolves (correspondent/tag names, etc).
// Returns null rather than "" when content is null/missing (document not yet
// OCR'd) -- collapsing that to "" upstream made "no OCR text yet" and "grep
// found nothing" indistinguishable to the calling model.
async function fetchDocumentContent(client: PaperlessClient, id: number): Promise<string | null> {
  const doc = unwrap(
    await client.GET("/api/documents/{id}/", {
      params: { path: { id }, query: { fields: ["id", "content"] } },
    }),
  );
  return typeof doc.content === "string" ? doc.content : null;
}

// Distinguishes "document has no OCR content yet" from "content exists but
// grep/range found nothing in it" for the calling model.
type ContentStatus = "present" | "null" | "empty";

function contentStatusFor(content: string): ContentStatus {
  return content === "" ? "empty" : "present";
}

const MAX_GREP_CONTEXT_LINES = 10;
const DEFAULT_GREP_CONTEXT_LINES = 2;
const MAX_GREP_MATCHES = 100;
const DEFAULT_GREP_MATCHES = 20;

// Node has no built-in regex timeout, so catastrophic backtracking from a
// user/model-supplied pattern can hang the single-threaded plugin process
// for every in-flight call, not just this one. These are static, pre-match
// guards rather than a runtime timeout: a length cap (pathological patterns
// tend to be long, repetitive constructions) and a check for 10+ quantifiers
// anywhere in the pattern (e.g. `a+a+a+a+...`, or nested forms like
// `(a+)+`), which is the shape that produces exponential/polynomial blowup.
const MAX_PATTERN_LENGTH = 500;
const MAX_PATTERN_QUANTIFIERS = 10;

function assertSafePattern(pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `paperless_grep_document: pattern rejected -- longer than ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  const quantifiers = pattern.match(/[*+?]|\{\d+(?:,\d*)?\}/g) ?? [];
  if (quantifiers.length >= MAX_PATTERN_QUANTIFIERS) {
    throw new Error(
      "paperless_grep_document: pattern rejected -- too many repetition operators " +
        "(possible catastrophic backtracking).",
    );
  }
}

const grepDocumentParams = Type.Object({
  id: Type.Integer({ description: "Document id to search within." }),
  pattern: Type.String({
    description:
      `Text or regular expression (JS syntax) to search for, evaluated against each line of the ` +
      `document's OCR content -- like \`grep\`. Capped at ${MAX_PATTERN_LENGTH} characters and ` +
      `rejected if it has ${MAX_PATTERN_QUANTIFIERS}+ repetition operators (*, +, ?, {n,m}), as a ` +
      `guard against catastrophic-backtracking regexes.`,
  }),
  ignore_case: Type.Optional(
    Type.Boolean({ description: "Case-insensitive match. Defaults to true." }),
  ),
  context_lines: Type.Optional(
    Type.Integer({
      description: `Lines of context to include before and after each match, like grep -C. Defaults to ${DEFAULT_GREP_CONTEXT_LINES}, capped at ${MAX_GREP_CONTEXT_LINES}.`,
    }),
  ),
  max_matches: Type.Optional(
    Type.Integer({
      description: `Maximum number of matches to return. Defaults to ${DEFAULT_GREP_MATCHES}, capped at ${MAX_GREP_MATCHES}.`,
    }),
  ),
});

export function createGrepDocumentTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_grep_document",
    label: "Search within a paperless-ngx document",
    description:
      "Search one document's OCR content for a pattern (like `grep -n -C`) without pulling the " +
      "whole document into context. Returns only matching lines plus surrounding context. Prefer " +
      "this over paperless_get_document with include_content=true when " +
      "you're hunting for a specific detail (an amount, a policy number, a clause) inside a " +
      "document you already know the id of. This only trims what's returned to you -- paperless-ngx " +
      "still reads the document's full OCR content server-side to search it. The response's " +
      "`content_status` is 'null' if the document has no OCR content yet (not yet processed; " +
      "matches will always be empty), 'empty' if content is an empty string, or 'present' otherwise.",
    parameters: grepDocumentParams,
    execute: async (_toolCallId, params: Static<typeof grepDocumentParams>) => {
      const { client } = await handlePromise;

      assertSafePattern(params.pattern);
      let regex: RegExp;
      try {
        regex = new RegExp(params.pattern, (params.ignore_case ?? true) ? "i" : "");
      } catch (err) {
        throw new Error(
          `paperless_grep_document: invalid pattern -- ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const rawContent = await fetchDocumentContent(client, params.id);
      if (rawContent === null) {
        return toToolResult({
          document_id: params.id,
          pattern: params.pattern,
          total_lines: 0,
          total_matches: 0,
          matches: [],
          truncated: false,
          content_status: "null" satisfies ContentStatus,
        });
      }
      const content = normalizeLineEndings(rawContent);

      const contextLines = Math.min(
        Math.max(params.context_lines ?? DEFAULT_GREP_CONTEXT_LINES, 0),
        MAX_GREP_CONTEXT_LINES,
      );
      const maxMatches = Math.min(
        Math.max(params.max_matches ?? DEFAULT_GREP_MATCHES, 1),
        MAX_GREP_MATCHES,
      );

      const lines = content.split("\n");
      const matchingLineNumbers: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i] ?? "")) matchingLineNumbers.push(i);
      }

      const matches = matchingLineNumbers.slice(0, maxMatches).map((i) => {
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        return {
          line_number: i + 1,
          line: lines[i] ?? "",
          context: lines.slice(start, end + 1).join("\n"),
        };
      });

      return toToolResult({
        document_id: params.id,
        pattern: params.pattern,
        total_lines: lines.length,
        total_matches: matchingLineNumbers.length,
        matches,
        truncated: matchingLineNumbers.length > matches.length,
        content_status: contentStatusFor(content),
      });
    },
  };
}

const getDocumentRangeParams = Type.Object({
  id: Type.Integer({ description: "Document id." }),
  start_line: Type.Optional(
    Type.Integer({ description: "1-indexed starting line (inclusive). Defaults to 1." }),
  ),
  end_line: Type.Optional(
    Type.Integer({
      description:
        `1-indexed ending line (inclusive). Defaults to start_line + ${DEFAULT_RANGE_LINES - 1}. ` +
        `The span is capped at ${MAX_RANGE_LINES} lines regardless of what's requested.`,
    }),
  ),
});

export function createGetDocumentRangeTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return {
    name: "paperless_get_document_range",
    label: "Get a line range from a paperless-ngx document",
    description:
      "Fetch a specific line range of a document's OCR content -- e.g. to read a section you " +
      "located with paperless_grep_document or a content_snippet from paperless_list_documents. " +
      "Cheaper than paperless_get_document with include_content=true when you only need part of " +
      "a long document -- though this only trims what's returned to you, since paperless-ngx " +
      "still reads the full OCR content server-side. `total_lines` in the response tells you " +
      "whether there's more: if `end_line < total_lines`, call again with " +
      "`start_line: end_line + 1` to page through the rest -- don't assume one call covers the " +
      "whole document. The response's " +
      "`content_status` is 'null' if the document has no OCR content yet (not yet processed; " +
      "content will always be empty), 'empty' if content is an empty string, or 'present' otherwise.",
    parameters: getDocumentRangeParams,
    execute: async (_toolCallId, params: Static<typeof getDocumentRangeParams>) => {
      const { client } = await handlePromise;
      const startLine = Math.max(1, params.start_line ?? 1);

      if (params.end_line !== undefined && params.end_line < startLine) {
        throw new Error(
          `paperless_get_document_range: end_line (${params.end_line}) is before start_line ` +
            `(${startLine}) -- pass an end_line greater than or equal to start_line.`,
        );
      }

      const rawContent = await fetchDocumentContent(client, params.id);
      if (rawContent === null) {
        return toToolResult({
          document_id: params.id,
          start_line: startLine,
          end_line: startLine - 1,
          total_lines: 0,
          content: "",
          content_status: "null" satisfies ContentStatus,
        });
      }
      const content = normalizeLineEndings(rawContent);
      const lines = content.split("\n");

      const requestedEnd = params.end_line ?? startLine + DEFAULT_RANGE_LINES - 1;
      const endLine = Math.max(
        startLine,
        Math.min(requestedEnd, startLine + MAX_RANGE_LINES - 1, lines.length),
      );
      const isEmptyRange = startLine > lines.length;
      const slice = isEmptyRange ? [] : lines.slice(startLine - 1, endLine);

      return toToolResult({
        document_id: params.id,
        start_line: startLine,
        end_line: isEmptyRange ? startLine - 1 : endLine,
        total_lines: lines.length,
        content: slice.join("\n"),
        content_status: contentStatusFor(content),
      });
    },
  };
}
