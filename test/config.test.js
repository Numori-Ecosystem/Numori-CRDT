import { describe, it, expect } from 'vitest'
import { loadConfig, loadDatabaseConfig, ConfigError } from '../src/config.mjs'

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

  it('rejects a revocation channel that is not a plain identifier', () => {
    expect(() =>
      loadConfig({
        CRDT_APPS: JSON.stringify([
          { id: 'notes', secret: SECRET, revokeChannel: 'bad; DROP TABLE x' },
        ]),
        DATABASE_URL: 'postgres://user:pw@localhost:5432/db',
      }),
    ).toThrow(/simple identifier/)
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

describe('default app resolution', () => {
  it('makes a lone app the implicit default so legacy paths keep working', () => {
    const config = loadConfig({ CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]) })
    expect(config.defaultAppId).toBe('notes')
  })

  it('has no implicit default once several apps are hosted', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([
        { id: 'notes', secret: SECRET },
        { id: 'todo', secret: SECRET },
      ]),
    })
    expect(config.defaultAppId).toBeNull()
  })

  it('honours an explicit default', () => {
    const config = loadConfig({
      CRDT_APPS: JSON.stringify([
        { id: 'notes', secret: SECRET },
        { id: 'todo', secret: SECRET },
      ]),
      CRDT_DEFAULT_APP: 'todo',
    })
    expect(config.defaultAppId).toBe('todo')
  })

  it('rejects a default naming an app that does not exist', () => {
    expect(() =>
      loadConfig({
        CRDT_APPS: JSON.stringify([{ id: 'notes', secret: SECRET }]),
        CRDT_DEFAULT_APP: 'ghost',
      }),
    ).toThrow(/not a configured app/)
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
