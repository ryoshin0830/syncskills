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

  it('never offers a base tree that state.json does not describe', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    await raceOnNextPush(b)
    await b.writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\nG\n')
    await b.sync()

    // A base tree with no recorded base would be used as the ancestor of a
    // three-way merge that never actually agreed on it. The directory may well
    // still be on disk — what matters is that it is not offered.
    const { existingBaseTree } = await import('../../src/basetree.js')
    const state = await b.readState()
    expect(state.items['skill:gamma']).toBeUndefined()
    expect(
      existingBaseTree(b.configDir, 'skill', 'gamma', state.items['skill:gamma']?.contentHash),
    ).toBeUndefined()
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

/**
 * A rejected push used to drop the base TREE of every in-sync item, including
 * ones the run never touched. If such an item later conflicted, nothing would
 * restore its tree — recordAgreedBases only runs for items that are in sync —
 * and the merge ran with no ancestor at all.
 *
 * The tree now carries the hash it was saved for, so a stale one is simply
 * never offered; there is nothing left to drop, and an untouched one survives.
 */
describe('a push race and an unrelated base tree', () => {
  it('leaves an untouched item’s base tree in place', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    const { existingBaseTree } = await import('../../src/basetree.js')
    const hash = async () => (await b.readState()).items['skill:alpha']?.contentHash
    expect(existingBaseTree(b.configDir, 'skill', 'alpha', await hash())).toBeDefined()

    await raceOnNextPush(b)
    await b.writeSkill('gamma', '---\nname: gamma\ndescription: g\n---\nG\n')
    const out = await b.sync()

    expect(out.pushRejected).toBeTypeOf('string')
    expect(
      existingBaseTree(b.configDir, 'skill', 'alpha', await hash()),
      'the race dropped an untouched item’s ancestor',
    ).toBeDefined()
  })

  it('does not offer the base tree of the item whose push was rejected', async () => {
    await a.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA\n')
    await a.sync()
    await b.sync()

    await raceOnNextPush(b)
    await b.writeSkill('alpha', '---\nname: alpha\ndescription: a\n---\nA-edited\n')
    await b.sync()

    const { existingBaseTree } = await import('../../src/basetree.js')
    const recorded = (await b.readState()).items['skill:alpha']?.contentHash
    // state.json still names the version before the edit, so the tree written
    // for the edited one must not be usable as an ancestor.
    expect(existingBaseTree(b.configDir, 'skill', 'alpha', recorded)).toBeUndefined()
  })
})
