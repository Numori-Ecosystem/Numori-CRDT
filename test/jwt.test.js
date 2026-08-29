import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { signJwt, verifyJwt, JwtError } from '../src/auth/jwt.mjs'

const SECRET = 'a-sufficiently-long-secret-value'

describe('verifyJwt', () => {
  it('round-trips a signed payload', () => {
    const token = signJwt({ purpose: 'collab', userId: 7 }, SECRET, { expiresInSeconds: 60 })
    const payload = verifyJwt(token, SECRET)
    expect(payload).toMatchObject({ purpose: 'collab', userId: 7 })
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('rejects a token signed with a different key', () => {
    const token = signJwt({ purpose: 'collab' }, SECRET, { expiresInSeconds: 60 })
    expect(() => verifyJwt(token, 'another-sufficiently-long-secret')).toThrow(
      /Signature verification failed/,
    )
  })

  it('rejects a tampered payload', () => {
    const token = signJwt({ purpose: 'collab', userId: 1 }, SECRET, { expiresInSeconds: 60 })
    const [header, , signature] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ purpose: 'collab', userId: 999 })).toString(
      'base64url',
    )
    expect(() => verifyJwt(`${header}.${forged}.${signature}`, SECRET)).toThrow(
      /Signature verification failed/,
    )
  })

  it('rejects alg:none even when the signature segment is empty', () => {
    // The classic algorithm-confusion attack: claim no algorithm and supply no
    // signature. Must be refused on the header check.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ purpose: 'collab' })).toString('base64url')
    expect(() => verifyJwt(`${header}.${payload}.`, SECRET)).toThrow(/empty segment/)
    expect(() => verifyJwt(`${header}.${payload}.x`, SECRET)).toThrow(/Unsupported alg "none"/)
  })

  it('rejects an unexpected HMAC variant', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ purpose: 'collab' })).toString('base64url')
    const sig = crypto
      .createHmac('sha512', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url')
    expect(() => verifyJwt(`${header}.${payload}.${sig}`, SECRET)).toThrow(/Unsupported alg/)
  })

  it('rejects an expired token', () => {
    const token = signJwt({ purpose: 'collab', exp: Math.floor(Date.now() / 1000) - 3600 }, SECRET)
    expect(() => verifyJwt(token, SECRET)).toThrow(/expired/i)
  })

  it('tolerates small clock skew around expiry', () => {
    const token = signJwt({ purpose: 'collab', exp: Math.floor(Date.now() / 1000) - 5 }, SECRET)
    expect(() => verifyJwt(token, SECRET, { clockSkewSeconds: 60 })).not.toThrow()
    expect(() => verifyJwt(token, SECRET, { clockSkewSeconds: 0 })).toThrow(/expired/i)
  })

  it('rejects a token that is not yet valid', () => {
    const token = signJwt(
      { purpose: 'collab', nbf: Math.floor(Date.now() / 1000) + 3600 },
      SECRET,
      { expiresInSeconds: 7200 },
    )
    expect(() => verifyJwt(token, SECRET)).toThrow(/not yet valid/i)
  })

  it('rejects structurally malformed input', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d']) {
      expect(() => verifyJwt(bad, SECRET)).toThrow(JwtError)
    }
  })

  it('rejects an oversized token before parsing', () => {
    const huge = `${'a'.repeat(9000)}.b.c`
    expect(() => verifyJwt(huge, SECRET)).toThrow(/maximum size/)
  })

  it('refuses to verify without a key', () => {
    const token = signJwt({ purpose: 'collab' }, SECRET, { expiresInSeconds: 60 })
    expect(() => verifyJwt(token, '')).toThrow(/No verification key/)
  })

  it('exposes a machine-readable failure code', () => {
    try {
      verifyJwt('a.b.c', SECRET)
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(JwtError)
      expect(err.code).toBeTruthy()
    }
  })
})
