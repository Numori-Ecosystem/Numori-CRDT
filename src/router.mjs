/**
 * Numori CRDT — HTTP listener, app routing, health endpoints.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW AN APP IS SELECTED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One port serves every hosted app. The first path segment names the app:
 *
 *   wss://crdt.example.com/notes?token=…   → the "notes" app
 *   wss://crdt.example.com/todo?token=…    → the "todo" app
 *
 * If the first segment does not match a configured app, the request falls back
 * to the default app (a single-app deployment gets one implicitly, otherwise set
 * CRDT_DEFAULT_APP). That fallback is what lets an existing client which
 * connects to `/collab` keep working unchanged while pointing at this service.
 *
 * Routing by path rather than subdomain keeps TLS and reverse-proxy config to a
 * single hostname, and the same URL shape works behind a path-routed proxy.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HEALTH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   GET /healthz   liveness — the process is up and serving (always 200)
 *   GET /readyz    readiness — plus a database round-trip when one is
 *                  configured; 503 if it fails, so an orchestrator stops
 *                  sending traffic to an instance that cannot persist
 *   GET <other>    200 plain-text ok, so a proxy health check on any path
 *                  (e.g. the collab path itself) succeeds
 * ═══════════════════════════════════════════════════════════════════════════
 */
import http from 'node:http'
import { createLogger } from './log.mjs'
import { createAdminHandler } from './admin.mjs'
import { isDbInitialized, ping, describeDb } from './db.mjs'
import { describeAuth } from './auth/index.mjs'

const log = createLogger('router')

/** Guard the readiness probe so a wedged database cannot hang the endpoint. */
const READINESS_TIMEOUT_MS = 2000

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Parse the request URL. WebSocket upgrade requests carry only a path, so a
 * base is required; the Host header is used when present for accurate logging.
 */
function parseUrl(req) {
  const host = typeof req.headers?.host === 'string' ? req.headers.host : 'localhost'
  try {
    return new URL(req.url || '/', `http://${host}`)
  } catch {
    try {
      return new URL(req.url || '/', 'http://localhost')
    } catch {
      return null
    }
  }
}

/**
 * Resolve which app a request addresses.
 *
 * @returns {{tenant: object|null, appId: string|null, viaDefault: boolean}}
 */
function resolveTenant(url, tenants, defaultAppId) {
  const first = url.pathname.split('/').filter(Boolean)[0]
  if (first && tenants.has(first)) {
    return { tenant: tenants.get(first), appId: first, viaDefault: false }
  }
  // Allow the app to be named by query parameter too, for clients that cannot
  // control the path (some embedded WebSocket libraries).
  const fromQuery = url.searchParams.get('app')
  if (fromQuery && tenants.has(fromQuery)) {
    return { tenant: tenants.get(fromQuery), appId: fromQuery, viaDefault: false }
  }
  if (defaultAppId && tenants.has(defaultAppId)) {
    return { tenant: tenants.get(defaultAppId), appId: defaultAppId, viaDefault: true }
  }
  return { tenant: null, appId: first ?? null, viaDefault: false }
}

async function checkDatabase() {
  if (!isDbInitialized()) return { configured: false, ok: true }
  try {
    const ok = await Promise.race([
      ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('timed out')), READINESS_TIMEOUT_MS).unref?.(),
      ),
    ])
    return { configured: true, ok: !!ok }
  } catch (err) {
    return { configured: true, ok: false, error: err?.message }
  }
}

/**
 * Create the HTTP server that fronts every app.
 *
 * @param {object} options
 * @param {object} options.config service config
 * @param {Map<string, object>} options.tenants app id → tenant handle
 * @returns {{httpServer: http.Server, listen: Function, close: Function}}
 */
export function createRouter({ config, tenants }) {
  const handleAdmin = createAdminHandler({ config, tenants })

  const httpServer = http.createServer((req, res) => {
    const url = parseUrl(req)
    if (!url) {
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('Bad request URI\n')
      return
    }

    if (url.pathname.startsWith('/_admin')) {
      handleAdmin(req, res, url).catch((err) => {
        log.error('admin handler failed:', err?.message)
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' })
      })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' })
      res.end('Method not allowed\n')
      return
    }

    if (url.pathname === '/healthz' || url.pathname === '/livez') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'numori-crdt',
        uptimeSeconds: Math.floor(process.uptime()),
        apps: [...tenants.values()].map((t) => ({
          ...t.stats(),
          auth: describeAuth(t.app),
        })),
        database: isDbInitialized() ? describeDb() : { configured: false },
      })
      return
    }

    if (url.pathname === '/readyz') {
      checkDatabase()
        .then((db) => {
          const ready = db.ok
          sendJson(res, ready ? 200 : 503, {
            status: ready ? 'ready' : 'not_ready',
            service: 'numori-crdt',
            database: db,
          })
        })
        .catch(() => sendJson(res, 503, { status: 'not_ready', service: 'numori-crdt' }))
      return
    }

    // Any other GET succeeds so that a reverse-proxy health check aimed at the
    // sync path itself passes. Real traffic arrives as a WebSocket upgrade.
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('numori-crdt ok\n')
  })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req)
    if (!url) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const { tenant, appId, viaDefault } = resolveTenant(url, tenants, config.defaultAppId)
    if (!tenant) {
      log.warn(`upgrade rejected: no app for path "${url.pathname}"`)
      socket.write(
        'HTTP/1.1 404 Not Found\r\n' +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          `No CRDT app is configured at this path. ` +
          `Connect to /<appId> (configured: ${[...tenants.keys()].join(', ')}).\r\n`,
      )
      socket.destroy()
      return
    }

    // A socket error between upgrade and handoff would otherwise surface as an
    // unhandled 'error' event and crash the process.
    socket.on('error', (err) => log.debug('upgrade socket error:', err?.message))

    log.debug(`upgrade for app "${appId}"${viaDefault ? ' (via default)' : ''}: ${url.pathname}`)
    tenant.handleUpgrade(req, socket, head, url).catch((err) => {
      log.error(`upgrade failed for app "${appId}":`, err?.message)
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
    })
  })

  /** Start listening once every app's network adapter is wired up. */
  const listen = async (port, host) => {
    await Promise.all([...tenants.values()].map((t) => t.whenReady()))
    return new Promise((resolve, reject) => {
      httpServer.once('error', reject)
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', reject)
        resolve(httpServer.address())
      })
    })
  }

  let closed = null

  /**
   * Stop accepting new connections without waiting for existing ones to finish.
   *
   * This must happen before tenants are drained: `httpServer.close()` does not
   * resolve until every connection has ended, and live WebSockets are
   * connections. Closing the listener first, draining the sockets second, then
   * awaiting `close()` avoids waiting on sockets that nothing has asked to end.
   */
  const stopAccepting = () => {
    if (!closed) {
      closed = httpServer.listening
        ? new Promise((resolve) => httpServer.close(() => resolve()))
        : Promise.resolve()
    }
    // Idle HTTP keep-alive sockets (health checks) would otherwise hold the
    // listener open for their timeout.
    httpServer.closeIdleConnections?.()
    return closed
  }

  const close = async () => {
    const pending = stopAccepting()
    // Backstop for anything still attached after the tenants were drained.
    httpServer.closeAllConnections?.()
    await pending
  }

  return { httpServer, listen, stopAccepting, close }
}
