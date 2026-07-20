import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient, PaperlessClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { paginationParams } from "./pagination.js";
import { fetchNameMap } from "./relations.js";

type TaxonomyEndpoint = "/api/tags/" | "/api/correspondents/" | "/api/document_types/";

const listParams = Type.Object({
  name_contains: Type.Optional(
    Type.String({ description: "Case-insensitive name substring filter." }),
  ),
  ...paginationParams,
});

// owner/permissions are ACL metadata: not settable via any tool in this
// plugin and not relevant to taxonomy lookups -- stripped for the same
// reason as on documents (see shapeDocument in documents.ts).
function stripAcl<T extends Record<string, unknown>>(item: T): Omit<T, "owner" | "permissions"> {
  const { owner: _owner, permissions: _permissions, ...rest } = item;
  return rest;
}

// Tags can be hierarchical (parent/children), carried as bare ids just like
// documents' correspondent/document_type/tags. Resolved the same way: batch
// id__in lookups against /api/tags/ itself.
function collectTagHierarchyIds(tags: Record<string, unknown>[]): number[] {
  const ids = new Set<number>();
  for (const tag of tags) {
    if (typeof tag.parent === "number") ids.add(tag.parent);
    if (Array.isArray(tag.children)) {
      for (const childId of tag.children) {
        if (typeof childId === "number") ids.add(childId);
      }
    }
  }
  return [...ids];
}

function shapeTag<T extends Record<string, unknown>>(
  tagNames: Map<number, string>,
  tag: T,
): Record<string, unknown> {
  const { parent, children } = tag;
  return {
    ...stripAcl(tag),
    ...(typeof parent === "number" && tagNames.has(parent)
      ? { parent_name: tagNames.get(parent) }
      : {}),
    ...(Array.isArray(children)
      ? {
          children_names: children
            .filter(
              (childId): childId is number => typeof childId === "number" && tagNames.has(childId),
            )
            .map((childId) => tagNames.get(childId)),
        }
      : {}),
  };
}

async function shapeTagList<T extends { results?: unknown[] }>(
  client: PaperlessClient,
  response: T,
): Promise<T> {
  const tags = Array.isArray(response.results)
    ? (response.results as Record<string, unknown>[])
    : [];
  const tagNames = await fetchNameMap(client, "/api/tags/", collectTagHierarchyIds(tags));
  return {
    ...response,
    results: tags.map((tag) => shapeTag(tagNames, tag)),
  };
}

async function shapeSingleTag(
  client: PaperlessClient,
  tag: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tagNames = await fetchNameMap(client, "/api/tags/", collectTagHierarchyIds([tag]));
  return shapeTag(tagNames, tag);
}

type TaxonomyToolMeta = {
  name: string;
  label: string;
  description: string;
  endpoint: TaxonomyEndpoint;
};

function createListTaxonomyTool(
  handlePromise: Promise<PaperlessClientHandle>,
  meta: TaxonomyToolMeta,
): AnyAgentTool {
  return {
    name: meta.name,
    label: meta.label,
    description: meta.description,
    parameters: listParams,
    execute: async (_toolCallId, params: Static<typeof listParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.GET(meta.endpoint, {
          params: {
            query: {
              name__icontains: params.name_contains,
              page: params.page,
              page_size: params.page_size,
            },
          },
        }),
      );
      if (meta.endpoint === "/api/tags/") {
        return toToolResult(await shapeTagList(client, result));
      }
      return toToolResult({
        ...result,
        results: Array.isArray(result.results) ? result.results.map(stripAcl) : result.results,
      });
    },
  };
}

export function createListTagsTool(handlePromise: Promise<PaperlessClientHandle>): AnyAgentTool {
  return createListTaxonomyTool(handlePromise, {
    name: "paperless_list_tags",
    label: "List paperless-ngx tags",
    description:
      "List existing tags, optionally filtered by name. parent/children tag ids are automatically resolved to parent_name/children_names alongside the ids.",
    endpoint: "/api/tags/",
  });
}

export function createListCorrespondentsTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return createListTaxonomyTool(handlePromise, {
    name: "paperless_list_correspondents",
    label: "List paperless-ngx correspondents",
    description: "List existing correspondents, optionally filtered by name.",
    endpoint: "/api/correspondents/",
  });
}

export function createListDocumentTypesTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return createListTaxonomyTool(handlePromise, {
    name: "paperless_list_document_types",
    label: "List paperless-ngx document types",
    description: "List existing document types, optionally filtered by name.",
    endpoint: "/api/document_types/",
  });
}

const createNamedParams = Type.Object({
  name: Type.String({ description: "Name of the new entry." }),
});

function createCreateTaxonomyTool(
  handlePromise: Promise<PaperlessClientHandle>,
  meta: TaxonomyToolMeta,
): AnyAgentTool {
  return {
    name: meta.name,
    label: meta.label,
    description: meta.description,
    parameters: createNamedParams,
    execute: async (_toolCallId, params: Static<typeof createNamedParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.POST(meta.endpoint, {
          body: { name: params.name },
        }),
      );
      if (meta.endpoint === "/api/tags/") {
        return toToolResult(await shapeSingleTag(client, result));
      }
      return toToolResult(stripAcl(result));
    },
  };
}

export function createCreateCorrespondentTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return createCreateTaxonomyTool(handlePromise, {
    name: "paperless_create_correspondent",
    label: "Create paperless-ngx correspondent",
    description:
      "Create a new correspondent. Check paperless_list_correspondents first to avoid creating a near-duplicate of an existing one.",
    endpoint: "/api/correspondents/",
  });
}

export function createCreateDocumentTypeTool(
  handlePromise: Promise<PaperlessClientHandle>,
): AnyAgentTool {
  return createCreateTaxonomyTool(handlePromise, {
    name: "paperless_create_document_type",
    label: "Create paperless-ngx document type",
    description:
      "Create a new document type. Check paperless_list_document_types first to avoid creating a near-duplicate of an existing one.",
    endpoint: "/api/document_types/",
  });
}

export function createCreateTagTool(handlePromise: Promise<PaperlessClientHandle>): AnyAgentTool {
  return createCreateTaxonomyTool(handlePromise, {
    name: "paperless_create_tag",
    label: "Create paperless-ngx tag",
    description:
      "Create a new tag. Check paperless_list_tags first to avoid creating a near-duplicate of an existing one.",
    endpoint: "/api/tags/",
  });
}
