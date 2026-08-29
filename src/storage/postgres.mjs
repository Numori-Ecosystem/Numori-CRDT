/**
 * Numori CRDT — tenant-scoped PostgreSQL storage adapter.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DESIGN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * automerge-repo persists each document as a set of binary *chunks* keyed by a
 * hierarchical StorageKey (`string[]`), e.g.
 *   [documentId, "snapshot", hash]
 *   [documentId, "incremental", hash]
 *
 * The key is stored as a native Postgres `text[]` so prefix (range) queries are
 * exact for arbitrary key strings — no delimiter escaping games. The binary
 * chunk is stored as `bytea`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * MULTI-TENANCY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every row carries an `app_id`, and each adapter instance is *bound* to one
 * app at construction. Every statement filters on that app_id, which means:
 *
 *   • one app can never read another app's chunks, even given a document id;
 *   • `loadRange([])` / `removeRange([])` — which automerge-repo may issue with
 *     an empty prefix — are scoped to the calling app instead of scanning or
 *     deleting the whole table. In a shared table that distinction is the
 *     difference between a normal operation and a cross-tenant data loss.
 *
 * The primary key (app_id, key) has app_id leading, so the tenant filter is
 * always index-assisted. A slice comparison like `key[1:N] = $prefix` is not
 * indexable on its own, so range queries additionally constrain `key[1]`
 * (the document id) which is covered by a dedicated expression index.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { query } from '../db.mjs'
import { createLogger } from '../log.mjs'

const log = createLogger('storage')

/** Table/identifier names are interpolated, so they must be plain identifiers. */
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

const schemaReady = new Map()

/**
 * Create the chunk table and indexes if absent (idempotent, once per table
 * name per process).
 *
 * @param {string} table
 */
export async function ensureSchema(table = 'crdt_chunks') {
  if (!IDENTIFIER_PATTERN.test(table)) {
    throw new Error(`Invalid chunk table name "${table}"`)
  }
  if (!schemaReady.has(table)) {
    const promise = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS ${table} (
          app_id     TEXT   NOT NULL,
          key        TEXT[] NOT NULL,
          data       BYTEA,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (app_id, key)
        )
      `)
      // Range queries are effectively always "all chunks of one document", so
      // index the app + first key element (the document id).
      await query(`
        CREATE INDEX IF NOT EXISTS ${table}_app_doc_idx
        ON ${table} (app_id, (key[1]))
      `)
      log.debug(`schema ready for table ${table}`)
    })().catch((err) => {
      // Don't cache a failed migration — a transient outage shouldn't poison
      // the adapter for the life of the process.
      schemaReady.delete(table)
      throw err
    })
    schemaReady.set(table, promise)
  }
  await schemaReady.get(table)
}

/** TEST-ONLY: forget cached schema promises. */
export function __resetSchemaCache() {
  schemaReady.clear()
}

/**
 * An automerge-repo StorageAdapterInterface bound to a single app.
 *
 * @implements {import('@automerge/automerge-repo').StorageAdapterInterface}
 */
export class PostgresStorageAdapter {
  /**
   * @param {object} options
   * @param {string} options.appId tenant this adapter is bound to
   * @param {string} [options.table='crdt_chunks']
   * @param {boolean} [options.ensure=true] lazily run the schema migration
   */
  constructor({ appId, table = 'crdt_chunks', ensure = true } = {}) {
    if (!appId) throw new Error('PostgresStorageAdapter requires an appId')
    if (!IDENTIFIER_PATTERN.test(table)) {
      throw new Error(`Invalid chunk table name "${table}"`)
    }
    this.appId = appId
    this.table = table
    this.ensure = ensure
    this._ready = null
  }

  async _prepare() {
    if (!this.ensure) return
    if (!this._ready) {
      this._ready = ensureSchema(this.table).catch((err) => {
        this._ready = null
        throw err
      })
    }
    await this._ready
  }

  /**
   * @param {string[]} key
   * @returns {Promise<Uint8Array|undefined>}
   */
  async load(key) {
    await this._prepare()
    const res = await query(`SELECT data FROM ${this.table} WHERE app_id = $1 AND key = $2`, [
      this.appId,
      key,
    ])
    if (res.rows.length === 0) return undefined
    const data = res.rows[0].data
    return data == null ? undefined : new Uint8Array(data)
  }

  /**
   * @param {string[]} key
   * @param {Uint8Array} data
   */
  async save(key, data) {
    await this._prepare()
    await query(
      `INSERT INTO ${this.table} (app_id, key, data) VALUES ($1, $2, $3)
       ON CONFLICT (app_id, key)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [this.appId, key, Buffer.from(data)],
    )
  }

  /** @param {string[]} key */
  async remove(key) {
    await this._prepare()
    await query(`DELETE FROM ${this.table} WHERE app_id = $1 AND key = $2`, [this.appId, key])
  }

  /**
   * Load every chunk whose key starts with `keyPrefix`.
   *
   * `key[1:N] = $prefix` selects the leading N elements of the stored key
   * (Postgres arrays are 1-indexed, slices inclusive). The extra `key[1] = ...`
   * predicate is redundant logically but lets the planner use the
   * (app_id, key[1]) index instead of scanning the app's rows.
   *
   * @param {string[]} keyPrefix
   * @returns {Promise<Array<{key: string[], data: Uint8Array|undefined}>>}
   */
  async loadRange(keyPrefix) {
    await this._prepare()
    const len = keyPrefix.length
    const res =
      len === 0
        ? await query(`SELECT key, data FROM ${this.table} WHERE app_id = $1`, [this.appId])
        : await query(
            `SELECT key, data FROM ${this.table}
             WHERE app_id = $1 AND key[1] = $2 AND key[1:${len}] = $3`,
            [this.appId, keyPrefix[0], keyPrefix],
          )
    return res.rows.map((row) => ({
      key: row.key,
      data: row.data == null ? undefined : new Uint8Array(row.data),
    }))
  }

  /** @param {string[]} keyPrefix */
  async removeRange(keyPrefix) {
    await this._prepare()
    const len = keyPrefix.length
    if (len === 0) {
      // Scoped to this app only — never a bare `DELETE FROM table`.
      await query(`DELETE FROM ${this.table} WHERE app_id = $1`, [this.appId])
      return
    }
    await query(
      `DELETE FROM ${this.table}
       WHERE app_id = $1 AND key[1] = $2 AND key[1:${len}] = $3`,
      [this.appId, keyPrefix[0], keyPrefix],
    )
  }

  /** Operational helper: number of stored chunks and documents for this app. */
  async stats() {
    await this._prepare()
    const res = await query(
      `SELECT count(*)::int AS chunks, count(DISTINCT key[1])::int AS documents
       FROM ${this.table} WHERE app_id = $1`,
      [this.appId],
    )
    return res.rows[0] ?? { chunks: 0, documents: 0 }
  }
}
