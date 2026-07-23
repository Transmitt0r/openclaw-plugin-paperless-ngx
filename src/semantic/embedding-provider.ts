import type {
  MemoryEmbeddingProvider,
  MemoryEmbeddingProviderAdapter,
} from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { getMemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import type { OpenClawConfig, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export type EmbeddingProviderHandleOptions = {
  config: OpenClawConfig;
  providerId: string;
  model: string;
  dimensions: number;
  idleUnloadMs: number;
  logger?: PluginLogger;
  // Overridable for tests -- defaults to the real SDK registry lookup
  // (openclaw/plugin-sdk/memory-core-host-engine-embeddings' own
  // getMemoryEmbeddingProvider), which is where the "local" adapter behind
  // EmbeddingGemma-300m / DEFAULT_LOCAL_MODEL is registered.
  resolveAdapter?: (id: string, cfg: OpenClawConfig) => MemoryEmbeddingProviderAdapter | undefined;
};

// Lazily creates the embedding provider on first use and unloads it again
// (provider.close()) after `idleUnloadMs` of inactivity. The local
// EmbeddingGemma-300m model costs ~400-500MB RSS while loaded, which a
// 4GB reference box shouldn't pay for while semantic search sits idle
// between searches/sync passes.
export class EmbeddingProviderHandle {
  readonly providerId: string;
  readonly model: string;
  readonly dimensions: number;

  private readonly config: OpenClawConfig;
  private readonly idleUnloadMs: number;
  private readonly logger: PluginLogger | undefined;
  private readonly resolveAdapter: (
    id: string,
    cfg: OpenClawConfig,
  ) => MemoryEmbeddingProviderAdapter | undefined;

  private provider: MemoryEmbeddingProvider | null = null;
  private loadingPromise: Promise<MemoryEmbeddingProvider> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EmbeddingProviderHandleOptions) {
    this.providerId = options.providerId;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.config = options.config;
    this.idleUnloadMs = options.idleUnloadMs;
    this.logger = options.logger;
    this.resolveAdapter = options.resolveAdapter ?? getMemoryEmbeddingProvider;
  }

  async embedQuery(text: string, options?: { signal?: AbortSignal }): Promise<number[]> {
    const provider = await this.ensureLoaded();
    return provider.embedQuery(text, options);
  }

  async embedBatch(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]> {
    const provider = await this.ensureLoaded();
    return provider.embedBatch(texts, options);
  }

  private async ensureLoaded(): Promise<MemoryEmbeddingProvider> {
    this.scheduleIdleUnload();
    if (this.provider) return this.provider;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const adapter = this.resolveAdapter(this.providerId, this.config);
      if (!adapter) {
        throw new Error(
          `semantic search: no embedding provider adapter registered for id "${this.providerId}"`,
        );
      }
      const { provider } = await adapter.create({
        config: this.config,
        model: this.model,
        outputDimensionality: this.dimensions,
      });
      if (!provider) {
        throw new Error(
          `semantic search: embedding provider "${this.providerId}" failed to initialize`,
        );
      }
      return provider;
    })();

    try {
      this.provider = await this.loadingPromise;
      return this.provider;
    } finally {
      this.loadingPromise = null;
    }
  }

  private scheduleIdleUnload(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.unload().catch((err) => {
        this.logger?.warn(
          `semantic search: idle-unload of embedding provider failed: ${String(err)}`,
        );
      });
    }, this.idleUnloadMs);
    // Node-only plugin; never let this timer keep the process alive.
    this.idleTimer.unref?.();
  }

  async unload(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const provider = this.provider;
    this.provider = null;
    if (provider?.close) {
      await provider.close();
    }
  }

  async dispose(): Promise<void> {
    await this.unload();
  }
}
