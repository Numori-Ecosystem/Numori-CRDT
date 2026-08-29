/**
 * Numori CRDT — service assembly.
 *
 * Wires configuration into the running parts: database pool → per-app storage →
 * per-app authenticator → per-app tenant runtime → shared HTTP router.
 *
 * Kept separate from index.mjs (the CLI) so the whole service can be started
 * in-process by tests on an ephemeral port, with no environment mutation.
 */
import { createTenant } from './tenant.mjs'
import { createRouter } from './router.mjs'
import { createStorage } from './storage/index.mjs'
import { createAuthenticator, createRoomAuthorizer } from './auth/index.mjs'
import { initDb, closeDb, isDbInitialized, ping } from './db.mjs'
import { describeConfig, clientUrlFor } from './config.mjs'
import { createLogger, setLogLevel } from './log.mjs'

const log = createLogger('service')

/**
 * Build (but do not start) the service.
 *
 * @param {object} config from loadConfig()
 * @returns {Promise<object>} service handle
 */
export async function createService(config) {
  setLogLevel(config.logLevel)

  const needsDb = config.apps.some((a) => a.storage === 'postgres')

  if (needsDb) {
    if (!config.database) {
      throw new Error('A database is required by the configured apps but none is configured')
    }
    initDb(config.database)
    // Fail fast: a sync service that cannot reach its store should not report
    // itself healthy and start accepting documents it cannot persist.
    try {
      await ping()
      log.info('database connection verified')
    } catch (err) {
      throw new Error(`Cannot reach the database: ${err.message}`, { cause: err })
    }
  }

  const tenants = new Map()
  for (const app of config.apps) {
    const tenant = createTenant({
      app,
      storage: createStorage(app, config),
      authenticate: createAuthenticator(app),
      authorizeRoom: createRoomAuthorizer(app),
      maxPayloadBytes: config.maxPayloadBytes,
      keepAliveMs: config.keepAliveMs,
    })
    tenants.set(app.id, tenant)
    log.info(
      `app "${app.id}" ready — storage=${app.storage}, auth=${app.requireAuth ? 'required' : 'DISABLED'}, binding=${app.documentBinding}, authz=${app.authz}`,
    )
    if (app.storage === 'memory') {
      log.warn(
        `app "${app.id}" uses memory storage — documents are lost when the process exits. Do not use in production.`,
      )
    }
    if (!app.requireAuth) {
      log.warn(
        `app "${app.id}" has authentication DISABLED — anyone who can reach this port can read and write its documents.`,
      )
    }
  }

  const router = createRouter({ config, tenants })

  const start = async () => {
    const address = await router.listen(config.port, config.host)
    const where =
      address && typeof address === 'object'
        ? `${address.address}:${address.port}`
        : `${config.host}:${config.port}`
    log.info(`listening on ${where}`)

    // Print the exact URL each app's clients should use. Getting this wrong (or
    // pointing at the wrong port behind a proxy) is the usual reason realtime
    // traffic never arrives, so make it explicit rather than something to infer.
    for (const app of config.apps) {
      const url = clientUrlFor(config.publicUrl, app.id)
      log.info(
        `app "${app.id}" — clients connect to ${url ?? `ws://<host>:${config.port}/${app.id}`}`,
      )
    }

    return address
  }

  const stop = async () => {
    // Order matters here.
    //
    // 1. Stop accepting new connections, but do not wait — http.Server.close()
    //    only resolves once every connection has ended, and live WebSockets are
    //    connections. Awaiting it before draining them would deadlock.
    router.stopAccepting()

    // 2. Drain each app: flush documents to storage, then close its sockets.
    await Promise.allSettled([...tenants.values()].map((t) => t.close()))

    // 3. Now the listener can finish closing.
    await router.close()

    // 4. Last, release the database that the flush in step 2 needed.
    if (isDbInitialized()) await closeDb().catch(() => {})
    log.info('stopped')
  }

  return {
    config,
    tenants,
    router,
    httpServer: router.httpServer,
    start,
    stop,
    describe: () => describeConfig(config),
  }
}
