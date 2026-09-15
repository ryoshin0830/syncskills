import { existsSync } from 'node:fs'
import { run } from '../util/exec.js'
import { loadDatabaseSync } from '../util/sqlite.js'
import type { App } from '../core/types.js'
import type { CcPaths } from './paths.js'

/**
 * Build the deep link cc-switch accepts for importing an MCP server.
 *
 * The contract was established against the real binary: `config` must be
 * URL-safe Base64 of a JSON document containing an `mcpServers` object, then
 * URL-escaped. Passing raw JSON fails with a Base64 decode error, and `apps`
 * must name at least one application or the import is rejected.
 */
export function buildDeeplink(
  id: string,
  config: Record<string, unknown>,
  apps: App[],
): string {
  if (apps.length === 0) {
    throw new Error(`deeplink requires at least one app; cc-switch rejects an empty apps list`)
  }
  const doc = JSON.stringify({ mcpServers: { [id]: config } })
  const b64 = Buffer.from(doc, 'utf8').toString('base64url')
  const params = new URLSearchParams({ resource: 'mcp', apps: apps.join(','), config: b64 })
  return `ccswitch://v1/import?${params.toString()}`
}

export type DeleteOutcome = 'deleted' | 'pending'

export interface CcWriter {
  importMcp(id: string, config: Record<string, unknown>, apps: App[]): Promise<void>
  /**
   * Import a server whose env holds real credentials. The deep link carries the
   * shape with blank values — a URL becomes a command argument, and argv is
   * readable by other processes — and the values are written separately.
   */
  importMcpWithSecrets(
    id: string, config: Record<string, unknown>, env: Record<string, string>, apps: App[],
  ): Promise<DeleteOutcome>
  setMcpApps(id: string, apps: App[]): Promise<void>
  deleteMcp(id: string): Promise<DeleteOutcome>
  importSkill(dir: string, apps: App[]): Promise<void>
  setSkillApps(dir: string, apps: App[]): Promise<void>
  syncSkills(): Promise<void>
  addRepo(owner: string, name: string, branch: string, enabled: boolean): Promise<void>
  removeRepo(owner: string, name: string): Promise<void>
  /** Write an MCP server's credentials without going through a deep link. */
  repairMcpSecrets(id: string, env: Record<string, string>): Promise<DeleteOutcome>
  /** Why the last operation could not be completed, when it returned 'pending'. */
  lastPendingReason(): string | undefined
}

export function createWriter(opts: {
  bin?: string
  paths: CcPaths
  env?: Record<string, string>
  /**
   * How to tell whether cc-switch is live. Defaults to looking for the real
   * process; tests supply their own so the guard itself stays testable without
   * depending on what happens to be running on the machine.
   */
  isCcSwitchRunning?: () => Promise<boolean>
}): CcWriter {
  const bin = opts.bin ?? 'cc-switch'
  const env = { CC_SWITCH_TEST_DISABLE_OPEN: '1', ...opts.env }
  const isRunning = opts.isCcSwitchRunning ?? ccSwitchIsRunning

  let pendingReason: string | undefined

  /**
   * cc-switch's import paths refuse an empty app list, but "enabled nowhere" is
   * a state the user can reach in its own UI and must therefore be able to
   * travel. The row is created with one harness on and the matrix is cleared
   * afterwards — the order matters, because the import is what creates the row.
   */
  function seedApps(apps: App[]): App[] {
    return apps.length === 0 ? [SEED_APP] : apps
  }

  async function zeroMatrix(
    table: 'skills' | 'mcp_servers', keyColumn: string, key: string,
  ): Promise<void> {
    const ok = await zeroAppMatrix(opts.paths, table, keyColumn, key, isRunning)
      .catch((e: Error) => {
        pendingReason = e.message
        return false
      })
    if (!ok) throw new Error(pendingReason ?? `could not disable "${key}" everywhere`)
  }

  async function putMcpApps(id: string, apps: App[]): Promise<void> {
    // cc-switch refuses an empty list ("Please provide at least one app"),
    // so disabling the last harness has to go through the database.
    if (apps.length === 0) return zeroMatrix('mcp_servers', 'id', id)
    await cc(['mcp', 'set-apps', id, '--apps', apps.join(',')], 'mcp set-apps')
  }

  async function putSkillApps(dir: string, apps: App[]): Promise<void> {
    if (apps.length === 0) return zeroMatrix('skills', 'directory', dir)
    await cc(['skills', 'set-apps', dir, '--apps', apps.join(',')], 'skills set-apps')
  }

  async function removeMcp(id: string): Promise<DeleteOutcome> {
    pendingReason = undefined
    if (await ptyDelete(bin, id, env).catch(() => false)) return 'deleted'
    // Keep the reason rather than swallowing it: "cc-switch is running" is
    // something the user can act on, and 'pending' alone is not.
    const ok = await directDelete(bin, id, opts.paths, env, isRunning).catch((e: Error) => {
      pendingReason = e.message
      return false
    })
    if (ok) return 'deleted'
    pendingReason ??= `could not delete "${id}"; is expect(1) installed?`
    return 'pending'
  }

  async function cc(args: string[], what: string): Promise<void> {
    const r = await run(bin, args, { env })
    if (r.code !== 0) {
      throw new Error(
        `cc-switch ${what} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
      )
    }
  }

  return {
    async importMcp(id, config, apps) {
      await cc(['deeplink', buildDeeplink(id, config, seedApps(apps))], 'deeplink import')
      if (apps.length === 0) await putMcpApps(id, apps)
    },

    async importMcpWithSecrets(id, config, env, apps) {
      const existed = mcpExists(opts.paths, id)

      const blanked: Record<string, unknown> = { ...config }
      if (config.env !== null && typeof config.env === 'object' && !Array.isArray(config.env)) {
        blanked.env = Object.fromEntries(Object.keys(config.env).map((k) => [k, '']))
      }

      // The deep link is additive: for a server that already exists it adds
      // apps and leaves server_config untouched, so it cannot carry an updated
      // configuration. Removing it first is the supported way to replace one,
      // and it keeps working while the cc-switch app is open.
      if (existed) {
        const removed = await removeMcp(id)
        if (removed === 'pending') return 'pending'
      }

      await cc(['deeplink', buildDeeplink(id, blanked, seedApps(apps))], 'deeplink import')

      // set-apps replaces the matrix outright, which the additive import cannot
      // do — without this a harness disabled elsewhere is never disabled here,
      // and a server disabled everywhere keeps the seed harness it was created
      // with. Reported as pending rather than thrown: the row exists now, so
      // the next run must see the real state rather than a recorded base.
      try {
        await putMcpApps(id, apps)
      } catch (e) {
        pendingReason = (e as Error).message
        return 'pending'
      }

      // Credentials are the one thing that cannot travel through a deep link
      // without landing on a command line, so they go through the database.
      const hasSecrets = Object.values(env).some((v) => v !== '')
      if (!hasSecrets) return 'deleted'

      const ok = await writeMcpConfig(opts.paths, id, config, isRunning).catch((e: Error) => {
        pendingReason = e.message
        return false
      })
      if (ok) return 'deleted'
      pendingReason ??= `could not store the credentials for "${id}"`
      return 'pending'
    },

    async repairMcpSecrets(id, envValues) {
      pendingReason = undefined
      const ok = await writeMcpEnvOnly(opts.paths, id, envValues, isRunning).catch((e: Error) => {
        pendingReason = e.message
        return false
      })
      if (ok) return 'deleted'
      pendingReason ??= `could not store the credentials for "${id}"`
      return 'pending'
    },

    lastPendingReason: () => pendingReason,

    setMcpApps: putMcpApps,

    async importSkill(dir, apps) {
      await cc(
        ['skills', 'import-from-apps', dir, '--apps', seedApps(apps).join(',')],
        'skills import-from-apps',
      )
      if (apps.length === 0) await putSkillApps(dir, apps)
    },

    setSkillApps: putSkillApps,

    async syncSkills() {
      await cc(['skills', 'sync'], 'skills sync')
    },

    async addRepo(owner, name, branch, enabled) {
      const spec = branch === '' || branch === 'main' ? `${owner}/${name}` : `${owner}/${name}@${branch}`
      await cc(['skills', 'repos', 'add', spec], 'skills repos add')
      await cc(
        ['skills', 'repos', enabled ? 'enable' : 'disable', `${owner}/${name}`],
        `skills repos ${enabled ? 'enable' : 'disable'}`,
      )
    },

    async removeRepo(owner, name) {
      await cc(['skills', 'repos', 'remove', `${owner}/${name}`], 'skills repos remove')
    },

    /**
     * `cc-switch mcp delete` prompts for confirmation, rejects piped stdin, and
     * offers no flag to skip the prompt. Three strategies in order: answer the
     * prompt under a pseudo-terminal, delete the row directly with cc-switch
     * stopped, or report the deletion as awaiting the user.
     */
    deleteMcp: removeMcp,
  }
}

/** The harness an item is created under when it is meant to be enabled nowhere. */
const SEED_APP: App = 'claude'

const APP_COLUMNS = [
  'enabled_claude', 'enabled_codex', 'enabled_gemini',
  'enabled_opencode', 'enabled_hermes', 'enabled_grokbuild',
]

export async function ccSwitchIsRunning(): Promise<boolean> {
  const ps = await run('pgrep', ['-f', 'cc-switch|ccswitch'])
  return ps.code === 0 && ps.stdout.trim().length > 0
}

async function guardCcSwitchStopped(
  isRunning: () => Promise<boolean>, what: string,
): Promise<void> {
  if (await isRunning()) {
    throw new Error(
      `cc-switch is running, so ${what} was not applied. ` +
      `Quit cc-switch and sync again, or make the change in cc-switch yourself.`,
    )
  }
}

/** Disable an item for every harness — a state cc-switch's CLI cannot express. */
async function zeroAppMatrix(
  p: CcPaths, table: 'skills' | 'mcp_servers', keyColumn: string, key: string,
  isRunning: () => Promise<boolean>,
): Promise<boolean> {
  if (!existsSync(p.db)) return false
  await guardCcSwitchStopped(isRunning, `disabling "${key}" everywhere`)

  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(p.db)
  try {
    const sets = APP_COLUMNS.map((c) => `${c} = 0`).join(', ')
    db.exec('BEGIN')
    db.prepare(`UPDATE ${table} SET ${sets} WHERE ${keyColumn} = ?`).run(key)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return true
}

/** Merge real environment values into a server that already has the right shape. */
async function writeMcpEnvOnly(
  p: CcPaths, id: string, envValues: Record<string, string>,
  isRunning: () => Promise<boolean>,
): Promise<boolean> {
  if (!existsSync(p.db)) return false
  await guardCcSwitchStopped(isRunning, `the credentials for "${id}"`)

  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(p.db)
  try {
    const row = db.prepare('SELECT server_config FROM mcp_servers WHERE id = ?').get(id) as
      { server_config?: string } | undefined
    if (row?.server_config === undefined) return false

    const config = JSON.parse(row.server_config) as Record<string, unknown>
    const current = (config.env ?? {}) as Record<string, string>
    config.env = { ...current, ...envValues }

    db.exec('BEGIN')
    db.prepare('UPDATE mcp_servers SET server_config = ? WHERE id = ?')
      .run(JSON.stringify(config), id)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  return true
}

function mcpExists(p: CcPaths, id: string): boolean {
  if (!existsSync(p.db)) return false
  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(p.db, { readOnly: true })
  try {
    return db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(id) !== undefined
  } finally {
    db.close()
  }
}

/**
 * Write an MCP server's whole configuration, credentials included.
 *
 * The deep link cannot update an existing server, and cc-switch offers no
 * non-interactive way to set one that avoids putting the value on a command
 * line. So this edits server_config directly, under the same guard as the
 * delete fallback: refuse while cc-switch is running, one transaction,
 * integrity checked afterwards.
 */
async function writeMcpConfig(
  p: CcPaths, id: string, config: Record<string, unknown>,
  isRunning: () => Promise<boolean>,
): Promise<boolean> {
  if (!existsSync(p.db)) return false
  await guardCcSwitchStopped(isRunning, `the change to "${id}"`)

  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(p.db)
  try {
    if (db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(id) === undefined) return false

    db.exec('BEGIN')
    db.prepare('UPDATE mcp_servers SET server_config = ? WHERE id = ?')
      .run(JSON.stringify(config), id)
    db.exec('COMMIT')

    const check = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>
    const verdict = String(Object.values(check)[0])
    if (verdict !== 'ok') throw new Error(`database integrity check failed: ${verdict}`)
  } finally {
    db.close()
  }
  return true
}

/** Answer cc-switch's confirmation prompt through expect(1). */
async function ptyDelete(
  bin: string, id: string, env: Record<string, string>,
): Promise<boolean> {
  // bin and id reach a Tcl interpreter, so they are passed as argv rather than
  // interpolated into the script text.
  const script = `set timeout 30
set prog [lindex $argv 0]
set target [lindex $argv 1]
spawn $prog mcp delete $target
expect {
  -re {\\(y/N\\)} { send "y\\r"; exp_continue }
  eof
}`
  // `expect - a b` would read "a" as a script file; `--` ends option parsing so
  // the script still comes from stdin and the rest lands in $argv.
  const r = await run('expect', ['--', '-', bin, id], { input: script, env })
  return r.code === 0 && /Deleted MCP server/.test(r.stdout)
}

/**
 * Last resort: remove the row ourselves. Guarded, because writing to a database
 * another process owns is how data gets corrupted — refuse while cc-switch is
 * running, wrap the delete in a transaction, and verify integrity afterwards.
 */
async function directDelete(
  _bin: string, id: string, p: CcPaths, _env: Record<string, string>,
  isRunning: () => Promise<boolean>,
): Promise<boolean> {
  if (!existsSync(p.db)) return false
  await guardCcSwitchStopped(isRunning, `deleting "${id}"`)

  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(p.db)
  try {
    const present = db.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(id)
    // Reporting a delete that matched nothing would let the caller record a
    // base saying the server is gone while it is still there.
    if (present === undefined) return false

    db.exec('BEGIN')
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    db.exec('COMMIT')
    const check = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>
    const verdict = String(Object.values(check)[0])
    if (verdict !== 'ok') throw new Error(`database integrity check failed after delete: ${verdict}`)
  } finally {
    db.close()
  }
  return true
}
