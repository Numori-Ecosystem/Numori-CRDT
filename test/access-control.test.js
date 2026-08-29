import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  startService,
  createClientPool,
  createOfflineRepo,
  attachNetwork,
  mintToken,
  waitFor,
  settle,
  servedText,
  docText,
  openRawSocket,
  TEST_SECRET,
} from './helpers.mjs'

/**
 * Room-level access control.
 *
 * ── Why the announce test matters ──────────────────────────────────────────
 * automerge-repo's legacy `sharePolicy` option only sets `shareConfig.announce`
 * and leaves `shareConfig.access` at allow-all. A server configured with
 * `sharePolicy: () => true` therefore announces every document it holds in
 * memory to every connected peer, regardless of what that peer asked for or is
 * entitled to. This service sets `announce: false` plus a real `access` gate;
 * the first test below is the regression guard for that.
 */
describe('the server never volunteers documents (announce: false)', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: TEST_SECRET }]),
    })
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('does not push a warm document to a peer that never requested it', async () => {
    const tokenA = mintToken({ secret: TEST_SECRET, userId: 1 })
    const tokenB = mintToken({ secret: TEST_SECRET, userId: 2 })
    const tenant = svc.tenant('notes')

    // Peer A authors a document; the server now holds it in memory.
    const { repo: repoA } = clients.connect(svc.ws(`/notes?token=${tokenA}`))
    const handleA = repoA.create({ text: 'first user private draft' })
    const documentId = handleA.documentId
    expect(await waitFor(() => servedText(tenant, documentId) === 'first user private draft')).toBe(
      true,
    )

    // Peer B connects and asks for nothing at all.
    const { repo: repoB } = clients.connect(svc.ws(`/notes?token=${tokenB}`))
    expect(await waitFor(() => repoB.peers.length > 0)).toBe(true)
    await settle(900)

    // B must not have been handed A's document.
    expect(Object.keys(repoB.handles)).not.toContain(documentId)
  })
})

describe('documentBinding: strict', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: TEST_SECRET, documentBinding: 'strict' }]),
    })
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('rejects a token that names no document', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    const result = await openRawSocket(svc.ws(`/notes?token=${token}`))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(401)
  })

  it('syncs a room the token grants, between two peers', async () => {
    // Allocate the id offline first, then mint a token for it — the same order a
    // share flow uses: create the document, then issue the link.
    const authorRepo = createOfflineRepo()
    const handle = authorRepo.create({ text: 'granted room' })
    const token = mintToken({ secret: TEST_SECRET, documentId: handle.documentId })
    const tenant = svc.tenant('notes')

    attachNetwork(clients, authorRepo, svc.ws(`/notes?token=${token}`))
    expect(await waitFor(() => servedText(tenant, handle.documentId) === 'granted room')).toBe(true)

    // A second peer holding the same grant reads it back.
    const readerRepo = createOfflineRepo()
    attachNetwork(clients, readerRepo, svc.ws(`/notes?token=${token}`))
    const readerHandle = await readerRepo.find(handle.url).catch(() => null)
    expect(await waitFor(() => docText(readerHandle) === 'granted room')).toBe(true)
  })

  it('denies a room the token does not grant', async () => {
    const repo = createOfflineRepo()
    const granted = repo.create({ text: 'covered by the token' })
    const ungranted = repo.create({ text: 'must not be accepted' })
    const token = mintToken({ secret: TEST_SECRET, documentId: granted.documentId })
    const tenant = svc.tenant('notes')
    const denialsBefore = tenant.stats().accessDenials

    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))

    // The granted room goes through…
    expect(
      await waitFor(() => servedText(tenant, granted.documentId) === 'covered by the token'),
    ).toBe(true)
    await settle(900)

    // …the other one is refused and never materializes on the server.
    expect(servedText(tenant, ungranted.documentId)).toBeUndefined()
    expect(tenant.stats().accessDenials).toBeGreaterThan(denialsBefore)
  })

  it('honours a multi-room grant via the documentIds claim', async () => {
    const repo = createOfflineRepo()
    const first = repo.create({ text: 'room one' })
    const second = repo.create({ text: 'room two' })
    const third = repo.create({ text: 'room three' })
    const tenant = svc.tenant('notes')

    const token = mintToken({
      secret: TEST_SECRET,
      documentIds: [first.documentId, second.documentId],
    })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))

    expect(
      await waitFor(
        () =>
          servedText(tenant, first.documentId) === 'room one' &&
          servedText(tenant, second.documentId) === 'room two',
      ),
    ).toBe(true)
    await settle(900)
    expect(servedText(tenant, third.documentId)).toBeUndefined()
  })

  it('treats an automerge: url in the claim as naming the same room', async () => {
    const repo = createOfflineRepo()
    const doc = repo.create({ text: 'scheme handled' })
    const tenant = svc.tenant('notes')

    const token = mintToken({ secret: TEST_SECRET, documentId: `automerge:${doc.documentId}` })
    attachNetwork(clients, repo, svc.ws(`/notes?token=${token}`))

    expect(await waitFor(() => servedText(tenant, doc.documentId) === 'scheme handled')).toBe(true)
  })
})

describe('documentBinding: open', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: TEST_SECRET, documentBinding: 'open' }]),
    })
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('lets one connection carry several rooms', async () => {
    // This is why "open" is the compatible default: a client multiplexes every
    // document it holds over a single connection to this server, so a token that
    // named only one room would break the others.
    const token = mintToken({ secret: TEST_SECRET, documentId: 'one-room-only-in-token' })
    const { repo } = clients.connect(svc.ws(`/notes?token=${token}`))
    const tenant = svc.tenant('notes')

    const first = repo.create({ text: 'room one' })
    const second = repo.create({ text: 'room two' })

    expect(
      await waitFor(
        () =>
          servedText(tenant, first.documentId) === 'room one' &&
          servedText(tenant, second.documentId) === 'room two',
      ),
    ).toBe(true)
    expect(tenant.stats().accessDenials).toBe(0)
  })

  it('still refuses a peer with no valid token', async () => {
    const result = await openRawSocket(svc.ws('/notes?token=not-a-jwt'))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(401)
  })

  it('rejects a token whose purpose claim is wrong', async () => {
    const token = mintToken({ secret: TEST_SECRET, purpose: 'password-reset' })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = mintToken({ secret: TEST_SECRET, expiresInSeconds: -3600 })
    expect((await openRawSocket(svc.ws(`/notes?token=${token}`))).status).toBe(401)
  })
})
