import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { paginationParams } from "./pagination.js";

type TaxonomyEndpoint = "/api/tags/" | "/api/correspondents/" | "/api/document_types/";

const listParams = Type.Object({
  name_contains: Type.Optional(
    Type.String({ description: "Case-insensitive name substring filter." }),
  ),
  ...paginationParams,
});

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
      return toToolResult(result);
    },
  };
}

export function createListTagsTool(handlePromise: Promise<PaperlessClientHandle>): AnyAgentTool {
  return createListTaxonomyTool(handlePromise, {
    name: "paperless_list_tags",
    label: "List paperless-ngx tags",
    description: "List existing tags, optionally filtered by name.",
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
      return toToolResult(result);
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
