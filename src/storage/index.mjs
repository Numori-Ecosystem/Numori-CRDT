/**
 * Numori CRDT — storage adapter factory.
 *
 * Returns a storage adapter bound to one app, or `undefined` for memory mode.
 *
 * Memory mode deliberately returns `undefined` rather than an in-memory adapter
 * implementation: automerge-repo derives `isEphemeral` from
 * `storage === undefined`, and an ephemeral repo also tells peers not to persist
 * sync state for it. Handing it a fake adapter would claim durability the
 * process cannot provide. In memory mode a document lives only while at least
 * one peer holds it — fine for development and tests, never for production.
 */
import { PostgresStorageAdapter } from './postgres.mjs'

/**
 * @param {object} app normalized app config
 * @param {object} serviceConfig full service config (for the table name)
 * @returns {import('@automerge/automerge-repo').StorageAdapterInterface|undefined}
 */
export function createStorage(app, serviceConfig) {
  if (app.storage !== 'postgres') return undefined
  return new PostgresStorageAdapter({
    appId: app.id,
    table: serviceConfig.chunkTable,
  })
}

export { PostgresStorageAdapter, ensureSchema } from './postgres.mjs'
