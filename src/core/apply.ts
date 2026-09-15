import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { copyTree, walk } from '../util/fs.js'
import { treeHash, canonicalJsonHash } from './hash.js'
import { setBase, stateKey } from '../state.js'
import { saveBaseTree, dropBaseTree, existingBaseTree } from '../basetree.js'
import { upsertEntry, removeEntry } from '../store/manifest.js'
import { scanForSecrets } from '../secrets/scan.js'
import { stripSecrets } from '../ccswitch/read.js'
import type { Action, Plan } from './plan.js'
import type { StateFile } from '../state.js'
import type { GitStore } from '../store/git.js'
import type { CcWriter } from '../ccswitch/write.js'
import type { CcPaths } from '../ccswitch/paths.js'
import type { SecretProvider, SecretBlob } from '../secrets/provider.js'
import type { Manifest } from '../store/manifest.js'

export interface ApplyContext {
  paths: CcPaths
  writer: CcWriter
  store: GitStore
  manifest: Manifest
  state: StateFile
  secrets: SecretProvider
  blob: SecretBlob
  device: string
  configDir: string
  dryRun: boolean
  /** Filled by applyOne; see ApplyResult.secretsToDrop. */
  secretsToDrop: string[]
}

export interface ApplyResult {
  applied: Action[]
  failed: { action: Action; error: string }[]
  /** Actions that need the user to finish them by hand. */
  pending: Action[]
  backupDir: string | null
  /**
   * Credentials to drop from the store once the push has landed, and not
   * before.
   *
   * Everything else the blob does is an addition, which is published first on
   * purpose: if the push lands and the secret write then fails, the next run
   * still sees work to do. A DELETION cannot follow that rule. Published first
   * and then raced, it removes the only copy of a value the store still says
   * every machine needs — and env values are outside the content hash, so no
   * later run notices. Deferred, the worst case is an orphan entry for a server
   * nobody has, which costs nothing.
   */
  secretsToDrop: string[]
}

/**
 * Copy the database and every skill directory before the first mutation. The
 * database is small and the skills are text; the cost is negligible next to
 * losing a user's work.
 */
export async function snapshot(ctx: ApplyContext): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(ctx.configDir, 'backups', stamp)
  await mkdir(dir, { recursive: true })

  // cc-switch.db holds raw env values, so this copy is a credential store.
  if (existsSync(ctx.paths.db)) {
    await writeFile(join(dir, 'cc-switch.db'), await readFile(ctx.paths.db), { mode: 0o600 })
  }
  if (existsSync(ctx.paths.skillsDir)) {
    await copyTree(ctx.paths.skillsDir, join(dir, 'skills'))
  }
  await pruneBackups(join(ctx.configDir, 'backups'))
  return dir
}

/** Keep the most recent backups only; an unbounded pile of database copies is
 *  an unbounded pile of credentials. */
export async function pruneBackups(root: string, keep = 10): Promise<string[]> {
  const entries = await readdir(root).catch(() => [])
  const stale = entries.sort().slice(0, Math.max(0, entries.length - keep))
  for (const name of stale) await rm(join(root, name), { recursive: true, force: true })
  return stale
}

/** Refuse to stage anything that looks like a credential. */
export async function assertNoSecrets(dir: string, label: string): Promise<void> {
  for await (const e of walk(dir)) {
    const text = await readFile(e.abs, 'utf8').catch(() => null)
    if (text === null) continue
    const hits = scanForSecrets(text)
    if (hits.length > 0) {
      throw new Error(
        `refusing to push ${label}: ${e.rel} looks like it contains a credential ` +
        `(${hits.join('; ')}). A secret pushed to git cannot be taken back. ` +
        `Remove it, or exclude this item in your config.`,
      )
    }
  }
}

export async function applyPlan(plan: Plan, ctx: ApplyContext): Promise<ApplyResult> {
  const result: ApplyResult = {
    applied: [], failed: [], pending: [], backupDir: null, secretsToDrop: ctx.secretsToDrop,
  }
  if (!ctx.dryRun) await recordAgreedBases(plan, ctx)
  if (plan.actions.length === 0) return result
  // A dry run is described as changing nothing, and a backup is a change: it
  // copies the database — credentials included — and every skill directory.
  if (!ctx.dryRun) result.backupDir = await snapshot(ctx)

  let touchedSkills = false

  for (const action of plan.actions) {
    try {
      if (ctx.dryRun) {
        result.applied.push(action)
        continue
      }
      const outcome = await applyOne(action, ctx)
      if (outcome === 'pending') {
        result.pending.push(action)
      } else {
        if (action.kind === 'skill') touchedSkills = true
        result.applied.push(action)
      }
    } catch (e) {
      result.failed.push({ action, error: (e as Error).message })
      // Carry on with the rest. Actions are independent per item and each one
      // records its own base, so a failure here costs only that item. Stopping
      // would be worse than it sounds: the plan is sorted deterministically, so
      // one item that fails every time would block everything ordered after it
      // on every future run, and the only way out would be editing the config
      // by hand.
      continue
    }
  }

  if (touchedSkills && !ctx.dryRun) await ctx.writer.syncSkills()
  return result
}

/**
 * Put the merged app matrix on this machine when it differs from what
 * cc-switch currently has. Recording a merged matrix without applying it is how
 * one device silently reverts another's enablement on the following sync.
 */
async function applyMergedApps(ctx: ApplyContext, action: Action): Promise<void> {
  const { kind, id, resolution } = action
  const current = resolution.local?.apps ?? []
  if (JSON.stringify(current) === JSON.stringify(resolution.apps)) return
  if (kind === 'skill') await ctx.writer.setSkillApps(id, resolution.apps)
  else if (kind === 'mcp') await ctx.writer.setMcpApps(id, resolution.apps)
}

/**
 * Write down what this machine and the remote already agree on. Nothing is
 * changed anywhere: it only fills in a base that was never recorded, or a base
 * tree that a matrix-only update left behind. Without it a later divergence
 * looks like two independent creations and cannot be merged three-way.
 */
async function recordAgreedBases(plan: Plan, ctx: ApplyContext): Promise<void> {
  for (const r of plan.inSync) {
    const local = r.local!
    const recorded = ctx.state.items[stateKey(r.kind, r.id)]
    const hashMatches = recorded?.contentHash === local.contentHash
    const appsMatch = JSON.stringify(recorded?.apps) === JSON.stringify(local.apps)
    const treeMissing =
      r.kind === 'skill' && existingBaseTree(ctx.configDir, r.kind, r.id) === undefined

    if (hashMatches && appsMatch && !treeMissing) continue

    setBase(ctx.state, r.kind, r.id, { contentHash: local.contentHash, apps: local.apps })
    if (r.kind === 'skill') {
      await saveBaseTree(ctx.configDir, r.kind, r.id, join(ctx.paths.skillsDir, r.id))
    }
  }
}

async function applyOne(action: Action, ctx: ApplyContext): Promise<'done' | 'pending'> {
  const { kind, id, resolution } = action

  switch (action.type) {
    case 'set-apps': {
      // Only when it differs — see applyMergedApps. A matrix the database
      // already holds needs publishing, not writing, and writing an EMPTY one
      // goes through the database, which refuses while cc-switch is open. That
      // turned a no-op into an item that failed on every run for good.
      await applyMergedApps(ctx, action)

      const side = { contentHash: resolution.local!.contentHash, apps: resolution.apps }
      setBase(ctx.state, kind, id, side)
      if (kind === 'skill') {
        await saveBaseTree(ctx.configDir, kind, id, join(ctx.paths.skillsDir, id))
      }
      upsertEntry(ctx.manifest, kind, id, side, ctx.device)
      return 'done'
    }

    case 'pull-content': {
      if (kind === 'skill') {
        const src = ctx.store.itemDir('skill', id)
        if (!existsSync(src)) throw new Error(`remote skills/${id} is missing from the store`)
        const dest = join(ctx.paths.skillsDir, id)
        await rm(dest, { recursive: true, force: true })
        await copyTree(src, dest)
        await ctx.writer.importSkill(id, resolution.apps)
        const pulled = { contentHash: await treeHash(dest), apps: resolution.apps }
        setBase(ctx.state, kind, id, pulled)
        await saveBaseTree(ctx.configDir, kind, id, dest)
        // The merged matrix must reach the manifest as well; otherwise the
        // remote still advertises the old one and the next run pulls it back.
        upsertEntry(ctx.manifest, kind, id, pulled, ctx.device)
        return 'done'
      }

      if (kind === 'mcp') {
        const sanitized = await ctx.store.readItemJson('mcp', id)
        if (sanitized === null) throw new Error(`remote mcp/${id}.json is missing from the store`)
        const env = ctx.blob.mcp[id]?.env ?? {}
        const config = rehydrate(sanitized, env)
        const outcome = await ctx.writer.importMcpWithSecrets(id, config, env, resolution.apps)
        if (outcome === 'pending') return 'pending'
        const pulledMcp = {
          contentHash: canonicalJsonHash({ config: sanitized }),
          apps: resolution.apps,
        }
        setBase(ctx.state, kind, id, pulledMcp)
        upsertEntry(ctx.manifest, kind, id, pulledMcp, ctx.device)
        return 'done'
      }

      if (kind === 'repo') {
        const stored = await ctx.store.readItemJson('repo', id)
        if (stored === null) throw new Error(`remote repos/${id}.json is missing from the store`)
        const [owner, name] = id.split('/')
        if (owner === undefined || name === undefined) {
          throw new Error(`malformed repository id "${id}"; expected owner/name`)
        }
        const branch = String(stored.branch ?? 'main')
        const enabled = stored.enabled === true
        await ctx.writer.addRepo(owner, name, branch, enabled)
        const pulledRepo = { contentHash: canonicalJsonHash({ branch, enabled }), apps: [] }
        setBase(ctx.state, kind, id, pulledRepo)
        upsertEntry(ctx.manifest, kind, id, pulledRepo, ctx.device)
        return 'done'
      }

      return 'done'
    }

    case 'push-content': {
      if (kind === 'skill') {
        const src = join(ctx.paths.skillsDir, id)
        if (!existsSync(src)) throw new Error(`local skill ${id} vanished before it could be pushed`)
        await assertNoSecrets(src, `skills/${id}`)

        // The matrix we record is the MERGED one. It has to land on this
        // machine too, or the next run reads the disagreement as a deliberate
        // local change and pushes it back, undoing the other device's work.
        //
        // It goes FIRST because it is the step that can fail — cc-switch
        // refusing, the binary missing, an empty matrix while cc-switch is
        // open. Copying into the store before it left committed bytes that no
        // manifest entry described: the other machine read its own hash, called
        // itself in sync, and never saw the newer content sitting in the
        // repository. Applying it first is safe to repeat, since the write is
        // skipped when the matrix already matches.
        await applyMergedApps(ctx, action)

        const dest = ctx.store.itemDir('skill', id)
        await rm(dest, { recursive: true, force: true })
        await copyTree(src, dest)

        const side = { contentHash: await treeHash(src), apps: resolution.apps }
        setBase(ctx.state, kind, id, side)
        await saveBaseTree(ctx.configDir, kind, id, src)
        upsertEntry(ctx.manifest, kind, id, side, ctx.device)
        return 'done'
      }

      if (kind === 'mcp') {
        const payload = resolution.local!.payload as {
          config: Record<string, unknown>
          tags: string[]
        }
        const { sanitized, secrets } = stripSecrets(payload.config)

        const hits = scanForSecrets(JSON.stringify(sanitized))
        if (hits.length > 0) {
          throw new Error(
            `refusing to push mcp/${id}: the sanitized config still looks like it contains ` +
            `a credential (${hits.join('; ')}). This is a bug in secret stripping; ` +
            `nothing was pushed.`,
          )
        }

        // First, for the same reason as a skill below: it is the step that can
        // fail, and nothing may reach the store that the manifest will not
        // describe.
        await applyMergedApps(ctx, action)

        await ctx.store.writeItemJson('mcp', id, sanitized)
        // Emptying a server's env must clear the stored values, not leave the
        // old ones behind in 1Password — but not before the push lands, for the
        // same reason a delete waits. See secretsToDrop.
        if (Object.keys(secrets).length > 0) ctx.blob.mcp[id] = { env: secrets }
        else ctx.secretsToDrop.push(id)

        const side = {
          contentHash: canonicalJsonHash({ config: sanitized }),
          apps: resolution.apps,
        }
        setBase(ctx.state, kind, id, side)
        upsertEntry(ctx.manifest, kind, id, side, ctx.device)
        return 'done'
      }

      if (kind === 'repo') {
        const row = resolution.local!.payload as {
          owner: string; name: string; branch: string; enabled: boolean
        }
        const value = { branch: row.branch, enabled: row.enabled }
        await ctx.store.writeItemJson('repo', id, value)
        const side = { contentHash: canonicalJsonHash(value), apps: [] }
        setBase(ctx.state, kind, id, side)
        upsertEntry(ctx.manifest, kind, id, side, ctx.device)
        return 'done'
      }

      return 'done'
    }

    case 'delete-remote': {
      await ctx.store.removeItem(kind, id)
      removeEntry(ctx.manifest, kind, id)
      // Only an MCP server owns a secret; a skill that happens to share its
      // name must not drop it. Queued rather than done here: see secretsToDrop.
      if (kind === 'mcp') ctx.secretsToDrop.push(id)
      setBase(ctx.state, kind, id, undefined)
      await dropBaseTree(ctx.configDir, kind, id)
      return 'done'
    }

    case 'delete-local': {
      if (kind === 'skill') {
        // The row goes first. If cc-switch is holding the database we must not
        // remove the directory either, or the skill is left half-deleted: a row
        // pointing at nothing, which localSkillSides() skips and nothing
        // reports.
        const outcome = await ctx.writer.deleteSkill(id)
        if (outcome === 'pending') return 'pending'
        await rm(join(ctx.paths.skillsDir, id), { recursive: true, force: true })
      } else if (kind === 'mcp') {
        const outcome = await ctx.writer.deleteMcp(id)
        // Leave the base alone: the item is still here, so the next run must
        // see the same decision rather than believing the delete happened.
        if (outcome === 'pending') return 'pending'
      } else if (kind === 'repo') {
        const [owner, name] = id.split('/')
        if (owner === undefined || name === undefined) {
          throw new Error(`malformed repository id "${id}"; expected owner/name`)
        }
        await ctx.writer.removeRepo(owner, name)
      }
      setBase(ctx.state, kind, id, undefined)
      await dropBaseTree(ctx.configDir, kind, id)
      return 'done'
    }

    default:
      return 'done'
  }
}

/**
 * Put the real environment values back into a config that arrived from the
 * repository holding only key names. A key with no stored value becomes an
 * empty string rather than vanishing, so the server still starts and the
 * missing credential is visible to the user.
 */
function rehydrate(
  sanitized: Record<string, unknown>,
  env: Record<string, string>,
): Record<string, unknown> {
  const out = { ...sanitized }
  if (sanitized.env !== null && typeof sanitized.env === 'object' && !Array.isArray(sanitized.env)) {
    const filled: Record<string, string> = {}
    for (const key of Object.keys(sanitized.env as Record<string, unknown>)) {
      filled[key] = env[key] ?? ''
    }
    out.env = filled
  }
  return out
}
