/**
 * Numori CRDT — configuration and the multi-app (tenant) registry.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A REGISTRY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One deployment of this service can host many unrelated applications — a
 * notes app, a todo app, anything that wants CRDT sync. Each application is a
 * tenant identified by a short slug ("app id") and gets:
 *
 *   • its own Automerge Repo          → document ids never collide or leak
 *   • its own storage namespace       → range queries can't cross apps
 *   • its own token signing key       → a token minted by one app is useless
 *                                       against another
 *   • its own authorization policy    → each app decides who may join a room
 *
 * That isolation is the whole point: adding a second app must never weaken the
 * first. Nothing here is app-specific — no table names, no schemas, no
 * knowledge of what a "note" or a "todo" is.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHERE CONFIG COMES FROM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Apps are declared as JSON, either inline or in a file:
 *
 *   CRDT_APPS='[{"id":"notes","secretEnv":"NOTES_JWT_SECRET"}]'
 *   CRDT_APPS_FILE=/etc/numori/apps.json
 *
 * For a single-app deployment you can skip the registry entirely and use the
 * flat form (CRDT_APP_ID + JWT_SECRET + CRDT_*), which keeps the migration
 * from the old single-tenant collab-server to one env var rename.
 *
 * Secrets should be referenced indirectly with `secretEnv` so the registry
 * itself (which may be baked into an image or a ConfigMap) holds no key
 * material.
 * ═══════════════════════════════════════════════════════════════════════════
 */
import fs from 'node:fs'

/** App ids appear in URL paths and storage keys, so keep them boring. */
const APP_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

/**
 * Path segments the router owns. An app may not claim these, otherwise it would
 * shadow the health or admin endpoints.
 */
export const RESERVED_APP_IDS = new Set([
  '_admin',
  'admin',
  'health',
  'healthz',
  'livez',
  'readyz',
  'metrics',
  'favicon.ico',
  'robots.txt',
])

const VALID_BINDINGS = new Set(['open', 'strict'])
const VALID_AUTHZ = new Set(['none', 'webhook'])
const VALID_STORAGE = new Set(['postgres', 'memory'])

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return fallback
}

function parseCount(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, label } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ConfigError(`${label || 'value'} must be an integer, got ${JSON.stringify(value)}`)
  }
  if (n < min || n > max) {
    throw new ConfigError(`${label || 'value'} must be between ${min} and ${max}, got ${n}`)
  }
  return n
}

/**
 * Resolve a secret from either a literal or an environment variable reference.
 * `secretEnv` is preferred so registries can be stored without key material.
 */
function resolveSecret(spec, env, { secretField, envField, appId }) {
  const literal = spec[secretField]
  const ref = spec[envField]
  if (literal && ref) {
    throw new ConfigError(
      `app "${appId}": set only one of "${secretField}" or "${envField}", not both`,
    )
  }
  if (ref) {
    const value = env[ref]
    if (!value) {
      throw new ConfigError(
        `app "${appId}": ${envField}="${ref}" but environment variable ${ref} is empty or unset`,
      )
    }
    return value
  }
  return literal ? String(literal) : null
}

function readAppsSource(env) {
  const inline = env.CRDT_APPS?.trim()
  const file = env.CRDT_APPS_FILE?.trim()

  if (inline && file) {
    throw new ConfigError('set only one of CRDT_APPS or CRDT_APPS_FILE, not both')
  }

  if (file) {
    let raw
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (err) {
      throw new ConfigError(`CRDT_APPS_FILE "${file}" could not be read: ${err.message}`)
    }
    return { raw, origin: `CRDT_APPS_FILE (${file})` }
  }
  if (inline) return { raw: inline, origin: 'CRDT_APPS' }
  return null
}

function parseAppsJson(raw, origin) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new ConfigError(`${origin} is not valid JSON: ${err.message}`)
  }
  // Accept either an array of app objects or a map of id → app object.
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') {
    return Object.entries(parsed).map(([id, value]) => ({ id, ...(value || {}) }))
  }
  throw new ConfigError(`${origin} must be a JSON array of apps or an object keyed by app id`)
}

/**
 * Build the flat single-app declaration used when no registry is provided.
 * This is the shape a straight port of the old collab-server needs.
 */
function singleAppFromEnv(env) {
  return {
    id: env.CRDT_APP_ID?.trim() || 'default',
    name: env.CRDT_APP_NAME?.trim() || undefined,
    secretEnv: env.CRDT_JWT_SECRET_ENV?.trim() || (env.JWT_SECRET ? 'JWT_SECRET' : undefined),
    requireAuth: env.CRDT_REQUIRE_AUTH,
    documentBinding: env.CRDT_DOCUMENT_BINDING,
    tokenPurpose: env.CRDT_TOKEN_PURPOSE,
    audience: env.CRDT_TOKEN_AUDIENCE,
    authz: env.CRDT_AUTHZ,
    webhookUrl: env.CRDT_WEBHOOK_URL,
    webhookSecretEnv: env.CRDT_WEBHOOK_SECRET_ENV,
    webhookSecret: env.CRDT_WEBHOOK_SECRET,
    webhookTimeoutMs: env.CRDT_WEBHOOK_TIMEOUT_MS,
    webhookFailOpen: env.CRDT_WEBHOOK_FAIL_OPEN,
    revokeChannel: env.CRDT_REVOKE_CHANNEL,
    storage: env.CRDT_APP_STORAGE,
  }
}

/**
 * Normalize and validate one app declaration.
 *
 * @param {object} spec raw declaration
 * @param {object} env process environment (for secretEnv references)
 * @param {object} defaults service-wide defaults
 */
function normalizeApp(spec, env, defaults) {
  if (!spec || typeof spec !== 'object') {
    throw new ConfigError('each app must be a JSON object')
  }

  const id = String(spec.id ?? '').trim()
  if (!id) throw new ConfigError('every app needs an "id"')
  if (!APP_ID_PATTERN.test(id)) {
    throw new ConfigError(
      `app id "${id}" is invalid: use 1-64 chars of a-z, 0-9, "-" or "_", starting with a letter or digit`,
    )
  }
  if (RESERVED_APP_IDS.has(id)) {
    throw new ConfigError(`app id "${id}" is reserved by the service and cannot be used`)
  }

  const requireAuth = parseBool(spec.requireAuth, defaults.requireAuth)

  const jwtSecret = resolveSecret(spec, env, {
    secretField: 'secret',
    envField: 'secretEnv',
    appId: id,
  })

  if (requireAuth && !jwtSecret) {
    throw new ConfigError(
      `app "${id}" requires authentication but has no signing key. ` +
        `Set "secretEnv" (preferred) or "secret", or set requireAuth:false for an open dev server.`,
    )
  }
  if (jwtSecret && jwtSecret.length < 16) {
    throw new ConfigError(
      `app "${id}": signing key is too short (${jwtSecret.length} chars). Use at least 16 characters.`,
    )
  }

  const documentBinding = String(spec.documentBinding ?? defaults.documentBinding).toLowerCase()
  if (!VALID_BINDINGS.has(documentBinding)) {
    throw new ConfigError(
      `app "${id}": documentBinding must be "open" or "strict", got "${documentBinding}"`,
    )
  }

  const authz = String(spec.authz ?? 'none').toLowerCase()
  if (!VALID_AUTHZ.has(authz)) {
    throw new ConfigError(`app "${id}": authz must be "none" or "webhook", got "${authz}"`)
  }

  let webhook = null
  if (authz === 'webhook') {
    const url = String(spec.webhookUrl ?? '').trim()
    if (!url) {
      throw new ConfigError(`app "${id}": authz="webhook" requires "webhookUrl"`)
    }
    let parsedUrl
    try {
      parsedUrl = new URL(url)
    } catch {
      throw new ConfigError(`app "${id}": webhookUrl "${url}" is not a valid URL`)
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new ConfigError(`app "${id}": webhookUrl must be http(s), got "${parsedUrl.protocol}"`)
    }
    const secret = resolveSecret(spec, env, {
      secretField: 'webhookSecret',
      envField: 'webhookSecretEnv',
      appId: id,
    })
    webhook = {
      url: parsedUrl.toString(),
      // Signing is optional but strongly recommended: it lets the app verify
      // the authorization request really came from this service.
      secret: secret || null,
      timeoutMs: parseCount(spec.webhookTimeoutMs, 3000, {
        min: 100,
        max: 30000,
        label: `app "${id}" webhookTimeoutMs`,
      }),
      // Default CLOSED: an authorization service that cannot be reached must
      // not silently grant access. Opt in to fail-open only if availability
      // matters more than the access check for that app.
      failOpen: parseBool(spec.webhookFailOpen, false),
    }
  }

  const storage = String(spec.storage ?? defaults.storage).toLowerCase()
  if (!VALID_STORAGE.has(storage)) {
    throw new ConfigError(`app "${id}": storage must be "postgres" or "memory", got "${storage}"`)
  }

  const revokeChannel = spec.revokeChannel ? String(spec.revokeChannel).trim() : null
  if (revokeChannel && storage !== 'postgres' && !defaults.hasDatabase) {
    throw new ConfigError(
      `app "${id}": revokeChannel needs a database connection; configure DATABASE_URL or POSTGRES_*`,
    )
  }
  if (revokeChannel && !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(revokeChannel)) {
    // The channel name is interpolated into a LISTEN statement, which cannot be
    // parameterized — so it must be a plain identifier.
    throw new ConfigError(
      `app "${id}": revokeChannel "${revokeChannel}" must be a simple identifier (letters, digits, underscore)`,
    )
  }

  const adminSecret = resolveSecret(spec, env, {
    secretField: 'adminSecret',
    envField: 'adminSecretEnv',
    appId: id,
  })

  return Object.freeze({
    id,
    name: spec.name ? String(spec.name) : id,
    requireAuth,
    jwtSecret,
    /** Expected `purpose` claim. Kept configurable for wire-compat with existing issuers. */
    tokenPurpose:
      spec.tokenPurpose === null ? null : String(spec.tokenPurpose ?? defaults.tokenPurpose),
    /**
     * When set, the token must carry a matching `app` (or `aud`) claim. This is
     * belt-and-braces on top of per-app signing keys: even if two apps were
     * mistakenly given the same key, an audience mismatch still rejects.
     */
    audience: spec.audience ? String(spec.audience) : null,
    documentBinding,
    authz,
    webhook,
    storage,
    revokeChannel,
    adminSecret: adminSecret || null,
    idleEvictMs: parseCount(spec.idleEvictMs, defaults.idleEvictMs, {
      min: 0,
      max: 86_400_000,
      label: `app "${id}" idleEvictMs`,
    }),
  })
}

/**
 * Build the Postgres connection settings. Supports a single DATABASE_URL
 * (what most hosting providers hand you) or discrete POSTGRES_* variables
 * (what the Numori compose files use).
 *
 * @returns {object|null} null when no database is configured
 */
export function loadDatabaseConfig(env = process.env) {
  const url = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim()
  const sslMode = (env.PGSSLMODE || env.POSTGRES_SSLMODE || '').trim().toLowerCase()
  // `require` verifies transport encryption but not the certificate chain,
  // which is what managed providers with self-signed internal CAs need.
  const ssl =
    sslMode === 'disable' || sslMode === ''
      ? undefined
      : sslMode === 'no-verify' || sslMode === 'require'
        ? { rejectUnauthorized: false }
        : { rejectUnauthorized: true }

  const max = parseCount(env.CRDT_PG_POOL_MAX, 10, {
    min: 1,
    max: 200,
    label: 'CRDT_PG_POOL_MAX',
  })

  if (url) return { connectionString: url, ssl, max }

  const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB } = env
  if (!POSTGRES_USER || !POSTGRES_HOST || !POSTGRES_DB) return null

  return {
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: parseCount(POSTGRES_PORT, 5432, { min: 1, max: 65535, label: 'POSTGRES_PORT' }),
    database: POSTGRES_DB,
    ssl,
    max,
  }
}

/**
 * Load and validate the full service configuration.
 *
 * Throws ConfigError on any invalid or unsafe combination so that a
 * misconfigured deployment fails at startup rather than at the first
 * connection attempt.
 *
 * @param {object} [env=process.env]
 * @returns {object} frozen configuration object
 */
export function loadConfig(env = process.env) {
  const database = loadDatabaseConfig(env)

  const globalStorage = String(env.CRDT_STORAGE ?? 'memory').toLowerCase()
  if (!VALID_STORAGE.has(globalStorage)) {
    throw new ConfigError(`CRDT_STORAGE must be "postgres" or "memory", got "${globalStorage}"`)
  }

  const defaults = {
    requireAuth: parseBool(env.CRDT_REQUIRE_AUTH, true),
    documentBinding: String(env.CRDT_DOCUMENT_BINDING ?? 'open').toLowerCase(),
    tokenPurpose: env.CRDT_TOKEN_PURPOSE ?? 'collab',
    storage: globalStorage,
    idleEvictMs: parseCount(env.CRDT_IDLE_EVICT_MS, 300_000, {
      min: 0,
      max: 86_400_000,
      label: 'CRDT_IDLE_EVICT_MS',
    }),
    hasDatabase: !!database,
  }

  const source = readAppsSource(env)
  const specs = source ? parseAppsJson(source.raw, source.origin) : [singleAppFromEnv(env)]

  if (specs.length === 0) {
    throw new ConfigError(`${source?.origin ?? 'app registry'} declared no apps`)
  }

  const apps = specs.map((spec) => normalizeApp(spec, env, defaults))

  const seen = new Set()
  for (const app of apps) {
    if (seen.has(app.id)) throw new ConfigError(`duplicate app id "${app.id}"`)
    seen.add(app.id)
  }

  if (apps.some((a) => a.storage === 'postgres') && !database) {
    const names = apps
      .filter((a) => a.storage === 'postgres')
      .map((a) => a.id)
      .join(', ')
    throw new ConfigError(
      `app(s) [${names}] use postgres storage but no database is configured. ` +
        `Set DATABASE_URL or POSTGRES_USER/POSTGRES_HOST/POSTGRES_DB.`,
    )
  }

  // A single-app deployment gets an implicit default so clients can connect to
  // any path (including the legacy "/collab"). With several apps the path must
  // name one, unless an explicit default is chosen.
  const explicitDefault = env.CRDT_DEFAULT_APP?.trim() || null
  if (explicitDefault && !seen.has(explicitDefault)) {
    throw new ConfigError(
      `CRDT_DEFAULT_APP="${explicitDefault}" is not a configured app (have: ${[...seen].join(', ')})`,
    )
  }
  const defaultAppId = explicitDefault || (apps.length === 1 ? apps[0].id : null)

  const adminSecret = env.CRDT_ADMIN_SECRET?.trim() || null
  if (adminSecret && adminSecret.length < 16) {
    throw new ConfigError('CRDT_ADMIN_SECRET must be at least 16 characters')
  }

  return Object.freeze({
    port: parseCount(env.CRDT_PORT, 3030, { min: 0, max: 65535, label: 'CRDT_PORT' }),
    host: env.CRDT_HOST?.trim() || '0.0.0.0',
    logLevel: env.CRDT_LOG_LEVEL?.trim() || 'info',
    storage: globalStorage,
    database,
    /** Table holding Automerge chunks for every app (namespaced by app_id). */
    chunkTable: env.CRDT_CHUNK_TABLE?.trim() || 'crdt_chunks',
    admin: Object.freeze({
      /** The admin API only exists when a secret is configured. */
      enabled: !!adminSecret || apps.some((a) => a.adminSecret),
      secret: adminSecret,
    }),
    apps: Object.freeze(apps),
    defaultAppId,
    /** Max WebSocket message size; guards against a peer exhausting memory. */
    maxPayloadBytes: parseCount(env.CRDT_MAX_PAYLOAD_BYTES, 100 * 1024 * 1024, {
      min: 1024,
      max: 1024 * 1024 * 1024,
      label: 'CRDT_MAX_PAYLOAD_BYTES',
    }),
    shutdownGraceMs: parseCount(env.CRDT_SHUTDOWN_GRACE_MS, 10_000, {
      min: 0,
      max: 120_000,
      label: 'CRDT_SHUTDOWN_GRACE_MS',
    }),
  })
}

/** Human-readable, secret-free summary for startup logs and /healthz. */
export function describeConfig(config) {
  return {
    port: config.port,
    host: config.host,
    storage: config.storage,
    database: config.database ? 'configured' : 'none',
    adminApi: config.admin.enabled ? 'enabled' : 'disabled',
    defaultApp: config.defaultAppId ?? '(none — path must name an app)',
    apps: config.apps.map((a) => ({
      id: a.id,
      requireAuth: a.requireAuth,
      documentBinding: a.documentBinding,
      authz: a.authz,
      storage: a.storage,
      revokeChannel: a.revokeChannel ?? null,
      idleEvictMs: a.idleEvictMs,
    })),
  }
}
