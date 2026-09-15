import pc from 'picocolors'
import { runSync } from '../engine.js'
import { EXIT } from '../cli.js'
import { emitJson, line } from '../output.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'

export async function syncCommand(
  opts: EngineOptions, io: Io, commandName: string,
): Promise<number> {
  const outcome = await runSync(opts)
  const { plan, result, unresolved, pushed, secretsRepaired, secretsPending } = outcome

  if (io.json) {
    emitJson(commandName, {
      device: opts.config.device,
      dryRun: opts.dryRun,
      counts: plan.counts,
      applied: result.applied.map((a) => ({ type: a.type, kind: a.kind, id: a.id })),
      pending: result.pending.map((a) => ({ type: a.type, kind: a.kind, id: a.id })),
      failed: result.failed.map((f) => ({ kind: f.action.kind, id: f.action.id, error: f.error })),
      unresolved: unresolved.map((c) => ({
        kind: c.kind, id: c.id, conflictKind: c.resolution.conflictKind ?? null,
      })),
      pushed,
      backupDir: result.backupDir,
      secretsRepaired,
      secretsPending,
    }, io)
  } else {
    if (result.applied.length === 0 && unresolved.length === 0 && result.failed.length === 0
        && secretsRepaired.length === 0 && secretsPending.length === 0) {
      line(pc.green('Everything is in sync.'), io)
    } else {
      for (const a of result.applied) line(`  ${pc.green('✓')} ${a.type.padEnd(16)} ${a.kind}/${a.id}`, io)
      for (const a of result.pending) line(`  ${pc.yellow('!')} ${a.type.padEnd(16)} ${a.kind}/${a.id} — needs you`, io)
      for (const c of unresolved) line(`  ${pc.yellow('⚠')} conflict        ${c.kind}/${c.id}`, io)
      for (const f of result.failed) line(`  ${pc.red('✗')} ${f.action.kind}/${f.action.id}: ${f.error}`, io)
      for (const id of secretsRepaired) line(`  ${pc.green('✓')} credentials      mcp/${id}`, io)
      for (const s of secretsPending) line(`  ${pc.yellow('!')} credentials      mcp/${s.id} — ${s.reason}`, io)
      if (result.backupDir !== null) line(pc.dim(`  backup: ${result.backupDir}`), io)
    }
  }

  if (result.failed.length > 0) return EXIT.ERROR
  if (unresolved.length > 0 || result.pending.length > 0 || secretsPending.length > 0) {
    return EXIT.CONFLICT
  }
  return EXIT.OK
}
