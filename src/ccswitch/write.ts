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
  setMcpApps(id: string, apps: App[]): Promise<void>
  deleteMcp(id: string): Promise<DeleteOutcome>
  importSkill(dir: string, apps: App[]): Promise<void>
  setSkillApps(dir: string, apps: App[]): Promise<void>
  syncSkills(): Promise<void>
}

export function createWriter(opts: {
  bin?: string
  paths: CcPaths
  env?: Record<string, string>
}): CcWriter {
  const bin = opts.bin ?? 'cc-switch'
  const env = { CC_SWITCH_TEST_DISABLE_OPEN: '1', ...opts.env }

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
      await cc(['deeplink', buildDeeplink(id, config, apps)], 'deeplink import')
    },

    async setMcpApps(id, apps) {
      await cc(['mcp', 'set-apps', id, '--apps', apps.join(',')], 'mcp set-apps')
    },

    async importSkill(dir, apps) {
      await cc(['skills', 'import-from-apps', dir, '--apps', apps.join(',')], 'skills import-from-apps')
    },

    async setSkillApps(dir, apps) {
      await cc(['skills', 'set-apps', dir, '--apps', apps.join(',')], 'skills set-apps')
    },

    async syncSkills() {
      await cc(['skills', 'sync'], 'skills sync')
    },

    /**
     * `cc-switch mcp delete` prompts for confirmation, rejects piped stdin, and
     * offers no flag to skip the prompt. Three strategies in order: answer the
     * prompt under a pseudo-terminal, delete the row directly with cc-switch
     * stopped, or report the deletion as awaiting the user.
     */
    async deleteMcp(id) {
      if (await ptyDelete(bin, id, env).catch(() => false)) return 'deleted'
      if (await directDelete(bin, id, opts.paths, env).catch(() => false)) return 'deleted'
      return 'pending'
    },
  }
}

/** Answer cc-switch's confirmation prompt through expect(1). */
async function ptyDelete(
  bin: string, id: string, env: Record<string, string>,
): Promise<boolean> {
  const script = `set timeout 30
spawn ${bin} mcp delete ${id}
expect {
  -re {\\(y/N\\)} { send "y\\r"; exp_continue }
  eof
}`
  const r = await run('expect', ['-'], { input: script, env })
  return r.code === 0 && /Deleted MCP server/.test(r.stdout)
}

/**
 * Last resort: remove the row ourselves. Guarded, because writing to a database
 * another process owns is how data gets corrupted — refuse while cc-switch is
 * running, wrap the delete in a transaction, and verify integrity afterwards.
 */
async function directDelete(
  _bin: string, id: string, p: CcPaths, _env: Record<string, string>,
): Promise<boolean> {
  if (!existsSync(p.db)) return false

  const ps = await run('pgrep', ['-f', 'cc-switch|ccswitch'])
  if (ps.code === 0 && ps.stdout.trim().length > 0) {
    throw new Error(
      'cc-switch is running; refusing to write to its database directly. ' +
      'Quit cc-switch and run syncskills again, or delete the server in cc-switch yourself.',
    )
  }

  const DatabaseSync = loadDatabaseSync()
  const db = new DatabaseSync(p.db)
  try {
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
