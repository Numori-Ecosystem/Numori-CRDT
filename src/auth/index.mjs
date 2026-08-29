/**
 * Numori CRDT — connection authentication and authorization.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MODEL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three independent gates, each narrowing what a connection may do:
 *
 *  1. TENANT      The URL path selects an app. Each app has its own signing key,
 *                 its own Repo and its own storage namespace, so a token minted
 *                 by the notes app is meaningless to the todo app and cannot
 *                 name a document belonging to it. This is structural — not a
 *                 policy check that can be misconfigured away.
 *
 *  2. CONNECTION  Every WebSocket upgrade must present a valid, unexpired token
 *                 signed by that app's key (`?token=<jwt>` or an Authorization
 *                 header), carrying the expected `purpose` and — when the app
 *                 configures one — a matching audience. Rejected connections
 *                 never reach the Repo.
 *
 *  3. ROOM        Which documents this connection may sync. Two modes:
 *
 *                 "open"   — any document the peer can name. Document ids are
 *                            unguessable 128-bit values revealed only through a
 *                            share link, so knowing one is the capability. This
 *                            matches how share links already work and lets one
 *                            socket carry several rooms.
 *
 *                 "strict" — only the documents the token (or the webhook)
 *                            names. Stronger, but the issuing app must list
 *                            every room the session needs, because a client
 *                            multiplexes all its documents over a single
 *                            connection to this server.
 *
 * Whichever mode is used, the room decision is enforced through automerge-repo's
 * `shareConfig.access` in tenant.mjs — not merely at upgrade time.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import { verifyJwt, JwtError } from './jwt.mjs'
import { createWebhookAuthorizer } from './webhook.mjs'
import { toDocumentId, toDocumentIdSet } from '../documentId.mjs'
import { createLogger } from '../log.mjs'

const log = createLogger('auth')

/**
 * Read the token from the request. The query parameter is the primary transport
 * because browser WebSocket clients cannot set request headers; the header form
 * exists for server-to-server peers and CLI tools.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {URL} url already-parsed request URL
 */
function extractToken(req, url) {
  const fromQuery = url.searchParams.get('token')
  if (fromQuery) return fromQuery
  const header = req.headers?.authorization
  if (typeof header === 'string' && /^bearer\s+/i.test(header)) {
    return header.replace(/^bearer\s+/i, '').trim()
  }
  return null
}

/**
 * The identity a verified token describes. Carried on the socket so revocation
 * can target it later, and so the room gate can consult it per document.
 */
function buildIdentity(app, payload) {
  const primary = toDocumentId(payload.documentId)
  // A token may grant one room (`documentId`, what the Numori apps mint today)
  // or several (`documentIds`), which is what "strict" mode needs.
  const granted = new Set(toDocumentIdSet(payload.documentIds))
  if (primary) granted.add(primary)

  return {
    appId: app.id,
    documentId: primary,
    documentIds: granted,
    userId: payload.userId ?? null,
    sid: payload.sid ?? null,
    kind: payload.kind ?? (payload.userId != null ? 'user' : 'guest'),
    access: payload.access || 'write',
    name: typeof payload.name === 'string' ? payload.name.slice(0, 200) : null,
    issuedAt: payload.iat ?? null,
    expiresAt: payload.exp ?? null,
  }
}

/**
 * Create the authenticator for one app.
 *
 * @param {object} app normalized app config
 * @returns {(req: import('node:http').IncomingMessage, url: URL) => Promise<{ok: boolean, reason: string, identity?: object}>}
 */
export function createAuthenticator(app) {
  const authorizeViaWebhook = app.authz === 'webhook' ? createWebhookAuthorizer(app) : null

  return async function authenticate(req, url) {
    // ── Open server (development / trusted networks) ─────────────────────
    if (!app.requireAuth) {
      return {
        ok: true,
        reason: 'auth disabled',
        identity: {
          appId: app.id,
          documentId: null,
          // No claims exist, so no document set can be enforced. tenant.mjs
          // treats an unauthenticated identity as unrestricted, which is the
          // documented meaning of requireAuth:false.
          documentIds: new Set(),
          unrestricted: true,
          userId: null,
          sid: null,
          kind: 'anonymous',
          access: 'write',
          name: null,
          issuedAt: null,
          expiresAt: null,
        },
      }
    }

    const token = extractToken(req, url)
    if (!token) return { ok: false, reason: 'no token supplied' }

    let payload
    try {
      payload = verifyJwt(token, app.jwtSecret)
    } catch (err) {
      const code = err instanceof JwtError ? err.code : 'invalid_token'
      return { ok: false, reason: `token rejected (${code}): ${err.message}` }
    }

    if (app.tokenPurpose && payload.purpose !== app.tokenPurpose) {
      return {
        ok: false,
        reason: `token purpose "${payload.purpose}" does not match required "${app.tokenPurpose}"`,
      }
    }

    // Defence in depth: per-app keys already isolate apps, but an explicit
    // audience catches the case where two apps were handed the same key.
    if (app.audience) {
      const claimed = payload.app ?? payload.aud
      const matches = Array.isArray(claimed)
        ? claimed.includes(app.audience)
        : claimed === app.audience
      if (!matches) {
        return { ok: false, reason: `token audience "${claimed}" does not match "${app.audience}"` }
      }
    }

    const identity = buildIdentity(app, payload)

    if (
      app.documentBinding === 'strict' &&
      identity.documentIds.size === 0 &&
      !authorizeViaWebhook
    ) {
      return {
        ok: false,
        reason: 'documentBinding is "strict" but the token names no documentId',
      }
    }

    // ── Live-state authorization ─────────────────────────────────────────
    if (authorizeViaWebhook) {
      const decision = await authorizeViaWebhook({
        ...identity,
        documentIds: [...identity.documentIds],
      })
      if (!decision.allow) {
        return { ok: false, reason: decision.reason }
      }
      if (decision.documentIds) {
        identity.documentIds = new Set(decision.documentIds)
        if (identity.documentId && !identity.documentIds.has(identity.documentId)) {
          // The app narrowed the grant; the token's entry point is no longer
          // included, so drop it rather than keep a stale claim.
          identity.documentId = identity.documentIds.values().next().value ?? null
        }
      }
      if (decision.access) identity.access = decision.access

      if (app.documentBinding === 'strict' && identity.documentIds.size === 0) {
        return {
          ok: false,
          reason: 'documentBinding is "strict" but neither token nor webhook named a document',
        }
      }
    }

    log.debug(
      `app "${app.id}": accepted ${identity.kind}`,
      identity.userId != null ? `user=${identity.userId}` : `sid=${identity.sid}`,
      `rooms=${identity.documentIds.size || 'any'}`,
    )

    return { ok: true, reason: 'authorized', identity }
  }
}

/** Secret-free description of an app's auth posture, for logs and /healthz. */
export function describeAuth(app) {
  return {
    requireAuth: app.requireAuth,
    documentBinding: app.documentBinding,
    authz: app.authz,
    tokenPurpose: app.tokenPurpose,
    audience: app.audience,
    webhook: app.webhook
      ? { url: app.webhook.url, signed: !!app.webhook.secret, failOpen: app.webhook.failOpen }
      : null,
  }
}
