import pc from 'picocolors'
import type { Plan, ActionType } from '../core/plan.js'

const LABELS: Partial<Record<ActionType, string>> = {
  'push-content': 'push to remote',
  'pull-content': 'pull from remote',
  'delete-remote': 'delete on remote',
  'delete-local': 'delete locally',
  'set-apps': 'update app matrix',
  merge: 'conflict — merge required',
}

export function summarize(plan: Plan): { label: string; count: number }[] {
  return (Object.keys(LABELS) as ActionType[])
    .map((t) => ({ label: LABELS[t]!, count: plan.counts[t] ?? 0 }))
    .filter((r) => r.count > 0)
}

/**
 * A minimal LCS diff. Enough to review a change before accepting it, with no
 * dependency — every byte counts when the package is fetched by npx on each run.
 */
export function renderDiff(a: string, b: string, opts: { context?: number } = {}): string {
  const context = opts.context ?? 3
  if (a === b) return ''

  const A = a.split('\n')
  const B = b.split('\n')

  const lcs: number[][] = Array.from({ length: A.length + 1 }, () => new Array<number>(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const rows: { mark: ' ' | '+' | '-'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { rows.push({ mark: ' ', text: A[i]! }); i++; j++ }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { rows.push({ mark: '-', text: A[i]! }); i++ }
    else { rows.push({ mark: '+', text: B[j]! }); j++ }
  }
  while (i < A.length) rows.push({ mark: '-', text: A[i++]! })
  while (j < B.length) rows.push({ mark: '+', text: B[j++]! })

  const keep = new Set<number>()
  rows.forEach((r, idx) => {
    if (r.mark === ' ') return
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) {
      keep.add(k)
    }
  })

  const out: string[] = []
  let lastKept = -1
  for (let idx = 0; idx < rows.length; idx++) {
    if (!keep.has(idx)) continue
    if (lastKept !== -1 && idx > lastKept + 1) out.push(pc.dim('  …'))
    const r = rows[idx]!
    const text = `${r.mark}${r.text}`
    out.push(r.mark === '+' ? pc.green(text) : r.mark === '-' ? pc.red(text) : pc.dim(text))
    lastKept = idx
  }
  return out.join('\n')
}
