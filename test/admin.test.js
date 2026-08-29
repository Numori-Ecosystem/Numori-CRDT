import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  startService,
  createClientPool,
  createOfflineRepo,
  attachNetwork,
  mintToken,
  waitFor,
  servedText,
  TEST_SECRET,
  ADMIN_SECRET,
} from './helpers.mjs'
import { REVOKED_CLOSE_CODE, matchesRevocation } from '../src/tenant.mjs'

describe('matchesRevocation', () => {
  const identity = (over = {}) => ({
    documentId: 'doc-1',
    documentIds: new Set(['doc-1']),
    userId: 7,
    sid: null,
    kind: 'user',
    ...over,
  })

  it('ignores a revocation for a different room', () => {
    expect(matchesRevocation(identity(), { documentId: 'doc-2' })).toBe(false)
  })

  it('boots the whole room when no target is named', () => {
    expect(matchesRevocation(identity(), { documentId: 'doc-1' })).toBe(true)
  })

  it('targets a specific account', () => {
    expect(matchesRevocation(identity(), { documentId: 'doc-1', userId: 7 })).toBe(true)
    expect(matchesRevocation(identity(), { documentId: 'doc-1', userId: 8 })).toBe(false)
  })

  it('targets a specific guest session', () => {
    const guest = identity({ userId: null, sid: 'abc', kind: 'guest' })
    expect(matchesRevocation(guest, { documentId: 'doc-1', sid: 'abc' })).toBe(true)
    expect(matchesRevocation(guest, { documentId: 'doc-1', sid: 'xyz' })).toBe(false)
  })

  it('targets a whole kind', () => {
    const guest = identity({ userId: null, sid: 'abc', kind: 'guest' })
    expect(matchesRevocation(guest, { documentId: 'doc-1', kind: 'guest' })).toBe(true)
    expect(matchesRevocation(identity(), { documentId: 'doc-1', kind: 'guest' })).toBe(false)
  })

  it('matches a room granted only through documentIds', () => {
    const multi = identity({ documentId: null, documentIds: new Set(['doc-1', 'doc-9']) })
    expect(matchesRevocation(multi, { documentId: 'doc-9' })).toBe(true)
  })

  it('never matches a missing identity or criteria', () => {
    expect(matchesRevocation(null, { documentId: 'doc-1' })).toBe(false)
    expect(matchesRevocation(identity(), {})).toBe(false)
  })
})

describe('admin API disabled by default', () => {
  let svc

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: TEST_SECRET }]),
    })
  })
  afterAll(() => svc.stop())

  it('reports the API as unavailable rather than unauthorized', async () => {
    const res = await fetch(svc.http('/_admin/stats'), {
      headers: { Authorization: `Bearer ${ADMIN_SECRET}` },
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('admin_api_disabled')
  })
})

describe('admin API', () => {
  let svc
  const clients = createClientPool()

  const admin = (path, options = {}) =>
    fetch(svc.http(path), {
      ...options,
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${ADMIN_SECRET}`,
        ...(options.headers || {}),
      },
    })

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        { id: 'notes', secret: TEST_SECRET },
        { id: 'todo', secret: TEST_SECRET },
      ]),
      CRDT_ADMIN_SECRET: ADMIN_SECRET,
    })
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('requires a bearer token', async () => {
    const res = await fetch(svc.http('/_admin/stats'))
    expect(res.status).toBe(401)
  })

  it('rejects a wrong secret', async () => {
    const res = await fetch(svc.http('/_admin/stats'), {
      headers: { Authorization: 'Bearer not-the-admin-secret-value' },
    })
    expect(res.status).toBe(401)
  })

  it('reports per-app stats', async () => {
    const res = await admin('/_admin/stats')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.apps.map((a) => a.id).sort()).toEqual(['notes', 'todo'])
  })

  it('does not reveal whether an app exists to an unauthenticated caller', async () => {
    // Both a real and a fake app must answer 401, not 401 vs 404.
    const real = await fetch(svc.http('/_admin/apps/notes/revoke'), {
      method: 'POST',
      body: '{}',
    })
    const fake = await fetch(svc.http('/_admin/apps/ghost/revoke'), {
      method: 'POST',
      body: '{}',
    })
    expect(real.status).toBe(401)
    expect(fake.status).toBe(401)
  })

  it('rejects a revoke request with no documentId', async () => {
    const res = await admin('/_admin/apps/notes/revoke', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown app when authenticated', async () => {
    const res = await admin('/_admin/apps/ghost/revoke', {
      method: 'POST',
      body: JSON.stringify({ documentId: 'abc123abc123abc123abc' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a non-POST revoke', async () => {
    const res = await admin('/_admin/apps/notes/revoke', { method: 'GET' })
    expect(res.status).toBe(405)
  })

  it('disconnects a peer from a room with close code 4001', async () => {
    const repo = createOfflineRepo()
    const handle = repo.create({ text: 'revoke me' })
    const documentId = handle.documentId
    const token = mintToken({ secret: TEST_SECRET, documentId, userId: 42 })
    const tenant = svc.tenant('notes')

    const adapter = attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    expect(await waitFor(() => servedText(tenant, documentId) === 'revoke me')).toBe(true)

    let closeCode = null
    // The adapter reassigns .socket on every reconnect, so read it now that the
    // connection is established.
    adapter.socket?.addEventListener('close', (ev) => {
      closeCode = ev?.code
    })

    const res = await admin('/_admin/apps/notes/revoke', {
      method: 'POST',
      body: JSON.stringify({ documentId, userId: 42 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, appId: 'notes', revoked: 1 })
    expect(await waitFor(() => closeCode === REVOKED_CLOSE_CODE)).toBe(true)
  })

  it('accepts an automerge: url as the target', async () => {
    const repo = createOfflineRepo()
    const handle = repo.create({ text: 'url form' })
    const token = mintToken({ secret: TEST_SECRET, documentId: handle.documentId, userId: 43 })
    const tenant = svc.tenant('notes')

    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))
    expect(await waitFor(() => servedText(tenant, handle.documentId) === 'url form')).toBe(true)

    const res = await admin('/_admin/apps/notes/revoke', {
      method: 'POST',
      body: JSON.stringify({ automergeUrl: handle.url }),
    })
    expect(await res.json()).toMatchObject({ revoked: 1, documentId: handle.documentId })
  })

  it('leaves peers of other rooms and other apps connected', async () => {
    const repo = createOfflineRepo()
    const target = repo.create({ text: 'target room' })
    const bystander = repo.create({ text: 'bystander room' })
    const tenant = svc.tenant('notes')

    const targetToken = mintToken({ secret: TEST_SECRET, documentId: target.documentId, userId: 1 })
    const otherRepo = createOfflineRepo()
    const otherToken = mintToken({
      secret: TEST_SECRET,
      documentId: bystander.documentId,
      userId: 2,
    })

    attachNetwork(clients, repo, svc.ws(`/notes?token=${targetToken}`))
    attachNetwork(clients, otherRepo, svc.ws(`/notes?token=${otherToken}`))
    expect(await waitFor(() => tenant.stats().connections === 2)).toBe(true)

    const res = await admin('/_admin/apps/notes/revoke', {
      method: 'POST',
      body: JSON.stringify({ documentId: target.documentId }),
    })
    expect(await res.json()).toMatchObject({ revoked: 1 })
  })
})

describe('per-app admin credentials', () => {
  let svc

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        { id: 'notes', secret: TEST_SECRET, adminSecret: 'notes-admin-secret-value-1' },
        { id: 'todo', secret: TEST_SECRET, adminSecret: 'todo-admin-secret-value-22' },
      ]),
    })
  })
  afterAll(() => svc.stop())

  it("does not accept one app's admin secret for another app", async () => {
    const res = await fetch(svc.http('/_admin/apps/todo/revoke'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer notes-admin-secret-value-1',
      },
      body: JSON.stringify({ documentId: 'abc123abc123abc123abc' }),
    })
    expect(res.status).toBe(401)
  })

  it('accepts the matching app secret', async () => {
    const res = await fetch(svc.http('/_admin/apps/todo/revoke'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer todo-admin-secret-value-22',
      },
      body: JSON.stringify({ documentId: 'abc123abc123abc123abc' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, revoked: 0 })
  })
})
