import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSync, gather } from '../../src/engine.js'
import { loadState } from '../../src/state.js'
import { makeFakeCcSwitch, addSkill, addMcp, addRepo, type FakeHome } from './fakeCcSwitch.js'
import { readRepos, readSkills, readMcp } from '../../src/ccswitch/read.js'
import { loadDatabaseSync } from '../../src/util/sqlite.js'
import type { Config } from '../../src/config.js'
import type { SyncOutcome } from '../../src/engine.js'
import type { StateFile } from '../../src/state.js'
import type { EngineOptions } from '../../src/engine.js'

export { makeBareRemote } from './bareRemote.js'

/**
 * One simulated machine: its own cc-switch home, its own syncskills config
 * directory, and a stub cc-switch binary that applies matrix changes straight
 * to that home's database. Two of these plus a bare repository reproduce the
 * whole product with no network and no risk to real data.
 */
export interface Device {
  name: string
  configDir: string
  paths: FakeHome
  ccBin: string

  sync(over?: Partial<EngineOptions>): Promise<SyncOutcome>
  push(): Promise<SyncOutcome>
  pull(): Promise<SyncOutcome>

  writeSkill(dir: string, body: string, apps?: string[]): Promise<void>
  readSkill(dir: string): Promise<string | null>
  deleteSkill(dir: string): Promise<void>
  addMcpServer(id: string, config: unknown, apps?: string[]): void
  addRepoRow(owner: string, name: string, branch?: string, enabled?: boolean): void
  addMcpServerWithTags(id: string, config: unknown, apps: string[], tags: string[]): void
  listMcpRows(): { id: string; config: Record<string, unknown>; apps: string[]; tags: string[] }[]
  setMcpConfig(id: string, config: unknown): void
  setMcpApps(id: string, apps: string[]): void
  listRepoRows(): { owner: string; name: string; branch: string; enabled: boolean }[]
  addUnmanagedSkillDir(dir: string, body: string): Promise<void>
  setSkillApps(dir: string, apps: string[]): void
  readSkillApps(dir: string): string[]

  readRemoteFile(relPath: string): Promise<string | null>
  readState(): Promise<StateFile>
  breakCcSwitch(): Promise<void>
  fixCcSwitch(): Promise<void>
}

/**
 * Stands in for cc-switch. `skills import-from-apps` and the two `set-apps`
 * commands write the matrix into the fake database; `skills sync` is a no-op
 * because nothing here reads the app symlink directories.
 */
async function makeCcStub(home: FakeHome): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ss-ccstub-'))
  const bin = join(dir, 'cc-switch')
  const helper = fileURLToPath(new URL('./ccStubHelper.mjs', import.meta.url))

  await writeFile(bin, `#!/bin/sh
DB=${JSON.stringify(home.db)}
HELPER=${JSON.stringify(helper)}
if [ -f "${join(dir, 'broken')}" ]; then echo "simulated cc-switch failure" >&2; exit 7; fi
case "$1 $2" in
  "skills import-from-apps") node "$HELPER" "$DB" skill "$3" "$5" ;;
  "skills set-apps")         node "$HELPER" "$DB" skill "$3" "$5" ;;
  "mcp set-apps")            node "$HELPER" "$DB" mcp   "$3" "$5" ;;
  "mcp delete")              node "$HELPER" "$DB" mcpdelete "$3" ;;
  "skills repos")            node "$HELPER" "$DB" repo  "$4" "$3" ;;
  "skills sync")             : ;;
  *)
    if [ "$1" = "deeplink" ]; then node "$HELPER" "$DB" deeplink "$2"; fi
    ;;
esac
exit 0
`)
  await chmod(bin, 0o755)
  return bin
}

export async function makeDevice(name: string, remote: string): Promise<Device> {
  const paths = await makeFakeCcSwitch()
  const configDir = await mkdtemp(join(tmpdir(), `ss-dev-${name}-`))
  const ccBin = await makeCcStub(paths)

  const config: Config = {
    schemaVersion: 1, host: 'github.com', owner: 'o', repo: 'r', branch: 'main',
    device: name, vault: 'agent', item: 'syncskills', secrets: false, excludes: [],
  }

  const options = (over: Partial<EngineOptions> = {}): EngineOptions => ({
    configDir,
    config,
    paths,
    mergeAgent: 'none',
    useSecrets: false,
    dryRun: false,
    direction: 'both',
    remoteOverride: remote,
    ccBin,
    ...over,
  })

  return {
    name, configDir, paths, ccBin,

    sync: (over) => runSync(options(over)),
    push: () => runSync(options({ direction: 'push' })),
    pull: () => runSync(options({ direction: 'pull' })),

    async writeSkill(dir, body, apps = ['claude']) {
      const target = join(paths.skillsDir, dir)
      if (!existsSync(target)) {
        await addSkill(paths, dir, body, apps)
        return
      }
      await writeFile(join(target, 'SKILL.md'), body)
    },

    async readSkill(dir) {
      return readFile(join(paths.skillsDir, dir, 'SKILL.md'), 'utf8').catch(() => null)
    },

    async deleteSkill(dir) {
      await rm(join(paths.skillsDir, dir), { recursive: true, force: true })
      const DatabaseSync = loadDatabaseSync()
      const d = new DatabaseSync(paths.db)
      try {
        d.prepare('DELETE FROM skills WHERE directory = ?').run(dir)
      } finally {
        d.close()
      }
    },

    addMcpServer(id, config_, apps = ['claude']) {
      addMcp(paths, id, config_, apps)
    },

    addMcpServerWithTags(id, config_, apps, tags) {
      addMcp(paths, id, config_, apps)
      const DatabaseSync = loadDatabaseSync()
      const d = new DatabaseSync(paths.db)
      try {
        d.prepare('UPDATE mcp_servers SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id)
      } finally {
        d.close()
      }
    },

    listMcpRows() {
      return readMcp(paths)
    },

    setMcpConfig(id, config_) {
      const DatabaseSync = loadDatabaseSync()
      const d = new DatabaseSync(paths.db)
      try {
        d.prepare('UPDATE mcp_servers SET server_config = ? WHERE id = ?')
          .run(JSON.stringify(config_), id)
      } finally {
        d.close()
      }
    },

    setMcpApps(id, apps) {
      const ALL = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'grokbuild']
      const DatabaseSync = loadDatabaseSync()
      const d = new DatabaseSync(paths.db)
      try {
        const sets = ALL.map((a) => `enabled_${a} = ${apps.includes(a) ? 1 : 0}`).join(', ')
        d.prepare(`UPDATE mcp_servers SET ${sets} WHERE id = ?`).run(id)
      } finally {
        d.close()
      }
    },

    addRepoRow(owner, name, branch = 'main', enabled = true) {
      addRepo(paths, owner, name, branch, enabled)
    },

    listRepoRows() {
      return readRepos(paths)
    },

    setSkillApps(dir, apps) {
      const ALL = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'grokbuild']
      const DatabaseSync = loadDatabaseSync()
      const d = new DatabaseSync(paths.db)
      try {
        const sets = ALL.map((a) => `enabled_${a} = ${apps.includes(a) ? 1 : 0}`).join(', ')
        d.prepare(`UPDATE skills SET ${sets} WHERE directory = ?`).run(dir)
      } finally {
        d.close()
      }
    },

    readSkillApps(dir) {
      const row = readSkills(paths).find((r) => r.directory === dir)
      return row === undefined ? [] : row.apps
    },

    async addUnmanagedSkillDir(dir, body) {
      const d = join(paths.skillsDir, dir)
      await mkdir(d, { recursive: true })
      await writeFile(join(d, 'SKILL.md'), body)
    },

    async readRemoteFile(relPath) {
      const { store } = await gather(options())
      return readFile(join(store.dir, relPath), 'utf8').catch(() => null)
    },

    readState: () => loadState(configDir),

    async breakCcSwitch() {
      await mkdir(join(ccBin, '..'), { recursive: true })
      await writeFile(join(ccBin, '..', 'broken'), 'x')
    },

    async fixCcSwitch() {
      await rm(join(ccBin, '..', 'broken'), { force: true })
    },
  }
}
