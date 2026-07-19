import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import { createPaperlessClient } from "./client.js";
import {
  createGetDocumentTool,
  createListDocumentsTool,
  createUpdateDocumentTool,
} from "./tools/documents.js";
import {
  createCreateCorrespondentTool,
  createCreateDocumentTypeTool,
  createCreateTagTool,
  createListCorrespondentsTool,
  createListDocumentTypesTool,
  createListTagsTool,
} from "./tools/taxonomy.js";

const configSchema = Type.Object({
  baseUrl: Type.String({
    description: "Base URL of the paperless-ngx instance, e.g. https://paperless.example.com",
  }),
  apiToken: Type.String({ description: "paperless-ngx API token" }),
});

export type PaperlessPluginConfig = Static<typeof configSchema>;

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "paperless-ngx",
  name: "paperless-ngx",
  description: "Tools for reading and updating documents in a paperless-ngx instance.",
  // TypeBox schemas are structurally JSON Schema but don't carry a string
  // index signature, which is all JsonSchemaObject adds on top of TSchema.
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  register(api) {
    const config = api.pluginConfig as PaperlessPluginConfig;
    const client = createPaperlessClient(config);

    api.registerTool(createListDocumentsTool(client));
    api.registerTool(createGetDocumentTool(client));
    api.registerTool(createUpdateDocumentTool(client));
    api.registerTool(createListTagsTool(client));
    api.registerTool(createCreateTagTool(client));
    api.registerTool(createListCorrespondentsTool(client));
    api.registerTool(createCreateCorrespondentTool(client));
    api.registerTool(createListDocumentTypesTool(client));
    api.registerTool(createCreateDocumentTypeTool(client));
  },
});

export default entry;
