import { describe, it, expect } from 'vitest'
import { renderDiff, summarize } from '../../src/tui/diff.js'
import { buildPlan } from '../../src/core/plan.js'
import { resolveItem } from '../../src/core/resolve.js'
import type { Side } from '../../src/core/types.js'

const S = (h: string): Side => ({ contentHash: h, apps: ['claude'] })

describe('renderDiff', () => {
  it('marks an added line', () => {
    expect(renderDiff('a\n', 'a\nb\n')).toContain('+b')
  })
  it('marks a removed line', () => {
    expect(renderDiff('a\nb\n', 'a\n')).toContain('-b')
  })
  it('returns an empty string for identical input', () => {
    expect(renderDiff('a\n', 'a\n')).toBe('')
  })
  it('does not repeat unchanged lines outside the context window', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n'
    const changed = long.replace('line20', 'CHANGED')
    const out = renderDiff(long, changed, { context: 2 })
    expect(out).not.toContain('line0\n')
    expect(out).toContain('CHANGED')
  })
  it('shows both sides of a replacement', () => {
    const out = renderDiff('x\nold\nz\n', 'x\nnew\nz\n')
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })
})

describe('summarize', () => {
  it('reports one row per non-zero action type', () => {
    const p = buildPlan([
      resolveItem({ kind: 'skill', id: 'a', base: S('A'), local: S('B'), remote: S('A') }),
      resolveItem({ kind: 'skill', id: 'b', base: S('A'), local: S('A'), remote: S('B') }),
    ])
    const rows = summarize(p)
    expect(rows.find((r) => r.label.includes('push'))!.count).toBe(1)
    expect(rows.find((r) => r.label.includes('pull'))!.count).toBe(1)
    expect(rows.every((r) => r.count > 0)).toBe(true)
  })

  it('returns an empty list when everything is in sync', () => {
    expect(summarize(buildPlan([
      resolveItem({ kind: 'skill', id: 'a', base: S('A'), local: S('A'), remote: S('A') }),
    ]))).toEqual([])
  })

  it('counts conflicts', () => {
    const p = buildPlan([
      resolveItem({ kind: 'skill', id: 'c', base: S('A'), local: S('B'), remote: S('C') }),
    ])
    expect(summarize(p).find((r) => r.label.includes('conflict'))!.count).toBe(1)
  })
})
