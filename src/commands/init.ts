import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { run } from '../util/exec.js'
import { saveConfig } from '../config.js'
import { onePasswordProvider } from '../secrets/onepassword.js'
import { emitJson } from '../output.js'
import { answer, required } from '../prompt.js'
import type { Config } from '../config.js'
import type { Io } from '../output.js'

export interface GhHost { host: string; login: string; active: boolean }

export async function detectGhHosts(ghBin = 'gh'): Promise<GhHost[]> {
  const r = await run(ghBin, ['auth', 'status', '--json', 'hosts']).catch(() => null)
  if (r === null || r.code !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout) as {
      hosts: Record<string, { login: string; active: boolean }[]>
    }
    return Object.entries(parsed.hosts).flatMap(([host, accounts]) =>
      accounts.map((a) => ({ host, login: a.login, active: a.active })),
    )
  } catch {
    return []
  }
}

export async function ensureRepo(c: Config, ghBin = 'gh'): Promise<'created' | 'exists'> {
  const slug = `${c.owner}/${c.repo}`
  const view = await run(ghBin, ['repo', 'view', slug, '--json', 'name'], {
    env: { GH_HOST: c.host },
  })
  if (view.code === 0) return 'exists'

  const create = await run(ghBin, [
    'repo', 'create', slug, '--private',
    '--description', 'syncskills store — AI agent skills and MCP servers',
  ], { env: { GH_HOST: c.host } })
  if (create.code !== 0) {
    throw new Error(`could not create ${slug} on ${c.host}: ${create.stderr.trim()}`)
  }
  return 'created'
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Split `owner/name`, refusing anything else rather than guessing a half. */
export function parseRepoSlug(spec: string): { owner: string; repo: string } {
  const parts = spec.trim().split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`repository must be written as owner/name; got "${spec}"`)
  }
  return { owner: parts[0]!, repo: parts[1]! }
}

export async function runInit(opts: {
  configDir: string
  flags: Record<string, string | boolean>
  io: Io
}): Promise<Config> {
  const { flags, io } = opts
  const nonInteractive = io.json || flags.yes === true

  if (!io.json) p.intro(pc.bold('syncskills — set up this device'))

  const hosts = await detectGhHosts()
  if (hosts.length === 0) {
    const msg = 'no authenticated GitHub host found — run `gh auth login` first'
    if (!io.json) p.cancel(msg)
    throw new Error(msg)
  }

  const wantedHost = asString(flags.host)
  const chosen =
    wantedHost !== undefined
      ? hosts.find((h) => h.host === wantedHost && h.active) ??
        hosts.find((h) => h.host === wantedHost) ??
        hosts[0]!
      : hosts.length === 1 || nonInteractive
        ? hosts.find((h) => h.active) ?? hosts[0]!
        : answer<GhHost>(await p.select({
            message: 'Which GitHub host and account?',
            options: hosts.map((h) => ({
              value: h,
              label: `${h.host} — ${h.login}${h.active ? ' (active)' : ''}`,
            })),
          }))

  const repoAnswer =
    asString(flags.repo) ??
    (nonInteractive
      ? `${chosen.login}/syncskills`
      : answer<string>(await p.text({
          message: 'Repository to store skills and MCP servers',
          initialValue: `${chosen.login}/syncskills`,
          validate: required('a repository'),
        })))
  const { owner, repo } = parseRepoSlug(repoAnswer)

  const device =
    asString(flags.device) ??
    (nonInteractive
      ? hostname()
      : answer<string>(await p.text({
          message: 'Name for this device',
          initialValue: hostname(),
          validate: required('a device name'),
        })))

  const useSecrets = flags['no-secrets'] !== true
  let vault = 'agent'
  let token = ''

  if (useSecrets) {
    vault =
      asString(flags.vault) ??
      (nonInteractive
        ? 'agent'
        : answer<string>(await p.text({
            message: '1Password vault holding the secret item',
            initialValue: 'agent',
            validate: required('a vault name'),
          })))

    token =
      asString(process.env.SYNCSKILLS_OP_TOKEN) ??
      (nonInteractive
        ? ''
        : answer<string>(await p.password({
            message: '1Password service-account token (stored locally, mode 0600)',
          })))

    if (token === '') {
      const msg =
        'a 1Password service-account token is required; pass it in SYNCSKILLS_OP_TOKEN ' +
        'for a non-interactive setup, or run without --json to be prompted, ' +
        'or use --no-secrets'
      if (!io.json) p.cancel(msg)
      throw new Error(msg)
    }

    const check = await onePasswordProvider({ vault, item: 'syncskills', token }).check()
    if (!check.ok) {
      if (!io.json) p.cancel(`1Password check failed: ${check.detail}`)
      throw new Error(`1Password check failed: ${check.detail}`)
    }
    if (!io.json) p.log.success(check.detail)
  }

  const config: Config = {
    schemaVersion: 1,
    host: chosen.host,
    owner,
    repo,
    branch: 'main',
    device,
    vault,
    item: 'syncskills',
    secrets: useSecrets,
    excludes: [],
  }

  const state = await ensureRepo(config)
  if (!io.json) p.log.success(`repository ${owner}/${repo} ${state}`)

  await mkdir(opts.configDir, { recursive: true })
  await saveConfig(opts.configDir, config)
  if (useSecrets) {
    await writeFile(join(opts.configDir, 'op-token'), token, { mode: 0o600 })
  }

  if (io.json) {
    emitJson('init', { config, repository: state, configDir: opts.configDir }, io)
  } else {
    p.outro(`Ready. Run ${pc.bold('syncskills')} to sync.`)
  }
  return config
}
