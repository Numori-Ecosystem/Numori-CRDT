/**
 * Shared test helpers.
 *
 * Services are built from an explicit env object rather than by mutating
 * process.env, so suites cannot leak configuration into one another and can run
 * several differently-configured services in the same process.
 */

// Initialize the Automerge WASM core (fullfat build) before any client Repo in a
// test constructs documents with the slim build.
import '@automerge/automerge'

import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { loadConfig } from '../src/config.mjs'
import { createService } from '../src/service.mjs'
import { signJwt } from '../src/auth/jwt.mjs'

/** A secret long enough to satisfy config validation. */
export const TEST_SECRET = 'test-secret-value-0123456789'
export const OTHER_SECRET = 'other-secret-value-9876543210'
export const ADMIN_SECRET = 'admin-secret-value-abcdefghij'

/**
 * Start a service on an ephemeral port.
 *
 * @param {object} env environment overrides (CRDT_APPS, etc.)
 * @returns {Promise<{service: object, port: number, ws: Function, http: Function, stop: Function}>}
 */
export async function startService(env = {}) {
  const config = loadConfig({
    CRDT_PORT: '0',
    CRDT_HOST: '127.0.0.1',
    CRDT_LOG_LEVEL: 'silent',
    ...env,
  })
  const service = await createService(config)
  const address = await service.start()
  const port = address.port
  return {
    service,
    port,
    config,
    tenant: (id) => service.tenants.get(id),
    ws: (path = '/') => `ws://127.0.0.1:${port}${path}`,
    http: (path = '/') => `http://127.0.0.1:${port}${path}`,
    stop: () => service.stop(),
  }
}

/**
 * Track client repos/adapters so a suite can tear them all down at once.
 * Leaked adapters keep reconnecting and make later assertions flaky.
 */
export function createClientPool() {
  const adapters = []

  const connect = (url) => {
    const adapter = new WebSocketClientAdapter(url)
    adapters.push(adapter)
    const repo = new Repo({ network: [adapter] })
    return { repo, adapter }
  }

  const disconnectAll = () => {
    for (const adapter of adapters) {
      try {
        adapter.disconnect()
      } catch {
        /* already closed */
      }
    }
    adapters.length = 0
  }

  return { connect, disconnectAll, adapters }
}

/** Mint a capability token of the shape the Numori apps issue. */
export function mintToken({
  secret = TEST_SECRET,
  documentId = null,
  documentIds = null,
  userId = 1,
  sid = null,
  kind = 'user',
  access = 'write',
  purpose = 'collab',
  app = undefined,
  expiresInSeconds = 3600,
  ...extra
} = {}) {
  const payload = { purpose, userId, kind, access, ...extra }
  if (documentId) payload.documentId = documentId
  if (documentIds) payload.documentIds = documentIds
  if (sid) payload.sid = sid
  if (app !== undefined) payload.app = app
  return signJwt(payload, secret, { expiresInSeconds })
}

/** Poll until `predicate` is truthy or the timeout elapses. */
export async function waitFor(predicate, timeout = 5000, interval = 25) {
  const start = Date.now()
  for (;;) {
    if (await predicate()) return true
    if (Date.now() - start >= timeout) return false
    await new Promise((r) => setTimeout(r, interval))
  }
}

/**
 * Wait a fixed period, used when asserting that something does NOT happen.
 * Kept generous enough that a sync would have completed if it were going to.
 */
export async function settle(ms = 700) {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Open a bare WebSocket (no Automerge) and report whether the upgrade was
 * accepted. Used to assert on the auth gate itself, including the HTTP status of
 * a rejection — which an Automerge adapter would hide behind its retry loop.
 *
 * @param {string} url
 * @param {object} [options] passed to the ws client (e.g. { headers })
 * @returns {Promise<{opened: true} | {opened: false, status?: number, error?: string}>}
 */
export async function openRawSocket(url, options = {}) {
  const { default: WebSocket } = await import('ws')
  return new Promise((resolve) => {
    const socket = new WebSocket(url, options)
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve(result)
    }

    socket.on('open', () => done({ opened: true }))
    // ws emits 'unexpected-response' when the server answers the upgrade with a
    // normal HTTP response, which is how a 401 arrives.
    socket.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }))
    socket.on('error', (err) => done({ opened: false, error: err?.message }))
    setTimeout(() => done({ opened: false, error: 'timeout' }), 4000).unref?.()
  })
}

/**
 * Read a document's text without throwing when the handle is not ready.
 * DocHandle.doc() throws in that state, which is unhelpful in an assertion that
 * is checking precisely whether the document arrived.
 */
export function docText(handle) {
  if (!handle) return undefined
  try {
    if (handle.isReady?.() === false) return undefined
    return handle.doc()?.text
  } catch {
    return undefined
  }
}

/** Text of a document as the server currently holds it, or undefined. */
export function servedText(tenant, documentId) {
  return docText(tenant.repo.handles[documentId])
}

/**
 * Create a Repo with no network, mirroring how an offline-first client starts.
 * Lets a test allocate a real documentId *before* minting a token for it, which
 * is the order a share flow uses (create the document, then issue the link).
 */
export function createOfflineRepo() {
  return new Repo({})
}

/**
 * Attach a network connection to an existing repo, as a client does when the
 * user first opens a shared document.
 */
export function attachNetwork(pool, repo, url) {
  const adapter = new WebSocketClientAdapter(url)
  pool.adapters.push(adapter)
  repo.networkSubsystem.addNetworkAdapter(adapter)
  return adapter
}
