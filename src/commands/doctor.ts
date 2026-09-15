import pc from 'picocolors'
import { existsSync } from 'node:fs'
import { run } from '../util/exec.js'
import { loadDatabaseSync } from '../util/sqlite.js'
import { emitJson, line } from '../output.js'
import { onePasswordProvider } from '../secrets/onepassword.js'
import type { Config } from '../config.js'
import type { CcPaths } from '../ccswitch/paths.js'
import type { Io } from '../output.js'

export interface Check {
  name: string
  ok: boolean
  required: boolean
  detail: string
}

async function version(bin: string, args: string[]): Promise<string | null> {
  const r = await run(bin, args).catch(() => null)
  if (r === null || r.code !== 0) return null
  return (r.stdout + r.stderr).trim().split('\n')[0] ?? ''
}

export async function collectChecks(opts: {
  paths: CcPaths
  config: Config | null
  token?: string
}): Promise<Check[]> {
  const checks: Check[] = []

  checks.push({
    name: 'node',
    ok: true,
    required: true,
    detail: `${process.version} (>=22.13 required for node:sqlite)`,
  })

  try {
    loadDatabaseSync()
    checks.push({ name: 'node:sqlite', ok: true, required: true, detail: 'available' })
  } catch (e) {
    checks.push({ name: 'node:sqlite', ok: false, required: true, detail: (e as Error).message })
  }

  for (const [name, args, required] of [
    ['git', ['--version'], true],
    ['gh', ['--version'], true],
    ['cc-switch', ['--version'], true],
    ['op', ['--version'], false],
    ['claude', ['--version'], false],
    ['codex', ['--version'], false],
    ['expect', ['-v'], false],
  ] as [string, string[], boolean][]) {
    const v = await version(name, args)
    checks.push({
      name,
      ok: v !== null,
      required,
      detail: v ?? `not found on PATH${required ? '' : ' (optional)'}`,
    })
  }

  if (!existsSync(opts.paths.db)) {
    checks.push({
      name: 'cc-switch database',
      ok: false,
      required: true,
      detail: `not found at ${opts.paths.db}`,
    })
  } else {
    try {
      const DatabaseSync = loadDatabaseSync()
      const db = new DatabaseSync(opts.paths.db, { readOnly: true })
      try {
        const names = (db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table'",
        ).all() as { name: string }[]).map((r) => r.name)
        const missing = ['skills', 'mcp_servers', 'skill_repos'].filter((t) => !names.includes(t))
        checks.push({
          name: 'cc-switch database',
          ok: missing.length === 0,
          required: true,
          detail: missing.length === 0
            ? `${opts.paths.db} has the expected tables`
            : `missing tables: ${missing.join(', ')} — this cc-switch version may be unsupported`,
        })
      } finally {
        db.close()
      }
    } catch (e) {
      checks.push({
        name: 'cc-switch database', ok: false, required: true, detail: (e as Error).message,
      })
    }
  }

  if (opts.config === null) {
    checks.push({
      name: 'configuration', ok: false, required: true, detail: 'not initialized — run `syncskills init`',
    })
    return checks
  }

  checks.push({
    name: 'configuration',
    ok: true,
    required: true,
    detail: `${opts.config.host}/${opts.config.owner}/${opts.config.repo} as "${opts.config.device}"`,
  })

  const auth = await run('gh', ['auth', 'status', '--hostname', opts.config.host]).catch(() => null)
  checks.push({
    name: 'gh auth',
    ok: auth !== null && auth.code === 0,
    required: true,
    detail: auth !== null && auth.code === 0
      ? `authenticated for ${opts.config.host}`
      : `not authenticated for ${opts.config.host} — run \`gh auth login --hostname ${opts.config.host}\``,
  })

  if (opts.config.secrets) {
    if (opts.token === undefined || opts.token === '') {
      checks.push({
        name: '1Password',
        ok: false,
        required: false,
        detail: 'no service-account token stored — run `syncskills init` or pass --no-secrets',
      })
    } else {
      const c = await onePasswordProvider({
        vault: opts.config.vault, item: opts.config.item, token: opts.token,
      }).check()
      checks.push({ name: '1Password', ok: c.ok, required: false, detail: c.detail })
    }
  } else {
    checks.push({ name: '1Password', ok: true, required: false, detail: 'disabled in config' })
  }

  return checks
}

export async function doctorCommand(
  opts: { paths: CcPaths; config: Config | null; token?: string },
  io: Io,
): Promise<number> {
  const checks = await collectChecks(opts)
  const broken = checks.filter((c) => c.required && !c.ok)

  if (io.json) {
    emitJson('doctor', { checks, ok: broken.length === 0 }, io)
    return broken.length === 0 ? 0 : 1
  }

  line('', io)
  for (const c of checks) {
    const mark = c.ok ? pc.green('✓') : c.required ? pc.red('✗') : pc.yellow('!')
    line(`  ${mark} ${c.name.padEnd(20)} ${pc.dim(c.detail)}`, io)
  }
  line('', io)
  if (broken.length > 0) {
    line(pc.red(`${broken.length} required check(s) failed.`), io)
    return 1
  }
  line(pc.green('Ready to sync.'), io)
  return 0
}
