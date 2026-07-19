import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { PaperlessClient } from "../client.js";
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
  clientPromise: Promise<PaperlessClient>,
  meta: TaxonomyToolMeta,
): AnyAgentTool {
  return {
    name: meta.name,
    label: meta.label,
    description: meta.description,
    parameters: listParams,
    execute: async (_toolCallId, params: Static<typeof listParams>) => {
      const client = await clientPromise;
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

export function createListTagsTool(clientPromise: Promise<PaperlessClient>): AnyAgentTool {
  return createListTaxonomyTool(clientPromise, {
    name: "paperless_list_tags",
    label: "List paperless-ngx tags",
    description: "List existing tags, optionally filtered by name.",
    endpoint: "/api/tags/",
  });
}

export function createListCorrespondentsTool(
  clientPromise: Promise<PaperlessClient>,
): AnyAgentTool {
  return createListTaxonomyTool(clientPromise, {
    name: "paperless_list_correspondents",
    label: "List paperless-ngx correspondents",
    description: "List existing correspondents, optionally filtered by name.",
    endpoint: "/api/correspondents/",
  });
}

export function createListDocumentTypesTool(clientPromise: Promise<PaperlessClient>): AnyAgentTool {
  return createListTaxonomyTool(clientPromise, {
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
  clientPromise: Promise<PaperlessClient>,
  meta: TaxonomyToolMeta,
): AnyAgentTool {
  return {
    name: meta.name,
    label: meta.label,
    description: meta.description,
    parameters: createNamedParams,
    execute: async (_toolCallId, params: Static<typeof createNamedParams>) => {
      const client = await clientPromise;
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
  clientPromise: Promise<PaperlessClient>,
): AnyAgentTool {
  return createCreateTaxonomyTool(clientPromise, {
    name: "paperless_create_correspondent",
    label: "Create paperless-ngx correspondent",
    description:
      "Create a new correspondent. Check paperless_list_correspondents first to avoid creating a near-duplicate of an existing one.",
    endpoint: "/api/correspondents/",
  });
}

export function createCreateDocumentTypeTool(
  clientPromise: Promise<PaperlessClient>,
): AnyAgentTool {
  return createCreateTaxonomyTool(clientPromise, {
    name: "paperless_create_document_type",
    label: "Create paperless-ngx document type",
    description:
      "Create a new document type. Check paperless_list_document_types first to avoid creating a near-duplicate of an existing one.",
    endpoint: "/api/document_types/",
  });
}

export function createCreateTagTool(clientPromise: Promise<PaperlessClient>): AnyAgentTool {
  return createCreateTaxonomyTool(clientPromise, {
    name: "paperless_create_tag",
    label: "Create paperless-ngx tag",
    description:
      "Create a new tag. Check paperless_list_tags first to avoid creating a near-duplicate of an existing one.",
    endpoint: "/api/tags/",
  });
}
