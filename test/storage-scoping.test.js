import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Verifies the multi-tenancy guarantee of the storage adapter without needing a
 * database: every statement it issues must be scoped to its own app_id.
 *
 * This matters most for the range operations. automerge-repo may call
 * `loadRange([])` / `removeRange([])` with an empty prefix; in a table shared by
 * several apps an unscoped `DELETE FROM crdt_chunks` would destroy every app's
 * documents. Asserting on the generated SQL catches that class of mistake even
 * when no Postgres is available to run against.
 */

const calls = []

vi.mock('../src/db.mjs', () => ({
  query: vi.fn(async (text, params) => {
    calls.push({ text, params })
    return { rows: [] }
  }),
}))

const { PostgresStorageAdapter } = await import('../src/storage/postgres.mjs')

/** Statements the adapter issues that are not the lazy schema migration. */
function dataStatements() {
  return calls.filter(
    ({ text }) =>
      !/CREATE TABLE|CREATE INDEX/i.test(text) && /crdt_chunks|SELECT|DELETE/i.test(text),
  )
}

describe('storage adapter tenant scoping', () => {
  let adapter

  beforeEach(() => {
    calls.length = 0
    adapter = new PostgresStorageAdapter({ appId: 'notes', ensure: false })
  })

  it('requires an appId', () => {
    expect(() => new PostgresStorageAdapter({})).toThrow(/requires an appId/)
  })

  it('rejects an unsafe table name', () => {
    // The table name is interpolated into SQL, so it must be an identifier.
    expect(() => new PostgresStorageAdapter({ appId: 'notes', table: 'x; DROP TABLE y' })).toThrow(
      /Invalid chunk table name/,
    )
  })

  it('scopes load by app_id', async () => {
    await adapter.load(['doc1', 'snapshot', 'h'])
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/WHERE app_id = \$1/)
    expect(stmt.params[0]).toBe('notes')
  })

  it('writes app_id on save', async () => {
    await adapter.save(['doc1', 'snapshot', 'h'], new Uint8Array([1, 2, 3]))
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/INSERT INTO crdt_chunks \(app_id, key, data\)/)
    expect(stmt.text).toMatch(/ON CONFLICT \(app_id, key\)/)
    expect(stmt.params[0]).toBe('notes')
  })

  it('scopes remove by app_id', async () => {
    await adapter.remove(['doc1', 'snapshot', 'h'])
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/DELETE FROM crdt_chunks\s+WHERE app_id = \$1 AND key = \$2/)
    expect(stmt.params[0]).toBe('notes')
  })

  it('scopes a prefix loadRange by app_id and constrains the document id', async () => {
    await adapter.loadRange(['doc1', 'incremental'])
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/app_id = \$1/)
    expect(stmt.text).toMatch(/key\[1\] = \$2/)
    expect(stmt.text).toMatch(/key\[1:2\] = \$3/)
    expect(stmt.params).toEqual(['notes', 'doc1', ['doc1', 'incremental']])
  })

  it('scopes an empty-prefix loadRange to this app only', async () => {
    await adapter.loadRange([])
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/SELECT key, data FROM crdt_chunks WHERE app_id = \$1/)
    expect(stmt.params).toEqual(['notes'])
  })

  it('never issues an unscoped delete, even for an empty prefix', async () => {
    await adapter.removeRange([])
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/DELETE FROM crdt_chunks WHERE app_id = \$1/)
    expect(stmt.params).toEqual(['notes'])
    // The dangerous form must never appear.
    expect(stmt.text).not.toMatch(/DELETE FROM crdt_chunks\s*$/)
  })

  it('scopes a prefix removeRange by app_id', async () => {
    await adapter.removeRange(['doc1'])
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/app_id = \$1/)
    expect(stmt.params).toEqual(['notes', 'doc1', ['doc1']])
  })

  it("carries every statement under the adapter's own app id", async () => {
    const other = new PostgresStorageAdapter({ appId: 'todo', ensure: false })
    calls.length = 0
    await other.load(['d'])
    await other.save(['d'], new Uint8Array([1]))
    await other.remove(['d'])
    await other.loadRange(['d'])
    await other.removeRange(['d'])
    await other.loadRange([])
    await other.removeRange([])

    const statements = dataStatements()
    expect(statements).toHaveLength(7)
    for (const stmt of statements) {
      expect(stmt.text).toMatch(/app_id = \$1|\(app_id, key, data\)/)
      expect(stmt.params[0]).toBe('todo')
    }
  })

  it('reports stats scoped to the app', async () => {
    await adapter.stats()
    const [stmt] = dataStatements()
    expect(stmt.text).toMatch(/WHERE app_id = \$1/)
    expect(stmt.params).toEqual(['notes'])
  })
})
