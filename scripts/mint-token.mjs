#!/usr/bin/env node
/**
 * Mint a capability token for manual testing of a deployment.
 *
 * This is a development convenience only. In production your application mints
 * its own tokens with its own signing key; this service never issues them.
 *
 * Usage:
 *   node scripts/mint-token.mjs --secret <key> [options]
 *
 * Options:
 *   --secret <key>     signing key (or set CRDT_MINT_SECRET / JWT_SECRET)
 *   --doc <id>         document id (or automerge: url) the token grants
 *   --docs <a,b,c>     several document ids, for documentBinding: strict
 *   --app <id>         audience claim, when the app configures one
 *   --user <id>        user id carried for revocation targeting
 *   --sid <id>         guest session id instead of a user id
 *   --kind <kind>      "user" (default) or "guest"
 *   --purpose <p>      purpose claim (default: collab)
 *   --ttl <seconds>    lifetime (default: 3600)
 *
 * Prints the token on stdout so it can be piped:
 *   TOKEN=$(node scripts/mint-token.mjs --secret … --doc …)
 */
import { signJwt } from '../src/auth/jwt.mjs'
import { toDocumentId, toDocumentIdSet } from '../src/documentId.mjs'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => argv[++i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--secret') args.secret = take()
    else if (arg === '--doc') args.doc = take()
    else if (arg === '--docs') args.docs = take()
    else if (arg === '--app') args.app = take()
    else if (arg === '--user') args.user = take()
    else if (arg === '--sid') args.sid = take()
    else if (arg === '--kind') args.kind = take()
    else if (arg === '--purpose') args.purpose = take()
    else if (arg === '--ttl') args.ttl = take()
    else if (arg.includes('=')) {
      const [key, value] = [arg.slice(2, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      args[key === 'secret' ? 'secret' : key] = value
    } else throw new Error(`Unknown argument "${arg}" (try --help)`)
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  process.stderr.write(
    [
      'Mint a development capability token.',
      '',
      'Usage: node scripts/mint-token.mjs --secret <key> [--doc <id>] [--user <id>]',
      '       [--docs a,b] [--app <id>] [--sid <id>] [--kind user|guest]',
      '       [--purpose collab] [--ttl 3600]',
      '',
    ].join('\n'),
  )
  process.exit(0)
}

const secret = args.secret || process.env.CRDT_MINT_SECRET || process.env.JWT_SECRET
if (!secret) {
  process.stderr.write('A signing key is required: --secret <key> or CRDT_MINT_SECRET.\n')
  process.exit(1)
}

const payload = {
  purpose: args.purpose || 'collab',
  kind: args.kind || (args.sid ? 'guest' : 'user'),
  access: 'write',
}
if (args.doc) {
  const id = toDocumentId(args.doc)
  if (!id) {
    process.stderr.write(`--doc "${args.doc}" is not a usable document id.\n`)
    process.exit(1)
  }
  payload.documentId = id
}
if (args.docs) payload.documentIds = toDocumentIdSet(args.docs)
if (args.app) payload.app = args.app
if (args.user) payload.userId = Number.isNaN(Number(args.user)) ? args.user : Number(args.user)
if (args.sid) payload.sid = args.sid

const ttl = Number(args.ttl || 3600)
if (!Number.isFinite(ttl) || ttl <= 0) {
  process.stderr.write('--ttl must be a positive number of seconds.\n')
  process.exit(1)
}

process.stdout.write(`${signJwt(payload, secret, { expiresInSeconds: ttl })}\n`)
