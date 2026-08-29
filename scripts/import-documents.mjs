#!/usr/bin/env node
/**
 * Import Automerge chunks from a single-tenant table into the multi-tenant chunk
 * table, assigning them to one app.
 *
 * A single-tenant source is keyed by StorageKey alone:
 *   <source>      (key TEXT[] PRIMARY KEY, data BYTEA)
 * This service namespaces every row by app:
 *   crdt_chunks   (app_id TEXT, key TEXT[], data BYTEA, PRIMARY KEY (app_id, key))
 *
 * The copy is additive and idempotent — existing rows are left alone — so it is
 * safe to run more than once, and the source table is never written to. Keep the
 * source until you have confirmed this service serves the documents, then drop it
 * yourself.
 *
 * Usage:
 *   node scripts/import-documents.mjs --app notes [options]
 *
 * Options:
 *   --app <id>        (required) app id to assign the imported documents to
 *   --from <table>    source table (default: collab_chunks)
 *   --to <table>      destination table (default: crdt_chunks, or CRDT_CHUNK_TABLE)
 *   --overwrite       replace rows that already exist for this app
 *   --dry-run         report what would be copied and change nothing
 *
 * Database connection comes from DATABASE_URL or the POSTGRES_* variables, the
 * same as the service itself.
 */
import { loadDatabaseConfig } from '../src/config.mjs'
import { initDb, query, closeDb } from '../src/db.mjs'
import { ensureSchema } from '../src/storage/postgres.mjs'

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/
const APP_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/

function parseArgs(argv) {
  const args = { from: 'collab_chunks', to: process.env.CRDT_CHUNK_TABLE || 'crdt_chunks' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--overwrite') args.overwrite = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--app') args.app = argv[++i]
    else if (arg === '--from') args.from = argv[++i]
    else if (arg === '--to') args.to = argv[++i]
    else if (arg.startsWith('--app=')) args.app = arg.slice(6)
    else if (arg.startsWith('--from=')) args.from = arg.slice(7)
    else if (arg.startsWith('--to=')) args.to = arg.slice(5)
    else throw new Error(`Unknown argument "${arg}" (try --help)`)
  }
  return args
}

function usage() {
  process.stderr.write(
    [
      'Import Automerge chunks from a single-tenant table into crdt_chunks.',
      '',
      'Usage: node scripts/import-documents.mjs --app <id> [options]',
      '',
      '  --app <id>      app id to assign imported documents to (required)',
      '  --from <table>  source table (default: collab_chunks)',
      '  --to <table>    destination table (default: crdt_chunks)',
      '  --overwrite     replace rows already present for this app',
      '  --dry-run       report only, change nothing',
      '',
    ].join('\n'),
  )
}

async function tableExists(table) {
  const res = await query(`SELECT to_regclass($1) AS reg`, [table])
  return res.rows[0]?.reg != null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    usage()
    process.exit(0)
  }
  if (!args.app) {
    usage()
    throw new Error('--app <id> is required')
  }
  if (!APP_ID.test(args.app)) {
    throw new Error(`--app "${args.app}" is not a valid app id`)
  }
  for (const [label, table] of [
    ['--from', args.from],
    ['--to', args.to],
  ]) {
    if (!IDENTIFIER.test(table)) throw new Error(`${label} "${table}" is not a valid table name`)
  }
  if (args.from === args.to) throw new Error('--from and --to must differ')

  const dbConfig = loadDatabaseConfig(process.env)
  if (!dbConfig) {
    throw new Error('No database configured. Set DATABASE_URL or POSTGRES_USER/HOST/DB.')
  }
  initDb(dbConfig)

  if (!(await tableExists(args.from))) {
    throw new Error(`Source table "${args.from}" does not exist — nothing to import.`)
  }
  await ensureSchema(args.to)

  const source = await query(
    `SELECT count(*)::int AS chunks, count(DISTINCT key[1])::int AS documents FROM ${args.from}`,
  )
  const existing = await query(`SELECT count(*)::int AS chunks FROM ${args.to} WHERE app_id = $1`, [
    args.app,
  ])

  process.stderr.write(
    `Source ${args.from}: ${source.rows[0].chunks} chunks across ${source.rows[0].documents} documents\n` +
      `Destination ${args.to} for app "${args.app}": ${existing.rows[0].chunks} chunks already present\n`,
  )

  if (args.dryRun) {
    const wouldCopy = await query(
      `SELECT count(*)::int AS n FROM ${args.from} s
       WHERE NOT EXISTS (
         SELECT 1 FROM ${args.to} d WHERE d.app_id = $1 AND d.key = s.key
       )`,
      [args.app],
    )
    process.stderr.write(
      `Dry run: would copy ${wouldCopy.rows[0].n} chunk(s) into "${args.to}" as app "${args.app}".\n`,
    )
    return
  }

  // A single INSERT … SELECT keeps the copy atomic: either the app's documents
  // are all present or the table is untouched, so a failed run cannot leave a
  // half-imported document that would fail to load.
  const conflict = args.overwrite
    ? 'ON CONFLICT (app_id, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()'
    : 'ON CONFLICT (app_id, key) DO NOTHING'

  const result = await query(
    `INSERT INTO ${args.to} (app_id, key, data)
     SELECT $1, key, data FROM ${args.from}
     ${conflict}`,
    [args.app],
  )

  const after = await query(`SELECT count(*)::int AS chunks FROM ${args.to} WHERE app_id = $1`, [
    args.app,
  ])

  process.stderr.write(
    `Copied ${result.rowCount} chunk(s). App "${args.app}" now has ${after.rows[0].chunks} chunks in "${args.to}".\n` +
      `The source table "${args.from}" was not modified — drop it once you have verified this service.\n` +
      `Point clients at ws(s)://<host>/${args.app}\n`,
  )
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    process.stderr.write(`\nImport failed: ${err.message}\n`)
    await closeDb().catch(() => {})
    process.exit(1)
  })
