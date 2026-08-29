/**
 * Numori CRDT — webhook authorizer.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A WEBHOOK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A capability token proves the owning app *once* issued permission. It cannot
 * express what changed since: a share revoked, a collaborator removed, a link
 * expired, a document deleted. Checking that live state means consulting the app.
 *
 * Reading the app's own tables from here would be the direct route, and the wrong
 * one: it hard-wires one product's schema into a service meant to host many, so
 * every new app would need code changes here. Instead each app may nominate an
 * HTTP endpoint answering one question — "may this identity join this room right
 * now?" — which keeps the app's schema private and this service generic while
 * preserving the live-state check.
 *
 * Requests are HMAC-signed over `timestamp.body` so the app can verify the
 * caller is really this service and reject replays. The signature scheme
 * matches the widely used Stripe/GitHub style, which most frameworks already
 * have helpers for.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * FAILURE POLICY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Default is fail CLOSED: if the endpoint is unreachable, slow or returns an
 * unexpected status, the connection is refused. An authorization service that
 * cannot answer must not be read as "yes". Apps that would rather keep
 * collaborating during an outage can set `webhookFailOpen: true`, accepting
 * that revocations may lag until the endpoint recovers.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import crypto from 'node:crypto'
import { createLogger } from '../log.mjs'
import { toDocumentIdSet } from '../documentId.mjs'

const log = createLogger('authz')

export const SIGNATURE_HEADER = 'x-numori-crdt-signature'
export const TIMESTAMP_HEADER = 'x-numori-crdt-timestamp'
export const APP_HEADER = 'x-numori-crdt-app'

/**
 * Compute the signature an app should expect for a given payload.
 * Exported so apps (and the test suite) can verify with identical logic.
 *
 * @param {string} body raw JSON body
 * @param {string|number} timestamp unix seconds
 * @param {string} secret
 * @returns {string} `sha256=<hex>`
 */
export function signPayload(body, timestamp, secret) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${mac}`
}

/**
 * Build an authorizer that asks the app's endpoint for a decision.
 *
 * @param {object} app normalized app config (must have app.webhook)
 * @returns {(identity: object) => Promise<{allow: boolean, reason: string, documentIds?: string[], access?: string}>}
 */
export function createWebhookAuthorizer(app) {
  const { url, secret, timeoutMs, failOpen } = app.webhook

  return async function authorize(identity) {
    const payload = {
      appId: app.id,
      documentId: identity.documentId ?? null,
      documentIds: identity.documentIds ?? [],
      userId: identity.userId ?? null,
      sid: identity.sid ?? null,
      kind: identity.kind ?? null,
      access: identity.access ?? null,
      name: identity.name ?? null,
      issuedAt: identity.issuedAt ?? null,
      expiresAt: identity.expiresAt ?? null,
    }
    const body = JSON.stringify(payload)
    const timestamp = Math.floor(Date.now() / 1000)

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': 'numori-crdt',
      [APP_HEADER]: app.id,
      [TIMESTAMP_HEADER]: String(timestamp),
    }
    if (secret) headers[SIGNATURE_HEADER] = signPayload(body, timestamp, secret)

    let res
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch (err) {
      const reason =
        err?.name === 'TimeoutError' || err?.name === 'AbortError'
          ? `authorization endpoint timed out after ${timeoutMs}ms`
          : `authorization endpoint unreachable: ${err?.message}`
      log.warn(`app "${app.id}": ${reason}; failing ${failOpen ? 'open' : 'closed'}`)
      return { allow: failOpen, reason }
    }

    // An explicit deny status is authoritative regardless of failOpen: the app
    // answered, and the answer was no.
    if (res.status === 401 || res.status === 403) {
      return { allow: false, reason: `authorization endpoint denied (HTTP ${res.status})` }
    }

    if (!res.ok) {
      const reason = `authorization endpoint returned HTTP ${res.status}`
      log.warn(`app "${app.id}": ${reason}; failing ${failOpen ? 'open' : 'closed'}`)
      return { allow: failOpen, reason }
    }

    let decision
    try {
      decision = await res.json()
    } catch (err) {
      const reason = `authorization endpoint returned unparseable JSON: ${err?.message}`
      log.warn(`app "${app.id}": ${reason}; failing ${failOpen ? 'open' : 'closed'}`)
      return { allow: failOpen, reason }
    }

    if (decision?.allow !== true) {
      return {
        allow: false,
        reason: decision?.reason ? String(decision.reason).slice(0, 200) : 'authorization denied',
      }
    }

    // The endpoint may widen or narrow the rooms this connection may sync — the
    // app knows the full membership, the token only carried the entry point.
    const documentIds =
      decision.documentIds !== undefined ? toDocumentIdSet(decision.documentIds) : undefined

    return {
      allow: true,
      reason: 'authorized',
      documentIds,
      access: typeof decision.access === 'string' ? decision.access : undefined,
    }
  }
}
