import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  startService,
  createClientPool,
  createOfflineRepo,
  attachNetwork,
  mintToken,
  waitFor,
  docText,
  servedText,
  TEST_SECRET,
  OTHER_SECRET,
} from './helpers.mjs'
import { initDb, query, closeDb, isDbInitialized } from '../src/db.mjs'
import {
  PostgresStorageAdapter,
  ensureSchema,
  __resetSchemaCache,
} from '../src/storage/postgres.mjs'
import { loadDatabaseConfig } from '../src/config.mjs'

/**
 * Durability and storage-level tenant isolation against a real PostgreSQL.
 *
 * Skipped automatically when no database is reachable, so the suite never blocks
 * a checkout without one. Start a throwaway instance with:
 *
 *   npm run dev:db
 *
 * or point the suite at your own via TEST_DATABASE_URL / POSTGRES_*.
 */

const TEST_TABLE = 'crdt_chunks_test'

function testEnv() {
  return {
    DATABASE_URL:
      process.env.TEST_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgres://crdt:crdt@127.0.0.1:5434/crdt',
  }
}

async function detectPostgres() {
  try {
    const config = loadDatabaseConfig(testEnv())
    if (!config) return false
    initDb({ ...config, max: 4 })
    await query('SELECT 1')
    await ensureSchema(TEST_TABLE)
    return true
  } catch {
    if (isDbInitialized()) await closeDb().catch(() => {})
    return false
  }
}

const pgAvailable = await detectPostgres()

if (!pgAvailable) {
  // Make the skip visible rather than silent, so a missing database is never
  // mistaken for a passing storage suite.
  console.warn(
    '[test] PostgreSQL not reachable — skipping durability and storage-isolation suites. ' +
      'Start one with `npm run dev:db` or set TEST_DATABASE_URL.',
  )
}

describe.skipIf(!pgAvailable)('storage adapter against real PostgreSQL', () => {
  const notes = new PostgresStorageAdapter({ appId: 'notes-test', table: TEST_TABLE })
  const todo = new PostgresStorageAdapter({ appId: 'todo-test', table: TEST_TABLE })

  afterAll(async () => {
    await notes.removeRange([])
    await todo.removeRange([])
  })

  it('saves and loads a chunk', async () => {
    await notes.save(['doc-a', 'snapshot', 'h1'], new Uint8Array([1, 2, 3]))
    expect(Array.from(await notes.load(['doc-a', 'snapshot', 'h1']))).toEqual([1, 2, 3])
  })

  it('returns undefined for a missing chunk', async () => {
    expect(await notes.load(['doc-a', 'snapshot', 'absent'])).toBeUndefined()
  })

  it('overwrites on conflict rather than duplicating', async () => {
    await notes.save(['doc-a', 'snapshot', 'h2'], new Uint8Array([1]))
    await notes.save(['doc-a', 'snapshot', 'h2'], new Uint8Array([9]))
    expect(Array.from(await notes.load(['doc-a', 'snapshot', 'h2']))).toEqual([9])
  })

  it('loads all chunks under a prefix', async () => {
    await notes.save(['doc-b', 'incremental', 'a'], new Uint8Array([10]))
    await notes.save(['doc-b', 'incremental', 'b'], new Uint8Array([20]))
    const chunks = await notes.loadRange(['doc-b', 'incremental'])
    expect(chunks.map((c) => c.data[0]).sort((x, y) => x - y)).toEqual([10, 20])
  })

  it('does not leak between sibling prefixes', async () => {
    await notes.save(['doc-b', 'snapshot', 'x'], new Uint8Array([99]))
    const inc = await notes.loadRange(['doc-b', 'incremental'])
    expect(inc.every((c) => c.key[1] === 'incremental')).toBe(true)
  })

  it('removes a range', async () => {
    await notes.save(['doc-c', 'wipe', '1'], new Uint8Array([1]))
    await notes.save(['doc-c', 'wipe', '2'], new Uint8Array([2]))
    await notes.removeRange(['doc-c', 'wipe'])
    expect(await notes.loadRange(['doc-c', 'wipe'])).toHaveLength(0)
  })

  // ── The multi-tenancy guarantees ───────────────────────────────────────
  it('keeps identical keys separate per app', async () => {
    const key = ['same-document-id', 'snapshot', 'h']
    await notes.save(key, new Uint8Array([1]))
    await todo.save(key, new Uint8Array([2]))
    expect(Array.from(await notes.load(key))).toEqual([1])
    expect(Array.from(await todo.load(key))).toEqual([2])
  })

  it("one app's empty-prefix loadRange never sees another app's chunks", async () => {
    await notes.save(['n-only', 'snapshot', 'h'], new Uint8Array([1]))
    await todo.save(['t-only', 'snapshot', 'h'], new Uint8Array([2]))
    const all = await todo.loadRange([])
    expect(all.some((c) => c.key[0] === 'n-only')).toBe(false)
    expect(all.some((c) => c.key[0] === 't-only')).toBe(true)
  })

  it("one app's empty-prefix removeRange never deletes another app's chunks", async () => {
    await notes.save(['survivor', 'snapshot', 'h'], new Uint8Array([7]))
    await todo.save(['casualty', 'snapshot', 'h'], new Uint8Array([8]))

    await todo.removeRange([]) // wipe the todo app entirely

    expect(Array.from(await notes.load(['survivor', 'snapshot', 'h']))).toEqual([7])
    expect(await todo.load(['casualty', 'snapshot', 'h'])).toBeUndefined()
  })

  it('reports stats for its own app only', async () => {
    await notes.removeRange([])
    await todo.removeRange([])
    await notes.save(['s1', 'snapshot', 'h'], new Uint8Array([1]))
    await notes.save(['s2', 'snapshot', 'h'], new Uint8Array([1]))
    await todo.save(['s3', 'snapshot', 'h'], new Uint8Array([1]))

    expect(await notes.stats()).toEqual({ chunks: 2, documents: 2 })
    expect(await todo.stats()).toEqual({ chunks: 1, documents: 1 })
  })
})

describe.skipIf(!pgAvailable)('durability across a service restart', () => {
  const clients = createClientPool()
  const env = () => ({
    ...testEnv(),
    CRDT_STORAGE: 'postgres',
    CRDT_CHUNK_TABLE: TEST_TABLE,
    CRDT_APPS: JSON.stringify([{ id: 'notes', secret: TEST_SECRET }]),
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    // The services under test open and close the shared pool; re-open it to tidy
    // the rows this suite created.
    if (!isDbInitialized()) initDb({ ...loadDatabaseConfig(testEnv()), max: 2 })
    __resetSchemaCache()
    await new PostgresStorageAdapter({ appId: 'notes', table: TEST_TABLE }).removeRange([])
    await closeDb().catch(() => {})
  })

  it('recovers a document from storage after the process is replaced', async () => {
    const expected = `durable-${Date.now()}`

    // ── Session 1: author a document and let the server persist it ──────
    const first = await startService(env())
    const repo = createOfflineRepo()
    const handle = repo.create({ text: expected })
    const token = mintToken({ secret: TEST_SECRET, documentId: handle.documentId })
    attachNetwork(clients, repo, first.ws(`/notes?token=${token}`))

    expect(
      await waitFor(() => servedText(first.tenant('notes'), handle.documentId) === expected),
    ).toBe(true)
    clients.disconnectAll()
    await first.stop() // flushes on the way down

    // ── Session 2: a fresh service reconstructs it from storage alone ───
    __resetSchemaCache()
    const second = await startService(env())
    const reader = createOfflineRepo()
    attachNetwork(clients, reader, second.ws(`/notes?token=${token}`))
    const recovered = await reader.find(handle.url).catch(() => null)

    expect(await waitFor(() => docText(recovered) === expected)).toBe(true)
    await second.stop()
  })

  it('writes chunks under the app id', async () => {
    const svc = await startService(env())
    const repo = createOfflineRepo()
    const handle = repo.create({ text: 'namespaced' })
    const token = mintToken({ secret: TEST_SECRET, documentId: handle.documentId })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    expect(
      await waitFor(() => servedText(svc.tenant('notes'), handle.documentId) === 'namespaced'),
    ).toBe(true)
    await svc.stop()

    if (!isDbInitialized()) initDb({ ...loadDatabaseConfig(testEnv()), max: 2 })
    const res = await query(`SELECT DISTINCT app_id FROM ${TEST_TABLE} WHERE key[1] = $1`, [
      handle.documentId,
    ])
    expect(res.rows.map((r) => r.app_id)).toEqual(['notes'])
  })
})

describe.skipIf(!pgAvailable)('two apps sharing one database', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    svc = await startService({
      ...testEnv(),
      CRDT_STORAGE: 'postgres',
      CRDT_CHUNK_TABLE: TEST_TABLE,
      CRDT_APPS: JSON.stringify([
        { id: 'notes2', secret: TEST_SECRET },
        { id: 'todo2', secret: OTHER_SECRET },
      ]),
    })
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
    if (!isDbInitialized()) initDb({ ...loadDatabaseConfig(testEnv()), max: 2 })
    __resetSchemaCache()
    await new PostgresStorageAdapter({ appId: 'notes2', table: TEST_TABLE }).removeRange([])
    await new PostgresStorageAdapter({ appId: 'todo2', table: TEST_TABLE }).removeRange([])
    await closeDb().catch(() => {})
  })

  it('persists each app under its own namespace', async () => {
    const notesRepo = createOfflineRepo()
    const notesDoc = notesRepo.create({ text: 'notes content' })
    attachNetwork(
      clients,
      notesRepo,
      svc.ws(
        `/notes2?token=${mintToken({ secret: TEST_SECRET, documentId: notesDoc.documentId })}`,
      ),
    )

    const todoRepo = createOfflineRepo()
    const todoDoc = todoRepo.create({ text: 'todo content' })
    attachNetwork(
      clients,
      todoRepo,
      svc.ws(`/todo2?token=${mintToken({ secret: OTHER_SECRET, documentId: todoDoc.documentId })}`),
    )

    expect(
      await waitFor(
        () =>
          servedText(svc.tenant('notes2'), notesDoc.documentId) === 'notes content' &&
          servedText(svc.tenant('todo2'), todoDoc.documentId) === 'todo content',
      ),
    ).toBe(true)

    await Promise.all([svc.tenant('notes2').repo.flush(), svc.tenant('todo2').repo.flush()])

    const res = await query(
      `SELECT app_id, key[1] AS doc FROM ${TEST_TABLE}
       WHERE key[1] = ANY($1) GROUP BY app_id, key[1] ORDER BY app_id`,
      [[notesDoc.documentId, todoDoc.documentId]],
    )
    expect(res.rows).toEqual([
      { app_id: 'notes2', doc: notesDoc.documentId },
      { app_id: 'todo2', doc: todoDoc.documentId },
    ])
  })
})
