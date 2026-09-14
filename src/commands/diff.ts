import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gather } from '../engine.js'
import { walk } from '../util/fs.js'
import { renderDiff } from '../tui/diff.js'
import { emitJson, emitJsonError, line } from '../output.js'
import { EXIT } from '../cli.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'

async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for await (const e of walk(dir)) {
    out.set(e.rel, await readFile(e.abs, 'utf8').catch(() => '<binary>'))
  }
  return out
}

export async function diffCommand(
  opts: EngineOptions, id: string | undefined, io: Io,
): Promise<number> {
  if (id === undefined) {
    const msg = 'usage: syncskills diff <item>'
    if (io.json) emitJsonError('diff', msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }

  const { resolutions, store } = await gather(opts)
  const r = resolutions.find((x) => x.id === id)
  if (r === undefined) {
    const msg = `no item named ${id}; run \`syncskills status\` to see what exists`
    if (io.json) emitJsonError('diff', msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }

  if (r.kind === 'skill') {
    const localFiles = await readTree(join(opts.paths.skillsDir, id))
    const remoteFiles = await readTree(store.itemDir('skill', id))
    const paths = [...new Set([...localFiles.keys(), ...remoteFiles.keys()])].sort()

    const diffs = paths
      .map((p) => ({ path: p, diff: renderDiff(remoteFiles.get(p) ?? '', localFiles.get(p) ?? '') }))
      .filter((d) => d.diff !== '')

    if (io.json) {
      emitJson('diff', { kind: r.kind, id, decision: r.decision, files: diffs }, io)
      return EXIT.OK
    }
    if (diffs.length === 0) {
      line(`${id}: identical (${r.decision})`, io)
      return EXIT.OK
    }
    for (const d of diffs) {
      line(`\n--- remote/${d.path}\n+++ local/${d.path}`, io)
      line(d.diff, io)
    }
    return EXIT.OK
  }

  const remote = await store.readItemJson(r.kind, id)
  const localPayload = (r.local?.payload ?? null) as { config?: unknown } | null
  const localText = JSON.stringify(localPayload?.config ?? null, null, 2)
  const remoteText = JSON.stringify(remote, null, 2)
  const diff = renderDiff(remoteText, localText)

  if (io.json) {
    emitJson('diff', { kind: r.kind, id, decision: r.decision, diff }, io)
    return EXIT.OK
  }
  if (diff === '') line(`${id}: identical (${r.decision})`, io)
  else { line(`\n--- remote/${id}\n+++ local/${id}`, io); line(diff, io) }
  return EXIT.OK
}
