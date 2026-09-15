import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDatabaseSync } from '../../src/util/sqlite.js'

const DatabaseSync = loadDatabaseSync()

/**
 * A throwaway cc-switch home: the same schema the real one has, in a temp
 * directory. Tests never touch the user's actual database.
 */
export interface FakeHome { home: string; db: string; skillsDir: string }

export async function makeFakeCcSwitch(): Promise<FakeHome> {
  const home = await mkdtemp(join(tmpdir(), 'ss-cc-'))
  const skillsDir = join(home, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const db = join(home, 'cc-switch.db')

  const d = new DatabaseSync(db)
  d.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      directory TEXT NOT NULL, repo_owner TEXT, repo_name TEXT, repo_branch TEXT,
      readme_url TEXT,
      enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
      enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      enabled_hermes BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL,
      description TEXT, homepage TEXT, docs TEXT, tags TEXT NOT NULL DEFAULT '[]',
      enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
      enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
      enabled_hermes BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE skill_repos (
      owner TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main',
      enabled BOOLEAN NOT NULL DEFAULT 1, PRIMARY KEY (owner, name));
  `)
  d.close()
  return { home, db, skillsDir }
}

export async function addSkill(
  f: FakeHome, dir: string, body: string, apps: string[],
): Promise<void> {
  await mkdir(join(f.skillsDir, dir), { recursive: true })
  await writeFile(join(f.skillsDir, dir, 'SKILL.md'), body)
  addSkillRow(f, dir, apps)
}

/** Register a skill row without creating its directory on disk. */
export function addSkillRow(f: FakeHome, dir: string, apps: string[]): void {
  const d = new DatabaseSync(f.db)
  try {
    const cols = apps.map((a) => `enabled_${a}`)
    d.prepare(
      `INSERT INTO skills (id,name,directory${cols.length ? ',' + cols.join(',') : ''})
       VALUES (?,?,?${cols.map(() => ',1').join('')})`,
    ).run(`local:${dir}`, dir, dir)
  } finally {
    d.close()
  }
}

export function addMcp(f: FakeHome, id: string, config: unknown, apps: string[]): void {
  const d = new DatabaseSync(f.db)
  try {
    const cols = apps.map((a) => `enabled_${a}`)
    d.prepare(
      `INSERT INTO mcp_servers (id,name,server_config${cols.length ? ',' + cols.join(',') : ''})
       VALUES (?,?,?${cols.map(() => ',1').join('')})`,
    ).run(id, id, JSON.stringify(config))
  } finally {
    d.close()
  }
}

export function addRepo(
  f: FakeHome, owner: string, name: string, branch = 'main', enabled = true,
): void {
  const d = new DatabaseSync(f.db)
  try {
    d.prepare('INSERT INTO skill_repos (owner,name,branch,enabled) VALUES (?,?,?,?)')
      .run(owner, name, branch, enabled ? 1 : 0)
  } finally {
    d.close()
  }
}
