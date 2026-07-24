import {
  chunkMarkdown,
  hashText,
  runWithConcurrency,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PaperlessClient } from "../client.js";
import { unwrap } from "../client.js";
import { MAX_PAGE_SIZE } from "../tools/pagination.js";
import type { EmbeddingProviderHandle } from "./embedding-provider.js";
import type { SemanticIndexStore, UpsertChunk } from "./store.js";
import type { SemanticSearchConfig } from "./types.js";

// Mirrors documents.ts's normalizeLineEndings (not imported directly to
// avoid a src/semantic -> src/tools dependency edge) so chunk line numbers
// agree with what paperless_read_document numbers lines against.
function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export type SyncLogger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
};

export type SyncSummary = {
  processed: number;
  skippedUnchanged: number;
  failed: number;
  pagesFetched: number;
  reachedEnd: boolean;
};

export type RunSyncParams = {
  client: PaperlessClient;
  store: SemanticIndexStore;
  embeddingProvider: EmbeddingProviderHandle;
  config: Pick<
    SemanticSearchConfig,
    "chunkTokens" | "chunkOverlap" | "maxDocumentsPerSync" | "embedConcurrency"
  >;
  logger?: SyncLogger;
};

type DocumentRow = { id: number; modified: string; content: string | null };

// One incremental pass over paperless's corpus: fetches documents modified
// since the stored watermark (unset on first run -- a full backfill),
// newest-first, short-circuits re-embedding when OCR content is unchanged
// (a tag/title edit bumps `modified` without touching `content`), and
// chunks+embeds+stores the rest. Bounded to `maxDocumentsPerSync` per call
// so one pass can't monopolize a small box indefinitely; the watermark
// only advances once a full page of concurrent work completes, so an
// interrupted run safely re-attempts at most one page's worth of documents
// (cheaply, thanks to the content-hash short-circuit) rather than losing
// its place.
export async function runIncrementalSync(params: RunSyncParams): Promise<SyncSummary> {
  const { client, store, embeddingProvider, config, logger } = params;
  const summary: SyncSummary = {
    processed: 0,
    skippedUnchanged: 0,
    failed: 0,
    pagesFetched: 0,
    reachedEnd: false,
  };

  const { watermark } = store.getSyncState();
  let page = 1;

  while (
    summary.processed + summary.skippedUnchanged + summary.failed <
    config.maxDocumentsPerSync
  ) {
    const remaining =
      config.maxDocumentsPerSync - (summary.processed + summary.skippedUnchanged + summary.failed);
    const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, remaining));

    const result = unwrap(
      await client.GET("/api/documents/", {
        params: {
          query: {
            ordering: "-modified",
            modified__gt: watermark,
            page,
            page_size: pageSize,
            fields: ["id", "modified", "content"],
          },
        },
      }),
    );
    summary.pagesFetched += 1;

    const rawResults: Record<string, unknown>[] = Array.isArray(result.results)
      ? result.results
      : [];
    const rows: DocumentRow[] = [];
    for (const doc of rawResults) {
      if (typeof doc.id === "number" && typeof doc.modified === "string") {
        rows.push({
          id: doc.id,
          modified: doc.modified,
          content: typeof doc.content === "string" ? doc.content : null,
        });
      }
    }

    if (rows.length === 0) {
      summary.reachedEnd = true;
      break;
    }

    await processPage(rows, { store, embeddingProvider, config, logger, summary });

    // Newest-first ordering means the last row is the oldest in this page;
    // once every task in the page has settled, it's safe to move the
    // watermark up to that boundary.
    const oldestInPage = rows.at(-1);
    if (oldestInPage) {
      store.setSyncState(oldestInPage.modified, oldestInPage.id);
    }

    if (!result.next) {
      summary.reachedEnd = true;
      break;
    }
    page += 1;
  }

  return summary;
}

async function processPage(
  rows: DocumentRow[],
  params: {
    store: SemanticIndexStore;
    embeddingProvider: EmbeddingProviderHandle;
    config: RunSyncParams["config"];
    logger?: SyncLogger;
    summary: SyncSummary;
  },
): Promise<void> {
  const { store, embeddingProvider, config, logger, summary } = params;
  const tasks = rows.map((doc) => async () => {
    try {
      const content = doc.content ?? "";
      const contentHash = hashText(content);
      if (store.getDocumentContentHash(doc.id) === contentHash) {
        summary.skippedUnchanged += 1;
        return;
      }

      const normalized = normalizeLineEndings(content);
      const chunks = chunkMarkdown(normalized, {
        tokens: config.chunkTokens,
        overlap: config.chunkOverlap,
      });

      let upsertChunks: UpsertChunk[] = [];
      if (chunks.length > 0) {
        const embeddings = await embeddingProvider.embedBatch(chunks.map((c) => c.text));
        upsertChunks = chunks.map((chunk, i) => ({
          id: `${doc.id}:${chunk.startLine}-${chunk.endLine}`,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: chunk.text,
          hash: chunk.hash,
          embedding: embeddings[i] ?? [],
        }));
      }
      store.upsertDocument(doc.id, contentHash, doc.modified, upsertChunks);
      summary.processed += 1;
    } catch (err) {
      summary.failed += 1;
      logger?.warn(
        `semantic search: failed to index document ${doc.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  await runWithConcurrency(tasks, Math.max(1, config.embedConcurrency));
}
