# Numori CRDT

A multi-tenant [Automerge](https://automerge.org) sync service. One deployment
serves many applications — a notes app, a todo app, anything that wants CRDT
collaboration — with each application isolated from the others.

It runs as its own deployment, so the realtime workload scales independently of
any application's REST API, and adding a second app does not mean running a
second sync server.

---

## Why one service can serve many apps

The Automerge sync protocol is content-agnostic. The server relays opaque change
deltas and stores opaque binary chunks keyed by an unguessable document id; it
never inspects, parses or understands what a document contains. Nothing about
"a note" or "a todo item" appears anywhere in this codebase.

The one thing a sync service genuinely needs to know per application is _who may
enter which room_, and that is expressed generically: capability tokens each app
signs with its own key, plus an optional [authorization webhook](#authorization)
each app can expose for live checks. Your app keeps its schema private; this
service never reads your tables.

### What isolation actually means here

Each app gets:

|                              |                                                               |
| ---------------------------- | ------------------------------------------------------------- |
| its own `Repo`               | document ids cannot collide or leak between apps              |
| its own storage namespace    | every row carries an `app_id`; range queries can't cross apps |
| its own signing key          | a token minted by one app is meaningless to another           |
| its own authorization policy | each app decides who may enter a room                         |

Isolation is structural, not a policy check that a bug could bypass. Two apps
could use the identical document id and still never see each other's data,
because they are different `Repo` instances reading different slices of storage.

---

## Quick start

```bash
npm install
cp .env.example .env      # then set the signing keys

npm run dev:db            # throwaway PostgreSQL on port 5434
npm start
```

Clients connect to `ws://localhost:3030/<appId>?token=<jwt>`.

Health: `GET /healthz` (liveness), `GET /readyz` (readiness, includes a database
round-trip).

```bash
npm test          # 124 tests; the PostgreSQL suites skip if no database
npm run lint
```

---

## Registering apps

Apps are declared as JSON, inline in `CRDT_APPS` or in a file named by
`CRDT_APPS_FILE`:

```jsonc
[
  {
    "id": "notes",
    "secretEnv": "NOTES_JWT_SECRET", // env var holding the HS256 key
    "documentBinding": "open",
    "authz": "webhook",
    "webhookUrl": "https://notes.example.com/api/collab/authorize",
    "webhookSecretEnv": "NOTES_WEBHOOK_SECRET",
  },
  {
    "id": "todo",
    "secretEnv": "TODO_JWT_SECRET",
    "documentBinding": "strict",
  },
]
```

Prefer `secretEnv` over an inline `secret` so the registry itself carries no key
material. Full field reference is in [`.env.example`](.env.example).

Adding an app is a registry entry plus a key. Nothing else changes, and existing
apps are untouched.

### Routing

The first path segment selects the app:

```
wss://crdt.example.com/notes?token=…   → the notes app
wss://crdt.example.com/todo?token=…    → the todo app
```

Clients that cannot control the path may name the app with an `app` query
parameter instead.

A request naming no configured app is refused with `404`, listing the app ids that
are configured. There is no default: silently routing an unrecognised name
somewhere would turn a typo into documents landing in the wrong app's store.

Configuration is validated at startup and a mistake exits with code `78`
(`EX_CONFIG`) and a plain-language message, rather than failing later on the
first connection.

---

## Tokens

Your app mints a short-lived HS256 JWT with its own key. This service only
verifies; it never issues tokens.

```jsonc
{
  "purpose": "collab", // must match the app's tokenPurpose
  "documentId": "3Ux1s9…", // the room being entered
  "documentIds": ["…", "…"], // optional: several rooms (needed for "strict")
  "userId": 42, // carried so revocation can target this account
  "sid": null, // guest session id, when there is no account
  "kind": "user", // "user" | "guest"
  "access": "write",
  "app": "notes", // required only if the app configures an audience
  "exp": 1767225600,
}
```

Sent as `?token=<jwt>` (browsers cannot set headers on a WebSocket) or as
`Authorization: Bearer <jwt>` for server-to-server peers. Either `documentId` or
`automerge:<documentId>` is accepted.

For manual testing:

```bash
node scripts/mint-token.mjs --secret "$NOTES_JWT_SECRET" --doc automerge:3Ux1s9… --user 42
```

### `documentBinding`: which rooms a connection may enter

**`open`** (default) — an authenticated peer may sync any document it can name,
within its own app. Document ids are unguessable 128-bit values revealed only
through a share link, so knowing one is the capability. This matches how share
links already work.

**`strict`** — a connection may only sync the documents its token (or the
authorization webhook) names. Stronger, but the issuing app must list _every_
room the session needs.

That last point is not optional, and it is the reason `open` is the default. An
Automerge client multiplexes all of its documents over a single connection to a
given server: `NetworkSubsystem` keys peers by peer id, and the first adapter to
see a peer id handles every subsequent message to it. A second socket to the same
server is therefore never used for sending. Under `strict`, a token naming one
room will break every other room the client has open.

Use `strict` when your app can enumerate a session's rooms at token-mint time (or
answer with them from the webhook). Use `open` otherwise.

---

## Authorization

A token proves permission was granted _once_. It cannot express what changed
since — a share revoked, a collaborator removed, a link expired. Set
`authz: "webhook"` and this service asks your app instead of assuming:

```http
POST /api/collab/authorize
x-numori-crdt-app: notes
x-numori-crdt-timestamp: 1767225600
x-numori-crdt-signature: sha256=<hmac>

{"appId":"notes","check":"connection","documentId":"3Ux1s9…","userId":42,"kind":"user", …}
```

Answer `200` with:

```jsonc
{
  "allow": true,
  "documentIds": ["…"], // optional: the full set of rooms this session may enter
  "access": "write", // optional override
}
```

Returning `documentIds` is how an app using `strict` binding hands over a
session's complete room list — it knows the membership, the token only carried the
entry point.

### `check: "connection"` vs `check: "room"`

The endpoint answers two different questions, distinguished by the `check` field.

`connection` is a peer establishing a socket, carrying the document its token
names.

`room` is an already-connected peer reaching for a document its grant does not
cover, and it exists to close a real hole. A single socket can name any number of
documents, so a collaborator removed from document A could reconnect with a
still-valid token for document B and then ask for A across that socket — closing
their socket does not prevent it, because the next connection is legitimately
authorized, just not for A. Checking the document, rather than only the
connection, is what stops that.

Decisions are cached per connection per document for `webhookCacheTtlMs`
(default 60s), positive and negative alike. That caching is not an optional
optimization: automerge-repo consults its access gate on **every** sync message,
so uncached checks would mean thousands of requests per editing session. The TTL
bounds only how long a stale grant can linger for a document the peer keeps
syncing — removing access outright is immediate via the
[admin revoke endpoint](#revoking-access), which closes the socket.

Rooms already covered by a grant are never re-checked, so the common case costs
no requests at all.

### Verifying the signature

Verify before trusting the request:

```js
const expected =
  'sha256=' +
  crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${timestampHeader}.${rawBody}`).digest('hex')
```

**Failure policy.** Default is fail **closed**: an endpoint that is unreachable,
slow or returns an unexpected status denies the connection, because an
authorization service that cannot answer must not be read as "yes". `401`/`403`
are treated as authoritative denials regardless. Set `webhookFailOpen: true` to
keep collaborating during an outage, accepting that revocations lag until the
endpoint recovers.

---

## Revoking access

Tokens have a lifetime; access changes should not wait for it. Both mechanisms
close matching sockets immediately with WebSocket code **4001**, and a peer that
reconnects is re-authorized from scratch.

**Admin API** (works wherever your app is hosted):

```bash
curl -X POST https://crdt.example.com/_admin/apps/notes/revoke \
  -H "Authorization: Bearer $CRDT_ADMIN_SECRET" \
  -H 'content-type: application/json' \
  -d '{"documentId":"3Ux1s9…","userId":42}'
```

Omit `userId`/`sid`/`kind` to boot everyone in the room. The endpoint does not
exist unless `CRDT_ADMIN_SECRET` or a per-app `adminSecret` is configured, and it
authenticates before revealing whether an app exists.

Call it from the same code path that changes the share, so the two cannot drift.

---

## Storage

`crdt_chunks` holds every app's documents, namespaced by `app_id`:

```sql
CREATE TABLE crdt_chunks (
  app_id     TEXT   NOT NULL,
  key        TEXT[] NOT NULL,   -- automerge StorageKey, e.g. [docId,'snapshot',hash]
  data       BYTEA,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, key)
);
CREATE INDEX crdt_chunks_app_doc_idx ON crdt_chunks (app_id, (key[1]));
```

Created automatically on first use. Each adapter instance is bound to one app and
every statement filters on it, so `loadRange([])` and `removeRange([])` — which
automerge-repo may call with an empty prefix — are scoped to the calling app
rather than the whole table.

`CRDT_STORAGE=memory` keeps documents only while a peer holds them. Useful for
development; never for production.

Idle documents are flushed and evicted from memory after `CRDT_IDLE_EVICT_MS`
(default 5 minutes), which bounds memory without losing anything: the document
reloads from storage on next access. Eviction is disabled automatically under
memory storage, where dropping the cache would destroy the document.

### Documents are not end-to-end encrypted

The sync service merges changes, which means it reads document contents. Anything
requiring end-to-end encryption cannot be a CRDT document synced through a
server. This is inherent to server-side merging, not a limitation of this
implementation.

### Read-only access is not enforceable

The `access` claim is carried and exposed, but the Automerge sync protocol is
bidirectional — a peer that can sync a document can send changes to it. Treat
`access: "read"` as advisory and enforce read-only sharing by not granting the
room at all (for example by serving a static snapshot instead).

---

## Deployment

```bash
docker compose up -d --build
```

### Coolify

Use [`docker-compose.coolify.yml`](docker-compose.coolify.yml) as the compose file
for a Coolify resource with build pack **Docker Compose**. In that mode the
compose file is the single source of truth — environment variables, volumes and
healthchecks are declared there, not in the UI.

Set `NOTES_JWT_SECRET` (marked required, so Coolify blocks the deploy until it is
filled in) to the same value as the Numori Notes deployment's `JWT_SECRET`.
Everything else has a working default, and Coolify generates the Postgres password
and admin credential itself.

**Routing.** The file lists `SERVICE_FQDN_CRDT_3030`, which asks Coolify to
generate a domain and route it to container port 3030 while serving the public
side on 443. To use your own domain instead, drop that line and enter
`http://crdt.example.com:3030` in the UI — the `:3030` tells Coolify which
container port to forward to and does not appear in the public URL. There is
deliberately no `ports:` mapping, since publishing a host port would bypass the
proxy and TLS.

On startup the service logs the exact URL for each app, e.g.
`app "notes" — clients connect to wss://crdt-abc123.example.com/notes`. Copy that
into the notes deployment as `NUXT_PUBLIC_COLLAB_WS_URL`.

**WebSockets through Traefik.** Traefik proxies upgrades on the same router as
ordinary HTTP, so no extra labels or configuration are required. Realtime traffic
failing on a Traefik-fronted PaaS almost always comes down to one of three things:

| Symptom                          | Cause                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| Connection never arrives         | The domain points at the wrong container port                   |
| `No Available Server`            | The container is unhealthy, so Traefik dropped it from the pool |
| Sockets drop after a few minutes | Something on the path closes idle connections                   |

The third is handled already: the service pings every `CRDT_KEEPALIVE_MS`
(default 5s), well inside Traefik's 180s idle timeout. Lower it if you have a
stricter proxy or CDN in front.

The second is why the healthcheck probes `/healthz` (liveness) rather than
`/readyz`. On a platform that routes on container health, a readiness probe that
fails when the database hiccups would pull the service out of the proxy entirely
and sever every live collaboration — even though each peer holds its own copy of
the document and would otherwise just retry. `/readyz` remains available for
orchestrators that treat readiness separately, such as Kubernetes.

### Behind your own reverse proxy

Forward WebSocket upgrades and preserve the path:

```nginx
location /crdt/ {
    proxy_pass http://crdt:3030/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;   # collaboration sockets are long-lived
}
```

`proxy_read_timeout` matters: the default 60s will drop idle collaboration
sockets. Any `GET` returns `200`, so a health check aimed at the sync path itself
succeeds.

`SIGTERM` triggers a graceful shutdown — stop accepting connections, flush every
document to storage, close sockets with code `1012` so clients retry, then exit.
Bounded by `CRDT_SHUTDOWN_GRACE_MS` (default 10s).

---

## Architecture

```
src/
  index.mjs              CLI entrypoint, signal handling
  service.mjs            assembly: db → storage → auth → tenants → router
  config.mjs             app registry parsing and validation
  router.mjs             one HTTP listener, routes upgrades to apps, health
  tenant.mjs             per-app Repo + WebSocketServer, access gate, eviction
  admin.mjs              authenticated revoke + stats endpoints
  auth/
    index.mjs            connection authentication, room grants
    jwt.mjs              HS256 verification (alg-checked, constant-time)
    webhook.mjs          the per-app authorization callback
  storage/
    postgres.mjs         tenant-scoped Automerge storage adapter
  documentId.mjs         document id normalization
  db.mjs                 shared connection pool
  log.mjs                levelled logger
```

`service.mjs` is separate from `index.mjs` so the whole service can be started
in-process on an ephemeral port by the tests, with no environment mutation.

---

## Security notes

- Authentication is required by default; `requireAuth: false` logs a loud warning
  and should only ever be used on a trusted network.
- Documents are served only on explicit request. The service configures
  automerge-repo with `shareConfig.announce` set to `false` and
  `shareConfig.access` bound to the requesting connection's grants, so it never
  volunteers a document to a peer. **If you modify this, do not reach for the
  `sharePolicy` option**: it sets only `announce` and silently leaves `access` at
  allow-all, and `CollectionSynchronizer` shares a document when
  `announce || (access && hasRequested)` — so a permissive `sharePolicy` makes the
  server push every document in its memory to every connected peer, whatever they
  asked for or hold a capability for. `test/access-control.test.js` guards this.
- Signing keys must be at least 16 characters and are validated at startup.
- The `alg` header is checked against HS256, so an `alg: "none"` token is refused
  rather than trusted.
- Signature comparison is constant-time; admin credentials are compared as
  hashes so the comparison leaks nothing about their length.
- The chunk table name is interpolated into SQL (it cannot be parameterized) and
  is validated as a plain identifier before use. All values are parameterized.
- `npm audit` reports advisories against `uuid` reached through
  `@automerge/automerge-repo`. No fix is published upstream; the affected code
  path is `uuid` v3/v5/v6 with a caller-supplied buffer, which automerge-repo
  does not use.

---

## Licence

AGPL-3.0. See [LICENSE](LICENSE).
