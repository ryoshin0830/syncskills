import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveBaseTree, existingBaseTree, dropBaseTree } from '../src/basetree.js'

let configDir: string
let src: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'ss-bt-'))
  src = await mkdtemp(join(tmpdir(), 'ss-bt-src-'))
  await mkdir(src, { recursive: true })
  await writeFile(join(src, 'SKILL.md'), 'v1\n')
})

/**
 * state.json holds the base HASH and the base tree holds the base CONTENT, and
 * they are one record. They are written at different moments, though: the tree
 * during apply, state.json only after a successful push. Anything that ends the
 * run in between — a rejected push, a network failure, a throw from the secret
 * store, Ctrl-C — leaves a tree describing an agreement that never happened.
 *
 * Used as an ancestor, such a tree is worse than none: a three-way merge reads
 * every line the other side did not also have as deliberately deleted, and
 * drops it with no conflict reported. So the tree carries the hash it was saved
 * for, and is only offered when state.json still agrees.
 */
describe('a base tree whose state was never saved', () => {
  it('is not offered as an ancestor', async () => {
    await saveBaseTree(configDir, 'skill', 'demo', src, 'sha256:v2')
    // The run died before saveState; state.json still names the older content.
    expect(existingBaseTree(configDir, 'skill', 'demo', 'sha256:v1')).toBeUndefined()
  })

  it('is offered once state.json agrees with it', async () => {
    await saveBaseTree(configDir, 'skill', 'demo', src, 'sha256:v2')
    expect(existingBaseTree(configDir, 'skill', 'demo', 'sha256:v2')).toBeDefined()
  })

  it('is not offered when the item has no recorded base at all', async () => {
    await saveBaseTree(configDir, 'skill', 'demo', src, 'sha256:v2')
    expect(existingBaseTree(configDir, 'skill', 'demo', undefined)).toBeUndefined()
  })

  it('is not offered when nothing was ever saved', () => {
    expect(existingBaseTree(configDir, 'skill', 'never', 'sha256:v1')).toBeUndefined()
  })

  it('is not offered when the tree is there but the hash beside it is not', async () => {
    await mkdir(join(configDir, 'base', 'skill', 'orphan'), { recursive: true })
    await writeFile(join(configDir, 'base', 'skill', 'orphan', 'SKILL.md'), 'v1\n')
    expect(existingBaseTree(configDir, 'skill', 'orphan', 'sha256:v1')).toBeUndefined()
  })

  it('stops being offered after it is dropped', async () => {
    await saveBaseTree(configDir, 'skill', 'demo', src, 'sha256:v2')
    await dropBaseTree(configDir, 'skill', 'demo')
    expect(existingBaseTree(configDir, 'skill', 'demo', 'sha256:v2')).toBeUndefined()
  })

  it('re-saving for new content replaces the hash as well as the tree', async () => {
    await saveBaseTree(configDir, 'skill', 'demo', src, 'sha256:v2')
    await writeFile(join(src, 'SKILL.md'), 'v3\n')
    await saveBaseTree(configDir, 'skill', 'demo', src, 'sha256:v3')
    expect(existingBaseTree(configDir, 'skill', 'demo', 'sha256:v2')).toBeUndefined()
    expect(existingBaseTree(configDir, 'skill', 'demo', 'sha256:v3')).toBeDefined()
  })
})
