import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { resolveAll } from './core/resolve.js'
import { buildPlan, takeSide } from './core/plan.js'
import { applyPlan } from './core/apply.js'
import { createGitStore, PushRejected } from './store/git.js'
import { dropBaseTree } from './basetree.js'
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
  const actions = plan.actions.filter((a) =>
    a.type === 'set-apps' ? keepApps.has(a.resolution.appsDecision) : keep.has(a.type),
  )
  // Recounted, not carried over. `counts` is what `--json` reports and what the
  // interface summarises, so leaving the pre-narrowing numbers there told a
  // script that `push` had pulls to make.
  const counts = { ...plan.counts }
  for (const t of Object.keys(counts) as (keyof typeof counts)[]) {
    if (t === 'merge' || t === 'noop') continue
    counts[t] = 0
  }
  for (const a of actions) counts[a.type]++
  return { ...plan, actions, counts }
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
  /** Use a different credential store instead of 1Password. Tests only. */
  secretProvider?: SecretProvider
  /**
   * Settle conflicts by taking a side instead of reporting them. The
   * interactive interface asks the user; this is the same decision made without
   * one, which is what lets it be tested without a terminal.
   */
  resolveConflict?: (action: Action) => 'local' | 'remote' | 'skip'
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
  /**
   * Why the credential store could not be read, when it could not be.
   *
   * `blob` is empty in that case, and an empty blob is indistinguishable from
   * "there are no credentials" — which is why this is reported separately
   * rather than inferred. Writing an unread blob back would replace every
   * stored credential with nothing, and env values are excluded from the
   * content hash, so no later run would notice or retry.
   */
  secretsUnreadable?: string
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
    opts.secretProvider ??
    (opts.useSecrets && opts.token !== undefined && opts.token !== ''
      ? onePasswordProvider({ vault: opts.config.vault, item: opts.config.item, token: opts.token })
      : nullProvider())
  // A read that fails is not a read that returned nothing. The distinction is
  // kept rather than flattened, because the caller has to refuse to write.
  let secretsUnreadable: string | undefined
  const blob = await secrets.read().catch((e: unknown) => {
    // Never `e.message` alone: a rejection that is not an Error has none, and a
    // reason of `undefined` reads as "the store was fine" — which is exactly
    // the wipe this guard exists to prevent.
    const why = e instanceof Error ? e.message : String(e)
    secretsUnreadable = why === '' ? 'the credential store rejected the read' : why
    return emptyBlob()
  })

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

  return {
    resolutions, store, manifest, state, blob, secrets, unsafeLocalIds, staleSecrets,
    ...(secretsUnreadable === undefined ? {} : { secretsUnreadable }),
  }
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
  /**
   * Set when another device published first and this run's changes stayed
   * local. Not an exception: the local half of the work is real and has to be
   * reported, and the run is repeatable as it stands.
   */
  pushRejected?: string
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

/**
 * Refuse to go on when the credential store answered with an error.
 *
 * Everything downstream treats `blob` as the truth: a pull rehydrates an MCP
 * server's env from it, and the publish step writes it back whole. Both of
 * those turn "1Password was briefly unreachable" into "every credential on
 * every machine is gone", silently, because env values are deliberately
 * outside the content hash and so nothing would ever retry.
 */
export function assertSecretsReadable(opts: EngineOptions, g: Gathered): void {
  if (!opts.useSecrets || g.secretsUnreadable === undefined) return
  // Only MCP servers own a credential. A skills-or-repos-only run has nothing
  // to rehydrate and nothing to store, which is why the message below can offer
  // it as the way to keep working; writing the blob is skipped there too.
  if (!(opts.only ?? ALL_KINDS).includes('mcp')) return
  throw new Error(
    `could not read the credential store: ${g.secretsUnreadable}. ` +
    `Nothing was changed. Syncing now would overwrite the stored credentials ` +
    `with nothing, so this run stops here; fix the store and try again, or ` +
    `sync the rest meanwhile with \`--only skills,repo\`.`,
  )
}

/**
 * A one-way run may not settle conflicts.
 *
 * narrowByDirection leaves `plan.conflicts` alone on purpose: resolving one is
 * bidirectional by nature, which is exactly what `push` and `pull` are asking
 * not to do. Converting a conflict to an action afterwards would put the
 * declined half of the plan back, unchecked, so the combination is refused
 * rather than silently narrowed a second time.
 */
export function assertConflictResolutionAllowed(opts: EngineOptions): void {
  if (opts.resolveConflict === undefined || opts.direction === 'both') return
  throw new Error(
    `conflicts cannot be settled in a one-way run: taking a side is bidirectional, ` +
    `and \`${opts.direction}\` declined half the plan. Run a full sync instead.`,
  )
}

export async function runSync(opts: EngineOptions): Promise<SyncOutcome> {
  assertConflictResolutionAllowed(opts)
  const gathered = await gather(opts)
  assertSecretsReadable(opts, gathered)
  const {
    resolutions, store, manifest, state, blob, secrets, staleSecrets, secretsUnreadable,
  } = gathered
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)

  if (opts.resolveConflict !== undefined) {
    const settled: Action[] = []
    for (const c of plan.conflicts) {
      const side = opts.resolveConflict(c)
      if (side === 'skip') continue
      takeSide(plan, c, side)
      settled.push(c)
    }
    plan.conflicts = plan.conflicts.filter((c) => !settled.includes(c))
  }

  const writer = createWriter({
    paths: opts.paths,
    ...(opts.ccBin === undefined ? {} : { bin: opts.ccBin }),
    ...(opts.isCcSwitchRunning === undefined ? {} : { isCcSwitchRunning: opts.isCcSwitchRunning }),
  })
  const result = await applyPlan(plan, {
    paths: opts.paths, writer, store, manifest, state, secrets, blob,
    device: opts.config.device, configDir: opts.configDir, dryRun: opts.dryRun,
    secretsToDrop: [],
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
  let pushRejected: string | undefined
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
    // Never a blob that was not read: the guard above lets a skills-only run
    // through, and an empty blob written there would still destroy every stored
    // credential. Belt as well as braces, because the cost is unrecoverable.
    if (opts.useSecrets && secretsUnreadable === undefined) await secrets.write(blob)
    await store.writeManifest(manifest)
    try {
      pushed = await store.commitAndPush(
        `sync from ${opts.config.device} (${result.applied.length} change(s))`,
      )
      await saveState(opts.configDir, state)
      await dropStoredSecrets(opts, secrets, blob, result.secretsToDrop, secretsUnreadable)
    } catch (e) {
      if (!(e instanceof PushRejected)) throw e
      pushRejected = e.message
      // state.json stays as it was, deliberately. Recording a base for an item
      // whose content never reached the store would make the next run read
      // "local matches base, remote has nothing" as a deletion and remove it.
      //
      // The base trees written during apply need no compensation here: each one
      // carries the hash it was saved for and is only offered when state.json
      // still agrees, so one this run wrote is already invisible. Deleting them
      // instead used to take untouched items' ancestors with them, and only
      // covered this one exit — a network failure, a failing secret write or a
      // Ctrl-C left a tree that lied.
    }
  }

  // Read after the repair pass, so a value 1Password just restored is not
  // reported as missing.
  const blanks = opts.dryRun ? [] : blankCredentials(opts.paths)

  return {
    plan, result, unresolved: plan.conflicts, pushed,
    secretsRepaired, secretsPending, blankCredentials: blanks,
    ...(pushRejected === undefined ? {} : { pushRejected }),
  }
}

/**
 * Remove the credentials of servers this run deleted — after the push, never
 * before. See ApplyResult.secretsToDrop for why the ordering is inverted here
 * relative to every other blob write.
 *
 * A failure is deliberately not fatal: by this point the deletion has landed
 * everywhere, and all that is left behind is an entry for a server no machine
 * has. The next run that touches the blob clears it.
 */
export async function dropStoredSecrets(
  opts: EngineOptions,
  secrets: SecretProvider,
  blob: SecretBlob,
  ids: string[],
  secretsUnreadable: string | undefined,
): Promise<void> {
  if (ids.length === 0 || !opts.useSecrets || secretsUnreadable !== undefined) return
  let changed = false
  for (const id of ids) {
    if (blob.mcp[id] === undefined) continue
    delete blob.mcp[id]
    changed = true
  }
  if (changed) await secrets.write(blob)
}

