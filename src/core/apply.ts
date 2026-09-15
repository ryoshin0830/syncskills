import { mkdir, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { copyTree, walk } from '../util/fs.js'
import { treeHash, canonicalJsonHash } from './hash.js'
import { setBase } from '../state.js'
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
}

export interface ApplyResult {
  applied: Action[]
  failed: { action: Action; error: string }[]
  /** Actions that need the user to finish them by hand. */
  pending: Action[]
  backupDir: string | null
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
  const result: ApplyResult = { applied: [], failed: [], pending: [], backupDir: null }
  if (plan.actions.length === 0) return result
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
      // Stop at the first failure. Everything applied so far is recorded in
      // state, so the next run resolves from reality rather than from a guess.
      break
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

async function applyOne(action: Action, ctx: ApplyContext): Promise<'done' | 'pending'> {
  const { kind, id, resolution } = action

  switch (action.type) {
    case 'set-apps': {
      if (kind === 'skill') await ctx.writer.setSkillApps(id, resolution.apps)
      else if (kind === 'mcp') await ctx.writer.setMcpApps(id, resolution.apps)

      const side = { contentHash: resolution.local!.contentHash, apps: resolution.apps }
      setBase(ctx.state, kind, id, side)
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
          contentHash: canonicalJsonHash({ config: sanitized, tags: [] }),
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

        const dest = ctx.store.itemDir('skill', id)
        await rm(dest, { recursive: true, force: true })
        await copyTree(src, dest)

        // The matrix we record is the MERGED one. It has to land on this
        // machine too, or the next run reads the disagreement as a deliberate
        // local change and pushes it back, undoing the other device's work.
        await applyMergedApps(ctx, action)

        const side = { contentHash: await treeHash(src), apps: resolution.apps }
        setBase(ctx.state, kind, id, side)
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

        await ctx.store.writeItemJson('mcp', id, sanitized)
        if (Object.keys(secrets).length > 0) ctx.blob.mcp[id] = { env: secrets }

        await applyMergedApps(ctx, action)

        const side = {
          contentHash: canonicalJsonHash({ config: sanitized, tags: payload.tags }),
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
      delete ctx.blob.mcp[id]
      setBase(ctx.state, kind, id, undefined)
      return 'done'
    }

    case 'delete-local': {
      if (kind === 'skill') {
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
