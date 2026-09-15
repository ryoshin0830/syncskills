import { describe, it, expect } from 'vitest'
import { scanForSecrets } from '../../src/secrets/scan.js'

describe('scanForSecrets', () => {
  it('passes a sanitized MCP document', () => {
    expect(scanForSecrets(JSON.stringify({ env: { API_KEY: { secret: true } } }))).toEqual([])
  })

  it('flags an OpenAI-style key', () => {
    expect(scanForSecrets('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789').length).toBeGreaterThan(0)
  })

  it('flags an Anthropic key', () => {
    expect(scanForSecrets('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123').length).toBeGreaterThan(0)
  })

  it('flags a GitHub token', () => {
    expect(scanForSecrets('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB').length).toBeGreaterThan(0)
  })

  it('flags a 1Password service account token', () => {
    expect(scanForSecrets('ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9').length)
      .toBeGreaterThan(0)
  })

  it('flags an AWS access key id', () => {
    expect(scanForSecrets('AKIAIOSFODNN7EXAMPLE').length).toBeGreaterThan(0)
  })

  it('flags a private key block', () => {
    expect(scanForSecrets('-----BEGIN OPENSSH PRIVATE KEY-----').length).toBeGreaterThan(0)
  })

  it('flags a long high-entropy blob assigned to a credential-named field', () => {
    expect(scanForSecrets('"API_KEY": "Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcd"').length)
      .toBeGreaterThan(0)
  })

  it('does not flag ordinary prose', () => {
    expect(scanForSecrets('The quick brown fox jumps over the lazy dog, repeatedly.')).toEqual([])
  })

  it('does not flag one of our own content hashes', () => {
    expect(scanForSecrets(`"contentHash": "sha256:${'a'.repeat(64)}"`)).toEqual([])
  })

  it('does not flag a ${VAR} or $VAR placeholder', () => {
    expect(scanForSecrets('"API_KEY": "${MY_API_KEY_THAT_IS_LONG_ENOUGH}"')).toEqual([])
    expect(scanForSecrets('"API_TOKEN": "$SOME_VERY_LONG_ENVIRONMENT_VAR"')).toEqual([])
  })

  it('does not flag a 1Password reference', () => {
    expect(scanForSecrets('"API_KEY": "op://agent/oneset/notesPlain"')).toEqual([])
  })

  it('reports each distinct pattern once, not once per occurrence', () => {
    const t = 'AKIAIOSFODNN7EXAMPLE and AKIAIOSFODNN7EXAMPLQ'
    expect(scanForSecrets(t)).toHaveLength(1)
  })

  it('scans a realistic sanitized mcp file clean', () => {
    const doc = JSON.stringify({
      type: 'stdio', command: 'oracle-mcp', args: [], env: { API_KEY: { secret: true } },
    }, null, 2)
    expect(scanForSecrets(doc)).toEqual([])
  })
})

describe('diff output never carries a credential (regression)', () => {
  it('stripSecrets is what diff renders, so a real value cannot reach the terminal', async () => {
    const { stripSecrets } = await import('../../src/ccswitch/read.js')
    const raw = { type: 'stdio', command: 'x', env: { API_KEY: 'sk-live-do-not-print' } }
    const rendered = JSON.stringify(stripSecrets(raw).sanitized, null, 2)
    expect(rendered).not.toContain('sk-live-do-not-print')
    expect(rendered).toContain('API_KEY')
    expect(scanForSecrets(rendered)).toEqual([])
  })
})
