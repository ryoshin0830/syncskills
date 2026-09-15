import { describe, it, expect, beforeEach } from 'vitest'
import { writeFile, chmod, rm, mkdtemp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/util/exec.js'
import { makeDevice, makeBareRemote } from '../helpers/device.js'
import type { Device } from '../helpers/device.js'

let remote: string
let a: Device
let b: Device

beforeEach(async () => {
  remote = await makeBareRemote()
  a = await makeDevice('A', remote)
  b = await makeDevice('B', remote)
})

/**
 * Make the remote move between this device's fetch and its push — the window a
 * second machine syncing at the same time opens. A pre-push hook lands another
 * commit on the remote just before the transfer, so the race is real and not a
 * matter of timing.
 */
async function raceOnNextPush(device: Device): Promise<string> {
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
  return hook
}

describe('two devices pushing at the same time', () => {
  it('reports the rejection instead of throwing out of the sync', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    await raceOnNextPush(b)
    await b.writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\nG\n')

    const outcome = await b.sync()

    expect(outcome.pushRejected).toBeTypeOf('string')
    expect(outcome.pushRejected).toMatch(/another device/i)
    expect(outcome.pushed).toBe(false)
  })

  it('keeps the local work and records no base, so the next run redoes it', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    const hook = await raceOnNextPush(b)
    await b.writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\nG\n')
    await b.sync()

    // The skill is still here, and no base was recorded for it. Recording one
    // would make the next run read "local matches base, remote has nothing" as
    // a deletion and remove the user's skill.
    expect(await b.readSkill('gamma')).toContain('name: gamma')
    expect((await b.readState()).items['skill:gamma']).toBeUndefined()

    await rm(hook, { force: true })
    const second = await b.sync()
    expect(second.pushRejected).toBeUndefined()
    expect(second.pushed).toBe(true)
    expect(await b.readRemoteFile('skills/gamma/SKILL.md')).toContain('name: gamma')
  })

  it('never leaves a base tree behind that state.json does not describe', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    await raceOnNextPush(b)
    await b.writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\nG\n')
    await b.sync()

    // A base tree with no recorded base would be used as the ancestor of a
    // three-way merge that never actually agreed on it.
    const state = await b.readState()
    const orphan = existsSync(join(b.configDir, 'base', 'skill', 'gamma'))
      && state.items['skill:gamma'] === undefined
    expect(orphan).toBe(false)
  })

  it('still prints a JSON envelope saying it failed', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    await raceOnNextPush(b)
    await b.writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\nG\n')

    const runResult = await b.runSyncCommand({ json: true })
    expect(runResult.envelope).not.toBeNull()
    expect(runResult.envelope!.ok).toBe(false)
    expect(runResult.code).toBe(1)
  })
})
