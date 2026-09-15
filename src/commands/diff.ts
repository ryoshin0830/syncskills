import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { gather } from '../engine.js'
import { stripSecrets } from '../ccswitch/read.js'
import { walk } from '../util/fs.js'
import { renderDiff } from '../tui/diff.js'
import { emitJson, emitJsonError, line } from '../output.js'
import { EXIT } from '../cli.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'
import type { ItemKind, Resolution } from '../core/types.js'

async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for await (const e of walk(dir)) {
    out.set(e.rel, await readFile(e.abs, 'utf8').catch(() => '<binary>'))
  }
  return out
}

const KINDS: ItemKind[] = ['skill', 'mcp', 'repo']

/**
 * Find the item a `diff` argument names.
 *
 * A skill and an MCP server may share a name, so an id on its own is not always
 * enough; `kind/id` disambiguates, and an ambiguous bare name is reported
 * rather than resolved to whichever sorted first. A repository id contains a
 * slash of its own, which is why the prefix is matched against the known kinds
 * instead of splitting on the first separator.
 */
export function selectItem(
  resolutions: Resolution[], query: string,
): { item: Resolution | undefined } | { ambiguous: ItemKind[] } {
  for (const k of KINDS) {
    if (!query.startsWith(`${k}/`)) continue
    const id = query.slice(k.length + 1)
    const item = resolutions.find((x) => x.kind === k && x.id === id)
    if (item !== undefined) return { item }
  }

  const matches = resolutions.filter((x) => x.id === query)
  if (matches.length > 1) {
    return { ambiguous: [...new Set(matches.map((m) => m.kind))].sort() }
  }
  return { item: matches[0] }
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
  const found = selectItem(resolutions, id)
  if ('ambiguous' in found) {
    const msg =
      `${id} names more than one item (${found.ambiguous.join(', ')}); ` +
      `say which with \`syncskills diff ${found.ambiguous[0]}/${id}\``
    if (io.json) emitJsonError('diff', msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }
  const r = found.item
  if (r === undefined) {
    const msg = `no item named ${id}; run \`syncskills status\` to see what exists`
    if (io.json) emitJsonError('diff', msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }
  // Every path below reads the item by its own id, not by what was typed.
  id = r.id

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
  const localPayload = (r.local?.payload ?? null) as { config?: Record<string, unknown> } | null
  // The payload carries real env values. What the remote holds — and what we
  // are allowed to show — is the sanitized shape.
  const localConfig = localPayload?.config === undefined
    ? null
    : stripSecrets(localPayload.config).sanitized
  const localText = JSON.stringify(localConfig, null, 2)
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
