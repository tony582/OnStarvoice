import assert from 'node:assert/strict'
import test from 'node:test'

import {
  targetNoteIdFromRecord,
  validatedSavedXhsSourceUrl,
} from './xhs-source-link.ts'

const NOTE_ID = '0123456789abcdef01234567'
const TOKEN = 'test-token-value'

test('accepts a saved explore URL for the exact note with xsec_token', () => {
  const source = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=${encodeURIComponent(TOKEN)}&xsec_source=pc_search`
  assert.equal(validatedSavedXhsSourceUrl(source, NOTE_ID), source)
})

test('accepts an exact note URL reached through an author profile', () => {
  const source = `https://www.xiaohongshu.com/user/profile/author123/${NOTE_ID}?xsec_token=${encodeURIComponent(TOKEN)}&xsec_source=pc_user`
  assert.equal(validatedSavedXhsSourceUrl(source, NOTE_ID), source)
})

test('rejects a saved URL without xsec_token', () => {
  assert.equal(
    validatedSavedXhsSourceUrl(`https://www.xiaohongshu.com/explore/${NOTE_ID}`, NOTE_ID),
    '',
  )
})

test('rejects a saved URL for a different note', () => {
  const source = `https://www.xiaohongshu.com/explore/6a94e7f40000000021033bee?xsec_token=${encodeURIComponent(TOKEN)}`
  assert.equal(validatedSavedXhsSourceUrl(source, NOTE_ID), '')
})

test('rejects lookalike hosts, credentials, and non-standard ports', () => {
  const suffix = `/explore/${NOTE_ID}?xsec_token=${encodeURIComponent(TOKEN)}`
  assert.equal(validatedSavedXhsSourceUrl(`https://xiaohongshu.com.evil.example${suffix}`, NOTE_ID), '')
  assert.equal(validatedSavedXhsSourceUrl(`https://user@www.xiaohongshu.com${suffix}`, NOTE_ID), '')
  assert.equal(validatedSavedXhsSourceUrl(`https://www.xiaohongshu.com:444${suffix}`, NOTE_ID), '')
})

test('uses external_id first and only falls back to a valid canonical identity URL', () => {
  assert.equal(targetNoteIdFromRecord({ external_id: NOTE_ID }), NOTE_ID)
  assert.equal(targetNoteIdFromRecord({
    canonical_url: `https://www.xiaohongshu.com/explore/${NOTE_ID}`,
  }), NOTE_ID)
  assert.equal(targetNoteIdFromRecord({
    canonical_url: `https://xiaohongshu.com.evil.example/explore/${NOTE_ID}`,
  }), '')
})
