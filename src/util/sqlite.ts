import { createRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'

/**
 * `node:sqlite` is still flagged experimental, which has two consequences we
 * have to work around here:
 *
 *  1. It is absent from `module.builtinModules`, so bundlers and Vite strip the
 *     `node:` prefix and then fail to resolve a package called `sqlite`. Loading
 *     it through `createRequire` keeps it out of static analysis entirely.
 *  2. It did not exist before Node 22.5 and needed `--experimental-sqlite`
 *     until 22.13 / 23.4. On an older runtime the import throws, and a raw
 *     module-not-found stack trace tells the user nothing useful.
 */
const req = createRequire(import.meta.url)

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean }) => DatabaseSync

let cached: DatabaseSyncCtor | null = null

export function loadDatabaseSync(): DatabaseSyncCtor {
  if (cached !== null) return cached
  try {
    const mod = req('node:sqlite') as { DatabaseSync: DatabaseSyncCtor }
    cached = mod.DatabaseSync
    return cached
  } catch (err) {
    throw new Error(
      `this Node build has no node:sqlite, which oneset needs to read cc-switch's ` +
      `database. Node 22.13 or newer is required (you are on ${process.version}). ` +
      `Upgrade Node, or run oneset through npx with a newer runtime. ` +
      `Original error: ${(err as Error).message}`,
    )
  }
}

/**
 * `node:sqlite` prints an ExperimentalWarning the first time it is used. That
 * is noise on every single CLI invocation, so the entry point silences exactly
 * that class and lets every other warning through.
 */
export function silenceSqliteExperimentalWarning(): void {
  const listeners = process.listeners('warning')
  process.removeAllListeners('warning')
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return
    for (const l of listeners) l(w)
    if (listeners.length === 0) process.stderr.write(`${w.name}: ${w.message}\n`)
  })
}
