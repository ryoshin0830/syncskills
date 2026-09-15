import pc from 'picocolors'
import { readdir, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { emitJson, emitJsonError, line } from '../output.js'
import { EXIT } from '../cli.js'
import type { CcPaths } from '../ccswitch/paths.js'
import type { Io } from '../output.js'

export interface Snapshot { id: string; stamp: string; item: string; path: string }

export async function listSnapshots(configDir: string): Promise<Snapshot[]> {
  const root = join(configDir, 'conflicts')
  if (!existsSync(root)) return []

  const out: Snapshot[] = []
  for (const stamp of (await readdir(root)).sort()) {
    const dir = join(root, stamp)
    for (const item of (await readdir(dir).catch(() => [])).sort()) {
      out.push({ id: `${stamp}/${item}`, stamp, item, path: join(dir, item) })
    }
  }
  return out
}

export async function conflictsCommand(
  opts: { configDir: string; paths: CcPaths },
  positionals: string[],
  io: Io,
): Promise<number> {
  const [sub, id] = positionals
  const snapshots = await listSnapshots(opts.configDir)

  if (sub === undefined || sub === 'list') {
    if (io.json) {
      emitJson('conflicts', { snapshots: snapshots.map((s) => ({ id: s.id, path: s.path })) }, io)
    } else if (snapshots.length === 0) {
      line('No conflict snapshots.', io)
    } else {
      for (const s of snapshots) line(`  ${s.id}`, io)
    }
    return EXIT.OK
  }

  if (sub === 'restore') {
    const wanted = positionals[2]
    if (wanted !== undefined && wanted !== 'local' && wanted !== 'remote') {
      const msg = `unknown side "${wanted}"; expected local or remote`
      if (io.json) emitJsonError('conflicts', msg, io)
      else process.stderr.write(`oneset: ${msg}\n`)
      return EXIT.ERROR
    }
    const snap = snapshots.find((s) => s.id === id)
    if (snap === undefined) {
      const msg = `no snapshot ${id ?? '(none)'}; run \`oneset conflicts\` to list them`
      if (io.json) emitJsonError('conflicts', msg, io)
      else process.stderr.write(`oneset: ${msg}\n`)
      return EXIT.ERROR
    }
    // Restoring the REMOTE side is the whole point after a bad merge, so it
    // must be reachable; local is only the default.
    const wantedSide = positionals[2] as 'local' | 'remote' | undefined
    const side = wantedSide ?? (existsSync(join(snap.path, 'local')) ? 'local' : 'remote')
    if (!existsSync(join(snap.path, side))) {
      const msg = `snapshot ${snap.id} has no ${side} side`
      if (io.json) emitJsonError('conflicts', msg, io)
      else process.stderr.write(`oneset: ${msg}\n`)
      return EXIT.ERROR
    }
    const dest = join(opts.paths.skillsDir, snap.item)
    await rm(dest, { recursive: true, force: true })
    await cp(join(snap.path, side), dest, { recursive: true })

    if (io.json) emitJson('conflicts', { restored: snap.id, side, to: dest }, io)
    else line(`${pc.green('✓')} restored ${snap.item} (${side} side) to ${dest}`, io)
    return EXIT.OK
  }

  const msg = `unknown subcommand ${sub}; expected list or restore`
  if (io.json) emitJsonError('conflicts', msg, io)
  else process.stderr.write(`oneset: ${msg}\n`)
  return EXIT.ERROR
}
