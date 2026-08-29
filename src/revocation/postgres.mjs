/**
 * Numori CRDT — optional Postgres LISTEN/NOTIFY revocation bridge.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHEN TO USE THIS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The primary way to revoke access is the admin HTTP API (see src/admin.mjs),
 * which works no matter where an app is hosted. This bridge exists for apps that
 * already share a database with the sync service and signal access changes with
 *
 *   SELECT pg_notify('<channel>', '{"documentId":"…","userId":1}')
 *
 * inside the same transaction that changes the share. Keeping that path means an
 * existing app can move to this service without rewriting its revocation logic,
 * and the notification stays transactional with the change that caused it.
 *
 * Enable per app with `revokeChannel` in the registry. Apps without it are
 * unaffected.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESILIENCE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A dedicated connection is held per distinct channel (LISTEN is connection
 * scoped and a pooled client could be handed to someone else). If it drops, the
 * listener reconnects with capped backoff. While disconnected, revocation
 * degrades to token expiry — new connections are still authorized normally, so
 * this is a soft failure rather than an open door.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { useDb } from '../db.mjs'
import { createLogger } from '../log.mjs'
import { toDocumentId } from '../documentId.mjs'

const log = createLogger('revoke')

const INITIAL_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 30_000

/**
 * Start listeners for every app that configured a revocation channel.
 *
 * @param {object} options
 * @param {Array<object>} options.apps normalized app configs
 * @param {(appId: string, criteria: object) => void} options.onRevoke
 * @returns {Promise<() => Promise<void>>} stop function
 */
export async function startRevocationListeners({ apps, onRevoke }) {
  // Several apps may legitimately share a channel; dispatch to all of them.
  const byChannel = new Map()
  for (const app of apps) {
    if (!app.revokeChannel) continue
    if (!byChannel.has(app.revokeChannel)) byChannel.set(app.revokeChannel, [])
    byChannel.get(app.revokeChannel).push(app.id)
  }
  if (byChannel.size === 0) return async () => {}

  const pool = useDb()
  const listeners = []

  for (const [channel, appIds] of byChannel) {
    const state = { client: null, stopped: false, backoff: INITIAL_BACKOFF_MS, timer: null }

    const handleNotification = (msg) => {
      if (msg.channel !== channel || !msg.payload) return
      let payload
      try {
        payload = JSON.parse(msg.payload)
      } catch (err) {
        log.warn(`channel "${channel}": ignoring unparseable payload:`, err?.message)
        return
      }
      const documentId = toDocumentId(payload.documentId ?? payload.automergeUrl)
      if (!documentId) {
        log.warn(`channel "${channel}": notification has no usable documentId`)
        return
      }
      const criteria = {
        documentId,
        userId: payload.userId ?? null,
        sid: payload.sid ?? null,
        kind: payload.kind ?? null,
      }
      // A payload may name its app, which matters when several apps share a
      // channel; otherwise every app on the channel is notified.
      const targets = payload.appId ? appIds.filter((id) => id === payload.appId) : appIds
      for (const appId of targets) {
        try {
          onRevoke(appId, criteria)
        } catch (err) {
          log.error(`app "${appId}": revoke handler threw:`, err?.message)
        }
      }
    }

    const connect = async () => {
      if (state.stopped) return
      let client
      try {
        client = await pool.connect()
        client.on('notification', handleNotification)
        client.on('error', (err) => {
          log.warn(`channel "${channel}": connection error:`, err?.message)
          scheduleReconnect(client)
        })
        // The channel name cannot be parameterized; config.mjs validates it as a
        // plain identifier before it reaches here.
        await client.query(`LISTEN ${channel}`)
        state.client = client
        state.backoff = INITIAL_BACKOFF_MS
        log.info(`listening on channel "${channel}" for app(s): ${appIds.join(', ')}`)
      } catch (err) {
        log.warn(`channel "${channel}": failed to start listener:`, err?.message)
        if (client) {
          try {
            client.release(true)
          } catch {
            /* ignore */
          }
        }
        scheduleReconnect(null)
      }
    }

    const scheduleReconnect = (deadClient) => {
      if (state.stopped) return
      if (deadClient) {
        if (state.client !== deadClient) return // already handled
        state.client = null
        try {
          // Pass an error so the pool discards rather than reuses this client.
          deadClient.release(new Error('revocation listener connection lost'))
        } catch {
          /* ignore */
        }
      }
      if (state.timer) return
      const delay = state.backoff
      state.backoff = Math.min(state.backoff * 2, MAX_BACKOFF_MS)
      log.info(`channel "${channel}": reconnecting in ${delay}ms`)
      state.timer = setTimeout(() => {
        state.timer = null
        connect()
      }, delay)
      state.timer.unref?.()
    }

    await connect()

    listeners.push(async () => {
      state.stopped = true
      if (state.timer) clearTimeout(state.timer)
      const client = state.client
      state.client = null
      if (!client) return
      try {
        await client.query(`UNLISTEN ${channel}`)
      } catch {
        /* connection may already be gone */
      }
      try {
        client.release()
      } catch {
        /* ignore */
      }
    })
  }

  return async () => {
    await Promise.allSettled(listeners.map((stop) => stop()))
  }
}
