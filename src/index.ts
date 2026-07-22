import {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import { Type } from "typebox";
import { createPaperlessClient, type PaperlessClientHandle } from "./client.js";
import {
  createGetDocumentRangeTool,
  createGetDocumentTool,
  createGrepDocumentTool,
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

// register() must be synchronous (the host throws "plugin register must be
// synchronous" otherwise), so the client can't be built eagerly there when
// apiToken might be an unresolved SecretRef needing an async lookup.
// Instead, kick off resolution here without awaiting it and hand tools the
// in-flight promise -- each tool's execute() (already async) awaits it,
// resolving once and reusing the result for every subsequent call.
function createClientHandle(api: OpenClawPluginApi): Promise<PaperlessClientHandle> {
  const rawConfig = api.pluginConfig as { baseUrl: string; apiToken: unknown };
  const baseUrl = rawConfig.baseUrl.replace(/\/+$/, "");
  return resolveApiToken(api, rawConfig.apiToken).then((apiToken) => ({
    client: createPaperlessClient({ baseUrl: rawConfig.baseUrl, apiToken }),
    baseUrl,
  }));
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
  register(api) {
    const handle = createClientHandle(api);

    api.registerTool(createListDocumentsTool(handle));
    api.registerTool(createGetDocumentTool(handle));
    api.registerTool(createUpdateDocumentTool(handle));
    api.registerTool(createGrepDocumentTool(handle));
    api.registerTool(createGetDocumentRangeTool(handle));
    api.registerTool(createListTagsTool(handle));
    api.registerTool(createCreateTagTool(handle));
    api.registerTool(createListCorrespondentsTool(handle));
    api.registerTool(createCreateCorrespondentTool(handle));
    api.registerTool(createListDocumentTypesTool(handle));
    api.registerTool(createCreateDocumentTypeTool(handle));
  },
});

export default entry;
