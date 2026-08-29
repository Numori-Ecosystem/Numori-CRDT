/**
 * Numori CRDT — document id normalization.
 *
 * Automerge refers to a document either as a bare documentId (a base58-encoded
 * 16-byte identifier, e.g. "3Ux1s9pQvR7bKcHnT2wYzE") or as a URL with the
 * `automerge:` scheme. Tokens, admin calls and storage keys must all agree on
 * one form, so everything entering the service is normalized to the bare id.
 */

/** Base58 (Bitcoin alphabet) — no 0, O, I or l, so ids are unambiguous. */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{16,64}$/

/**
 * Convert an automerge url or bare id to a bare documentId.
 *
 * @param {unknown} value
 * @returns {string|null} normalized id, or null if unusable
 */
export function toDocumentId(value) {
  if (typeof value !== 'string') return null
  let id = value.trim()
  if (!id) return null
  if (id.startsWith('automerge:')) id = id.slice('automerge:'.length)
  // Strip any trailing fragment/query an app may have appended.
  const cut = id.search(/[?#/]/)
  if (cut !== -1) id = id.slice(0, cut)
  if (!id) return null
  if (id.length > 128) return null
  return id
}

/**
 * Whether a normalized id looks like a genuine Automerge document id.
 *
 * Used for defence in depth on untrusted input (admin API, token claims). It is
 * deliberately not applied to ids coming from automerge-repo itself, which is
 * authoritative about its own id format.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLikelyDocumentId(value) {
  const id = toDocumentId(value)
  return id != null && BASE58.test(id)
}

/**
 * Normalize a list of ids (from a `documentIds` claim or an admin payload),
 * dropping anything unusable and de-duplicating.
 *
 * @param {unknown} value array, comma-separated string, or single id
 * @returns {string[]}
 */
export function toDocumentIdSet(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : value == null
        ? []
        : [value]
  const out = new Set()
  for (const entry of raw) {
    const id = toDocumentId(entry)
    if (id) out.add(id)
  }
  return [...out]
}
