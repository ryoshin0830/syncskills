import pc from 'picocolors'
import { gather, blankCredentials } from '../engine.js'
import { unmanagedSkills, taggedMcpServers } from '../ccswitch/read.js'
import { unsafeManifestIds } from '../store/manifest.js'
import { buildPlan } from '../core/plan.js'
import { narrowByDirection } from '../engine.js'
import { emitJson, line } from '../output.js'
import { summarize } from '../tui/diff.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'

export async function statusCommand(opts: EngineOptions, io: Io): Promise<number> {
  const { resolutions, unsafeLocalIds, staleSecrets, manifest, secretsUnreadable } =
    await gather(opts)
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)

  // status changes nothing, so an unreachable store is reported rather than
  // fatal — but it must be reported, or the MCP rows below are read against a
  // blob that is empty for the wrong reason.
  if (opts.useSecrets && secretsUnreadable !== undefined) {
    // Only a run that touches MCP servers refuses; saying otherwise would send
    // the user looking for a problem that does not block them.
    const blocks = (opts.only ?? ['skill', 'mcp', 'repo']).includes('mcp')
    io.warnings.push(
      `could not read the credential store: ${secretsUnreadable}; ` +
      `MCP credentials could not be checked` +
      (blocks ? ', and a sync will refuse to run until it is reachable' : ''),
    )
  }

  for (const s of staleSecrets) {
    io.warnings.push(
      `mcp/${s.id} is missing ${Object.keys(s.env).sort().join(', ')} on this machine; ` +
      `the next sync restores them from 1Password`,
    )
  }

  // Keys 1Password cannot fill either — with --no-secrets that is every key a
  // pulled server has, and the result is a config that looks fine and fails.
  const restorable = new Set(staleSecrets.map((s) => s.id))
  const blanks = blankCredentials(opts.paths).filter((b) => !restorable.has(b.id))
  for (const b of blanks) {
    io.warnings.push(
      `mcp/${b.id} has no value for ${b.keys.join(', ')} on this machine; ` +
      `the server will start with an empty credential`,
    )
  }

  // Ids the remote advertises that this machine refuses. Saying so is the
  // difference between "not synced" and "silently invisible".
  for (const id of unsafeManifestIds(manifest)) {
    io.warnings.push(`${id} was published by another device but its name is not safe to use as a path here`)
  }

  for (const id of unsafeLocalIds) {
    io.warnings.push(
      `${id} cannot be synced: its name would not be safe to use as a path on ` +
      `another machine. Rename it to sync it.`,
    )
  }

  const tagged = taggedMcpServers(opts.paths)
  if (tagged.length > 0) {
    io.warnings.push(
      `tags on ${tagged.join(', ')} are not synced — cc-switch's import has no field ` +
      `for them, so they stay on the machine that set them`,
    )
  }

  const unmanaged = unmanagedSkills(opts.paths)
  for (const d of unmanaged) {
    io.warnings.push(
      `skills/${d} is not managed by cc-switch and will not sync — ` +
      `adopt it with \`cc-switch skills import-from-apps ${d}\``,
    )
  }

  if (io.json) {
    emitJson('status', {
      device: opts.config.device,
      counts: plan.counts,
      items: resolutions.map((r) => ({
        kind: r.kind, id: r.id, decision: r.decision,
        ...(r.conflictKind === undefined ? {} : { conflictKind: r.conflictKind }),
        apps: r.apps,
        base: r.base?.contentHash ?? null,
        local: r.local?.contentHash ?? null,
        remote: r.remote?.contentHash ?? null,
      })),
      conflicts: plan.conflicts.map((c) => ({ kind: c.kind, id: c.id })),
      unmanagedSkills: unmanaged,
      untransferableTags: tagged,
      unsafeIds: unsafeLocalIds,
      staleSecrets: staleSecrets.map((s) => ({ id: s.id, keys: Object.keys(s.env).sort() })),
      blankCredentials: blanks,
    }, io)
    return 0
  }

  const rows = summarize(plan)
  if (rows.length === 0) {
    line(pc.green('Everything is in sync.'), io)
    for (const w of io.warnings) line(pc.yellow(`  ! ${w}`), io)
    return 0
  }

  line('', io)
  for (const row of rows) line(`  ${String(row.count).padStart(3)}  ${row.label}`, io)
  line('', io)
  for (const a of [...plan.actions, ...plan.conflicts]) {
    const mark = a.type === 'merge' ? pc.yellow('conflict') : pc.dim(a.type)
    line(`  ${mark.padEnd(24)} ${a.kind}/${a.id}`, io)
  }
  for (const w of io.warnings) line(pc.yellow(`  ! ${w}`), io)
  line('', io)
  return 0
}
