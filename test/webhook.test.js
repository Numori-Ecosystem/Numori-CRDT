import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import {
  startService,
  createClientPool,
  createOfflineRepo,
  attachNetwork,
  mintToken,
  openRawSocket,
  waitFor,
  settle,
  servedText,
  TEST_SECRET,
} from './helpers.mjs'
import { signPayload, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../src/auth/webhook.mjs'

const WEBHOOK_SECRET = 'webhook-signing-secret-value'

/**
 * A stand-in for the owning app's authorization endpoint. Records what it was
 * asked and answers however the current test dictates.
 */
function createFakeApp() {
  const state = {
    requests: [],
    respond: (_payload, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: true }))
    },
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let payload = null
      try {
        payload = JSON.parse(raw)
      } catch {
        /* leave null */
      }
      state.requests.push({ headers: req.headers, raw, payload })
      state.respond(payload, res, { raw, headers: req.headers })
    })
  })

  return {
    state,
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

describe('webhook authorization', () => {
  let app
  let appPort
  let svc

  beforeAll(async () => {
    app = createFakeApp()
    appPort = await app.listen()
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        {
          id: 'notes',
          secret: TEST_SECRET,
          authz: 'webhook',
          webhookUrl: `http://127.0.0.1:${appPort}/authorize`,
          webhookSecret: WEBHOOK_SECRET,
          webhookTimeoutMs: 1000,
        },
      ]),
    })
  })

  afterAll(async () => {
    await svc.stop()
    await app.close()
  })

  beforeEach(() => {
    app.state.requests.length = 0
    app.state.respond = (_payload, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: true }))
    }
  })

  it('lets a connection through when the app allows it', async () => {
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    expect(await openRawSocket(svc.ws(`/notes?token=${token}`))).toEqual({ opened: true })
    expect(app.state.requests).toHaveLength(1)
  })

  it('forwards the identity the token described', async () => {
    const token = mintToken({
      secret: TEST_SECRET,
      documentId: 'abc123abc123abc123abc',
      userId: 99,
      kind: 'user',
      access: 'write',
    })
    await openRawSocket(svc.ws(`/notes?token=${token}`))
    expect(app.state.requests[0].payload).toMatchObject({
      appId: 'notes',
      documentId: 'abc123abc123abc123abc',
      userId: 99,
      kind: 'user',
      access: 'write',
    })
  })

  it('signs the request so the app can verify the caller', async () => {
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    await openRawSocket(svc.ws(`/notes?token=${token}`))

    const { headers, raw } = app.state.requests[0]
    const timestamp = headers[TIMESTAMP_HEADER]
    expect(timestamp).toBeTruthy()
    expect(headers[SIGNATURE_HEADER]).toBe(signPayload(raw, timestamp, WEBHOOK_SECRET))
    // And a wrong key must not verify.
    expect(headers[SIGNATURE_HEADER]).not.toBe(signPayload(raw, timestamp, 'wrong-secret-value-x'))
  })

  it('produces a signature the standard HMAC recipe reproduces', async () => {
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    await openRawSocket(svc.ws(`/notes?token=${token}`))
    const { headers, raw } = app.state.requests[0]
    const expected = `sha256=${crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(`${headers[TIMESTAMP_HEADER]}.${raw}`)
      .digest('hex')}`
    expect(headers[SIGNATURE_HEADER]).toBe(expected)
  })

  it('refuses the connection when the app denies', async () => {
    app.state.respond = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: false, reason: 'membership revoked' }))
    }
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    const result = await openRawSocket(svc.ws(`/notes?token=${token}`))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(401)
  })

  it('treats HTTP 403 as an authoritative deny', async () => {
    app.state.respond = (_p, res) => {
      res.writeHead(403)
      res.end()
    }
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })

  it('fails closed when the app errors', async () => {
    app.state.respond = (_p, res) => {
      res.writeHead(500)
      res.end()
    }
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })

  it('fails closed when the app returns unparseable JSON', async () => {
    app.state.respond = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('not json at all')
    }
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })

  it('fails closed when the app is too slow', async () => {
    app.state.respond = (_p, res) => {
      // Exceeds the configured 1000ms timeout.
      setTimeout(() => {
        try {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ allow: true }))
        } catch {
          /* connection already gone */
        }
      }, 2500).unref?.()
    }
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })

  it('does not call the webhook when the token itself is invalid', async () => {
    // Signature verification comes first, so a forged token costs no round-trip.
    await openRawSocket(svc.ws('/notes?token=garbage'))
    expect(app.state.requests).toHaveLength(0)
  })
})

describe('webhook fail-open opt-in', () => {
  let app
  let svc

  beforeAll(async () => {
    app = createFakeApp()
    const port = await app.listen()
    app.state.respond = (_p, res) => {
      res.writeHead(500)
      res.end()
    }
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        {
          id: 'notes',
          secret: TEST_SECRET,
          authz: 'webhook',
          webhookUrl: `http://127.0.0.1:${port}/authorize`,
          webhookFailOpen: true,
          webhookTimeoutMs: 500,
        },
      ]),
    })
  })

  afterAll(async () => {
    await svc.stop()
    await app.close()
  })

  it('admits a valid token when the endpoint is broken and fail-open is set', async () => {
    const token = mintToken({ secret: TEST_SECRET, documentId: 'abc123abc123abc123abc' })
    expect(await openRawSocket(svc.ws(`/notes?token=${token}`))).toEqual({ opened: true })
  })
})

/**
 * Per-room authorization.
 *
 * Authorizing only at connect time leaves a gap: one socket can name any number
 * of documents, so a collaborator removed from document A could reconnect with a
 * still-valid token for document B and then ask for A over that socket. Closing
 * their socket does not help, because the next connection is legitimately
 * authorized — just not for A. These tests pin the check that closes it.
 */
describe('per-room authorization', () => {
  let app
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    app = createFakeApp()
    const port = await app.listen()
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        {
          id: 'notes',
          secret: TEST_SECRET,
          authz: 'webhook',
          webhookUrl: `http://127.0.0.1:${port}/authorize`,
          webhookTimeoutMs: 1000,
          webhookCacheTtlMs: 1000,
        },
      ]),
    })
  })

  beforeEach(() => {
    // Each test asserts on the requests it caused, so start from a clean slate.
    app.state.requests.length = 0
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
    await app.close()
  })

  const allowAll = () => {
    app.state.respond = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: true }))
    }
  }

  it('does not re-ask for a room the token already granted', async () => {
    const repo = createOfflineRepo()
    const doc = repo.create({ text: 'granted at connect' })
    allowAll()
    const token = mintToken({ secret: TEST_SECRET, documentId: doc.documentId })

    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    expect(
      await waitFor(() => servedText(svc.tenant('notes'), doc.documentId) === 'granted at connect'),
    ).toBe(true)

    // Exactly one request: the connection check. The room was already granted, so
    // syncing it must not generate a second round-trip per message.
    const roomChecks = app.state.requests.filter((r) => r.payload?.check === 'room')
    expect(roomChecks).toHaveLength(0)
  })

  it('asks the app about a room the token did not grant, and honours a denial', async () => {
    const repo = createOfflineRepo()
    const granted = repo.create({ text: 'the entry room' })
    const other = repo.create({ text: 'must not be accepted' })
    const tenant = svc.tenant('notes')

    app.state.respond = (payload, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      // Approve the connection, refuse the room the token never named.
      const allow = !(payload.check === 'room' && payload.documentId === other.documentId)
      res.end(JSON.stringify({ allow, reason: allow ? 'ok' : 'not a member' }))
    }

    const token = mintToken({ secret: TEST_SECRET, documentId: granted.documentId })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))

    expect(await waitFor(() => servedText(tenant, granted.documentId) === 'the entry room')).toBe(
      true,
    )
    await settle(900)

    expect(servedText(tenant, other.documentId)).toBeUndefined()
    const roomChecks = app.state.requests.filter((r) => r.payload?.check === 'room')
    expect(roomChecks.length).toBeGreaterThan(0)
    expect(roomChecks.every((r) => r.payload.documentId === other.documentId)).toBe(true)
  })

  it('admits a room the token did not grant when the app approves it', async () => {
    const repo = createOfflineRepo()
    const entry = repo.create({ text: 'entry' })
    const extra = repo.create({ text: 'approved later' })
    const tenant = svc.tenant('notes')
    allowAll()

    const token = mintToken({ secret: TEST_SECRET, documentId: entry.documentId })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))

    expect(await waitFor(() => servedText(tenant, extra.documentId) === 'approved later')).toBe(
      true,
    )
  })

  it('caches a decision instead of asking on every sync message', async () => {
    const repo = createOfflineRepo()
    const entry = repo.create({ text: 'entry' })
    const extra = repo.create({ text: '' })
    const tenant = svc.tenant('notes')
    allowAll()

    const token = mintToken({ secret: TEST_SECRET, documentId: entry.documentId })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    const handle = await repo.find(extra.url)
    expect(await waitFor(() => servedText(tenant, extra.documentId) !== undefined)).toBe(true)

    const afterFirstSync = app.state.requests.filter((r) => r.payload?.check === 'room').length
    expect(afterFirstSync).toBeGreaterThan(0)

    // Twenty separate edits, each producing at least one sync message. The access
    // gate runs for all of them; the app must not see twenty more requests.
    for (let i = 0; i < 20; i++) {
      handle.change((d) => {
        d.text = `${d.text}x`
      })
      await settle(15)
    }
    await settle(300)

    const afterEdits = app.state.requests.filter((r) => r.payload?.check === 'room').length
    expect(afterEdits).toBe(afterFirstSync)
  })

  it('re-asks once the cached decision expires', async () => {
    const repo = createOfflineRepo()
    const entry = repo.create({ text: 'entry' })
    const extra = repo.create({ text: '' })
    const tenant = svc.tenant('notes')
    allowAll()

    const token = mintToken({ secret: TEST_SECRET, documentId: entry.documentId })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    const handle = await repo.find(extra.url)
    expect(await waitFor(() => servedText(tenant, extra.documentId) !== undefined)).toBe(true)
    const before = app.state.requests.filter((r) => r.payload?.check === 'room').length

    // Cache ttl for this service is 1000ms.
    await settle(1300)
    handle.change((d) => {
      d.text = 'after expiry'
    })
    expect(
      await waitFor(
        () => app.state.requests.filter((r) => r.payload?.check === 'room').length > before,
      ),
    ).toBe(true)
  })

  it('fails closed on a room check when the app is unreachable', async () => {
    const repo = createOfflineRepo()
    const entry = repo.create({ text: 'entry' })
    const extra = repo.create({ text: 'should not land' })
    const tenant = svc.tenant('notes')

    app.state.respond = (payload, res) => {
      if (payload.check === 'room') {
        res.writeHead(500)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: true }))
    }

    const token = mintToken({ secret: TEST_SECRET, documentId: entry.documentId })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    expect(await waitFor(() => servedText(tenant, entry.documentId) === 'entry')).toBe(true)
    await settle(900)

    expect(servedText(tenant, extra.documentId)).toBeUndefined()
  })

  it('identifies the room being checked in the request', async () => {
    const repo = createOfflineRepo()
    const entry = repo.create({ text: 'entry' })
    const extra = repo.create({ text: 'extra' })
    allowAll()

    const token = mintToken({
      secret: TEST_SECRET,
      documentId: entry.documentId,
      userId: 77,
      kind: 'user',
    })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    expect(
      await waitFor(() =>
        app.state.requests.some(
          (r) => r.payload?.check === 'room' && r.payload?.documentId === extra.documentId,
        ),
      ),
    ).toBe(true)

    const check = app.state.requests.find(
      (r) => r.payload?.check === 'room' && r.payload?.documentId === extra.documentId,
    )
    expect(check.payload).toMatchObject({ appId: 'notes', userId: 77, kind: 'user' })
  })
})

describe('webhook room grants', () => {
  let app
  let svc

  beforeAll(async () => {
    app = createFakeApp()
    const port = await app.listen()
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        {
          id: 'notes',
          secret: TEST_SECRET,
          documentBinding: 'strict',
          authz: 'webhook',
          webhookUrl: `http://127.0.0.1:${port}/authorize`,
        },
      ]),
    })
  })

  afterAll(async () => {
    await svc.stop()
    await app.close()
  })

  it('accepts a token naming no room when the app supplies the rooms', async () => {
    // Under strict binding a bare token is normally refused; the app answering
    // with an explicit room list is what makes it admissible.
    app.state.respond = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: true, documentIds: ['abc123abc123abc123abc'] }))
    }
    const token = mintToken({ secret: TEST_SECRET })
    expect(await openRawSocket(svc.ws(`/notes?token=${token}`))).toEqual({ opened: true })
  })

  it('still refuses when neither token nor app names a room', async () => {
    app.state.respond = (_p, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ allow: true, documentIds: [] }))
    }
    const token = mintToken({ secret: TEST_SECRET })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })
})
