import { describe, it, expect } from 'vitest'
import { loadConfig, loadDatabaseConfig, clientUrlFor, ConfigError } from '../src/config.mjs'

const SECRET = 'a-sufficiently-long-secret-value'

describe('app registry parsing', () => {
  it('accepts a JSON array of apps', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([
        { id: 'notes', secret: SECRET },
        { id: 'todo', secret: SECRET },
      ]),
    })
    expect(config.apps.map((a) => a.id)).toEqual(['notes', 'todo'])
  })

  it('accepts an object keyed by app id', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify({ notes: { secret: SECRET }, todo: { secret: SECRET } }),
    })
    expect(config.apps.map((a) => a.id)).toEqual(['notes', 'todo'])
  })

  it('resolves secrets indirectly through secretEnv', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secretEnv: 'NOTES_KEY' }]),
      NOTES_KEY: SECRET,
    })
    expect(config.apps[0].jwtSecret).toBe(SECRET)
  })

  it('rejects a secretEnv pointing at an unset variable', () => {
    expect(() =>
      loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes', secretEnv: 'MISSING_KEY' }]) }),
    ).toThrow(/MISSING_KEY is empty or unset/)
  })

  it('falls back to a single app built from flat env vars', () => {
    const config = loadConfig({ CRDT_APP_ID: 'notes', JWT_SECRET: SECRET })
    expect(config.apps).toHaveLength(1)
    expect(config.apps[0].id).toBe('notes')
    expect(config.apps[0].jwtSecret).toBe(SECRET)
  })
})

describe('app registry validation', () => {
  it('requires a signing key when auth is required', () => {
    expect(() => loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes' }]) })).toThrow(ConfigError)
  })

  it('allows a keyless app only when auth is explicitly disabled', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([{ id: 'dev', requireAuth: false }]),
    })
    expect(config.apps[0].requireAuth).toBe(false)
  })

  it('rejects a short signing key', () => {
    expect(() =>
      loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes', secret: 'tooshort' }]) }),
    ).toThrow(/too short/)
  })

  it('rejects app ids that would shadow service routes', () => {
    // These are valid slugs, so only the reserved-name check can stop them.
    for (const id of ['admin', 'health', 'healthz', 'livez', 'readyz', 'metrics']) {
      expect(() => loadConfig({ CRDT_APPS: JSON.stringify([{ id, secret: SECRET }]) })).toThrow(
        /reserved/,
      )
    }
    // "_admin" is additionally not a legal slug; either rejection is fine.
    expect(() =>
      loadConfig({ CRDT_APPS: JSON.stringify([{ id: '_admin', secret: SECRET }]) }),
    ).toThrow(ConfigError)
  })

  it('rejects app ids that are not URL-safe slugs', () => {
    for (const id of ['Notes', 'my app', 'app/one', 'app.one', '-lead']) {
      expect(() => loadConfig({ CRDT_APPS: JSON.stringify([{ id, secret: SECRET }]) })).toThrow(
        /is invalid/,
      )
    }
  })

  it('rejects duplicate app ids', () => {
    expect(() =>
      loadConfig({
        CRDT_APPS: JSON.stringify([
          { id: 'notes', secret: SECRET },
          { id: 'notes', secret: SECRET },
        ]),
      }),
    ).toThrow(/duplicate app id/)
  })

  it('rejects an unknown documentBinding or authz value', () => {
    expect(() =>
      loadConfig({
        CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET, documentBinding: 'loose' }]),
      }),
    ).toThrow(/documentBinding/)
    expect(() =>
      loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET, authz: 'ldap' }]) }),
    ).toThrow(/authz/)
  })

  it('requires a webhookUrl when authz is webhook', () => {
    expect(() =>
      loadConfig({
        CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET, authz: 'webhook' }]),
      }),
    ).toThrow(/requires "webhookUrl"/)
  })

  it('defaults the webhook to fail closed', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([
        {
          id: 'notes',
          secret: SECRET,
          authz: 'webhook',
          webhookUrl: 'https://notes.example/authorize',
        },
      ]),
    })
    expect(config.apps[0].webhook.failOpen).toBe(false)
  })

  it('rejects postgres storage without a database', () => {
    expect(() =>
      loadConfig({
        CRDT_STORAGE: 'postgres',
        CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]),
      }),
    ).toThrow(/no database is configured/)
  })
})

describe('database configuration', () => {
  it('prefers DATABASE_URL', () => {
    const db = loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@h:5432/d' })
    expect(db.connectionString).toBe('postgres://u:p@h:5432/d')
  })

  it('falls back to discrete POSTGRES_* variables', () => {
    const db = loadDatabaseConfig({
      POSTGRES_USER: 'u',
      POSTGRES_HOST: 'h',
      POSTGRES_DB: 'd',
      POSTGRES_PORT: '5433',
    })
    expect(db).toMatchObject({ user: 'u', host: 'h', database: 'd', port: 5433 })
  })

  it('returns null when nothing is configured', () => {
    expect(loadDatabaseConfig({})).toBeNull()
  })

  it('relaxes certificate verification for sslmode=require', () => {
    const db = loadDatabaseConfig({ DATABASE_URL: 'postgres://u:p@h/d', PGSSLMODE: 'require' })
    expect(db.ssl).toEqual({ rejectUnauthorized: false })
  })
})

describe('clientUrlFor', () => {
  it('builds a wss url from a bare hostname', () => {
    // Hosting platforms typically inject a bare FQDN, not an origin.
    expect(clientUrlFor('crdt.example.com', 'notes')).toBe('wss://crdt.example.com/notes')
  })

  it('keeps an explicit https origin as wss', () => {
    expect(clientUrlFor('https://crdt.example.com', 'notes')).toBe('wss://crdt.example.com/notes')
  })

  it('maps a plain http origin to ws', () => {
    expect(clientUrlFor('http://localhost:3030', 'notes')).toBe('ws://localhost:3030/notes')
  })

  it('tolerates a trailing slash', () => {
    expect(clientUrlFor('https://crdt.example.com/', 'todo')).toBe('wss://crdt.example.com/todo')
  })

  it('returns null when no public url is configured', () => {
    expect(clientUrlFor(null, 'notes')).toBeNull()
    expect(clientUrlFor('', 'notes')).toBeNull()
  })
})

describe('proxy-related limits', () => {
  it('defaults the keepalive well inside a typical proxy idle timeout', () => {
    const config = loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]) })
    // Traefik and most CDNs close idle connections at 60-180s.
    expect(config.keepAliveMs).toBe(5000)
    expect(config.keepAliveMs).toBeLessThan(60_000)
  })

  it('allows tuning the keepalive for stricter proxies', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]),
      CRDT_KEEPALIVE_MS: '2000',
    })
    expect(config.keepAliveMs).toBe(2000)
  })

  it('rejects a keepalive outside the sane range', () => {
    for (const value of ['0', '500', '999999']) {
      expect(() =>
        loadConfig({
          CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]),
          CRDT_KEEPALIVE_MS: value,
        }),
      ).toThrow(/CRDT_KEEPALIVE_MS/)
    }
  })
})

describe('admin API gating', () => {
  it('stays disabled without a secret', () => {
    const config = loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]) })
    expect(config.admin.enabled).toBe(false)
  })

  it('enables when a service-wide secret is set', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]),
      CRDT_ADMIN_SECRET: 'admin-secret-value-abcdefghij',
    })
    expect(config.admin.enabled).toBe(true)
  })

  it('enables when only a per-app secret is set', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([
        { id: 'notes', secret: SECRET, adminSecret: 'per-app-admin-secret-value' },
      ]),
    })
    expect(config.admin.enabled).toBe(true)
  })
})
