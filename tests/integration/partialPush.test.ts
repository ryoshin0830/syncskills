import { describe, it, expect, beforeEach } from 'vitest'
import { makeDevice, makeBareRemote, type Device } from '../helpers/device.js'

/**
 * `applyPlan` continues past a failed action on purpose, and `runSync` publishes
 * the successes — a partial plan is still a consistent one, because every action
 * records its own base and its own manifest entry. `push-content` broke that
 * promise: it copied the new content into the store working copy BEFORE the
 * matrix write that can fail, so a failure committed bytes that no manifest
 * entry described. The other machine then read the manifest, saw its own hash,
 * and reported itself in sync while the newer content sat in the repository
 * unseen.
 */
describe('a push that fails halfway', () => {
  let a: Device
  let b: Device
  const v1 = '---\nname: demo\ndescription: d\n---\nv1\n'
  const v2 = '---\nname: demo\ndescription: d\n---\nv2-from-A\n'

  beforeEach(async () => {
    const remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
    await a.writeSkill('demo', v1, ['claude'])
    await a.sync()
    await b.sync()

    // B widens the matrix; A edits the content. A's matrix write will fail.
    b.setSkillApps('demo', ['claude', 'codex'])
    await b.sync()
    await a.writeSkill('demo', v2)
  })

  it('leaves the store describing what it actually holds', async () => {
    const out = await a.sync({ isCcSwitchRunning: async () => true, ccBin: '/nonexistent/cc' })
    expect(out.result.failed.length).toBe(1)

    // The action failed, so no manifest entry was written for v2. The store
    // must therefore not be holding v2 either.
    expect(await a.readRemoteFile('skills/demo/SKILL.md')).toBe(v1)
  })

  it('does not tell the other machine it is in sync while newer content sits in the store', async () => {
    await a.sync({ isCcSwitchRunning: async () => true, ccBin: '/nonexistent/cc' })
    const out = await b.sync()
    expect(out.plan.actions).toEqual([])
    expect(await b.readSkill('demo')).toBe(v1)
  })

  it('still lands once the matrix write can succeed', async () => {
    await a.sync({ isCcSwitchRunning: async () => true, ccBin: '/nonexistent/cc' })
    await a.sync()
    await b.sync()
    expect(await b.readSkill('demo')).toBe(v2)
  })
})
