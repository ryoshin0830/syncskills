import { mkdir, rm, cp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { gather, narrowByDirection } from '../engine.js'
import { buildPlan } from '../core/plan.js'
import { applyPlan, assertNoSecrets } from '../core/apply.js'
import { createWriter } from '../ccswitch/write.js'
import { saveState } from '../state.js'
import { pickAgent } from '../merge/agent.js'
import { mergeTrees } from '../merge/index.js'
import { copyTree, walk } from '../util/fs.js'
import { treeHash } from '../core/hash.js'
import { setBase } from '../state.js'
import { upsertEntry } from '../store/manifest.js'
import { summarize, renderDiff } from './diff.js'
import { EXIT } from '../cli.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'
import type { Action } from '../core/plan.js'
import type { GitStore } from '../store/git.js'

async function readTree(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!existsSync(dir)) return out
  for await (const e of walk(dir)) out.set(e.rel, await readFile(e.abs, 'utf8').catch(() => ''))
  return out
}

/** Save both sides before a merge writes anything, so a bad merge is reversible. */
async function snapshotConflict(
  configDir: string, item: string, localDir: string, store: GitStore,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(configDir, 'conflicts', stamp, item)
  await mkdir(dir, { recursive: true })
  if (existsSync(localDir)) await copyTree(localDir, join(dir, 'local'))
  const remoteDir = store.itemDir('skill', item)
  if (existsSync(remoteDir)) await copyTree(remoteDir, join(dir, 'remote'))
  return dir
}

export async function runTui(opts: EngineOptions, io: Io): Promise<number> {
  p.intro(pc.bold(`syncskills — ${opts.config.device}`))

  const spin = p.spinner()
  spin.start('Comparing this device with the remote')
  const { resolutions, store, manifest, state, blob, secrets } = await gather(opts)
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)
  spin.stop('Comparison complete')

  const rows = summarize(plan)
  if (rows.length === 0) {
    p.outro(pc.green('Everything is in sync.'))
    return EXIT.OK
  }

  p.note(
    rows.map((r) => `${String(r.count).padStart(3)}  ${r.label}`).join('\n'),
    'What needs doing',
  )

  const wantsDetail = await p.confirm({ message: 'Show the item list?', initialValue: false })
  if (wantsDetail === true) {
    p.note(
      [...plan.actions, ...plan.conflicts]
        .map((a) => `${a.type.padEnd(16)} ${a.kind}/${a.id}`)
        .join('\n'),
      'Items',
    )
  }

  // ---- conflicts first: nothing else is applied until these are settled ----
  const stillUnresolved: Action[] = []

  if (plan.conflicts.length > 0) {
    const agent = await pickAgent(opts.mergeAgent)

    for (const c of plan.conflicts) {
      if (c.kind !== 'skill') {
        stillUnresolved.push(c)
        continue
      }

      const localDir = join(opts.paths.skillsDir, c.id)
      const remoteDir = store.itemDir('skill', c.id)
      const backup = await snapshotConflict(opts.configDir, c.id, localDir, store)

      const outDir = join(opts.configDir, 'cache', 'merged', c.id)
      await rm(outDir, { recursive: true, force: true })

      const mspin = p.spinner()
      mspin.start(`Merging ${c.id} with ${agent.name === 'none' ? 'git only' : agent.name}`)
      const report = await mergeTrees({
        localDir, remoteDir, outDir, agent,
      })
      mspin.stop(
        report.resolved
          ? `Merged ${c.id}`
          : `Could not fully merge ${c.id}`,
      )

      const before = await readTree(localDir)
      const after = await readTree(outDir)
      const diffs = [...new Set([...before.keys(), ...after.keys()])].sort()
        .map((f) => ({ f, d: renderDiff(before.get(f) ?? '', after.get(f) ?? '') }))
        .filter((x) => x.d !== '')

      if (diffs.length > 0) {
        p.note(diffs.map((x) => `${pc.bold(x.f)}\n${x.d}`).join('\n\n'), `${c.id} — merged result`)
      }

      const choice = report.resolved
        ? await p.select({
            message: `Accept the merge for ${c.id}?`,
            options: [
              { value: 'accept', label: 'Accept the merge (keeps both sides)' },
              { value: 'local', label: 'Keep this device’s version' },
              { value: 'remote', label: 'Take the other device’s version' },
              { value: 'skip', label: 'Decide later' },
            ],
          })
        : await p.select({
            message: `${c.id} could not be merged automatically. What now?`,
            options: [
              { value: 'local', label: 'Keep this device’s version' },
              { value: 'remote', label: 'Take the other device’s version' },
              { value: 'skip', label: 'Decide later' },
            ],
          })

      if (choice === 'skip' || typeof choice !== 'string') {
        stillUnresolved.push(c)
        p.log.info(`${c.id} left alone. Both versions are saved in ${backup}`)
        continue
      }

      const source = choice === 'accept' ? outDir : choice === 'remote' ? remoteDir : localDir

      if (opts.dryRun) {
        p.log.info(`${c.id}: would take the ${choice} version (dry run, nothing written)`)
        continue
      }

      // A merge can pull a credential in from either side, so the resolved tree
      // faces the same gate as any other push. A secret in git history cannot
      // be taken back.
      await assertNoSecrets(source, `skills/${c.id}`)

      if (source !== localDir) {
        await rm(localDir, { recursive: true, force: true })
        await copyTree(source, localDir)
      }

      const writer = createWriter({
        paths: opts.paths,
        ...(opts.ccBin === undefined ? {} : { bin: opts.ccBin }),
      })
      await writer.importSkill(c.id, c.resolution.apps)

      const side = { contentHash: await treeHash(localDir), apps: c.resolution.apps }
      setBase(state, 'skill', c.id, side)
      upsertEntry(manifest, 'skill', c.id, side, opts.config.device)

      await rm(store.itemDir('skill', c.id), { recursive: true, force: true })
      await copyTree(localDir, store.itemDir('skill', c.id))

      p.log.success(`${c.id} resolved — both versions kept in ${backup}`)
    }
  }

  // ---- then the straightforward actions ----
  if (plan.actions.length > 0) {
    const go = await p.confirm({
      message: `Apply ${plan.actions.length} change(s)?`,
      initialValue: true,
    })
    if (go !== true) {
      p.outro('Nothing applied.')
      return EXIT.OK
    }
  }

  const writer = createWriter({
    paths: opts.paths,
    ...(opts.ccBin === undefined ? {} : { bin: opts.ccBin }),
  })
  const aspin = p.spinner()
  aspin.start('Applying')
  const result = await applyPlan(plan, {
    paths: opts.paths, writer, store, manifest, state, secrets, blob,
    device: opts.config.device, configDir: opts.configDir, dryRun: opts.dryRun,
  })
  aspin.stop('Applied')

  for (const f of result.failed) {
    p.log.error(`${f.action.kind}/${f.action.id}: ${f.error}`)
  }
  for (const a of result.pending) {
    p.log.warn(`${a.kind}/${a.id} needs you to finish it by hand`)
  }

  if (result.failed.length === 0 && !opts.dryRun) {
    const pspin = p.spinner()
    pspin.start('Publishing')
    await store.writeManifest(manifest)
    const pushed = await store.commitAndPush(
      `sync from ${opts.config.device} (${result.applied.length} change(s))`,
    )
    if (opts.useSecrets) await secrets.write(blob)
    await saveState(opts.configDir, state)
    pspin.stop(pushed ? 'Published' : 'Nothing to publish')
  }

  if (result.backupDir !== null) p.log.info(`Backup: ${result.backupDir}`)

  if (result.failed.length > 0) {
    p.outro(pc.red('Finished with errors.'))
    return EXIT.ERROR
  }
  if (stillUnresolved.length > 0 || result.pending.length > 0) {
    p.outro(pc.yellow(`${stillUnresolved.length + result.pending.length} item(s) still need you.`))
    return EXIT.CONFLICT
  }
  p.outro(pc.green('Done.'))
  return EXIT.OK
}

export { snapshotConflict }
