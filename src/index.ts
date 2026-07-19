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

// What register() actually receives at runtime: OpenClaw resolves any
// SecretRef in config down to a plain string before handing it to plugin
// code, so this stays strict even though the manifest-facing schema below
// has to accept the unresolved SecretRef shape too.
const runtimeConfigShape = Type.Object({
  baseUrl: Type.String({
    description: "Base URL of the paperless-ngx instance, e.g. https://paperless.example.com",
  }),
  apiToken: Type.String({ description: "paperless-ngx API token" }),
});

export type PaperlessPluginConfig = Static<typeof runtimeConfigShape>;

// Manifest-facing schema: apiToken accepts a plain string OR a SecretRef
// object (e.g. `openclaw config set ... --ref-provider default --ref-source
// env --ref-id PAPERLESS_TOKEN`), matching how other secret-capable bundled
// plugins (e.g. brave's webSearch.apiKey) type their sensitive fields as
// `["string", "object"]` so config validation doesn't reject an unresolved
// ref at set-time.
const configSchema = Type.Object({
  baseUrl: Type.String({
    description: "Base URL of the paperless-ngx instance, e.g. https://paperless.example.com",
  }),
  apiToken: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
    description: "paperless-ngx API token, as a plain string or a SecretRef object",
  }),
});

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
