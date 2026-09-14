import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSync, gather } from '../../src/engine.js'
import { loadState } from '../../src/state.js'
import { makeFakeCcSwitch, addSkill, addMcp, type FakeHome } from './fakeCcSwitch.js'
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
  const helper = join(dir, 'apply.mjs')

  await writeFile(helper, `
import { DatabaseSync } from 'node:sqlite'
const [, , db, kind, id, apps] = process.argv
const list = (apps ?? '').split(',').filter(Boolean)
const ALL = ['claude','codex','gemini','opencode','hermes','grokbuild']
const d = new DatabaseSync(db)
const sets = ALL.map((a) => \`enabled_\${a} = \${list.includes(a) ? 1 : 0}\`).join(', ')
if (kind === 'skill') {
  const row = d.prepare('SELECT id FROM skills WHERE directory = ?').get(id)
  if (row === undefined) {
    d.prepare(\`INSERT INTO skills (id,name,directory,\${ALL.map((a)=>'enabled_'+a).join(',')}) VALUES (?,?,?,\${ALL.map((a)=>list.includes(a)?1:0).join(',')})\`)
      .run('local:' + id, id, id)
  } else {
    d.prepare(\`UPDATE skills SET \${sets} WHERE directory = ?\`).run(id)
  }
} else {
  d.prepare(\`UPDATE mcp_servers SET \${sets} WHERE id = ?\`).run(id)
}
d.close()
`)

  await writeFile(bin, `#!/bin/sh
DB=${JSON.stringify(home.db)}
HELPER=${JSON.stringify(helper)}
if [ -f "${join(dir, 'broken')}" ]; then echo "simulated cc-switch failure" >&2; exit 7; fi
case "$1 $2" in
  "skills import-from-apps") node "$HELPER" "$DB" skill "$3" "$5" ;;
  "skills set-apps")         node "$HELPER" "$DB" skill "$3" "$5" ;;
  "mcp set-apps")            node "$HELPER" "$DB" mcp   "$3" "$5" ;;
  "skills sync")             : ;;
  "deeplink "*)              : ;;
  *)                         : ;;
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
