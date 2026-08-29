import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import * as A from '@automerge/automerge/slim'
import {
  startService,
  createClientPool,
  mintToken,
  waitFor,
  settle,
  openRawSocket,
  TEST_SECRET,
} from './helpers.mjs'

/**
 * End-to-end real-time sync over the full network path: client adapter →
 * WebSocket upgrade → auth gate → tenant Repo → Automerge sync protocol. This is
 * the same flow two browser tabs use.
 */
describe('real-time sync', () => {
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

  it('serves liveness on /healthz', async () => {
    const res = await fetch(svc.http('/healthz'))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.service).toBe('numori-crdt')
    expect(body.apps.map((a) => a.id)).toEqual(['notes'])
  })

  it('answers any other GET so proxy health checks pass', async () => {
    const res = await fetch(svc.http('/notes'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('numori-crdt ok')
  })

  it('converges two clients on the same document', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    const { repo: repoA } = clients.connect(svc.ws(`/notes?token=${token}`))
    const { repo: repoB } = clients.connect(svc.ws(`/notes?token=${token}`))

    const handleA = repoA.create({ text: '' })
    handleA.change((d) => A.splice(d, ['text'], 0, 0, 'hello from A'))
    const url = handleA.url

    const handleB = await repoB.find(url)
    await handleB.whenReady()
    expect(await waitFor(() => handleB.doc()?.text === 'hello from A')).toBe(true)

    handleB.change((d) => A.splice(d, ['text'], d.text.length, 0, ' + B'))
    expect(await waitFor(() => handleA.doc()?.text === 'hello from A + B')).toBe(true)
    expect(handleB.doc().text).toBe('hello from A + B')
  })

  it('merges concurrent edits from both sides without loss', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    const { repo: repoA } = clients.connect(svc.ws(`/notes?token=${token}`))
    const { repo: repoB } = clients.connect(svc.ws(`/notes?token=${token}`))

    const handleA = repoA.create({ text: 'start' })
    const url = handleA.url
    const handleB = await repoB.find(url)
    await handleB.whenReady()
    expect(await waitFor(() => handleB.doc()?.text === 'start')).toBe(true)

    // Both peers edit before either has seen the other's change.
    handleA.change((d) => A.splice(d, ['text'], 0, 0, 'A:'))
    handleB.change((d) => A.splice(d, ['text'], d.text.length, 0, ':B'))

    const converged = await waitFor(() => {
      const a = handleA.doc()?.text
      const b = handleB.doc()?.text
      return a && a === b && a.includes('A:') && a.includes(':B')
    })
    expect(converged).toBe(true)
  })

  it('accepts a token in the Authorization header', async () => {
    // Browsers cannot set headers on a WebSocket, but server-to-server peers can.
    const token = mintToken({ secret: TEST_SECRET })
    const opened = await openRawSocket(svc.ws('/notes'), {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(opened).toEqual({ opened: true })
  })

  it('rejects an upgrade with no credentials at all', async () => {
    const result = await openRawSocket(svc.ws('/notes'))
    expect(result.opened).toBe(false)
    expect(result.status).toBe(401)
  })

  it('relays ephemeral messages between peers', async () => {
    // Presence (live cursors, participant lists) rides on Automerge's ephemeral
    // messages rather than document changes: they are relayed to the room but
    // never persisted. Applications build their own presence payloads on top, so
    // the property the service owns is simply that they reach the other peers.
    const token = mintToken({ secret: TEST_SECRET })
    const { repo: repoA } = clients.connect(svc.ws(`/notes?token=${token}`))
    const { repo: repoB } = clients.connect(svc.ws(`/notes?token=${token}`))

    const handleA = repoA.create({ text: 'shared doc' })
    const handleB = await repoB.find(handleA.url)
    await handleB.whenReady()

    const received = []
    handleB.on('ephemeral-message', ({ senderId, message }) => received.push({ senderId, message }))

    handleA.broadcast({ type: 'presence', name: 'Ada', anchor: 1, head: 3 })

    expect(await waitFor(() => received.length > 0)).toBe(true)
    expect(received[0].message).toMatchObject({ type: 'presence', name: 'Ada', head: 3 })
    expect(received[0].senderId).toBeTruthy()

    // Ephemeral traffic must not be written to the document.
    expect(handleB.doc().text).toBe('shared doc')
  })

  it('does not leak ephemeral messages to peers outside the room', async () => {
    const token = mintToken({ secret: TEST_SECRET })
    const { repo: repoA } = clients.connect(svc.ws(`/notes?token=${token}`))
    const { repo: repoC } = clients.connect(svc.ws(`/notes?token=${token}`))

    const handleA = repoA.create({ text: 'room one' })
    // C joins a different document and must never see room one's presence.
    const handleC = repoC.create({ text: 'room two' })

    const seen = []
    handleC.on('ephemeral-message', (payload) => seen.push(payload))

    handleA.broadcast({ type: 'presence', name: 'Ada' })
    await settle()

    expect(seen).toHaveLength(0)
  })
})

describe('open server (auth disabled)', () => {
  let svc
  const clients = createClientPool()

  beforeAll(async () => {
    svc = await startService({
      CRDT_APPS: JSON.stringify([{ id: 'dev', requireAuth: false }]),
    })
  })

  afterAll(async () => {
    clients.disconnectAll()
    await svc.stop()
  })

  it('relays without a token when requireAuth is false', async () => {
    const { repo: repoA } = clients.connect(svc.ws('/dev'))
    const { repo: repoB } = clients.connect(svc.ws('/dev'))

    const handleA = repoA.create({ text: 'no auth needed' })
    const handleB = await repoB.find(handleA.url)
    expect(await waitFor(() => handleB.doc()?.text === 'no auth needed')).toBe(true)
  })
})
