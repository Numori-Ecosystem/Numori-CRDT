/**
 * Numori CRDT — admin HTTP API.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tokens have a lifetime; access changes do not wait for it. When an app removes
 * a collaborator, deletes a share or makes a document private, the peers already
 * connected must be disconnected now rather than at token expiry.
 *
 * An authenticated HTTP call is the mechanism because it works wherever the app
 * is hosted. Signalling through the database instead would be transactional with
 * the change that triggered it, but it would require every app to share a
 * database with this service — a coupling that cannot hold once several unrelated
 * apps are hosted, and one that would give the sync service access to application
 * tables it has no business reading.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ENDPOINTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   POST /_admin/apps/:appId/revoke   boot matching sockets from a room
 *   GET  /_admin/stats                connection/document counts per app
 *
 * Authentication is a bearer token compared in constant time against the app's
 * `adminSecret`, falling back to the service-wide CRDT_ADMIN_SECRET. The API
 * does not exist at all unless one of those is configured.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import crypto from 'node:crypto'
import { createLogger } from './log.mjs'
import { toDocumentId } from './documentId.mjs'

const log = createLogger('admin')

/** Refuse oversized admin bodies rather than buffering them. */
const MAX_BODY_BYTES = 64 * 1024

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** Constant-time secret comparison that tolerates differing lengths. */
function secretsMatch(given, expected) {
  if (!given || !expected) return false
  // Hash both sides so timingSafeEqual always gets equal-length buffers and the
  // comparison leaks nothing about the secret's length.
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(a, b)
}

function bearerToken(req) {
  const header = req.headers?.authorization
  if (typeof header !== 'string' || !/^bearer\s+/i.test(header)) return null
  return header.replace(/^bearer\s+/i, '').trim()
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body too large')
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const err = new Error('Request body is not valid JSON')
    err.statusCode = 400
    throw err
  }
}

/**
 * Build the admin request handler.
 *
 * @param {object} options
 * @param {object} options.config service config
 * @param {Map<string, object>} options.tenants app id → tenant handle
 * @returns {(req, res, url) => Promise<boolean>} true if the request was handled
 */
export function createAdminHandler({ config, tenants }) {
  /**
   * Authorize against the app-specific secret if present, otherwise the
   * service-wide one. A per-app secret lets each app hold a credential that
   * cannot touch another app's rooms.
   */
  const authorize = (req, app) => {
    const token = bearerToken(req)
    if (!token) return { ok: false, reason: 'missing bearer token' }
    if (app?.adminSecret && secretsMatch(token, app.adminSecret)) return { ok: true }
    if (config.admin.secret && secretsMatch(token, config.admin.secret)) return { ok: true }
    return { ok: false, reason: 'invalid credentials' }
  }

  return async function handleAdmin(req, res, url) {
    const path = url.pathname
    if (!path.startsWith('/_admin')) return false

    if (!config.admin.enabled) {
      sendJson(res, 404, {
        error: 'admin_api_disabled',
        message: 'Set CRDT_ADMIN_SECRET (or a per-app adminSecret) to enable the admin API.',
      })
      return true
    }

    // ── GET /_admin/stats ────────────────────────────────────────────────
    if (path === '/_admin/stats' && req.method === 'GET') {
      const auth = authorize(req, null)
      if (!auth.ok) {
        sendJson(res, 401, { error: 'unauthorized', message: auth.reason })
        return true
      }
      sendJson(res, 200, {
        uptimeSeconds: Math.floor(process.uptime()),
        apps: [...tenants.values()].map((t) => t.stats()),
      })
      return true
    }

    // ── POST /_admin/apps/:appId/revoke ──────────────────────────────────
    const revokeMatch = path.match(/^\/_admin\/apps\/([^/]+)\/revoke$/)
    if (revokeMatch) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST' })
        return true
      }
      const appId = decodeURIComponent(revokeMatch[1])
      const tenant = tenants.get(appId)

      // Authorize before confirming the app exists, so the endpoint cannot be
      // used to enumerate hosted apps.
      const auth = authorize(req, tenant?.app)
      if (!auth.ok) {
        sendJson(res, 401, { error: 'unauthorized', message: auth.reason })
        return true
      }
      if (!tenant) {
        sendJson(res, 404, { error: 'unknown_app', message: `No app "${appId}" is configured` })
        return true
      }

      let body
      try {
        body = await readJsonBody(req)
      } catch (err) {
        sendJson(res, err.statusCode || 400, { error: 'bad_request', message: err.message })
        return true
      }

      const documentId = toDocumentId(body.documentId ?? body.automergeUrl)
      if (!documentId) {
        sendJson(res, 400, {
          error: 'bad_request',
          message: 'documentId (or automergeUrl) is required',
        })
        return true
      }

      const criteria = {
        documentId,
        userId: body.userId ?? null,
        sid: body.sid ?? null,
        kind: body.kind ?? null,
      }
      const revoked = tenant.revoke(criteria)
      log.info(`app "${appId}": revoke request closed ${revoked} socket(s)`)
      sendJson(res, 200, { ok: true, appId, documentId, revoked })
      return true
    }

    sendJson(res, 404, { error: 'not_found', message: `No admin route for ${path}` })
    return true
  }
}
