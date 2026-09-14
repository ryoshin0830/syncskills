import { run } from '../util/exec.js'

export interface MergeRequest { path: string; base: string; local: string; remote: string }

export interface MergeAgent {
  name: string
  merge(req: MergeRequest): Promise<string>
}

const PROMPT = (req: MergeRequest): string =>
  `You are resolving a merge conflict in a file that two machines edited independently.
The file is \`${req.path}\`.

Rules you MUST follow:
1. Preserve the intent of BOTH sides. Never drop one side's contribution.
2. Where the two sides express the same idea differently, state it once.
3. Where they express different ideas, keep both, ordered sensibly.
4. Keep the file's original format valid (YAML frontmatter, JSON, shell syntax).
5. Output ONLY the merged file contents. No commentary, no code fences.

=== COMMON ANCESTOR ===
${req.base}
=== END COMMON ANCESTOR ===

=== VERSION A (this machine) ===
${req.local}
=== END VERSION A ===

=== VERSION B (the other machine) ===
${req.remote}
=== END VERSION B ===`

/** Agents sometimes wrap output in a fence despite being told not to. */
function stripFence(text: string): string {
  const t = text.trim()
  const m = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t)
  return m === null ? text : m[1]!
}

export function claudeAgent(bin = 'claude'): MergeAgent {
  return {
    name: 'claude',
    async merge(req) {
      const r = await run(bin, ['-p', '--permission-mode', 'plan'], { input: PROMPT(req) })
      if (r.code !== 0) {
        throw new Error(`claude merge failed: ${r.stderr.trim() || r.stdout.trim()}`)
      }
      return stripFence(r.stdout)
    },
  }
}

export function codexAgent(bin = 'codex'): MergeAgent {
  return {
    name: 'codex',
    async merge(req) {
      const r = await run(bin, ['exec', '--skip-git-repo-check', '-'], { input: PROMPT(req) })
      if (r.code !== 0) {
        throw new Error(`codex merge failed: ${r.stderr.trim() || r.stdout.trim()}`)
      }
      return stripFence(r.stdout)
    },
  }
}

/** Forces manual resolution. Used by --merge-agent none and when none is found. */
export function noAgent(): MergeAgent {
  return {
    name: 'none',
    async merge() {
      throw new Error('no merge agent configured')
    },
  }
}

async function onPath(bin: string): Promise<boolean> {
  const r = await run('which', [bin]).catch(() => ({ code: 1 }))
  return r.code === 0
}

export async function pickAgent(
  name: 'claude' | 'codex' | 'none' | 'auto',
): Promise<MergeAgent> {
  if (name === 'none') return noAgent()
  if (name === 'claude') return claudeAgent()
  if (name === 'codex') return codexAgent()
  if (await onPath('claude')) return claudeAgent()
  if (await onPath('codex')) return codexAgent()
  return noAgent()
}
