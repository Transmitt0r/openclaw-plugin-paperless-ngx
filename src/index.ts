import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import { Type } from "typebox";
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

export type PaperlessPluginConfig = {
  baseUrl: string;
  apiToken: string;
};

// Manifest-facing schema: apiToken accepts a plain string OR a SecretRef
// object (e.g. `openclaw config set ... --ref-provider default --ref-source
// env --ref-id PAPERLESS_TOKEN`), matching how other secret-capable bundled
// plugins (e.g. brave's webSearch.apiKey) type their sensitive fields as
// `["string", "object"]` so config validation doesn't reject an unresolved
// ref at set-time. Despite the field being marked sensitive, OpenClaw does
// NOT resolve it before handing config to register() -- that has to happen
// explicitly, see resolveApiToken below.
const configSchema = Type.Object({
  baseUrl: Type.String({
    description: "Base URL of the paperless-ngx instance, e.g. https://paperless.example.com",
  }),
  apiToken: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })], {
    description: "paperless-ngx API token, as a plain string or a SecretRef object",
  }),
});

async function resolveApiToken(api: OpenClawPluginApi, value: unknown): Promise<string> {
  if (!isSecretRef(value)) {
    return value as string;
  }
  const resolved = await resolveSecretRefValues([value], { config: api.config });
  const [resolvedValue] = resolved.values();
  if (typeof resolvedValue !== "string") {
    throw new Error("paperless-ngx: apiToken SecretRef did not resolve to a string");
  }
  return resolvedValue;
}

const entry: OpenClawPluginDefinition = definePluginEntry({
  id: "paperless-ngx",
  name: "paperless-ngx",
  description: "Tools for reading and updating documents in a paperless-ngx instance.",
  // TypeBox schemas are structurally JSON Schema but don't carry a string
  // index signature, which is all JsonSchemaObject adds on top of TSchema.
  configSchema: buildJsonPluginConfigSchema(
    configSchema as unknown as Parameters<typeof buildJsonPluginConfigSchema>[0],
  ),
  // definePluginEntry types register() as returning void, but that's the
  // standard TS accommodation for fire-and-forget async handlers -- the
  // host awaits it before considering the plugin loaded.
  async register(api) {
    const rawConfig = api.pluginConfig as { baseUrl: string; apiToken: unknown };
    const config: PaperlessPluginConfig = {
      baseUrl: rawConfig.baseUrl,
      apiToken: await resolveApiToken(api, rawConfig.apiToken),
    };
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
