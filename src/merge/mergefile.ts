import { readFile } from 'node:fs/promises'
import { run } from '../util/exec.js'

/**
 * Deterministic three-way merge via git. Running this before any AI agent means
 * the common case — edits that do not overlap — resolves identically on every
 * machine, for free, and the tool still works with no agent installed.
 *
 * git merge-file exits 0 when clean, with the number of conflicts (1..127) when
 * the sides overlap, and 255 on a genuine failure.
 */
export async function mergeFile(
  base: string, local: string, remote: string,
): Promise<{ clean: boolean; text: string }> {
  const r = await run('git', [
    'merge-file', '-p', '--diff3',
    '-L', 'local', '-L', 'base', '-L', 'remote',
    local, base, remote,
  ])

  if (r.code === 255 || r.code < 0) {
    throw new Error(`git merge-file failed: ${r.stderr.trim() || 'unknown error'}`)
  }
  if (r.code === 0) return { clean: true, text: r.stdout }
  return { clean: false, text: r.stdout || (await readFile(local, 'utf8')) }
}
