/**
 * Numori CRDT — PostgreSQL connection pool.
 *
 * A single pool is shared by every app (tenant); isolation between apps is
 * enforced in the queries (each row carries an `app_id`), not by separate
 * connections. That keeps connection count independent of how many apps are
 * hosted.
 *
 * Connection settings come from loadDatabaseConfig() — either DATABASE_URL or
 * discrete POSTGRES_* variables — so the service drops into managed-Postgres
 * hosting and docker-compose alike.
 */
import pg from 'pg'
import { createLogger } from './log.mjs'

const { Pool } = pg
const log = createLogger('db')

let pool = null
let poolConfig = null

/**
 * Initialize the shared pool. Safe to call once at startup; later calls with an
 * equivalent config are a no-op.
 *
 * @param {object} config settings from loadDatabaseConfig()
 */
export function initDb(config) {
  if (!config) throw new Error('initDb() requires a database configuration')
  if (pool) return pool
  poolConfig = config
  pool = new Pool(config)
  // A pool-level 'error' event fires for idle clients dropped by the server or
  // a network blip. Without a listener Node treats it as an unhandled error and
  // crashes the process, so this handler is load-bearing, not decorative.
  pool.on('error', (err) => {
    log.error('idle client error (pool will reconnect):', err?.message)
  })
  return pool
}

export function useDb() {
  if (!pool) {
    throw new Error('Database not initialized — call initDb(config) during startup')
  }
  return pool
}

export function isDbInitialized() {
  return !!pool
}

export async function query(text, params) {
  return useDb().query(text, params)
}

/** Verify connectivity. Used by startup checks and /healthz. */
export async function ping() {
  const res = await query('SELECT 1 AS ok')
  return res.rows[0]?.ok === 1
}

export function describeDb() {
  if (!poolConfig) return { configured: false }
  return {
    configured: true,
    // Never echo credentials; report only the shape of the connection.
    mode: poolConfig.connectionString ? 'connectionString' : 'discrete',
    host: poolConfig.host ?? '(from connection string)',
    database: poolConfig.database ?? '(from connection string)',
    ssl: !!poolConfig.ssl,
    poolMax: poolConfig.max,
    totalCount: pool?.totalCount ?? 0,
    idleCount: pool?.idleCount ?? 0,
    waitingCount: pool?.waitingCount ?? 0,
  }
}

/** Close the pool (graceful shutdown and tests). */
export async function closeDb() {
  if (!pool) return
  const p = pool
  pool = null
  poolConfig = null
  await p.end()
}
