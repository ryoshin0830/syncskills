import { describe, it, expect } from 'vitest'
import { narrowByDirection } from '../src/engine.js'
import { buildPlan } from '../src/core/plan.js'
import { resolveItem } from '../src/core/resolve.js'
import type { App, Side } from '../src/core/types.js'

const S = (h: string): Side => ({ contentHash: h, apps: ['claude'] })

const plan = () => buildPlan([
  resolveItem({ kind: 'skill', id: 'p', base: S('A'), local: S('B'), remote: S('A') }),
  resolveItem({ kind: 'skill', id: 'q', base: S('A'), local: S('A'), remote: S('B') }),
  resolveItem({ kind: 'skill', id: 'dl', base: S('A'), local: S('A'), remote: undefined }),
  resolveItem({ kind: 'skill', id: 'dr', base: S('A'), local: undefined, remote: S('A') }),
])

describe('narrowByDirection', () => {
  it('keeps everything in both mode', () => {
    expect(narrowByDirection(plan(), 'both').actions).toHaveLength(4)
  })

  it('push mode keeps only outbound actions', () => {
    const types = narrowByDirection(plan(), 'push').actions.map((a) => a.type)
    expect(new Set(types)).toEqual(new Set(['push-content', 'delete-remote']))
  })

  it('pull mode keeps only inbound actions', () => {
    const types = narrowByDirection(plan(), 'pull').actions.map((a) => a.type)
    expect(new Set(types)).toEqual(new Set(['pull-content', 'delete-local']))
  })

  it('carries conflicts through in every direction', () => {
    const p = buildPlan([
      resolveItem({ kind: 'skill', id: 'c', base: S('A'), local: S('B'), remote: S('C') }),
    ])
    for (const d of ['both', 'push', 'pull'] as const) {
      expect(narrowByDirection(p, d).conflicts).toHaveLength(1)
    }
  })

  const matrixPlan = (local: App[], remote: App[]) => buildPlan([
    resolveItem({
      kind: 'skill', id: 'm',
      base: { contentHash: 'A', apps: ['claude'] },
      local: { contentHash: 'A', apps: local },
      remote: { contentHash: 'A', apps: remote },
    }),
  ])

  it('sends a locally changed matrix on push but not on pull', () => {
    const p = matrixPlan(['claude', 'codex'], ['claude'])
    expect(narrowByDirection(p, 'both').actions.map((a) => a.type)).toEqual(['set-apps'])
    expect(narrowByDirection(p, 'push').actions.map((a) => a.type)).toEqual(['set-apps'])
    // A pull that published this machine's enablement would not be a pull.
    expect(narrowByDirection(p, 'pull').actions).toHaveLength(0)
  })

  it('takes a remotely changed matrix on pull but not on push', () => {
    const p = matrixPlan(['claude'], ['claude', 'codex'])
    expect(narrowByDirection(p, 'pull').actions.map((a) => a.type)).toEqual(['set-apps'])
    expect(narrowByDirection(p, 'push').actions).toHaveLength(0)
  })

  it('leaves a matrix both sides moved to a bidirectional run', () => {
    // Merging this one applies the other device's change here AND publishes
    // ours — both halves at once, which is what a one-way run declines to do.
    const p = matrixPlan(['claude', 'codex'], ['claude', 'gemini'])
    expect(narrowByDirection(p, 'both').actions.map((a) => a.type)).toEqual(['set-apps'])
    expect(narrowByDirection(p, 'push').actions).toHaveLength(0)
    expect(narrowByDirection(p, 'pull').actions).toHaveLength(0)
  })

  it('does not mutate the plan it was given', () => {
    const p = plan()
    narrowByDirection(p, 'push')
    expect(p.actions).toHaveLength(4)
  })
})
