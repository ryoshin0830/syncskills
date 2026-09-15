import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeDevice, makeBareRemote } from '../helpers/device.js'
import type { Device } from '../helpers/device.js'

let a: Device
let b: Device

beforeEach(async () => {
  const remote = await makeBareRemote()
  a = await makeDevice('A', remote)
  b = await makeDevice('B', remote)
})

const body = '---\nname: doomed\ndescription: d\n---\nD\n'

describe('a skill deleted on one device', () => {
  beforeEach(async () => {
    await a.writeSkill('doomed', body)
    await a.sync()
    await b.sync()
    expect(b.listSkillRows().map((r) => r.directory)).toContain('doomed')
    await a.deleteSkill('doomed')
    await a.sync()
  })

  it('takes its cc-switch row with it on the other device', async () => {
    await b.sync()

    // Removing only the directory leaves cc-switch listing a skill whose
    // content is gone — and localSkillSides() skips such a row, so nothing
    // would ever mention it again.
    expect(existsSync(join(b.paths.skillsDir, 'doomed'))).toBe(false)
    expect(b.listSkillRows().map((r) => r.directory)).not.toContain('doomed')
  })

  it('leaves both the row and the directory alone when the row cannot be removed', async () => {
    // cc-switch owns the database while it is running; writing underneath it is
    // how the file gets corrupted. Deleting half of the skill would be worse
    // than waiting.
    const outcome = await b.sync({ isCcSwitchRunning: async () => true })

    expect(outcome.result.pending.map((p) => `${p.type} ${p.id}`)).toContain('delete-local doomed')
    expect(existsSync(join(b.paths.skillsDir, 'doomed'))).toBe(true)
    expect(b.listSkillRows().map((r) => r.directory)).toContain('doomed')
  })

  it('finishes the delete on a later run once cc-switch is closed', async () => {
    await b.sync({ isCcSwitchRunning: async () => true })
    await b.sync()

    expect(existsSync(join(b.paths.skillsDir, 'doomed'))).toBe(false)
    expect(b.listSkillRows().map((r) => r.directory)).not.toContain('doomed')
  })
})
