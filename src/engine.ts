import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { resolveAll } from './core/resolve.js'
import { buildPlan } from './core/plan.js'
import { applyPlan } from './core/apply.js'
import { createGitStore } from './store/git.js'
import { manifestSides } from './store/manifest.js'
import { createWriter } from './ccswitch/write.js'
import { localSkillSides, localMcpSides, localRepoSides, readMcp } from './ccswitch/read.js'
import { loadState, saveState } from './state.js'
import { nullProvider, emptyBlob } from './secrets/provider.js'
import { onePasswordProvider } from './secrets/onepassword.js'
import { isSafeItemId } from './core/types.js'
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

// A matrix-only change has a direction of its own, held separately from the
// content decision. Without consulting it, `push` would take the remote's
// enablement and `pull` would publish this machine's.
const APPS_OUTBOUND = new Set(['PUSH', 'PUSH_NEW', 'DELETE_REMOTE'])
const APPS_INBOUND = new Set(['PULL', 'PULL_NEW', 'DELETE_LOCAL'])

/**
 * Narrow a plan to one direction. The resolver is untouched, so every safety
 * property still holds; push and pull simply decline to carry out the half of
 * the plan they are not responsible for. Conflicts are reported in every mode,
 * and so is a matrix both sides moved: merging one is bidirectional by nature,
 * which is exactly what a one-way run is asking not to do.
 */
export function narrowByDirection(plan: Plan, direction: Direction): Plan {
  if (direction === 'both') return plan
  const keep = direction === 'push' ? OUTBOUND : INBOUND
  const keepApps = direction === 'push' ? APPS_OUTBOUND : APPS_INBOUND
  return {
    ...plan,
    actions: plan.actions.filter((a) =>
      a.type === 'set-apps' ? keepApps.has(a.resolution.appsDecision) : keep.has(a.type),
    ),
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
  /** Override how the cc-switch process is detected. Tests only. */
  isCcSwitchRunning?: () => Promise<boolean>
}

const ALL_KINDS: ItemKind[] = ['skill', 'mcp', 'repo']

export async function readToken(configDir: string): Promise<string | undefined> {
  const t = await readFile(join(configDir, 'op-token'), 'utf8').catch(() => null)
  return t === null ? undefined : t.trim()
}

export interface Gathered {
  resolutions: Resolution[]
  /** Local ids refused as unsafe to use as a path. Reported, never synced. */
  unsafeLocalIds: string[]
  /**
   * Servers whose credentials 1Password holds but this machine does not.
   * Env values are excluded from the content hash — deliberately, so rotating a
   * key is not a config change — which means a credential that failed to write
   * leaves a server that looks identical to the remote and would never be
   * retried. This is detected separately, from the values themselves.
   */
  staleSecrets: { id: string; env: Record<string, string> }[]
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
  const unsafeLocalIds: string[] = []

  for (const kind of kinds) {
    const local =
      kind === 'skill' ? await localSkillSides(opts.paths)
      : kind === 'mcp' ? localMcpSides(opts.paths)
      : localRepoSides(opts.paths)

    // An id that cannot safely become a path is refused on the way OUT as well
    // as the way in. Pushing one the other machines will then refuse to pull
    // would be worse than not syncing it: the two sides would disagree forever
    // with nothing to show for it.
    for (const id of [...local.keys()]) {
      if (isSafeItemId(kind, id)) continue
      unsafeLocalIds.push(`${kind}:${id}`)
      local.delete(id)
    }

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

  const staleSecrets: { id: string; env: Record<string, string> }[] = []
  if (kinds.includes('mcp')) {
    for (const row of readMcp(opts.paths)) {
      const stored = blob.mcp[row.id]?.env
      if (stored === undefined) continue
      const live = (row.config.env ?? {}) as Record<string, unknown>
      const missing: Record<string, string> = {}
      for (const [k, v] of Object.entries(stored)) {
        if (v !== '' && String(live[k] ?? '') === '') missing[k] = v
      }
      if (Object.keys(missing).length > 0) staleSecrets.push({ id: row.id, env: missing })
    }
  }

  return { resolutions, store, manifest, state, blob, secrets, unsafeLocalIds, staleSecrets }
}

export interface SyncOutcome {
  plan: Plan
  result: ApplyResult
  unresolved: Action[]
  pushed: boolean
  /** Credentials this run restored, and ones it could not. */
  secretsRepaired: string[]
  secretsPending: { id: string; reason: string }[]
  /** Servers left holding an env key with no value; see blankCredentials(). */
  blankCredentials: { id: string; keys: string[] }[]
}

/**
 * Servers whose configuration names an environment key but has nothing to put
 * in it. With `--no-secrets` this is the normal outcome of a pull — the key
 * names travel through git, the values do not — and the server that results
 * will start and fail. It is a credential, so it cannot be fixed silently; it
 * can only be reported.
 */
export function blankCredentials(paths: CcPaths): { id: string; keys: string[] }[] {
  const out: { id: string; keys: string[] }[] = []
  for (const row of readMcp(paths)) {
    const env = (row.config.env ?? {}) as Record<string, unknown>
    if (env === null || typeof env !== 'object') continue
    const keys = Object.keys(env).filter((k) => String(env[k] ?? '') === '').sort()
    if (keys.length > 0) out.push({ id: row.id, keys })
  }
  return out
}

export async function runSync(opts: EngineOptions): Promise<SyncOutcome> {
  const { resolutions, store, manifest, state, blob, secrets, staleSecrets } = await gather(opts)
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)

  const writer = createWriter({
    paths: opts.paths,
    ...(opts.ccBin === undefined ? {} : { bin: opts.ccBin }),
    ...(opts.isCcSwitchRunning === undefined ? {} : { isCcSwitchRunning: opts.isCcSwitchRunning }),
  })
  const result = await applyPlan(plan, {
    paths: opts.paths, writer, store, manifest, state, secrets, blob,
    device: opts.config.device, configDir: opts.configDir, dryRun: opts.dryRun,
  })

  // Restore any credential 1Password holds that this machine is missing. A
  // blank one is invisible to the content hash, so nothing else would retry it.
  const secretsRepaired: string[] = []
  const secretsPending: { id: string; reason: string }[] = []
  if (!opts.dryRun && opts.useSecrets) {
    for (const stale of staleSecrets) {
      const outcome = await writer.repairMcpSecrets(stale.id, stale.env)
      if (outcome === 'deleted') secretsRepaired.push(stale.id)
      else {
        secretsPending.push({
          id: stale.id,
          reason: writer.lastPendingReason() ?? 'unknown reason',
        })
      }
    }
  }

  let pushed = false
  if (!opts.dryRun) {
    // Publish what did land, even when something else failed. Every action
    // records its own base and its own manifest entry, so a partial plan is
    // still a consistent one — and withholding the manifest because of one
    // permanently failing item would freeze every other item with it.
    //
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

  // Read after the repair pass, so a value 1Password just restored is not
  // reported as missing.
  const blanks = opts.dryRun ? [] : blankCredentials(opts.paths)

  return {
    plan, result, unresolved: plan.conflicts, pushed,
    secretsRepaired, secretsPending, blankCredentials: blanks,
  }
}
