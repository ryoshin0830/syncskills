import { describe, it, expect, beforeEach } from 'vitest'
import { makeBareRemote, makeDevice, type Device } from '../helpers/device.js'

/**
 * Regressions for the three faults found by reviewing the built CLI in a
 * container. Each one made sync fail permanently from an ordinary action, so
 * each gets an end-to-end test rather than a unit test of the piece that broke.
 */
describe('a server enabled in no harness at all', () => {
  let remote: string
  let a: Device
  let b: Device

  beforeEach(async () => {
    remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
  })

  it('travels to a device that does not have it, rather than being rejected', async () => {
    a.addMcpServer('gh', { command: 'npx', args: ['gh'] }, [])
    await a.sync()

    const outcome = await b.sync()
    expect(outcome.result.failed).toEqual([])

    const row = b.listMcpRows().find((r) => r.id === 'gh')
    expect(row, 'the server never arrived').toBeDefined()
    expect(row!.apps, 'it arrived enabled somewhere it was disabled').toEqual([])
  })

  it('does not destroy the local copy when the matrix empties', async () => {
    a.addMcpServer('gh', { command: 'npx', args: ['gh'] }, ['claude'])
    await a.sync()
    await b.sync()
    expect(b.listMcpRows().map((r) => r.id)).toEqual(['gh'])

    // Disabling it everywhere is a thing the cc-switch UI can do; because the
    // config moved too, B takes the update through the import path, which
    // deletes the existing row before it rebuilds it.
    a.setMcpConfig('gh', { command: 'npx', args: ['gh', '--v2'] })
    a.setMcpApps('gh', [])
    await a.sync()
    const outcome = await b.sync()

    expect(outcome.result.failed).toEqual([])
    const row = b.listMcpRows().find((r) => r.id === 'gh')
    expect(row, 'the row was deleted and never restored').toBeDefined()
    expect(row!.apps).toEqual([])
    expect(row!.config.args).toEqual(['gh', '--v2'])
  })

  it('carries a skill that is enabled nowhere', async () => {
    await a.writeSkill('quiet', '# quiet\n', [])
    await a.sync()
    const outcome = await b.sync()

    // The content lands before cc-switch is told about it, so the file alone
    // proves nothing — the import has to have succeeded too.
    expect(outcome.result.failed).toEqual([])
    expect(await b.readSkill('quiet')).toBe('# quiet\n')
    expect(b.listSkillRows().map((r) => r.directory)).toContain('quiet')
    expect(b.readSkillApps('quiet')).toEqual([])
  })
})

describe('one failing item does not hold the rest hostage', () => {
  let remote: string
  let a: Device
  let b: Device

  // The secret scanner refuses this skill on every run, for as long as it
  // exists: a permanently failing action, reached by ordinary means. It sorts
  // before the healthy one, which is what used to make it fatal.
  const LEAKY = '# aaa-leaky\n\nexport GITHUB_TOKEN=ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7\n'

  beforeEach(async () => {
    remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
  })

  it('applies the actions ordered after a failure', async () => {
    await a.writeSkill('aaa-leaky', LEAKY, ['claude'])
    await a.writeSkill('zzz-good', '# zzz-good\n', ['claude'])

    const outcome = await a.sync()

    expect(outcome.result.failed.map((f) => f.action.id)).toEqual(['aaa-leaky'])
    expect(outcome.result.failed[0]!.error).toMatch(/credential/)
    expect(
      outcome.result.applied.map((x) => x.id),
      'the healthy skill was skipped because of an unrelated failure',
    ).toContain('zzz-good')
  })

  it('still publishes what landed when something else failed', async () => {
    await a.writeSkill('aaa-leaky', LEAKY, ['claude'])
    await a.writeSkill('zzz-good', '# zzz-good\n', ['claude'])
    await a.sync()

    expect(await a.readRemoteFile('skills/zzz-good/SKILL.md')).toBe('# zzz-good\n')
    // The refused one is still nowhere near the git history.
    expect(await a.readRemoteFile('skills/aaa-leaky/SKILL.md')).toBeNull()
    expect(JSON.stringify(await a.readRemoteFile('manifest.json'))).not.toContain('ghp_')
  })

  it('lets the healthy item reach the other device', async () => {
    await a.writeSkill('aaa-leaky', LEAKY, ['claude'])
    await a.writeSkill('zzz-good', '# zzz-good\n', ['claude'])
    await a.sync()

    await b.sync()
    expect(await b.readSkill('zzz-good')).toBe('# zzz-good\n')
    expect(await b.readSkill('aaa-leaky')).toBeNull()
  })

  it('records the successes, so a later run has nothing left to redo', async () => {
    await a.writeSkill('aaa-leaky', LEAKY, ['claude'])
    await a.writeSkill('zzz-good', '# zzz-good\n', ['claude'])
    await a.sync()

    // The state file is what keeps the next run from re-deciding everything.
    // It used to be written only when nothing at all had failed.
    expect(Object.keys((await a.readState()).items)).toContain('skill:zzz-good')

    const second = await a.sync()
    // The leaky one is still refused every time; nothing else is left over.
    expect(second.result.applied).toEqual([])
    expect(second.result.failed.map((f) => f.action.id)).toEqual(['aaa-leaky'])
  })
})
