import { mkdir, mkdtemp, writeFile, readFile, copyFile, rm, stat, chmod } from 'node:fs/promises'
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
 * Whether a file has to be treated as opaque bytes.
 *
 * This matters more than it looks: `Buffer#toString('utf8')` does not fail on
 * invalid bytes, it replaces each one with U+FFFD. Two different images
 * therefore decode to the SAME string, and a text-based comparison calls them
 * identical — which would drop one side's change without reporting a conflict.
 */
function isBinary(buf: Buffer): boolean {
  if (buf.includes(0)) return true
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)
}

/**
 * Give a merged file the mode it had on the side it came from.
 *
 * `writeFile` creates 0644 regardless of the source, and treeHash() hashes the
 * executable bit as part of an item's content — so dropping it here would push
 * a script that no longer runs to every other machine.
 */
async function inheritMode(target: string, ...sources: (string | undefined)[]): Promise<void> {
  for (const src of sources) {
    if (src === undefined) continue
    const st = await stat(src).catch(() => null)
    if (st === null) continue
    await chmod(target, st.mode & 0o777)
    return
  }
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
      // Every comparison below is over bytes, never over a decoded string: a
      // side that "did not change" has to mean byte-for-byte, or a binary whose
      // edits happen to be invalid UTF-8 looks untouched.
      const bBuf = bPath === undefined ? null : await readFile(bPath)

      if (lPath !== undefined && rPath === undefined) {
        const lBuf = await readFile(lPath)
        if (bBuf !== null && bBuf.equals(lBuf)) {
          report.files.push({ path: p, how: 'deleted' })
          continue
        }
        await copyFile(lPath, target)
        report.files.push({ path: p, how: 'local-only' })
        continue
      }

      if (lPath === undefined && rPath !== undefined) {
        const rBuf = await readFile(rPath)
        if (bBuf !== null && bBuf.equals(rBuf)) {
          report.files.push({ path: p, how: 'deleted' })
          continue
        }
        await copyFile(rPath, target)
        report.files.push({ path: p, how: 'remote-only' })
        continue
      }

      const lBuf = await readFile(lPath!)
      const rBuf = await readFile(rPath!)

      if (lBuf.equals(rBuf)) {
        await copyFile(lPath!, target)
        report.files.push({ path: p, how: 'identical' })
        continue
      }

      if (bBuf !== null && bBuf.equals(lBuf)) {
        await copyFile(rPath!, target)
        report.files.push({ path: p, how: 'remote-only' })
        continue
      }
      if (bBuf !== null && bBuf.equals(rBuf)) {
        await copyFile(lPath!, target)
        report.files.push({ path: p, how: 'local-only' })
        continue
      }

      // Both sides moved. Line-based merging is meaningless for bytes, and the
      // agent would be handed U+FFFD soup, so this one goes back to the user.
      if (isBinary(lBuf) || isBinary(rBuf)) {
        report.files.push({
          path: p, how: 'unresolved',
          reason: 'binary file changed on both sides; it cannot be merged line by line',
        })
        report.resolved = false
        continue
      }

      const lText = lBuf.toString('utf8')
      const rText = rBuf.toString('utf8')
      const bText = bBuf === null ? '' : bBuf.toString('utf8')

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
          await inheritMode(target, lPath, rPath)
          report.files.push({ path: p, how: 'git' })
          continue
        }
      }

      try {
        const text = await opts.agent.merge({ path: p, base: bText, local: lText, remote: rText })
        const v = validateMerged(p, text)
        if (!v.ok) throw new Error(v.reason)
        await writeFile(target, text)
        await inheritMode(target, lPath, rPath)
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
