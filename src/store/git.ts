import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../util/exec.js'
import type { Config } from '../config.js'
import { emptyManifest, parseManifest, serializeManifest } from './manifest.js'
import type { Manifest } from './manifest.js'
import type { ItemKind } from '../core/types.js'

export function remoteUrl(c: Config): string {
  return `https://${c.host}/${c.owner}/${c.repo}.git`
}

const DIR_OF: Record<ItemKind, string> = { skill: 'skills', mcp: 'mcp', repo: 'repos' }

export interface GitStore {
  /** The working copy on disk */
  dir: string
  ensure(): Promise<void>
  readManifest(): Promise<Manifest>
  writeManifest(m: Manifest): Promise<void>
  itemDir(kind: ItemKind, id: string): string
  readItemJson(kind: ItemKind, id: string): Promise<Record<string, unknown> | null>
  writeItemJson(kind: ItemKind, id: string, value: unknown): Promise<void>
  removeItem(kind: ItemKind, id: string): Promise<void>
  hasChanges(): Promise<boolean>
  /** Stage everything, commit, push. Returns false when there was nothing to do. */
  commitAndPush(message: string): Promise<boolean>
}

export function createGitStore(opts: {
  cacheDir: string
  config: Config
  gitBin?: string
  /** Point at a local path instead of the configured host. Used by tests. */
  remoteOverride?: string
}): GitStore {
  const git = opts.gitBin ?? 'git'
  const dir = join(opts.cacheDir, 'repo')
  const url = opts.remoteOverride ?? remoteUrl(opts.config)
  const branch = opts.config.branch

  async function g(args: string[], what: string) {
    const r = await run(git, ['-C', dir, ...args])
    if (r.code !== 0) {
      throw new Error(`git ${what} failed: ${r.stderr.trim() || r.stdout.trim()}`)
    }
    return r
  }

  return {
    dir,

    /**
     * Leave the working copy a faithful mirror of the remote before anything is
     * resolved against it. Local drift in the cache is discarded — the cache is
     * scratch, and stale content here would resolve as phantom local changes.
     */
    async ensure() {
      if (!existsSync(join(dir, '.git'))) {
        await mkdir(opts.cacheDir, { recursive: true })
        await rm(dir, { recursive: true, force: true })
        const r = await run(git, ['clone', '--branch', branch, url, dir])
        if (r.code !== 0) {
          // A repository created empty has no branches yet, so --branch fails.
          const r2 = await run(git, ['clone', url, dir])
          if (r2.code !== 0) {
            throw new Error(
              `could not clone ${url}: ${r2.stderr.trim()}. ` +
              `Check that the repository exists and that gh is authenticated for this host.`,
            )
          }
          await run(git, ['-C', dir, 'checkout', '-B', branch])
        }
      } else {
        const fetched = await run(git, ['-C', dir, 'fetch', 'origin', branch])
        if (fetched.code === 0) {
          await g(['checkout', '-B', branch, `origin/${branch}`], 'checkout')
          await g(['reset', '--hard', `origin/${branch}`], 'reset')
        } else {
          // The remote branch does not exist yet; keep whatever we have.
          await run(git, ['-C', dir, 'checkout', '-B', branch])
        }
        await g(['clean', '-fd'], 'clean')
      }

      await run(git, ['-C', dir, 'config', 'user.email', 'syncskills@localhost'])
      await run(git, ['-C', dir, 'config', 'user.name', 'syncskills'])
    },

    async readManifest() {
      const text = await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null)
      return text === null ? emptyManifest() : parseManifest(text)
    },

    async writeManifest(m) {
      await writeFile(join(dir, 'manifest.json'), serializeManifest(m))
    },

    itemDir(kind, id) {
      return join(dir, DIR_OF[kind], id)
    },

    async readItemJson(kind, id) {
      const text = await readFile(join(dir, DIR_OF[kind], `${id}.json`), 'utf8').catch(() => null)
      if (text === null) return null
      return JSON.parse(text) as Record<string, unknown>
    },

    async writeItemJson(kind, id, value) {
      const d = join(dir, DIR_OF[kind])
      await mkdir(d, { recursive: true })
      await writeFile(join(d, `${id}.json`), JSON.stringify(value, null, 2) + '\n')
    },

    async removeItem(kind, id) {
      await rm(join(dir, DIR_OF[kind], `${id}.json`), { force: true })
      await rm(join(dir, DIR_OF[kind], id), { recursive: true, force: true })
    },

    async hasChanges() {
      const r = await g(['status', '--porcelain'], 'status')
      return r.stdout.trim().length > 0
    },

    async commitAndPush(message) {
      await g(['add', '-A'], 'add')
      const st = await g(['status', '--porcelain'], 'status')
      if (st.stdout.trim().length === 0) return false
      await g(['commit', '-m', message], 'commit')
      await g(['push', 'origin', branch], 'push')
      return true
    },
  }
}
