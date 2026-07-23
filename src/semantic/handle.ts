import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { PaperlessClientHandle } from "../client.js";
import { EmbeddingProviderHandle } from "./embedding-provider.js";
import { searchSemantic } from "./search.js";
import { SemanticIndexStore } from "./store.js";
import { runIncrementalSync } from "./sync.js";
import type { IndexIdentity, SemanticMatch, SemanticSearchConfig } from "./types.js";
import { DEFAULT_SEMANTIC_SEARCH_CONFIG, identitiesMatch } from "./types.js";

export type SemanticSearchPluginConfig = {
  enabled?: boolean;
  indexPath?: string;
};

export type SemanticSearchHandle = {
  // False whenever the semantic backend couldn't come up for any reason
  // (disabled by config, Node runtime without node:sqlite, sqlite-vec
  // failed to load, no embedding provider registered, ...). `search`
  // still exists and is always safe to call -- it just always resolves to
  // `[]`, which is exactly the pre-existing stub behavior
  // paperless_search_documents already tolerates.
  available: boolean;
  search: (searchTerm: string | undefined, limit: number) => Promise<SemanticMatch[]>;
  dispose: () => Promise<void>;
};

function unavailableHandle(): SemanticSearchHandle {
  return {
    available: false,
    search: async () => [],
    dispose: async () => {},
  };
}

function resolveConfig(raw: SemanticSearchPluginConfig | undefined): SemanticSearchConfig & {
  enabled: boolean;
} {
  const indexPath =
    raw?.indexPath ??
    path.join(os.homedir(), ".openclaw", "plugins", "paperless-ngx", "semantic-index.db");
  return {
    ...DEFAULT_SEMANTIC_SEARCH_CONFIG,
    enabled: raw?.enabled ?? DEFAULT_SEMANTIC_SEARCH_CONFIG.enabled,
    indexPath,
  };
}

function candidateIdentity(config: SemanticSearchConfig): IndexIdentity {
  return {
    providerId: config.providerId,
    model: config.model,
    dimensions: config.dimensions,
    chunkTokens: config.chunkTokens,
    chunkOverlap: config.chunkOverlap,
  };
}

// Builds the semantic-search backend the same way index.ts builds the
// paperless client handle: register() stays synchronous, this kicks off
// async setup without awaiting it, and hands back a promise every tool
// execute() can await once and reuse. `clientHandlePromise` is the same
// promise threaded into the paperless tools -- sync needs the paperless
// client too, so setup here waits on it internally rather than duplicating
// client construction.
export function createSemanticSearchHandle(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<PaperlessClientHandle>,
): Promise<SemanticSearchHandle> {
  const rawConfig = (
    api.pluginConfig as { semanticSearch?: SemanticSearchPluginConfig } | undefined
  )?.semanticSearch;
  const config = resolveConfig(rawConfig);
  // Falls back to a no-op logger rather than assuming api.logger is always
  // set -- register() must never throw or produce an unhandled rejection
  // just because logging is unavailable in whatever hosted this plugin.
  const logger: PluginLogger = api.logger ?? {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  if (!config.enabled) {
    return Promise.resolve(unavailableHandle());
  }

  return setup(api, clientHandlePromise, config, logger).catch((err) => {
    logger.warn(
      `semantic search: setup failed, falling back to lexical-only search: ${describe(err)}`,
    );
    return unavailableHandle();
  });
}

async function setup(
  api: OpenClawPluginApi,
  clientHandlePromise: Promise<PaperlessClientHandle>,
  config: SemanticSearchConfig,
  logger: PluginLogger,
): Promise<SemanticSearchHandle> {
  const opened = await SemanticIndexStore.open(config.indexPath, config.dimensions);
  if (!opened.available) {
    logger.warn(
      `semantic search: index unavailable, falling back to lexical-only search: ${opened.reason}`,
    );
    return unavailableHandle();
  }
  const { store } = opened;

  const embeddingProvider = new EmbeddingProviderHandle({
    config: api.config,
    providerId: config.providerId,
    model: config.model,
    dimensions: config.dimensions,
    idleUnloadMs: config.idleUnloadMs,
    logger,
  });

  const identity = candidateIdentity(config);
  const storedIdentity = store.getIdentity();
  if (!storedIdentity || !identitiesMatch(storedIdentity, identity)) {
    logger.info?.(
      storedIdentity
        ? "semantic search: embedding/chunking config changed, rebuilding index from scratch"
        : "semantic search: no existing index, starting a fresh backfill",
    );
    store.rebuild(identity);
  }

  let syncInFlight = false;
  const runSyncPass = async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      const { client } = await clientHandlePromise;
      const summary = await runIncrementalSync({
        client,
        store,
        embeddingProvider,
        config,
        logger,
      });
      logger.info?.(
        `semantic search: sync pass complete (processed=${summary.processed}, ` +
          `skipped=${summary.skippedUnchanged}, failed=${summary.failed})`,
      );
    } catch (err) {
      logger.warn(`semantic search: sync pass failed: ${describe(err)}`);
    } finally {
      syncInFlight = false;
    }
  };

  // Kick off an initial pass in the background rather than blocking tool
  // registration on a full backfill -- the first search after plugin load
  // may simply find nothing semantic yet, which is no worse than the
  // lexical-only behavior this replaces.
  void runSyncPass();

  const interval = setInterval(() => void runSyncPass(), config.syncIntervalMs);
  interval.unref?.();

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    await embeddingProvider.dispose();
    store.close();
  };

  api.lifecycle.registerRuntimeLifecycle({
    id: "paperless-ngx-semantic-search",
    description: "Closes the semantic search index and unloads the embedding provider on shutdown.",
    cleanup: () => dispose(),
  });

  return {
    available: true,
    search: (searchTerm, limit) =>
      searchSemantic(
        { store, embeddingProvider, queryTimeoutMs: config.queryTimeoutMs, logger },
        searchTerm,
        limit,
      ),
    dispose,
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
