import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, configDir, type Config } from '../src/config.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-cfg-')) })

const sample: Config = {
  schemaVersion: 1, host: 'github.com', owner: 'ryoshin0830', repo: 'syncskills',
  branch: 'main', device: 'work-pc', vault: 'agent', item: 'syncskills',
  secrets: true, excludes: [],
}

describe('configDir', () => {
  it('prefers the --config flag', () => {
    expect(configDir({ config: '/tmp/a' }, {} as NodeJS.ProcessEnv)).toBe('/tmp/a')
  })
  it('then SYNCSKILLS_CONFIG_DIR', () => {
    expect(configDir({}, { SYNCSKILLS_CONFIG_DIR: '/tmp/b' } as NodeJS.ProcessEnv)).toBe('/tmp/b')
  })
  it('then XDG_CONFIG_HOME/syncskills', () => {
    expect(configDir({}, { XDG_CONFIG_HOME: '/tmp/c' } as NodeJS.ProcessEnv))
      .toBe('/tmp/c/syncskills')
  })
  it('otherwise ~/.config/syncskills', () => {
    expect(configDir({}, { HOME: '/Users/x' } as NodeJS.ProcessEnv))
      .toBe('/Users/x/.config/syncskills')
  })
  it('ignores an empty --config rather than resolving to the current directory', () => {
    expect(configDir({ config: '' }, { HOME: '/Users/x' } as NodeJS.ProcessEnv))
      .toBe('/Users/x/.config/syncskills')
  })
})

describe('config', () => {
  it('returns null when not initialized', async () => {
    expect(await loadConfig(dir)).toBeNull()
  })

  it('round-trips', async () => {
    await saveConfig(dir, sample)
    expect(await loadConfig(dir)).toEqual(sample)
  })

  it('writes the file owner-readable only', async () => {
    await saveConfig(dir, sample)
    const st = await stat(join(dir, 'config.json'))
    expect(st.mode & 0o077).toBe(0)
  })

  it('rejects a config from a future schema version', async () => {
    await saveConfig(dir, { ...sample, schemaVersion: 99 as unknown as 1 })
    await expect(loadConfig(dir)).rejects.toThrow(/schema version/i)
  })

  it('names the file when the config is corrupt', async () => {
    await writeFile(join(dir, 'config.json'), '{ broken')
    await expect(loadConfig(dir)).rejects.toThrow(/config\.json is not valid JSON/)
  })
})
