/**
 * Numori CRDT — minimal, dependency-free HS256 JWT verification.
 *
 * Wire-compatible with tokens minted by a Nitro/Node API that signs
 * `base64url(header).base64url(payload)` with HMAC-SHA256, which is what the
 * Numori apps do. Keeping this dependency-free avoids pulling a JWT library
 * (and its transitive tree) into a service whose only crypto need is one HMAC.
 *
 * Hardening over a naive implementation:
 *
 *   • The `alg` header is checked against HS256. Without this a token could
 *     claim `alg: "none"` and, in implementations that honour the header, skip
 *     verification entirely. We never read the header to choose an algorithm,
 *     but rejecting unexpected values keeps the contract explicit.
 *   • Signature comparison is constant-time and length-checked.
 *   • `exp` and `nbf` are enforced with a small clock-skew allowance.
 *   • Payload size is bounded before parsing.
 */
import crypto from 'node:crypto'

/** Tokens larger than this are rejected before any work is done. */
const MAX_TOKEN_BYTES = 8192

/** Tolerance for clock drift between the issuing app and this service. */
const DEFAULT_CLOCK_SKEW_SECONDS = 30

export class JwtError extends Error {
  constructor(message, code = 'invalid_token') {
    super(message)
    this.name = 'JwtError'
    this.code = code
  }
}

function decodeSegment(segment, label) {
  let json
  try {
    json = Buffer.from(segment, 'base64url').toString('utf8')
  } catch {
    throw new JwtError(`${label} is not valid base64url`, 'malformed')
  }
  try {
    return JSON.parse(json)
  } catch {
    throw new JwtError(`${label} is not valid JSON`, 'malformed')
  }
}

/**
 * Verify an HS256 JWT and return its payload.
 *
 * @param {string} token
 * @param {string} secret
 * @param {object} [options]
 * @param {number} [options.clockSkewSeconds]
 * @returns {object} the decoded payload
 * @throws {JwtError}
 */
export function verifyJwt(token, secret, options = {}) {
  if (!secret) throw new JwtError('No verification key configured', 'no_key')
  if (typeof token !== 'string' || token.length === 0) {
    throw new JwtError('Missing token', 'missing')
  }
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) {
    throw new JwtError('Token exceeds maximum size', 'too_large')
  }

  const parts = token.split('.')
  if (parts.length !== 3) throw new JwtError('Token must have three segments', 'malformed')
  const [headerB64, payloadB64, signatureB64] = parts
  if (!headerB64 || !payloadB64 || !signatureB64) {
    throw new JwtError('Token has an empty segment', 'malformed')
  }

  const header = decodeSegment(headerB64, 'Header')
  if (header.alg !== 'HS256') {
    throw new JwtError(`Unsupported alg "${header.alg}" (expected HS256)`, 'bad_alg')
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')

  const given = Buffer.from(signatureB64, 'utf8')
  const want = Buffer.from(expected, 'utf8')
  // timingSafeEqual throws on length mismatch, so compare lengths first — but
  // still run the comparison on equal-length buffers to keep timing flat.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    throw new JwtError('Signature verification failed', 'bad_signature')
  }

  const payload = decodeSegment(payloadB64, 'Payload')
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new JwtError('Payload must be a JSON object', 'malformed')
  }

  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS
  const now = Math.floor(Date.now() / 1000)

  if (payload.exp != null) {
    if (typeof payload.exp !== 'number') throw new JwtError('exp must be a number', 'malformed')
    if (payload.exp + skew < now) throw new JwtError('Token expired', 'expired')
  }
  if (payload.nbf != null) {
    if (typeof payload.nbf !== 'number') throw new JwtError('nbf must be a number', 'malformed')
    if (payload.nbf - skew > now) throw new JwtError('Token not yet valid', 'not_yet_valid')
  }

  return payload
}

/**
 * Sign an HS256 JWT. Not used by the service at runtime (it only verifies), but
 * needed by the test suite and handy for `scripts/mint-token.mjs`, so it lives
 * alongside the verifier to guarantee the two stay in step.
 *
 * @param {object} payload
 * @param {string} secret
 * @param {object} [options]
 * @param {number} [options.expiresInSeconds]
 * @returns {string}
 */
export function signJwt(payload, secret, options = {}) {
  if (!secret) throw new JwtError('No signing key provided', 'no_key')
  const header = { alg: 'HS256', typ: 'JWT' }
  const body = { ...payload }
  if (options.expiresInSeconds != null && body.exp == null) {
    body.exp = Math.floor(Date.now() / 1000) + options.expiresInSeconds
  }
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url')
  const payloadB64 = Buffer.from(JSON.stringify(body)).toString('base64url')
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')
  return `${headerB64}.${payloadB64}.${signature}`
}
