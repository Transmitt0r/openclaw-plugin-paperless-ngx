import createClient from "openapi-fetch";
import type { paths } from "./generated/paperless-schema.js";

export type PaperlessClientConfig = {
  baseUrl: string;
  apiToken: string;
};

export type PaperlessClient = ReturnType<typeof createClient<paths>>;

export function createPaperlessClient(config: PaperlessClientConfig): PaperlessClient {
  return createClient<paths>({
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    headers: {
      Authorization: `Token ${config.apiToken}`,
    },
  });
}

/**
 * openapi-fetch returns { data, error } instead of throwing on non-2xx
 * responses. AgentTool.execute is expected to throw on failure, so tools
 * route their results through this instead of checking `error` by hand.
 */
export function unwrap<T>({ data, error }: { data?: T; error?: unknown }): T {
  if (error !== undefined) {
    const detail = typeof error === "string" ? error : JSON.stringify(error);
    throw new Error(`paperless-ngx API error: ${detail}`);
  }
  if (data === undefined) {
    throw new Error("paperless-ngx API returned no data");
  }
  return data;
}
