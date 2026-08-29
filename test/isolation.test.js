import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import {
  startService,
  createClientPool,
  mintToken,
  waitFor,
  settle,
  docText,
  servedText,
  openRawSocket,
  TEST_SECRET,
  OTHER_SECRET,
} from './helpers.mjs'

/**
 * Cross-app isolation — the property that makes it safe to host several
 * unrelated applications on one deployment.
 *
 * Each app has its own signing key, its own Repo and its own storage namespace,
 * so isolation is structural rather than a policy check that could be
 * misconfigured. These tests pin that behaviour.
 */
describe('cross-app isolation', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        { id: 'alpha', secret: TEST_SECRET },
        { id: 'beta', secret: OTHER_SECRET },
      ]),
    })
  })

  afterEach(() => clients.disconnectAll())
  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('gives each app its own Repo instance', () => {
    const alpha = svc.tenant('alpha')
    const beta = svc.tenant('beta')
    expect(alpha.repo).not.toBe(beta.repo)
    expect(alpha.repo.peerId).not.toBe(beta.repo.peerId)
  })

  it("refuses a token signed with another app's key", async () => {
    const alphaToken = mintToken({ secret: TEST_SECRET })
    const result = await openRawSocket(svc.ws(`/beta?token=${alphaToken}`))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(401)
  })

  it('accepts the same token on its own app', async () => {
    const alphaToken = mintToken({ secret: TEST_SECRET })
    const result = await openRawSocket(svc.ws(`/alpha?token=${alphaToken}`))
    expect(result).toEqual({ opened: true })
  })

  it("does not expose one app's document to another app, even given its id", async () => {
    const alphaToken = mintToken({ secret: TEST_SECRET })
    const betaToken = mintToken({ secret: OTHER_SECRET })

    // Author a document through the alpha app and let it reach the server.
    const { repo: alphaClient } = clients.connect(svc.ws(`/alpha?token=${alphaToken}`))
    const handle = alphaClient.create({ text: 'alpha private content' })
    const url = handle.url
    const documentId = handle.documentId
    expect(
      await waitFor(() => servedText(svc.tenant('alpha'), documentId) === 'alpha private content'),
    ).toBe(true)

    // Ask the beta app for the very same document id with a valid beta token.
    const { repo: betaClient } = clients.connect(svc.ws(`/beta?token=${betaToken}`))
    const betaHandle = await betaClient.find(url).catch(() => null)
    await settle()

    // No content crosses the app boundary.
    expect(docText(betaHandle)).toBeUndefined()

    // The beta tenant may hold an empty placeholder handle for an id a peer
    // asked about — automerge-repo creates one while resolving a request. What
    // matters is that it never resolves to alpha's data, because beta's Repo
    // reads a different storage namespace and shares no peers with alpha's.
    expect(servedText(svc.tenant('beta'), documentId)).toBeUndefined()
    expect(servedText(svc.tenant('alpha'), documentId)).toBe('alpha private content')
  })

  it('routes by the first path segment', async () => {
    const alphaToken = mintToken({ secret: TEST_SECRET })
    // Correct app: accepted. Wrong app with the same token: refused.
    expect(await openRawSocket(svc.ws(`/alpha?token=${alphaToken}`))).toEqual({ opened: true })
    expect((await openRawSocket(svc.ws(`/beta?token=${alphaToken}`))).status).toBe(401)
  })

  it('refuses an upgrade to an unknown app when no default is configured', async () => {
    const alphaToken = mintToken({ secret: TEST_SECRET })
    const result = await openRawSocket(svc.ws(`/nonexistent?token=${alphaToken}`))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(404)
  })
})

describe('audience binding', () => {
  let svc

  beforeAll(async () => {
    // Two apps sharing one key — a configuration mistake. An audience claim is
    // the second line of defence that still keeps them apart.
    svc = await startService({
      CRDT_APPS: JSON.stringify([
        { id: 'alpha', secret: TEST_SECRET, audience: 'alpha' },
        { id: 'beta', secret: TEST_SECRET, audience: 'beta' },
      ]),
    })
  })

  afterAll(() => svc.stop())

  it('accepts a token whose audience matches', async () => {
    const token = mintToken({ secret: TEST_SECRET, app: 'alpha' })
    expect(await openRawSocket(svc.ws(`/alpha?token=${token}`))).toEqual({ opened: true })
  })

  it('rejects a correctly signed token aimed at another app', async () => {
    const token = mintToken({ secret: TEST_SECRET, app: 'alpha' })
    const result = await openRawSocket(svc.ws(`/beta?token=${token}`))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(401)
  })

  it('rejects a token with no audience claim when one is required', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    expect((await openRawSocket(svc.ws(`/alpha?token=${token}`))).status).toBe(401)
  })
})

describe('default app fallback', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    // A single app becomes the implicit default, which is what lets an existing
    // client that connects to "/collab" keep working unchanged.
    svc = await startService({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: TEST_SECRET }]),
    })
  })

  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('serves a legacy path through the default app', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    const { repo } = clients.connect(svc.ws(`/collab?token=${token}`))
    const handle = repo.create({ text: 'legacy path' })
    expect(
      await waitFor(() => servedText(svc.tenant('notes'), handle.documentId) === 'legacy path'),
    ).toBe(true)
  })

  it('also accepts the app named by query parameter', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    expect(await openRawSocket(svc.ws(`/?app=notes&token=${token}`))).toEqual({ opened: true })
  })
})
