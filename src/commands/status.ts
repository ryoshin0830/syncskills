import pc from 'picocolors'
import { gather } from '../engine.js'
import { unmanagedSkills, taggedMcpServers } from '../ccswitch/read.js'
import { buildPlan } from '../core/plan.js'
import { narrowByDirection } from '../engine.js'
import { emitJson, line } from '../output.js'
import { summarize } from '../tui/diff.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'

export async function statusCommand(opts: EngineOptions, io: Io): Promise<number> {
  const { resolutions, unsafeLocalIds } = await gather(opts)
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)

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
