import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeFakeCcSwitch, addSkill, addSkillRow, addMcp, addRepo, type FakeHome,
} from '../helpers/fakeCcSwitch.js'
import {
  readSkills, readMcp, readRepos, localSkillSides, localMcpSides, localRepoSides, stripSecrets,
} from '../../src/ccswitch/read.js'
import { resolveCcPaths } from '../../src/ccswitch/paths.js'

let f: FakeHome
beforeEach(async () => { f = await makeFakeCcSwitch() })

describe('resolveCcPaths', () => {
  it('honours CC_SWITCH_CONFIG_DIR', () => {
    const p = resolveCcPaths({ CC_SWITCH_CONFIG_DIR: '/tmp/x' } as NodeJS.ProcessEnv)
    expect(p.home).toBe('/tmp/x')
    expect(p.db).toBe('/tmp/x/cc-switch.db')
    expect(p.skillsDir).toBe('/tmp/x/skills')
  })

  it('falls back to CC_SWITCH_TEST_HOME, then to ~/.cc-switch', () => {
    expect(resolveCcPaths({ CC_SWITCH_TEST_HOME: '/tmp/y' } as NodeJS.ProcessEnv).home).toBe('/tmp/y')
    expect(resolveCcPaths({ HOME: '/Users/z' } as NodeJS.ProcessEnv).home).toBe('/Users/z/.cc-switch')
  })
})

describe('readSkills', () => {
  it('reads rows and decodes the app matrix', async () => {
    await addSkill(f, 'code-review', '# review', ['claude', 'hermes'])
    const rows = readSkills(f)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.directory).toBe('code-review')
    expect(rows[0]!.apps).toEqual(['claude', 'hermes'])
  })

  it('returns an empty array when there are no skills', () => {
    expect(readSkills(f)).toEqual([])
  })

  it('reports app order in the canonical APPS order, not insertion order', async () => {
    await addSkill(f, 's', 'x', ['hermes', 'claude', 'codex'])
    expect(readSkills(f)[0]!.apps).toEqual(['claude', 'codex', 'hermes'])
  })

  it('raises a clear error when the database is missing', () => {
    expect(() => readSkills({ ...f, db: '/nonexistent/cc-switch.db' }))
      .toThrow(/cc-switch database not found/)
  })
})

describe('readMcp and readRepos', () => {
  it('parses server_config and tags', () => {
    addMcp(f, 'oracle', { type: 'stdio', command: 'oracle-mcp', args: [] }, ['claude'])
    const rows = readMcp(f)
    expect(rows[0]!.config).toEqual({ type: 'stdio', command: 'oracle-mcp', args: [] })
    expect(rows[0]!.tags).toEqual([])
    expect(rows[0]!.apps).toEqual(['claude'])
  })

  it('reads repositories with their branch and enabled flag', () => {
    addRepo(f, 'anthropics', 'skills', 'main', true)
    addRepo(f, 'someone', 'other', 'dev', false)
    expect(readRepos(f)).toEqual([
      { owner: 'anthropics', name: 'skills', branch: 'main', enabled: true },
      { owner: 'someone', name: 'other', branch: 'dev', enabled: false },
    ])
  })
})

describe('stripSecrets', () => {
  it('replaces env values with a secret marker and returns the real values', () => {
    const { sanitized, secrets } = stripSecrets({
      type: 'stdio', command: 'x', env: { API_KEY: 'sk-live-1', PORT: '8080' },
    })
    expect(sanitized.env).toEqual({ API_KEY: { secret: true }, PORT: { secret: true } })
    expect(secrets).toEqual({ API_KEY: 'sk-live-1', PORT: '8080' })
    expect(JSON.stringify(sanitized)).not.toContain('sk-live-1')
  })

  it('leaves a config without env untouched', () => {
    const { sanitized, secrets } = stripSecrets({ type: 'stdio', command: 'x' })
    expect(sanitized).toEqual({ type: 'stdio', command: 'x' })
    expect(secrets).toEqual({})
  })

  it('does not mutate the config it was given', () => {
    const original = { type: 'stdio', env: { K: 'v' } }
    stripSecrets(original)
    expect(original.env).toEqual({ K: 'v' })
  })

  it('treats an env that is not an object as no env at all', () => {
    const { sanitized, secrets } = stripSecrets({ command: 'x', env: null })
    expect(secrets).toEqual({})
    expect(sanitized.env).toBeNull()
  })

  /**
   * A value cc-switch stored as something other than a string used to become
   * the literal text "[object Object]" on every other machine.
   */
  it('does not corrupt a non-string value into [object Object]', () => {
    const { secrets } = stripSecrets({
      command: 'x',
      env: { OBJ: { a: 1 }, ARR: [1, 2], NUM: 3000, BOOL: true, NIL: null },
    })
    expect(secrets.OBJ).toBe('{"a":1}')
    expect(secrets.ARR).toBe('[1,2]')
    expect(secrets.NUM).toBe('3000')
    expect(secrets.BOOL).toBe('true')
    expect(secrets.NIL).toBe('')
    expect(Object.values(secrets)).not.toContain('[object Object]')
  })
})

describe('localSkillSides', () => {
  it('hashes each skill directory', async () => {
    await addSkill(f, 'a', 'body-a', ['claude'])
    const sides = await localSkillSides(f)
    expect(sides.get('a')!.contentHash.startsWith('sha256:')).toBe(true)
    expect(sides.get('a')!.apps).toEqual(['claude'])
  })

  it('skips a row whose directory is missing from disk', () => {
    addSkillRow(f, 'ghost', ['claude'])
    return expect(localSkillSides(f)).resolves.toEqual(new Map())
  })

  it('gives two directories with identical content the same hash', async () => {
    await addSkill(f, 'a', 'same', ['claude'])
    await addSkill(f, 'b', 'same', ['codex'])
    const sides = await localSkillSides(f)
    expect(sides.get('a')!.contentHash).toBe(sides.get('b')!.contentHash)
  })
})

describe('localMcpSides', () => {
  it('hashes the sanitized config, so rotating a key is not a content change', () => {
    addMcp(f, 'o', { type: 'stdio', command: 'c', env: { K: 'v1' } }, ['claude'])
    addMcp(f, 'p', { type: 'stdio', command: 'c', env: { K: 'v2' } }, ['claude'])
    const sides = localMcpSides(f)
    expect(sides.get('o')!.contentHash).toBe(sides.get('p')!.contentHash)
  })

  it('does change the hash when a real config field changes', () => {
    addMcp(f, 'o', { type: 'stdio', command: 'c' }, ['claude'])
    addMcp(f, 'p', { type: 'stdio', command: 'DIFFERENT' }, ['claude'])
    const sides = localMcpSides(f)
    expect(sides.get('o')!.contentHash).not.toBe(sides.get('p')!.contentHash)
  })

  it('does change the hash when an env KEY is added, since key names are synced', () => {
    addMcp(f, 'o', { type: 'stdio', command: 'c', env: { A: '1' } }, ['claude'])
    addMcp(f, 'p', { type: 'stdio', command: 'c', env: { A: '1', B: '2' } }, ['claude'])
    const sides = localMcpSides(f)
    expect(sides.get('o')!.contentHash).not.toBe(sides.get('p')!.contentHash)
  })

  it('carries the raw config as payload for later tasks', () => {
    addMcp(f, 'o', { type: 'stdio', command: 'c', env: { K: 'secret' } }, ['claude'])
    const side = localMcpSides(f).get('o')!
    expect(side.payload).toEqual({
      config: { type: 'stdio', command: 'c', env: { K: 'secret' } },
      tags: [],
    })
  })
})

describe('localRepoSides', () => {
  it('keys repositories by owner/name and hashes branch plus enabled', () => {
    addRepo(f, 'a', 'b', 'main', true)
    const sides = localRepoSides(f)
    expect([...sides.keys()]).toEqual(['a/b'])
    expect(sides.get('a/b')!.contentHash.startsWith('sha256:')).toBe(true)
  })

  it('distinguishes an enabled repository from a disabled one', () => {
    addRepo(f, 'a', 'b', 'main', true)
    addRepo(f, 'c', 'd', 'main', false)
    const sides = localRepoSides(f)
    expect(sides.get('a/b')!.contentHash).not.toBe(sides.get('c/d')!.contentHash)
  })
})
