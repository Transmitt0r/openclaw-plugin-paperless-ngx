import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  ensureDir,
  loadSqliteVecExtension,
  requireNodeSqlite,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { ChunkHit, IndexIdentity } from "./types.js";

// A single unstructured row (id always 1) holding the index's identity
// fingerprint. Compared against the caller's current config on open --
// see checkIdentityDrift.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS semantic_index_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  chunk_tokens INTEGER NOT NULL,
  chunk_overlap INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_documents (
  document_id INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL,
  modified TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_chunks (
  id TEXT PRIMARY KEY,
  document_id INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS semantic_chunks_document_id ON semantic_chunks(document_id);

CREATE TABLE IF NOT EXISTS semantic_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  watermark TEXT,
  checkpoint_document_id INTEGER,
  updated_at TEXT NOT NULL
);
`;

const VEC_TABLE = "semantic_chunks_vec";

function assertValidDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`semantic search: invalid embedding dimensions (${dimensions})`);
  }
}

export type OpenStoreResult =
  | { available: true; store: SemanticIndexStore }
  | { available: false; reason: string };

export type UpsertChunk = {
  id: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embedding: number[];
};

// Owns the plugin's private SQLite file: schema, identity/drift detection,
// per-document chunk+vector storage, sync checkpoint, and the brute-force
// cosine KNN query. Vector-only (no FTS5/BM25 leg) -- paperless-ngx's own
// Whoosh search already supplies the lexical leg one level up, in the same
// paperless_search_documents call (see mergeSemanticMatches in
// src/tools/documents.ts).
export class SemanticIndexStore {
  private constructor(private readonly db: DatabaseSyncType) {}

  // Feature-detects node:sqlite (absent on Node 20, this plugin's declared
  // floor) and the sqlite-vec extension, then opens/creates the index file
  // and its schema. Never throws -- any failure resolves to
  // `{ available: false, reason }` so the caller can fail open to
  // lexical-only search instead of crashing plugin registration.
  static async open(indexPath: string, dimensions: number): Promise<OpenStoreResult> {
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = requireNodeSqlite();
    } catch (err) {
      return { available: false, reason: describeError(err) };
    }

    try {
      assertValidDimensions(dimensions);
      if (indexPath !== ":memory:") {
        ensureDir(path.dirname(indexPath));
      }
      const db = new sqlite.DatabaseSync(indexPath, { allowExtension: true });
      const vecResult = await loadSqliteVecExtension({ db });
      if (!vecResult.ok) {
        db.close();
        return {
          available: false,
          reason: vecResult.error ?? "sqlite-vec extension failed to load",
        };
      }
      const store = new SemanticIndexStore(db);
      store.ensureSchema(dimensions);
      return { available: true, store };
    } catch (err) {
      return { available: false, reason: describeError(err) };
    }
  }

  private ensureSchema(dimensions: number): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}])`,
    );
  }

  getIdentity(): IndexIdentity | undefined {
    const row = this.db
      .prepare(
        "SELECT provider_id, model, dimensions, chunk_tokens, chunk_overlap FROM semantic_index_meta WHERE id = 1",
      )
      .get() as
      | {
          provider_id: string;
          model: string;
          dimensions: number;
          chunk_tokens: number;
          chunk_overlap: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      providerId: row.provider_id,
      model: row.model,
      dimensions: row.dimensions,
      chunkTokens: row.chunk_tokens,
      chunkOverlap: row.chunk_overlap,
    };
  }

  private setIdentity(identity: IndexIdentity): void {
    this.db
      .prepare(
        `INSERT INTO semantic_index_meta (id, provider_id, model, dimensions, chunk_tokens, chunk_overlap)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id = excluded.provider_id,
           model = excluded.model,
           dimensions = excluded.dimensions,
           chunk_tokens = excluded.chunk_tokens,
           chunk_overlap = excluded.chunk_overlap`,
      )
      .run(
        identity.providerId,
        identity.model,
        identity.dimensions,
        identity.chunkTokens,
        identity.chunkOverlap,
      );
  }

  // Wipes every document/chunk/vector and the sync watermark, then records
  // `identity` as the new fingerprint. Called when the stored identity
  // doesn't match the configured provider/model/dims/chunking -- mixing
  // vectors from two different models in one vec0 table would make KNN
  // distances meaningless, so a clean rebuild (full re-backfill from
  // paperless, since the index is fully derivable from paperless content)
  // is the only safe option.
  rebuild(identity: IndexIdentity): void {
    assertValidDimensions(identity.dimensions);
    this.db.exec(`DROP TABLE IF EXISTS ${VEC_TABLE}`);
    this.db.exec("DELETE FROM semantic_chunks");
    this.db.exec("DELETE FROM semantic_documents");
    this.db.exec("DELETE FROM semantic_sync_state");
    this.ensureSchema(identity.dimensions);
    this.setIdentity(identity);
  }

  getDocumentContentHash(documentId: number): string | undefined {
    const row = this.db
      .prepare("SELECT content_hash FROM semantic_documents WHERE document_id = ?")
      .get(documentId) as { content_hash: string } | undefined;
    return row?.content_hash;
  }

  // Replaces every chunk/vector belonging to `documentId` with `chunks`
  // (paired 1:1 with `chunks[i].embedding`) in one transaction, and
  // records the document's content hash/modified timestamp so a future
  // sync pass can short-circuit on an unchanged hash (tag edits bump
  // `modified` without changing OCR text).
  upsertDocument(
    documentId: number,
    contentHash: string,
    modifiedIso: string,
    chunks: UpsertChunk[],
  ): void {
    const now = new Date().toISOString();
    this.withTransaction(() => {
      this.deleteDocumentChunks(documentId);
      const insertChunk = this.db.prepare(
        "INSERT INTO semantic_chunks (id, document_id, start_line, end_line, text, hash) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insertVec = this.db.prepare(`INSERT INTO ${VEC_TABLE} (id, embedding) VALUES (?, ?)`);
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.id,
          documentId,
          chunk.startLine,
          chunk.endLine,
          chunk.text,
          chunk.hash,
        );
        insertVec.run(chunk.id, JSON.stringify(chunk.embedding));
      }
      this.db
        .prepare(
          `INSERT INTO semantic_documents (document_id, content_hash, modified, indexed_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(document_id) DO UPDATE SET
             content_hash = excluded.content_hash,
             modified = excluded.modified,
             indexed_at = excluded.indexed_at`,
        )
        .run(documentId, contentHash, modifiedIso, now);
    });
  }

  // Removes a document paperless no longer has (deleted, or moved out of
  // whatever filter scope this plugin was configured to index) from the
  // index entirely.
  deleteDocument(documentId: number): void {
    this.withTransaction(() => {
      this.deleteDocumentChunks(documentId);
      this.db.prepare("DELETE FROM semantic_documents WHERE document_id = ?").run(documentId);
    });
  }

  private deleteDocumentChunks(documentId: number): void {
    const ids = this.db
      .prepare("SELECT id FROM semantic_chunks WHERE document_id = ?")
      .all(documentId) as { id: string }[];
    if (ids.length === 0) return;
    const deleteVec = this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE id = ?`);
    for (const { id } of ids) deleteVec.run(id);
    this.db.prepare("DELETE FROM semantic_chunks WHERE document_id = ?").run(documentId);
  }

  getSyncState(): { watermark?: string; checkpointDocumentId?: number } {
    const row = this.db
      .prepare("SELECT watermark, checkpoint_document_id FROM semantic_sync_state WHERE id = 1")
      .get() as { watermark: string | null; checkpoint_document_id: number | null } | undefined;
    if (!row) return {};
    return {
      watermark: row.watermark ?? undefined,
      checkpointDocumentId: row.checkpoint_document_id ?? undefined,
    };
  }

  setSyncState(watermark: string | undefined, checkpointDocumentId: number | undefined): void {
    this.db
      .prepare(
        `INSERT INTO semantic_sync_state (id, watermark, checkpoint_document_id, updated_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           watermark = excluded.watermark,
           checkpoint_document_id = excluded.checkpoint_document_id,
           updated_at = excluded.updated_at`,
      )
      .run(watermark ?? null, checkpointDocumentId ?? null, new Date().toISOString());
  }

  // Brute-force cosine KNN over every stored chunk vector via sqlite-vec's
  // vec_distance_cosine scalar function -- not vec0's own MATCH/k ANN query
  // mode, which was tried first but dropped: its auxiliary-column
  // requirement has varied across sqlite-vec versions, while a plain
  // ORDER BY full scan works identically everywhere and, verified directly
  // against the bundled sqlite-vec build, returns the same ranking (a flat
  // vec0 table is a brute-force scan either way, so nothing is lost by not
  // using MATCH). At the 600-6000 document / low-tens-of-thousands-of-chunks
  // scale this is tuned for, a full scan is a few milliseconds; it stays
  // correct (exact, not approximate) all the way up to the 100k-document
  // envelope the design is only required to not fall over at.
  knnSearch(queryEmbedding: number[], limit: number): ChunkHit[] {
    const rows = this.db
      .prepare(
        `SELECT c.id AS chunk_id, c.document_id AS document_id, c.start_line AS start_line,
                c.end_line AS end_line, c.text AS text,
                vec_distance_cosine(v.embedding, vec_f32(?)) AS dist
           FROM ${VEC_TABLE} v
           JOIN semantic_chunks c ON c.id = v.id
          ORDER BY dist ASC
          LIMIT ?`,
      )
      .all(JSON.stringify(queryEmbedding), limit) as {
      chunk_id: string;
      document_id: number;
      start_line: number;
      end_line: number;
      text: string;
      dist: number;
    }[];
    return rows.map((row) => ({
      chunkId: row.chunk_id,
      documentId: row.document_id,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      score: 1 - row.dist,
    }));
  }

  documentCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM semantic_documents").get() as {
      n: number;
    };
    return row.n;
  }

  private withTransaction(fn: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
