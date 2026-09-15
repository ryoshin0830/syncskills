import { describe, it, expect } from 'vitest'
import { hasConflictMarkers, validateMerged } from '../../src/merge/validate.js'

describe('hasConflictMarkers', () => {
  it('detects all three marker kinds', () => {
    expect(hasConflictMarkers('<<<<<<< local\na\n=======\nb\n>>>>>>> remote\n')).toBe(true)
  })
  it('accepts clean text', () => {
    expect(hasConflictMarkers('just text\n')).toBe(false)
  })
  it('does not trip on a shorter run of angle brackets', () => {
    expect(hasConflictMarkers('a <<< b >>> c')).toBe(false)
  })
  it('does not trip on a markdown rule of equals signs longer than seven', () => {
    expect(hasConflictMarkers('title\n==========\n')).toBe(false)
  })
})

describe('validateMerged', () => {
  it('rejects empty output', () => {
    expect(validateMerged('SKILL.md', '   ')).toEqual({ ok: false, reason: 'merged output is empty' })
  })

  it('rejects leftover conflict markers', () => {
    expect(validateMerged('a.md', '<<<<<<< x\n1\n=======\n2\n>>>>>>> y\n').ok).toBe(false)
  })

  it('requires SKILL.md to keep valid frontmatter with name and description', () => {
    expect(validateMerged('SKILL.md', '---\nname: x\ndescription: y\n---\n\nbody\n'))
      .toEqual({ ok: true })
  })

  it('validates SKILL.md wherever it sits in the tree', () => {
    expect(validateMerged('nested/SKILL.md', 'body only\n').ok).toBe(false)
  })

  it('rejects SKILL.md that lost its frontmatter', () => {
    expect(validateMerged('SKILL.md', 'body only\n').ok).toBe(false)
  })

  it('rejects SKILL.md that lost its name field', () => {
    expect(validateMerged('SKILL.md', '---\ndescription: y\n---\nbody\n').ok).toBe(false)
  })

  it('rejects SKILL.md that lost its description field', () => {
    expect(validateMerged('SKILL.md', '---\nname: y\n---\nbody\n').ok).toBe(false)
  })

  it('requires a .json file to parse', () => {
    expect(validateMerged('x.json', '{ "a": 1 }').ok).toBe(true)
    expect(validateMerged('x.json', '{ broken').ok).toBe(false)
  })

  it('accepts any other text file', () => {
    expect(validateMerged('scripts/run.sh', 'echo hi\n')).toEqual({ ok: true })
  })
})

/**
 * `=======` on its own is ordinary Markdown — a setext heading underline, or a
 * section rule — and SKILL.md is Markdown. Reading it as a conflict marker
 * rejected clean, correct merges, sent them to the AI agent for no reason, and
 * reported them unresolved when the agent's output contained the same line.
 * Every real conflict carries `<<<<<<< ` and `>>>>>>> `, which are still checked.
 */
describe('a line of equals signs in ordinary Markdown', () => {
  it('is not a conflict marker under a setext heading', () => {
    expect(hasConflictMarkers('Overview\n=======\n\nBody\n')).toBe(false)
  })

  it('does not make a valid SKILL.md invalid', () => {
    const md = '---\nname: s\ndescription: d\n---\n\nOverview\n=======\n\nBody\n'
    expect(validateMerged('SKILL.md', md)).toEqual({ ok: true })
  })

  it('still catches a real conflict, which always has the outer markers', () => {
    const text = '<<<<<<< local\nmine\n=======\ntheirs\n>>>>>>> remote\n'
    expect(hasConflictMarkers(text)).toBe(true)
  })

  it('still catches the diff3 base section', () => {
    const text = '<<<<<<< local\nmine\n||||||| base\nwas\n=======\ntheirs\n>>>>>>> remote\n'
    expect(hasConflictMarkers(text)).toBe(true)
  })
})
