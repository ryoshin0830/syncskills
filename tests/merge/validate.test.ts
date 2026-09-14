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
