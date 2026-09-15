import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { resolveAll } from './core/resolve.js'
import { buildPlan } from './core/plan.js'
import { applyPlan } from './core/apply.js'
import { createGitStore } from './store/git.js'
import { manifestSides } from './store/manifest.js'
import { createWriter } from './ccswitch/write.js'
import { localSkillSides, localMcpSides, localRepoSides } from './ccswitch/read.js'
import { loadState, saveState } from './state.js'
import { nullProvider, emptyBlob } from './secrets/provider.js'
import { onePasswordProvider } from './secrets/onepassword.js'
import type { ItemKind, Resolution, Side } from './core/types.js'
import type { Config } from './config.js'
import type { CcPaths } from './ccswitch/paths.js'
import type { Plan, Action } from './core/plan.js'
import type { ApplyResult } from './core/apply.js'
import type { GitStore } from './store/git.js'
import type { Manifest } from './store/manifest.js'
import type { StateFile } from './state.js'
import type { SecretBlob, SecretProvider } from './secrets/provider.js'

export type Direction = 'both' | 'push' | 'pull'

const OUTBOUND = new Set(['push-content', 'delete-remote'])
const INBOUND = new Set(['pull-content', 'delete-local'])

/**
 * Narrow a plan to one direction. The resolver is untouched, so every safety
 * property still holds; push and pull simply decline to carry out the half of
 * the plan they are not responsible for. Conflicts are reported in every mode.
 */
export function narrowByDirection(plan: Plan, direction: Direction): Plan {
  if (direction === 'both') return plan
  const keep = direction === 'push' ? OUTBOUND : INBOUND
  return {
    ...plan,
    actions: plan.actions.filter((a) => keep.has(a.type) || a.type === 'set-apps'),
  }
}

export interface EngineOptions {
  configDir: string
  config: Config
  paths: CcPaths
  only?: ItemKind[]
  mergeAgent: 'claude' | 'codex' | 'none' | 'auto'
  useSecrets: boolean
  dryRun: boolean
  direction: Direction
  token?: string
  /** Point the store at a local path instead of the configured host. Tests only. */
  remoteOverride?: string
  /** Use a different cc-switch binary. Tests only. */
  ccBin?: string
}

const ALL_KINDS: ItemKind[] = ['skill', 'mcp', 'repo']

export async function readToken(configDir: string): Promise<string | undefined> {
  const t = await readFile(join(configDir, 'op-token'), 'utf8').catch(() => null)
  return t === null ? undefined : t.trim()
}

export interface Gathered {
  resolutions: Resolution[]
  store: GitStore
  manifest: Manifest
  state: StateFile
  blob: SecretBlob
  secrets: SecretProvider
}

export async function gather(opts: EngineOptions): Promise<Gathered> {
  const store = createGitStore({
    cacheDir: join(opts.configDir, 'cache'),
    config: opts.config,
    ...(opts.remoteOverride === undefined ? {} : { remoteOverride: opts.remoteOverride }),
  })
  await store.ensure()

  const manifest = await store.readManifest()
  const state = await loadState(opts.configDir)

  const secrets: SecretProvider =
    opts.useSecrets && opts.token !== undefined && opts.token !== ''
      ? onePasswordProvider({ vault: opts.config.vault, item: opts.config.item, token: opts.token })
      : nullProvider()
  const blob = await secrets.read().catch(() => emptyBlob())

  const kinds = opts.only ?? ALL_KINDS
  const excluded = new Set(opts.config.excludes)
  const resolutions: Resolution[] = []

  for (const kind of kinds) {
    const local =
      kind === 'skill' ? await localSkillSides(opts.paths)
      : kind === 'mcp' ? localMcpSides(opts.paths)
      : localRepoSides(opts.paths)

    const base = new Map<string, Side>(
      Object.entries(state.items)
        .filter(([k]) => k.startsWith(`${kind}:`))
        .map(([k, v]) => [k.slice(kind.length + 1), v] as const),
    )

    for (const r of resolveAll(base, local, manifestSides(manifest, kind), kind)) {
      if (excluded.has(r.id) || excluded.has(`${kind}:${r.id}`)) continue
      resolutions.push(r)
    }
  }

  return { resolutions, store, manifest, state, blob, secrets }
}

export interface SyncOutcome {
  plan: Plan
  result: ApplyResult
  unresolved: Action[]
  pushed: boolean
}

export async function runSync(opts: EngineOptions): Promise<SyncOutcome> {
  const { resolutions, store, manifest, state, blob, secrets } = await gather(opts)
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)

  const writer = createWriter({
    paths: opts.paths,
    ...(opts.ccBin === undefined ? {} : { bin: opts.ccBin }),
  })
  const result = await applyPlan(plan, {
    paths: opts.paths, writer, store, manifest, state, secrets, blob,
    device: opts.config.device, configDir: opts.configDir, dryRun: opts.dryRun,
  })

  let pushed = false
  if (!opts.dryRun && result.failed.length === 0) {
    // Order matters, and secrets come first. If the push landed and the secret
    // write then failed, the next run would see local === remote, decide
    // IN_SYNC, and never retry — leaving the other devices to rehydrate an
    // empty credential from a blob that was never written. Publishing the
    // manifest only after the secrets it refers to are safely stored means a
    // failure here simply leaves the remote unchanged.
    if (opts.useSecrets) await secrets.write(blob)
    await store.writeManifest(manifest)
    pushed = await store.commitAndPush(
      `sync from ${opts.config.device} (${result.applied.length} change(s))`,
    )
    await saveState(opts.configDir, state)
  }

  return { plan, result, unresolved: plan.conflicts, pushed }
}
