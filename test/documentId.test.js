import { describe, it, expect } from 'vitest'
import { toDocumentId, toDocumentIdSet, isLikelyDocumentId } from '../src/documentId.mjs'

describe('toDocumentId', () => {
  it('passes through a bare id', () => {
    expect(toDocumentId('3Ux1s9pQvR7bKcHnT2wYzE')).toBe('3Ux1s9pQvR7bKcHnT2wYzE')
  })

  it('strips the automerge: scheme', () => {
    expect(toDocumentId('automerge:3Ux1s9pQvR7bKcHnT2wYzE')).toBe('3Ux1s9pQvR7bKcHnT2wYzE')
  })

  it('drops any trailing path, query or fragment', () => {
    expect(toDocumentId('automerge:abc123?token=x')).toBe('abc123')
    expect(toDocumentId('automerge:abc123#heads')).toBe('abc123')
    expect(toDocumentId('automerge:abc123/extra')).toBe('abc123')
  })

  it('trims surrounding whitespace', () => {
    expect(toDocumentId('  automerge:abc123  ')).toBe('abc123')
  })

  it('returns null for unusable input', () => {
    for (const bad of [null, undefined, 42, '', '   ', 'automerge:', {}, []]) {
      expect(toDocumentId(bad)).toBeNull()
    }
  })

  it('rejects absurdly long values', () => {
    expect(toDocumentId('a'.repeat(200))).toBeNull()
  })
})

describe('isLikelyDocumentId', () => {
  it('accepts a base58 id of plausible length', () => {
    expect(isLikelyDocumentId('3Ux1s9pQvR7bKcHnT2wYzE')).toBe(true)
  })

  it('rejects values containing ambiguous base58 characters', () => {
    expect(isLikelyDocumentId('0OIl0OIl0OIl0OIl0OIl')).toBe(false)
  })

  it('rejects values that are too short', () => {
    expect(isLikelyDocumentId('abc')).toBe(false)
  })
})

describe('toDocumentIdSet', () => {
  it('normalizes and de-duplicates a mixed array', () => {
    expect(toDocumentIdSet(['automerge:abc123', 'abc123', 'def456'])).toEqual(['abc123', 'def456'])
  })

  it('accepts a comma-separated string', () => {
    expect(toDocumentIdSet('abc123,automerge:def456')).toEqual(['abc123', 'def456'])
  })

  it('drops unusable entries instead of failing', () => {
    expect(toDocumentIdSet(['abc123', null, '', 'automerge:'])).toEqual(['abc123'])
  })

  it('returns an empty array for empty input', () => {
    expect(toDocumentIdSet(null)).toEqual([])
    expect(toDocumentIdSet([])).toEqual([])
  })
})
