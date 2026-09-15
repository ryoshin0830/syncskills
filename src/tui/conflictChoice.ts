import type { Action } from '../core/plan.js'

export type ChoiceSide = 'local' | 'remote'

export interface ConflictChoice {
  message: string
  options: { value: ChoiceSide | 'skip'; label: string }[]
  /** Sides whose choice removes the item everywhere rather than replacing it. */
  destructive: Record<ChoiceSide, boolean>
  /** The label offered for one side, for asserting on and for a confirmation. */
  optionFor(side: ChoiceSide): string
}

/**
 * Say what choosing each side will actually do.
 *
 * A conflict is not always two edits. `resolve.ts` distinguishes four shapes,
 * and in two of them one of the choices is a DELETION that travels to every
 * other machine — taking an MCP server's stored credentials with it, which
 * cannot be recovered. Describing all four as "changed on both machines …
 * which side wins?" makes the destructive option look like the conservative
 * one, so each shape gets its own wording here.
 *
 * Deciding later is listed first everywhere, so that an accidental Enter never
 * lands on a choice the user has not read.
 */
export function describeConflict(action: Action): ConflictChoice {
  const { kind, id, resolution } = action
  const what = `${kind}/${id}`
  // Only an MCP server owns a credential; saying so for a skill would be noise
  // that teaches the user to skip the warning.
  const andSecrets = kind === 'mcp' ? ', and the credentials stored for it' : ''

  const deleteEverywhere = `Delete it everywhere — removes it from the other machines${andSecrets}`
  const deleteHere = 'Delete it here too'
  const keepLocal = 'Keep this device’s version (replaces the other machine’s)'
  const takeRemote = 'Take the other device’s version (replaces this machine’s)'
  const later = 'Decide later (leave both sides as they are)'

  let message: string
  let localLabel: string
  let remoteLabel: string
  let destructive: Record<ChoiceSide, boolean> = { local: false, remote: false }

  switch (resolution.conflictKind) {
    case 'local-deleted':
      message =
        `${what}: you deleted it here, and the other machine changed it. ` +
        `There is nothing to merge — what should happen?`
      localLabel = deleteEverywhere
      remoteLabel = 'Take the other device’s version (restores it here)'
      destructive = { local: true, remote: false }
      break

    case 'remote-deleted':
      message =
        `${what}: the other machine deleted it, and you changed it here. ` +
        `There is nothing to merge — what should happen?`
      localLabel = 'Keep it and restore it on the other machines'
      remoteLabel = deleteHere
      destructive = { local: false, remote: true }
      break

    case 'both-created':
      message =
        `${what} was created independently on both machines. ` +
        `It cannot be merged line by line — which side wins?`
      localLabel = keepLocal
      remoteLabel = takeRemote
      break

    default:
      message =
        `${what} changed on both machines. ` +
        `It cannot be merged line by line — which side wins?`
      localLabel = keepLocal
      remoteLabel = takeRemote
  }

  const options: ConflictChoice['options'] = [
    { value: 'skip', label: later },
    { value: 'local', label: localLabel },
    { value: 'remote', label: remoteLabel },
  ]

  return {
    message,
    options,
    destructive,
    optionFor: (side) => options.find((o) => o.value === side)!.label,
  }
}
