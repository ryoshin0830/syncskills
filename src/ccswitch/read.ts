import { loadDatabaseSync } from '../util/sqlite.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { APPS } from '../core/types.js'
import type { App, Side } from '../core/types.js'
import { treeHash, canonicalJsonHash } from '../core/hash.js'
import type { DatabaseSync } from 'node:sqlite'
import type { CcPaths } from './paths.js'

export interface SkillRow {
  id: string
  name: string
  description: string | null
  directory: string
  apps: App[]
}

export interface McpRow {
  id: string
  name: string
  config: Record<string, unknown>
  tags: string[]
  apps: App[]
}

export interface RepoRow {
  owner: string
  name: string
  branch: string
  enabled: boolean
}

/**
 * cc-switch's database is the single source of truth for which skills and MCP
 * servers exist and which harnesses they are enabled for. We only ever read it,
 * and only read-only: a stray write here would corrupt the user's setup.
 */
function open(p: CcPaths): DatabaseSync {
  if (!existsSync(p.db)) {
    throw new Error(
      `cc-switch database not found at ${p.db}. syncskills drives cc-switch and cannot ` +
      `run without it; install cc-switch and run it once, or point syncskills elsewhere ` +
      `with CC_SWITCH_CONFIG_DIR.`,
    )
  }
  const DatabaseSyncCtor = loadDatabaseSync()
  return new DatabaseSyncCtor(p.db, { readOnly: true })
}

/** Decode the enabled_<app> columns into the canonical APPS order. */
function appsOf(row: Record<string, unknown>): App[] {
  return APPS.filter((a) => Number(row[`enabled_${a}`] ?? 0) === 1)
}

export function readSkills(p: CcPaths): SkillRow[] {
  const db = open(p)
  try {
    const rows = db.prepare('SELECT * FROM skills ORDER BY directory')
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      description: r.description === null || r.description === undefined ? null : String(r.description),
      directory: String(r.directory),
      apps: appsOf(r),
    }))
  } finally {
    db.close()
  }
}

export function readMcp(p: CcPaths): McpRow[] {
  const db = open(p)
  try {
    const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY id')
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      config: JSON.parse(String(r.server_config)) as Record<string, unknown>,
      tags: JSON.parse(String(r.tags ?? '[]')) as string[],
      apps: appsOf(r),
    }))
  } finally {
    db.close()
  }
}

export function readRepos(p: CcPaths): RepoRow[] {
  const db = open(p)
  try {
    const rows = db.prepare('SELECT * FROM skill_repos ORDER BY owner, name')
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      owner: String(r.owner),
      name: String(r.name),
      branch: String(r.branch ?? 'main'),
      enabled: Number(r.enabled ?? 0) === 1,
    }))
  } finally {
    db.close()
  }
}

/**
 * Split an MCP config into a form safe to put in a git repository and the real
 * secret values, which go to 1Password instead.
 *
 * The key NAMES stay in the sanitized copy — they are part of the server's
 * shape and must sync — but every value is replaced by a marker. The content
 * hash is taken over the sanitized form, so rotating a credential does not look
 * like a configuration change and does not start a sync on every machine.
 */
export function stripSecrets(config: Record<string, unknown>): {
  sanitized: Record<string, unknown>
  secrets: Record<string, string>
} {
  const secrets: Record<string, string> = {}
  const sanitized: Record<string, unknown> = { ...config }

  const env = config.env
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    const marked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      secrets[k] = String(v)
      marked[k] = { secret: true }
    }
    sanitized.env = marked
  }

  return { sanitized, secrets }
}

export async function localSkillSides(p: CcPaths): Promise<Map<string, Side>> {
  const out = new Map<string, Side>()
  for (const row of readSkills(p)) {
    const dir = join(p.skillsDir, row.directory)
    // A row whose directory is gone is not content we can sync; the user
    // deleted it outside cc-switch, and the delete propagates as a normal
    // absence rather than an error.
    if (!existsSync(dir)) continue
    out.set(row.directory, { contentHash: await treeHash(dir), apps: row.apps })
  }
  return out
}

export function localMcpSides(p: CcPaths): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const row of readMcp(p)) {
    const { sanitized } = stripSecrets(row.config)
    out.set(row.id, {
      contentHash: canonicalJsonHash({ config: sanitized, tags: row.tags }),
      apps: row.apps,
      payload: { config: row.config, tags: row.tags },
    })
  }
  return out
}

/**
 * Directories sitting in the skills folder that cc-switch has no row for.
 * syncskills syncs what cc-switch manages, so these are skipped — but silently
 * skipping a directory the user can see is how trust is lost, so they are
 * reported instead. `cc-switch skills import-from-apps <dir>` adopts one.
 */
export function unmanagedSkills(p: CcPaths): string[] {
  if (!existsSync(p.skillsDir)) return []
  const managed = new Set(readSkills(p).map((r) => r.directory))
  return readdirSync(p.skillsDir, { withFileTypes: true })
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !managed.has(e.name))
    .map((e) => e.name)
    .sort()
}

export function localRepoSides(p: CcPaths): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const r of readRepos(p)) {
    out.set(`${r.owner}/${r.name}`, {
      contentHash: canonicalJsonHash({ branch: r.branch, enabled: r.enabled }),
      apps: [],
      payload: r,
    })
  }
  return out
}
