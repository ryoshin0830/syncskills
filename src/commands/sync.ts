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
  const {
    plan, result, unresolved, pushed, secretsRepaired, secretsPending, blankCredentials,
  } = outcome

  for (const b of blankCredentials) {
    io.warnings.push(
      `mcp/${b.id} has no value for ${b.keys.join(', ')} on this machine; ` +
      `the server will start with an empty credential`,
    )
  }

  // Worked out before anything is printed, so the JSON envelope's `ok` can say
  // the same thing as the exit code.
  const code =
    result.failed.length > 0 ? EXIT.ERROR
    : unresolved.length > 0 || result.pending.length > 0 || secretsPending.length > 0
      ? EXIT.CONFLICT
      : EXIT.OK

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
      blankCredentials,
    }, io, code === EXIT.OK)
    return code
  }

  if (opts.dryRun) line(pc.bold('Dry run — nothing was changed.'), io)

  if (result.applied.length === 0 && unresolved.length === 0 && result.failed.length === 0
      && result.pending.length === 0
      && secretsRepaired.length === 0 && secretsPending.length === 0) {
    line(pc.green('Everything is in sync.'), io)
  } else {
    // A dry run must never read like a run that happened.
    const verb = (type: string): string => (opts.dryRun ? `would ${type}` : type)
    const mark = opts.dryRun ? pc.dim('·') : pc.green('✓')
    for (const a of result.applied) line(`  ${mark} ${verb(a.type).padEnd(22)} ${a.kind}/${a.id}`, io)
    for (const a of result.pending) line(`  ${pc.yellow('!')} ${'pending'.padEnd(22)} ${a.kind}/${a.id} — needs you`, io)
    for (const c of unresolved) line(`  ${pc.yellow('⚠')} ${'conflict'.padEnd(22)} ${c.kind}/${c.id}`, io)
    for (const f of result.failed) line(`  ${pc.red('✗')} ${f.action.kind}/${f.action.id}: ${f.error}`, io)
    for (const id of secretsRepaired) line(`  ${mark} ${'credentials'.padEnd(22)} mcp/${id}`, io)
    for (const s of secretsPending) line(`  ${pc.yellow('!')} ${'credentials'.padEnd(22)} mcp/${s.id} — ${s.reason}`, io)
    if (result.backupDir !== null) line(pc.dim(`  backup: ${result.backupDir}`), io)
  }

  // Merging is an interactive step: it rewrites a skill with an AI agent's
  // output, and that is not something to do behind a script's back. Say where
  // it lives rather than leaving exit 2 to be interpreted.
  if (unresolved.length > 0) {
    line(
      pc.dim(`  run \`syncskills\` with no arguments to merge ${unresolved.length === 1 ? 'it' : 'them'} interactively`),
      io,
    )
  }
  for (const w of io.warnings) line(pc.yellow(`  ! ${w}`), io)

  return code
}
