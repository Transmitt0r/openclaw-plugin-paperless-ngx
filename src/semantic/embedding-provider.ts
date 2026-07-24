import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

// This plugin bundles node-llama-cpp directly (a real dependency in
// package.json) rather than resolving a "local" embedding provider through
// any shared OpenClaw host registry. That registry path was tried first
// and abandoned: it requires installing and enabling a *separate* plugin
// (the host's own llama.cpp provider), editing that plugin's own
// (memory-core) config namespace as a side effect of wanting document
// search, and depends on the host correctly activating a lazily-activated
// plugin -- which a live production deployment showed does not reliably
// happen for a long-running gateway process (a one-shot CLI invocation in
// the same environment resolved the provider correctly; the persistent
// gateway process never did, across multiple restarts). None of that is
// this plugin's own logic to fix. Depending on node-llama-cpp directly
// means "install this one plugin" is the whole story: no other plugin, no
// cross-plugin config, no activation-timing dependency on the host.
export const EMBEDDING_PROVIDER_ID = "node-llama-cpp";

// The minimal slice of node-llama-cpp's API this module needs (getLlama()
// for a backend instance, resolveModelFile() to fetch/locate a model from
// an `hf:` URI or local path with its own on-disk cache, model.loadModel(),
// model.createEmbeddingContext(), context.getEmbeddingFor()), mirrored from
// how OpenClaw's own (now-abandoned, see above) local-embedding code drove
// it. Derived from node-llama-cpp's own real types (`typeof import(...)`,
// not a hand-copied interface) so a future node-llama-cpp upgrade that
// actually changes this shape fails loudly at build time instead of
// silently drifting.
type NodeLlamaCppModule = Pick<typeof import("node-llama-cpp"), "getLlama" | "resolveModelFile">;
type Llama = Awaited<ReturnType<NodeLlamaCppModule["getLlama"]>>;
type LlamaModel = Awaited<ReturnType<Llama["loadModel"]>>;
type LlamaEmbeddingContext = Awaited<ReturnType<LlamaModel["createEmbeddingContext"]>>;

// Lazy (not top-level static) import -- the native module is only loaded
// the first time semantic search actually needs to embed something, same
// as the rest of this class's lazy-load behavior.
async function importNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
  return import("node-llama-cpp");
}

export type EmbeddingProviderHandleOptions = {
  model: string;
  dimensions: number;
  idleUnloadMs: number;
  modelCacheDir?: string;
  contextSize?: number;
  logger?: PluginLogger;
  // Overridable for tests -- defaults to the real dynamic import above, so
  // tests can inject a fake Llama/model/embedding-context without loading
  // (or downloading) a real model.
  loadModule?: () => Promise<NodeLlamaCppModule>;
};

// Lazily creates the embedding context on first use and unloads it again
// after `idleUnloadMs` of inactivity. The local EmbeddingGemma-300m model
// costs ~400-500MB RSS while loaded, which a 4GB reference box shouldn't
// pay for while semantic search sits idle between searches/sync passes.
//
// EmbeddingGemma's native embedding width is 768; `dimensions` (256 by
// default) is achieved by Matryoshka truncation -- node-llama-cpp has no
// built-in output-dimensionality option for embeddings, so this class
// truncates the raw vector to the first `dimensions` values and
// L2-renormalizes it itself (truncateAndNormalize below). A Matryoshka-
// trained model's leading dimensions remain a valid, independently-usable
// embedding under cosine similarity once renormalized -- that's the whole
// point of MRL training -- so this is not an approximation of a "real"
// truncation strategy, it's the intended one.
export class EmbeddingProviderHandle {
  readonly model: string;
  readonly dimensions: number;

  private readonly modelCacheDir: string | undefined;
  private readonly contextSize: number | undefined;
  private readonly idleUnloadMs: number;
  private readonly logger: PluginLogger | undefined;
  private readonly loadModule: () => Promise<NodeLlamaCppModule>;

  // Kept separate from `context` so an idle unload doesn't have to spin the
  // native backend back up on next use, only reload the model + context --
  // the Llama instance itself is a lightweight bindings handle, not the
  // ~400-500MB of loaded model weights.
  private llama: Llama | null = null;
  private loadedModel: LlamaModel | null = null;
  private context: LlamaEmbeddingContext | null = null;
  private loadingPromise: Promise<LlamaEmbeddingContext> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: EmbeddingProviderHandleOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.modelCacheDir = options.modelCacheDir;
    this.contextSize = options.contextSize;
    this.idleUnloadMs = options.idleUnloadMs;
    this.logger = options.logger;
    this.loadModule = options.loadModule ?? importNodeLlamaCpp;
  }

  async embedQuery(text: string): Promise<number[]> {
    const context = await this.ensureLoaded();
    const embedding = await context.getEmbeddingFor(text);
    return truncateAndNormalize(embedding.vector, this.dimensions);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const context = await this.ensureLoaded();
    const vectors: number[][] = [];
    // node-llama-cpp's embedding context has no batch-call API of its own
    // (unlike the remote/registry embed providers this replaced) -- each
    // call is one getEmbeddingFor(), issued sequentially against the one
    // warm context rather than fanning out concurrent native calls.
    for (const text of texts) {
      const embedding = await context.getEmbeddingFor(text);
      vectors.push(truncateAndNormalize(embedding.vector, this.dimensions));
    }
    return vectors;
  }

  private async ensureLoaded(): Promise<LlamaEmbeddingContext> {
    this.scheduleIdleUnload();
    if (this.context) return this.context;
    if (this.loadingPromise) return this.loadingPromise;

    this.loadingPromise = (async () => {
      const { getLlama, resolveModelFile } = await this.loadModule();
      const llama = this.llama ?? (await getLlama());
      this.llama = llama;

      const resolvedPath = await resolveModelFile(
        this.model,
        this.modelCacheDir ? { directory: this.modelCacheDir } : undefined,
      );
      const loadedModel = await llama.loadModel({ modelPath: resolvedPath });
      this.loadedModel = loadedModel;

      return loadedModel.createEmbeddingContext(
        this.contextSize !== undefined ? { contextSize: this.contextSize } : {},
      );
    })();

    try {
      this.context = await this.loadingPromise;
      return this.context;
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

  // Frees the loaded model + embedding context (the ~400-500MB) but keeps
  // the `Llama` backend handle itself so a subsequent embedQuery/embedBatch
  // doesn't pay to reinitialize the native backend, only to reload the
  // model.
  async unload(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const context = this.context;
    const model = this.loadedModel;
    this.context = null;
    this.loadedModel = null;
    if (context?.dispose) await context.dispose();
    if (model?.dispose) await model.dispose();
  }

  async dispose(): Promise<void> {
    await this.unload();
  }
}

// Matryoshka truncation: keep the first `dimensions` values of the raw
// (native-width) embedding vector and L2-renormalize so the truncated
// vector is itself a unit vector -- cosine similarity over it stays
// meaningful, matching how the store's KNN scan (vec_distance_cosine)
// expects to compare vectors.
function truncateAndNormalize(vector: readonly number[], dimensions: number): number[] {
  const truncated = vector.slice(0, dimensions);
  let sumOfSquares = 0;
  for (const value of truncated) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (norm === 0) return truncated;
  return truncated.map((value) => value / norm);
}
