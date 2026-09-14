import { describe, it, expect } from 'vitest'
import { narrowByDirection } from '../src/engine.js'
import { buildPlan } from '../src/core/plan.js'
import { resolveItem } from '../src/core/resolve.js'
import type { Side } from '../src/core/types.js'

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

  it('keeps set-apps in every direction, since the matrix is merged not directional', () => {
    const p = buildPlan([
      resolveItem({
        kind: 'skill', id: 'm',
        base: { contentHash: 'A', apps: ['claude'] },
        local: { contentHash: 'A', apps: ['claude', 'codex'] },
        remote: { contentHash: 'A', apps: ['claude'] },
      }),
    ])
    for (const d of ['both', 'push', 'pull'] as const) {
      expect(narrowByDirection(p, d).actions.map((a) => a.type)).toEqual(['set-apps'])
    }
  })

  it('does not mutate the plan it was given', () => {
    const p = plan()
    narrowByDirection(p, 'push')
    expect(p.actions).toHaveLength(4)
  })
})
