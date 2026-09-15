import { describe, it, expect, beforeEach } from 'vitest'
import { writeFile, chmod, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/util/exec.js'
import { makeDevice, makeBareRemote, type Device } from '../helpers/device.js'
import { emptyBlob } from '../../src/secrets/provider.js'
import type { SecretBlob, SecretProvider } from '../../src/secrets/provider.js'

function recordingProvider(): SecretProvider & { current: () => SecretBlob } {
  let current = emptyBlob()
  return {
    current: () => structuredClone(current),
    async read() { return structuredClone(current) },
    async write(b) { current = structuredClone(b) },
    async check() { return { ok: true, detail: 'in-memory' } },
  }
}

let remote: string
let a: Device

async function raceOnNextPush(device: Device): Promise<void> {
  const hook = join(device.configDir, 'cache', 'repo', '.git', 'hooks', 'pre-push')
  const other = await mkdtemp(join(tmpdir(), 'ss-other-'))
  await run('git', ['clone', remote, other])
  await run('git', ['-C', other, 'config', 'user.email', 'other@example.com'])
  await run('git', ['-C', other, 'config', 'user.name', 'other'])
  await writeFile(join(other, 'from-the-other-device.txt'), 'hello\n')
  await run('git', ['-C', other, 'add', '-A'])
  await run('git', ['-C', other, 'commit', '-m', 'the other device got there first'])
  await writeFile(hook, `#!/bin/sh\ngit -C ${JSON.stringify(other)} push origin HEAD:main\n`)
  await chmod(hook, 0o755)
}

/**
 * A push race is an ordinary event, not a crash — PushRejected says so, and the
 * run is careful to leave the base and the base trees as they were so the next
 * one redoes the work. The credential blob was the one apply-time write with no
 * such compensation: `delete-remote` dropped the entry, the blob was published
 * BEFORE the push, and the push was then rejected. The store still listed the
 * server, every other machine still had it, and the value existed nowhere.
 */
describe('a delete that loses the push race', () => {
  let secrets: ReturnType<typeof recordingProvider>

  beforeEach(async () => {
    remote = await makeBareRemote()
    a = await makeDevice('A', remote)
    secrets = recordingProvider()
    a.addMcpServer('srv', {
      command: 'npx', args: ['-y', 'srv'], env: { API_KEY: 'super-secret-value' },
    }, ['claude'])
    await a.sync({ useSecrets: true, secretProvider: secrets })
    expect(secrets.current().mcp.srv?.env).toEqual({ API_KEY: 'super-secret-value' })
  })

  it('keeps the credential when the store still holds the server', async () => {
    a.deleteMcpRow('srv')
    await raceOnNextPush(a)

    const out = await a.sync({ useSecrets: true, secretProvider: secrets })

    expect(out.pushRejected).toBeTypeOf('string')
    expect(secrets.current().mcp.srv?.env).toEqual({ API_KEY: 'super-secret-value' })
  })

  it('drops it once the deletion actually reaches the store', async () => {
    a.deleteMcpRow('srv')

    const out = await a.sync({ useSecrets: true, secretProvider: secrets })

    expect(out.pushRejected).toBeUndefined()
    expect(await a.readRemoteFile('mcp/srv.json')).toBeNull()
    expect(secrets.current().mcp.srv).toBeUndefined()
  })
})
