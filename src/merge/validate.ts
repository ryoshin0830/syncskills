export function hasConflictMarkers(text: string): boolean {
  return /^<{7}[ \t]/m.test(text) || /^={7}\s*$/m.test(text) || /^>{7}[ \t]/m.test(text)
}

export type Validation = { ok: true } | { ok: false; reason: string }

/**
 * A merge agent can return anything. Nothing it produces is written until it
 * passes here, because a damaged SKILL.md silently breaks the skill on every
 * machine it syncs to.
 */
export function validateMerged(relPath: string, text: string): Validation {
  if (text.trim().length === 0) return { ok: false, reason: 'merged output is empty' }
  if (hasConflictMarkers(text)) return { ok: false, reason: 'conflict markers remain' }

  const name = relPath.split('/').pop() ?? relPath

  if (name === 'SKILL.md') {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (m === null) return { ok: false, reason: 'SKILL.md lost its YAML frontmatter' }
    const fm = m[1]!
    if (!/^name\s*:/m.test(fm)) return { ok: false, reason: 'SKILL.md frontmatter lost `name`' }
    if (!/^description\s*:/m.test(fm)) {
      return { ok: false, reason: 'SKILL.md frontmatter lost `description`' }
    }
    return { ok: true }
  }

  if (name.endsWith('.json')) {
    try {
      JSON.parse(text)
    } catch (e) {
      return { ok: false, reason: `invalid JSON: ${(e as Error).message}` }
    }
  }

  return { ok: true }
}
