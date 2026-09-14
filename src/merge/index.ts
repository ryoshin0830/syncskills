import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { walk } from '../util/fs.js'
import { mergeFile } from './mergefile.js'
import { validateMerged } from './validate.js'
import type { MergeAgent } from './agent.js'

export type MergeHow =
  | 'identical' | 'local-only' | 'remote-only' | 'git' | 'agent' | 'deleted' | 'unresolved'

export interface MergeReport {
  files: { path: string; how: MergeHow; reason?: string }[]
  resolved: boolean
}

async function listFiles(dir: string | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (dir === undefined || !existsSync(dir)) return out
  for await (const e of walk(dir)) out.set(e.rel, e.abs)
  return out
}

/**
 * Merge two versions of one item, keeping both sides' work.
 *
 * Per file: identical content is taken as-is; a change on one side only is
 * taken from that side; genuine overlap goes to `git merge-file` first and only
 * reaches the AI agent when git leaves conflict markers. Nothing the agent
 * returns is written unless it validates, so a failed or damaged merge degrades
 * to "unresolved" rather than to corrupted content.
 */
export async function mergeTrees(opts: {
  baseDir?: string
  localDir: string
  remoteDir: string
  outDir: string
  agent: MergeAgent
}): Promise<MergeReport> {
  const base = await listFiles(opts.baseDir)
  const local = await listFiles(opts.localDir)
  const remote = await listFiles(opts.remoteDir)

  const paths = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort()
  const report: MergeReport = { files: [], resolved: true }
  const scratch = await mkdtemp(join(tmpdir(), 'ss-merge-'))

  await mkdir(opts.outDir, { recursive: true })

  try {
    for (const p of paths) {
      const target = join(opts.outDir, p)
      const lPath = local.get(p)
      const rPath = remote.get(p)
      const bPath = base.get(p)

      if (lPath === undefined && rPath === undefined) continue
      await mkdir(dirname(target), { recursive: true })

      // Present on one side only: either it was added there, or deleted on the
      // other. A deletion wins only when the surviving side never touched it.
      if (lPath !== undefined && rPath === undefined) {
        const lText = await readFile(lPath, 'utf8')
        const bText = bPath === undefined ? null : await readFile(bPath, 'utf8')
        if (bText !== null && bText === lText) {
          report.files.push({ path: p, how: 'deleted' })
          continue
        }
        await copyFile(lPath, target)
        report.files.push({ path: p, how: 'local-only' })
        continue
      }

      if (lPath === undefined && rPath !== undefined) {
        const rText = await readFile(rPath, 'utf8')
        const bText = bPath === undefined ? null : await readFile(bPath, 'utf8')
        if (bText !== null && bText === rText) {
          report.files.push({ path: p, how: 'deleted' })
          continue
        }
        await copyFile(rPath, target)
        report.files.push({ path: p, how: 'remote-only' })
        continue
      }

      const lText = await readFile(lPath!, 'utf8')
      const rText = await readFile(rPath!, 'utf8')

      if (lText === rText) {
        await copyFile(lPath!, target)
        report.files.push({ path: p, how: 'identical' })
        continue
      }

      const bText = bPath === undefined ? '' : await readFile(bPath, 'utf8')
      if (bText === lText) {
        await copyFile(rPath!, target)
        report.files.push({ path: p, how: 'remote-only' })
        continue
      }
      if (bText === rText) {
        await copyFile(lPath!, target)
        report.files.push({ path: p, how: 'local-only' })
        continue
      }

      const bFile = join(scratch, 'base')
      const lFile = join(scratch, 'local')
      const rFile = join(scratch, 'remote')
      await writeFile(bFile, bText)
      await writeFile(lFile, lText)
      await writeFile(rFile, rText)

      const merged = await mergeFile(bFile, lFile, rFile)
      if (merged.clean) {
        const v = validateMerged(p, merged.text)
        if (v.ok) {
          await writeFile(target, merged.text)
          report.files.push({ path: p, how: 'git' })
          continue
        }
      }

      try {
        const text = await opts.agent.merge({ path: p, base: bText, local: lText, remote: rText })
        const v = validateMerged(p, text)
        if (!v.ok) throw new Error(v.reason)
        await writeFile(target, text)
        report.files.push({ path: p, how: 'agent' })
      } catch (e) {
        await rm(target, { force: true })
        report.files.push({ path: p, how: 'unresolved', reason: (e as Error).message })
        report.resolved = false
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }

  return report
}
