import type { ItemKind, Resolution } from './types.js'

export type ActionType =
  | 'push-content' | 'pull-content' | 'delete-remote' | 'delete-local'
  | 'set-apps' | 'merge' | 'noop'

export interface Action {
  type: ActionType
  kind: ItemKind
  id: string
  resolution: Resolution
}

export interface Plan {
  actions: Action[]
  conflicts: Action[]
  /**
   * Items whose content already agrees. They need no action, but the base we
   * have recorded for them may be missing or stale — and a missing base turns a
   * later divergence into a "both created it" conflict instead of a clean
   * three-way merge.
   */
  inSync: Resolution[]
  counts: Record<ActionType, number>
}

/**
 * Pulls run before pushes so that a failed push cannot strand an already
 * decided pull, and deletes on the remote run last so that nothing is removed
 * from the shared store until every local change has been taken.
 */
const ORDER: ActionType[] = [
  'pull-content', 'delete-local', 'set-apps', 'push-content', 'delete-remote', 'merge', 'noop',
]

function typeFor(r: Resolution): ActionType {
  switch (r.decision) {
    case 'PUSH':
    case 'PUSH_NEW':
      return 'push-content'
    case 'PULL':
    case 'PULL_NEW':
      return 'pull-content'
    case 'DELETE_REMOTE':
      return 'delete-remote'
    case 'DELETE_LOCAL':
      return 'delete-local'
    case 'CONFLICT':
      return 'merge'
    case 'IN_SYNC':
      // Content agrees; the app matrix may still differ.
      return r.appsDecision === 'IN_SYNC' ? 'noop' : 'set-apps'
  }
}

export function buildPlan(resolutions: Resolution[]): Plan {
  const counts = Object.fromEntries(ORDER.map((t) => [t, 0])) as Record<ActionType, number>
  const actions: Action[] = []
  const conflicts: Action[] = []
  const inSync: Resolution[] = []

  for (const r of resolutions) {
    const type = typeFor(r)
    counts[type]++
    if (r.decision === 'IN_SYNC' && r.local !== undefined) inSync.push(r)
    if (type === 'noop') continue
    const action: Action = { type, kind: r.kind, id: r.id, resolution: r }
    if (type === 'merge') conflicts.push(action)
    else actions.push(action)
  }

  sortActions(actions)
  conflicts.sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )

  inSync.sort((a, b) =>
    a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  )

  return { actions, conflicts, inSync, counts }
}

/**
 * Put actions in the order they have to run in. Exported because a conflict
 * resolved interactively joins the plan after it was first built, and appending
 * it would silently break the ordering the plan depends on.
 */
export function sortActions(actions: Action[]): Action[] {
  return actions.sort((a, b) => {
    const d = ORDER.indexOf(a.type) - ORDER.indexOf(b.type)
    if (d !== 0) return d
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Settle one conflict by taking a side, in place.
 *
 * Both callers — the interactive interface and a resolver handed to runSync —
 * go through here, so "what choosing a side means" has exactly one definition.
 */
/**
 * Turn a conflict into the ordinary action that carries out the choice.
 *
 * Skills can be merged; an MCP server or a repository cannot be merged line by
 * line, so the only honest offer is "keep mine" or "take theirs". Expressing
 * that as a normal action rather than a second write path is what keeps the
 * base, the manifest and the stored credentials consistent afterwards — every
 * one of those records lives in applyOne() and nowhere else.
 */
export function takeSide(plan: Plan, action: Action, side: 'local' | 'remote'): void {
  plan.actions.push(resolveConflictAs(action, side))
  // The plan was ordered when it was built, and the order is load-bearing.
  sortActions(plan.actions)
}

export function resolveConflictAs(action: Action, side: 'local' | 'remote'): Action {
  const { resolution } = action
  const type: ActionType =
    side === 'local'
      ? resolution.local === undefined ? 'delete-remote' : 'push-content'
      : resolution.remote === undefined ? 'delete-local' : 'pull-content'
  return { ...action, type }
}
