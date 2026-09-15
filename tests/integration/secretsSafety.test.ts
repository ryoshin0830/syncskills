import { describe, it, expect, beforeAll } from 'vitest'
import { makeDevice, makeBareRemote, type Device } from '../helpers/device.js'
import { assertSecretsReadable } from '../../src/engine.js'
import { emptyBlob } from '../../src/secrets/provider.js'
import type { SecretBlob, SecretProvider } from '../../src/secrets/provider.js'

/**
 * A blob that could not be read must never be written back.
 *
 * `op read` failing for a moment — a network blip, an expired token, an item
 * someone edited by hand — used to be swallowed into an empty blob, which the
 * same run then wrote over the real one. Env values are excluded from the
 * content hash, so nothing afterwards would notice or retry: every credential
 * on every machine was gone, reported as "Everything is in sync."
 */
function unreadableProvider(): SecretProvider & { writes: SecretBlob[] } {
  const writes: SecretBlob[] = []
  return {
    writes,
    async read(): Promise<SecretBlob> {
      throw new Error('op read failed: network is unreachable')
    },
    async write(b) { writes.push(structuredClone(b)) },
    async check() { return { ok: false, detail: 'unreachable' } },
  }
}

function workingProvider(initial: SecretBlob = emptyBlob()):
  SecretProvider & { writes: SecretBlob[] } {
  let current = structuredClone(initial)
  const writes: SecretBlob[] = []
  return {
    writes,
    async read() { return structuredClone(current) },
    async write(b) { current = structuredClone(b); writes.push(structuredClone(b)) },
    async check() { return { ok: true, detail: 'in-memory' } },
  }
}

describe('a credential store that cannot be read', () => {
  let a: Device

  beforeAll(async () => {
    const remote = await makeBareRemote()
    a = await makeDevice('A', remote)
    a.addMcpServer('has-secrets', {
      command: 'npx', args: ['-y', 'demo'], env: { TOKEN: 'real-value' },
    }, ['claude'])
    // Get the machine and the store into agreement first, with a store that works.
    await a.sync({ useSecrets: true, secretProvider: workingProvider() })
  })

  it('is never overwritten with an empty blob', async () => {
    const p = unreadableProvider()
    await a.sync({ useSecrets: true, secretProvider: p }).catch(() => undefined)
    expect(p.writes).toEqual([])
  })

  it('stops the run instead of reporting success', async () => {
    const p = unreadableProvider()
    await expect(a.sync({ useSecrets: true, secretProvider: p }))
      .rejects.toThrow(/could not read the credential store/i)
  })

  it('names the underlying failure, so the user can act on it', async () => {
    const p = unreadableProvider()
    await expect(a.sync({ useSecrets: true, secretProvider: p }))
      .rejects.toThrow(/network is unreachable/)
  })

  it('still writes the blob when the store is readable', async () => {
    const p = workingProvider()
    await a.sync({ useSecrets: true, secretProvider: p })
    expect(p.writes.length).toBeGreaterThan(0)
  })
})

/**
 * The refusal names `--only skills,repo` as the way to keep working while the
 * credential store is down, so that has to be true: nothing in a skills-only or
 * repo-only run touches a credential, and the blob it never read must not be
 * written back either.
 */
describe('the way out the refusal offers', () => {
  let a: Device

  beforeAll(async () => {
    a = await makeDevice('C', await makeBareRemote())
    await a.writeSkill('s', '---\nname: s\ndescription: d\n---\nS\n', ['claude'])
  })

  it('syncs skills even though the credential store is unreachable', async () => {
    const p = unreadableProvider()
    const out = await a.sync({ useSecrets: true, secretProvider: p, only: ['skill'] })
    expect(out.result.failed).toEqual([])
    expect(await a.readRemoteFile('skills/s/SKILL.md')).toContain('name: s')
  })

  it('still writes nothing to the credential store it could not read', async () => {
    const p = unreadableProvider()
    await a.sync({ useSecrets: true, secretProvider: p, only: ['skill'] })
    expect(p.writes).toEqual([])
  })

  it('refuses again as soon as MCP servers are back in scope', async () => {
    const p = unreadableProvider()
    await expect(a.sync({ useSecrets: true, secretProvider: p, only: ['skill', 'mcp'] }))
      .rejects.toThrow(/could not read the credential store/)
  })
})

describe('the guard itself', () => {
  const gathered = (secretsUnreadable?: string) => ({
    secretsUnreadable, resolutions: [], unsafeLocalIds: [], staleSecrets: [],
  } as unknown as Parameters<typeof assertSecretsReadable>[1])

  const opts = (useSecrets: boolean) =>
    ({ useSecrets }) as unknown as Parameters<typeof assertSecretsReadable>[0]

  it('throws when secrets are in use and the store could not be read', () => {
    expect(() => assertSecretsReadable(opts(true), gathered('op read failed')))
      .toThrow(/could not read the credential store/)
  })

  it('says nothing when the store was read', () => {
    expect(() => assertSecretsReadable(opts(true), gathered(undefined))).not.toThrow()
  })

  it('says nothing under --no-secrets, where no blob is ever written', () => {
    expect(() => assertSecretsReadable(opts(false), gathered('op read failed'))).not.toThrow()
  })
})
