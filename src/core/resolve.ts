import { APPS } from './types.js'
import type { App, ConflictKind, Decision, ItemKind, Resolution, Side } from './types.js'

/**
 * Resolve the app matrix independently of content, so a machine that enables a
 * skill for Hermes does not fight a machine that edited the skill's text.
 *
 * For each app, whichever side moved away from base wins. When both sides agree
 * the answer is theirs; when both moved in opposite directions the local change
 * wins, because the local machine is the one the user is sitting at.
 */
export function mergeApps(base?: App[], local?: App[], remote?: App[]): App[] {
  const b = new Set(base ?? [])
  const l = new Set(local ?? base ?? [])
  const r = new Set(remote ?? base ?? [])

  const out = new Set<App>()
  for (const app of APPS) {
    const inB = b.has(app)
    const inL = l.has(app)
    const inR = r.has(app)

    if (inL === inR) {
      if (inL) out.add(app)
      continue
    }
    if (inL !== inB) {
      if (inL) out.add(app)
      continue
    }
    if (inR) out.add(app)
  }
  return APPS.filter((a) => out.has(a))
}

/**
 * The decision table. `undefined` means the item is absent on that side.
 *
 * Two properties hold for every possible input, and the exhaustive test in
 * tests/core/resolve.test.ts asserts them directly:
 *   - PUSH is returned only when the remote still equals base, so a push can
 *     never discard a remote change.
 *   - PULL is returned only when the local still equals base, so a pull can
 *     never discard a local change.
 * Everything that would violate either becomes a CONFLICT instead.
 */
function decide(base?: string, local?: string, remote?: string): Decision {
  if (local === remote) return 'IN_SYNC'

  if (local !== undefined && remote !== undefined) {
    if (base === undefined) return 'CONFLICT'
    if (local === base) return 'PULL'
    if (remote === base) return 'PUSH'
    return 'CONFLICT'
  }

  if (local !== undefined) {
    // The remote is absent.
    if (base === undefined) return 'PUSH_NEW'
    return local === base ? 'DELETE_LOCAL' : 'CONFLICT'
  }

  // The local side is absent.
  if (base === undefined) return 'PULL_NEW'
  return remote === base ? 'DELETE_REMOTE' : 'CONFLICT'
}

function conflictKind(base?: Side, local?: Side, remote?: Side): ConflictKind {
  if (local === undefined) return 'local-deleted'
  if (remote === undefined) return 'remote-deleted'
  return base === undefined ? 'both-created' : 'both-edited'
}

export function resolveItem(input: {
  kind: ItemKind
  id: string
  base?: Side
  local?: Side
  remote?: Side
}): Resolution {
  const { kind, id, base, local, remote } = input

  const decision = decide(base?.contentHash, local?.contentHash, remote?.contentHash)
  const appsDecision = decide(
    base && JSON.stringify(base.apps),
    local && JSON.stringify(local.apps),
    remote && JSON.stringify(remote.apps),
  )

  return {
    kind,
    id,
    decision,
    ...(decision === 'CONFLICT' ? { conflictKind: conflictKind(base, local, remote) } : {}),
    appsDecision,
    apps: mergeApps(base?.apps, local?.apps, remote?.apps),
    base,
    local,
    remote,
  }
}

/**
 * Resolve every id present on any side. Results come back sorted by id so that
 * two runs over the same state produce byte-identical output.
 */
export function resolveAll(
  base: Map<string, Side>,
  local: Map<string, Side>,
  remote: Map<string, Side>,
  kind: ItemKind,
): Resolution[] {
  const ids = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort()
  return ids.map((id) =>
    resolveItem({ kind, id, base: base.get(id), local: local.get(id), remote: remote.get(id) }),
  )
}
