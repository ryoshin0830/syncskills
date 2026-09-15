import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeBareRemote, makeDevice, type Device } from '../helpers/device.js'
import { blankCredentials } from '../../src/engine.js'

describe('a dry run changes nothing, including on this machine', () => {
  let a: Device

  beforeEach(async () => {
    a = await makeDevice('a', await makeBareRemote())
  })

  /**
   * `--dry-run` is documented as "change nothing". Taking a backup first copied
   * the cc-switch database — credentials and all — and every skill directory.
   */
  it('does not write a backup', async () => {
    await a.writeSkill('s', '# s\n', ['claude'])
    const outcome = await a.sync({ dryRun: true })

    expect(outcome.result.backupDir).toBeNull()
    const backups = join(a.configDir, 'backups')
    expect(
      existsSync(backups) ? await readdir(backups) : [],
      'a dry run copied the database into a backup',
    ).toEqual([])
  })

  it('still takes a backup on a real run', async () => {
    await a.writeSkill('s', '# s\n', ['claude'])
    const outcome = await a.sync()
    expect(outcome.result.backupDir).not.toBeNull()
    expect(existsSync(join(outcome.result.backupDir!, 'cc-switch.db'))).toBe(true)
  })

  it('pushes nothing', async () => {
    await a.writeSkill('s', '# s\n', ['claude'])
    await a.sync({ dryRun: true })
    expect(await a.readRemoteFile('skills/s/SKILL.md')).toBeNull()
  })
})

describe('a credential with no value is reported, never distributed quietly', () => {
  let remote: string
  let a: Device
  let b: Device

  beforeEach(async () => {
    remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
  })

  it('names the server and the keys that arrived empty', async () => {
    a.addMcpServer('gh', { command: 'npx', env: { GITHUB_TOKEN: 'ghp-real-value' } }, ['claude'])
    await a.sync()

    const outcome = await b.sync()

    // The value never travelled, which is the point of running without 1Password.
    const row = b.listMcpRows().find((r) => r.id === 'gh')!
    expect((row.config.env as Record<string, string>).GITHUB_TOKEN).toBe('')

    // But it is no longer silent.
    expect(outcome.blankCredentials).toEqual([{ id: 'gh', keys: ['GITHUB_TOKEN'] }])
  })

  it('says nothing about a server whose values are all present', async () => {
    a.addMcpServer('plain', { command: 'npx', args: ['x'] }, ['claude'])
    const outcome = await a.sync()
    expect(outcome.blankCredentials).toEqual([])
  })

  it('reads the matrix straight from cc-switch', async () => {
    a.addMcpServer('x', { command: 'c', env: { A: '', B: 'set', C: '' } }, ['claude'])
    expect(blankCredentials(a.paths)).toEqual([{ id: 'x', keys: ['A', 'C'] }])
  })
})

describe('the JSON envelope agrees with the exit code', () => {
  let remote: string
  let a: Device
  let b: Device

  /** Put A and B in conflict over the same skill. */
  async function conflict(): Promise<void> {
    await a.writeSkill('s', '# from A\n', ['claude'])
    await a.sync()
    await b.sync()
    await a.writeSkill('s', '# from A, edited\n')
    await b.writeSkill('s', '# from B, edited\n')
    await a.sync()
  }

  beforeEach(async () => {
    remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
  })

  it('reports a conflict without merging it behind the user’s back', async () => {
    await conflict()
    const outcome = await b.sync()

    expect(outcome.unresolved.map((c) => c.id)).toEqual(['s'])
    // Both sides intact: nothing was rewritten out of the two versions.
    expect(await b.readSkill('s')).toBe('# from B, edited\n')
    expect(await readFile(join(a.paths.skillsDir, 's', 'SKILL.md'), 'utf8'))
      .toBe('# from A, edited\n')
  })

  it('says ok: false and exits 2 for that conflict', async () => {
    await conflict()
    const { code, envelope } = await b.runSyncCommand({ json: true })

    expect(code).toBe(2)
    expect(envelope!.ok, 'the envelope claimed success for a run that exited 2').toBe(false)
    expect((envelope!.data as { unresolved: { id: string }[] }).unresolved.map((u) => u.id))
      .toEqual(['s'])
  })

  it('says ok: true and exits 0 for a clean run', async () => {
    await a.writeSkill('s', '# s\n', ['claude'])
    const { code, envelope } = await a.runSyncCommand({ json: true })
    expect(code).toBe(0)
    expect(envelope!.ok).toBe(true)
  })

  it('points a stuck user at the interactive merge instead of leaving them at exit 2', async () => {
    await conflict()
    const { code, text } = await b.runSyncCommand({ json: false })
    expect(code).toBe(2)
    expect(text).toMatch(/syncskills` with no arguments/)
  })

  it('marks a dry run so it cannot be mistaken for a real one', async () => {
    await a.writeSkill('s', '# s\n', ['claude'])
    const { text } = await a.runSyncCommand({ json: false, dryRun: true })
    expect(text).toMatch(/Dry run/)
    expect(text).toMatch(/would push-content/)
  })
})

/**
 * A `set-apps` action whose matrix already matches the database is a write of
 * the value that is already there. The merged-matrix path skips exactly that,
 * but the action path wrote unconditionally — and for an EMPTY matrix the write
 * goes through the database, which refuses while cc-switch is open. The result
 * was an item that failed on every run, forever, with nothing actually wrong.
 */
describe('an app matrix that is already correct', () => {
  let a: Device
  let b: Device

  beforeEach(async () => {
    const remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
    await a.writeSkill('s', '---\nname: s\ndescription: d\n---\nS\n', ['claude'])
    await a.sync()
    await b.sync()
  })

  it('is not rewritten while cc-switch holds the database', async () => {
    // Disabled everywhere here; the other device still has it on for claude,
    // so the merged matrix is empty and the decision is a push.
    a.setSkillApps('s', [])
    const outcome = await a.sync({ isCcSwitchRunning: async () => true })

    expect(outcome.result.failed.map((f) => f.error)).toEqual([])
    expect(a.readSkillApps('s')).toEqual([])
  })

  it('still publishes the matrix it did not need to write', async () => {
    a.setSkillApps('s', [])
    await a.sync({ isCcSwitchRunning: async () => true })
    await b.sync()

    expect(b.readSkillApps('s')).toEqual([])
  })
})
