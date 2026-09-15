import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  schemaVersion: 1
  /** github.com, or a GitHub Enterprise Server hostname */
  host: string
  owner: string
  repo: string
  branch: string
  /** Name recorded in the manifest for changes made from this machine */
  device: string
  /** 1Password vault holding the secret item */
  vault: string
  /** Title of the 1Password item holding the secret blob */
  item: string
  /** Whether to use 1Password at all */
  secrets: boolean
  /** Item ids never synced from this machine */
  excludes: string[]
  /**
   * An explicit git remote, used instead of building one from host/owner/repo.
   * Lets the store live on self-hosted git, an ssh remote, or a local path.
   */
  remote?: string
}

export function configDir(
  flags: { config?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (flags.config !== undefined && flags.config !== '') return flags.config
  if (env.ONESET_CONFIG_DIR) return env.ONESET_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'oneset')
  return join(env.HOME ?? homedir(), '.config', 'oneset')
}

export async function loadConfig(dir: string): Promise<Config | null> {
  const text = await readFile(join(dir, 'config.json'), 'utf8').catch(() => null)
  if (text === null) return null

  let parsed: Config
  try {
    parsed = JSON.parse(text) as Config
  } catch (e) {
    throw new Error(`${join(dir, 'config.json')} is not valid JSON: ${(e as Error).message}`)
  }

  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported config schema version ${parsed.schemaVersion} in ${join(dir, 'config.json')}; ` +
      `upgrade oneset`,
    )
  }
  return parsed
}

export async function saveConfig(dir: string, c: Config): Promise<void> {
  await mkdir(dir, { recursive: true })
  // Write then rename, so a crash mid-write cannot leave a half-parsed config.
  const tmp = join(dir, 'config.json.tmp')
  await writeFile(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, join(dir, 'config.json'))
}
