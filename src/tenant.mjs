/**
 * Numori CRDT — per-app (tenant) sync runtime.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE REPO PER APP
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Each app gets its own Automerge `Repo`, its own `WebSocketServer` and its own
 * storage namespace. That is what makes hosting several unrelated apps on one
 * deployment safe: isolation is structural rather than a policy check. A socket
 * authenticated for "notes" is handed to the notes Repo and can never name a
 * document in the todo Repo, because that Repo is a different object reading a
 * different slice of storage.
 *
 * The alternative — one Repo with app-prefixed keys — would put every app's
 * documents in one cache and one id space, leaving isolation to a policy
 * function that a single bug could bypass. Not worth it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY announce:false MATTERS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * automerge-repo's legacy `sharePolicy` option only sets `shareConfig.announce`,
 * while `shareConfig.access` silently defaults to allow-all. A server that sets
 * `sharePolicy: () => true` is therefore telling the repo to *actively announce
 * every document it holds in memory to every connected peer* —
 * CollectionSynchronizer decides with `announce || (access && hasRequested)`.
 * For a multi-user sync server that leaks documents to peers who never asked
 * for them and hold no capability for them.
 *
 * A sync server is a hub, not an editor: it should announce nothing and serve
 * only what a peer explicitly requests, subject to `access`. So this module
 * always passes an explicit `shareConfig`:
 *
 *   announce: () => false        never volunteer a document
 *   access:   perDocumentCheck   answer requests only for permitted rooms
 *
 * `access` resolves the requesting peer back to its WebSocket (the adapter
 * exposes `sockets[peerId]`) and consults the identity the auth gate stamped on
 * it at upgrade time. That is what makes room authorization real rather than
 * advisory: it is enforced on every document request for the life of the
 * connection, not once during the handshake.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// Side-effect import: on Node this resolves to Automerge's fullfat build, which
// initializes the WASM core at import time. automerge-repo uses the *slim* build
// which shares that same initialized low-level singleton, so no explicit
// initializeWasm() call is needed here.
import '@automerge/automerge'

import { WebSocketServer } from 'ws'
import { Repo } from '@automerge/automerge-repo'
import { WebSocketServerAdapter } from '@automerge/automerge-repo-network-websocket'
import { createLogger } from './log.mjs'

/** Close code sent when a peer's access is revoked while connected. */
export const REVOKED_CLOSE_CODE = 4001

/** Close code sent when the service is shutting down, so clients retry later. */
export const SHUTDOWN_CLOSE_CODE = 1012

/**
 * Decide whether a connection is targeted by a revocation.
 *
 * Matching is per-document; within a document a revocation can target a
 * specific account (userId), a specific guest session (sid), a whole kind
 * ('guest' | 'user'), or — when no target is given — everyone in the room.
 *
 * @param {object|null} identity the identity stamped on the socket
 * @param {{documentId: string, userId?: any, sid?: string, kind?: string}} criteria
 * @returns {boolean}
 */
export function matchesRevocation(identity, criteria) {
  if (!identity || !criteria?.documentId) return false

  // The connection is in scope if it was granted this room. In "open" mode a
  // token may name no rooms up front, in which case fall back to the room it
  // was issued for.
  const grants = identity.documentIds
  const inRoom =
    (grants instanceof Set && grants.has(criteria.documentId)) ||
    identity.documentId === criteria.documentId
  if (!inRoom) return false

  const { userId = null, sid = null, kind = null } = criteria
  if (userId == null && sid == null && kind == null) return true // boot the whole room
  if (userId != null && identity.userId === userId) return true
  if (sid != null && identity.sid === sid) return true
  if (kind != null && identity.kind === kind) return true
  return false
}

/**
 * Create the sync runtime for one app.
 *
 * @param {object} options
 * @param {object} options.app normalized app config
 * @param {import('@automerge/automerge-repo').StorageAdapterInterface} [options.storage]
 * @param {(req: import('node:http').IncomingMessage, url: URL) => Promise<{ok: boolean, reason: string, identity?: object}>} options.authenticate
 * @param {number} [options.maxPayloadBytes]
 * @param {number} [options.keepAliveMs] WebSocket ping interval
 * @returns {object} tenant handle
 */
export function createTenant({ app, storage, authenticate, maxPayloadBytes, keepAliveMs = 5000 }) {
  const log = createLogger(app.id)

  // noServer: the shared HTTP listener in router.mjs performs the upgrade and
  // routes it here, so each app does not need its own port.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: maxPayloadBytes,
    // Documents are compressed binary already; permessage-deflate would burn
    // CPU per message for little gain and has known memory-fragmentation issues
    // under many concurrent sockets.
    perMessageDeflate: false,
  })

  // The adapter pings each socket on this interval and drops peers that stop
  // answering. It also keeps otherwise-idle sockets alive through reverse proxies
  // that close quiet connections.
  const adapter = new WebSocketServerAdapter(wss, keepAliveMs)

  /**
   * Resolve the identity behind a peerId. The adapter records the socket for a
   * peer once it has joined, and the upgrade handler stamped the identity on
   * that socket, so this is a direct lookup rather than bookkeeping we maintain.
   */
  const identityOf = (peerId) => adapter.sockets?.[peerId]?._crdt ?? null

  const isPermitted = (peerId, documentId) => {
    const identity = identityOf(peerId)
    if (!identity) {
      // No identity means either the peer has not completed the handshake or it
      // is not one of ours. Deny — this is the fail-closed default.
      return false
    }
    // requireAuth:false servers carry no claims to check against.
    if (identity.unrestricted) return true
    if (app.documentBinding === 'strict') {
      return identity.documentIds instanceof Set && identity.documentIds.has(documentId)
    }
    // "open": document ids are unguessable capabilities revealed via share
    // links, so an authenticated peer may sync any room it can name — within
    // this app only, since another app's documents live in another Repo.
    return true
  }

  let deniedCount = 0

  const repo = new Repo({
    network: [adapter],
    storage,
    shareConfig: {
      // Never volunteer documents; see the header comment.
      announce: async () => false,
      access: async (peerId, documentId) => {
        const allowed = isPermitted(peerId, documentId)
        if (!allowed) {
          deniedCount++
          log.warn(`access denied: peer ${peerId} requested document ${documentId}`)
        }
        return allowed
      },
    },
    // A sync server is a hub, not an editor — it does not need to gossip remote
    // heads, which keeps per-connection work minimal.
    enableRemoteHeadsGossiping: false,
  })

  // Stamp the identity resolved during the upgrade onto the socket. The
  // Automerge adapter also listens for 'connection'; this listener is
  // independent of it and only reads from req.
  wss.on('connection', (ws, req) => {
    ws._crdt = req?.crdtIdentity ?? null
    ws._crdtConnectedAt = Date.now()
  })

  repo.networkSubsystem.on('peer', ({ peerId }) => log.info('peer connected:', peerId))
  repo.networkSubsystem.on('peer-disconnected', ({ peerId }) => log.info('peer left:', peerId))
  repo.on('document', ({ handle }) => log.debug('document opened:', handle.documentId))

  // ── Idle document eviction (bounded memory) ────────────────────────────
  // Editors emit change and presence events which keep their room "warm";
  // rooms with no activity are dropped from the in-memory cache after the TTL.
  // Eviction is safe with durable storage: the document is flushed first and
  // reloaded on next access. With memory storage eviction is disabled, since
  // dropping the cache there would destroy the document.
  let evictTimer = null
  const lastActive = new Map()
  const evictMs = storage ? app.idleEvictMs : 0

  if (evictMs > 0) {
    const touch = (id) => lastActive.set(id, Date.now())
    repo.on('document', ({ handle }) => {
      touch(handle.documentId)
      handle.on('change', () => touch(handle.documentId))
      handle.on('ephemeral-message', () => touch(handle.documentId))
    })
    evictTimer = setInterval(
      async () => {
        const now = Date.now()
        for (const [id, handle] of Object.entries(repo.handles)) {
          const seen = lastActive.get(id) ?? 0
          if (now - seen <= evictMs) continue
          try {
            if (handle.isReady?.()) await repo.flush([id])
            await repo.removeFromCache(id)
            log.debug('evicted idle document:', id)
          } catch (err) {
            log.warn('eviction failed for', id, '-', err?.message)
          }
          lastActive.delete(id)
        }
      },
      Math.max(1000, Math.floor(evictMs / 2)),
    )
    // Don't hold the event loop open for the timer alone.
    if (evictTimer.unref) evictTimer.unref()
  }

  /**
   * Perform the WebSocket upgrade for this app, after authenticating.
   * Returns true if the socket was accepted.
   */
  const handleUpgrade = async (req, socket, head, url) => {
    let decision
    try {
      decision = await authenticate(req, url)
    } catch (err) {
      log.error('authentication threw:', err?.message)
      decision = { ok: false, reason: 'internal authentication error' }
    }

    if (!decision.ok) {
      log.warn(`upgrade rejected: ${decision.reason}`)
      // A 401 body is not readable by browser WebSocket clients, but proxies and
      // non-browser peers log it, which makes misconfiguration diagnosable.
      socket.write(
        'HTTP/1.1 401 Unauthorized\r\n' +
          'Content-Type: text/plain\r\n' +
          'Connection: close\r\n' +
          '\r\n' +
          `Unauthorized: ${decision.reason}\r\n`,
      )
      socket.destroy()
      return false
    }

    req.crdtIdentity = decision.identity
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
    return true
  }

  /**
   * Immediately disconnect every live socket matching the revocation criteria.
   * A booted peer that reconnects is re-checked by the auth gate, so this is a
   * complete revocation as long as the app's authorization reflects the change.
   *
   * @returns {number} sockets closed
   */
  const revoke = (criteria) => {
    let count = 0
    for (const ws of wss.clients) {
      if (!matchesRevocation(ws._crdt, criteria)) continue
      try {
        ws.close(REVOKED_CLOSE_CODE, 'revoked')
      } catch {
        /* already closing */
      }
      count++
    }
    if (count) log.info(`revoked ${count} socket(s) for`, criteria)
    return count
  }

  const stats = () => ({
    id: app.id,
    connections: wss.clients.size,
    documentsInMemory: Object.keys(repo.handles).length,
    peers: repo.peers.length,
    accessDenials: deniedCount,
    storage: app.storage,
  })

  const close = async () => {
    if (evictTimer) clearInterval(evictTimer)
    // Flush before dropping sockets so no acknowledged change is lost.
    if (storage) {
      try {
        await repo.flush()
      } catch (err) {
        log.warn('flush during shutdown failed:', err?.message)
      }
    }
    for (const ws of wss.clients) {
      try {
        ws.close(SHUTDOWN_CLOSE_CODE, 'server shutting down')
      } catch {
        /* already closing */
      }
    }
    await new Promise((resolve) => {
      wss.close(() => resolve())
      // wss.close() waits for clients to acknowledge; terminate stragglers so
      // shutdown cannot hang on a half-open socket.
      setTimeout(() => {
        for (const ws of wss.clients) {
          try {
            ws.terminate()
          } catch {
            /* ignore */
          }
        }
        resolve()
      }, 2000).unref?.()
    })
  }

  /**
   * Resolve once the network adapter is wired up.
   *
   * The WebSocketServerAdapter only attaches its "connection" handler after the
   * repo's peerMetadata resolves — and with a storage backend that resolution
   * awaits a storageId read from the database. Accepting sockets before that
   * would silently drop the first client(s), whose upgrade fires before the
   * adapter is listening.
   */
  const whenReady = async () => {
    await repo.networkSubsystem.peerMetadata
    // Let the microtask that calls adapter.connect() (attaching the
    // "connection" listener) run before we report readiness.
    await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    id: app.id,
    app,
    repo,
    wss,
    adapter,
    handleUpgrade,
    revoke,
    stats,
    close,
    whenReady,
  }
}
