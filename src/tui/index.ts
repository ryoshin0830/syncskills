import { mkdir, rm, cp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as p from '@clack/prompts'
import pc from 'picocolors'
import { gather, narrowByDirection, assertSecretsReadable } from '../engine.js'
import { buildPlan, takeSide } from '../core/plan.js'
import { applyPlan, assertNoSecrets } from '../core/apply.js'
import { createWriter } from '../ccswitch/write.js'
import { saveState } from '../state.js'
import { pickAgent } from '../merge/agent.js'
import { mergeTrees } from '../merge/index.js'
import { copyTree, walk } from '../util/fs.js'
import { treeHash } from '../core/hash.js'
import { setBase } from '../state.js'
import { upsertEntry } from '../store/manifest.js'
import { existingBaseTree, saveBaseTree } from '../basetree.js'
import { summarize, renderDiff } from './diff.js'
import { describeConflict } from './conflictChoice.js'
import type { ChoiceSide } from './conflictChoice.js'
import { EXIT } from '../cli.js'
import { answer } from '../prompt.js'
import { PushRejected } from '../store/git.js'
import { dropStoredSecrets } from '../engine.js'
import { stateKey } from '../state.js'
import type { EngineOptions } from '../engine.js'
import type { Io } from '../output.js'
import type { Action } from '../core/plan.js'
import type { GitStore } from '../store/git.js'
import type { ApplyResult } from '../core/apply.js'

interface PublishOutcome { pushed: boolean; rejected?: string }

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
  p.intro(pc.bold(`oneset — ${opts.config.device}`))

  const spin = p.spinner()
  spin.start('Comparing this device with the remote')
  const gathered = await gather(opts)
  // Before anything is shown, let alone written: a merge publishes the blob
  // like any other run, and an unread blob published is every credential lost.
  assertSecretsReadable(opts, gathered)
  const { resolutions, store, manifest, state, blob, secrets, secretsUnreadable } = gathered
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

  const wantsDetail = answer(
    await p.confirm({ message: 'Show the item list?', initialValue: false }),
  )
  if (wantsDetail) {
    p.note(
      [...plan.actions, ...plan.conflicts]
        .map((a) => `${a.type.padEnd(16)} ${a.kind}/${a.id}`)
        .join('\n'),
      'Items',
    )
  }

  // ---- conflicts first: nothing else is applied until these are settled ----
  const stillUnresolved: Action[] = []
  /**
   * Conflicts the user settled by choosing a side, queued as ordinary actions.
   * Kept separately because nothing is written for them until the apply step is
   * confirmed — declining it has to put them back, not report them as done.
   */
  const queuedFromConflicts: Action[] = []
  let resolvedAny = false

  /**
   * Put the state and manifest built so far where the other devices can see it.
   * Returns the message to show when another device published first; see
   * runSync() for why the state is deliberately left unsaved in that case.
   */
  async function publish(applied: number, result?: ApplyResult): Promise<PublishOutcome> {
    // See runSync: a blob that was never read is never written back.
    if (opts.useSecrets && secretsUnreadable === undefined) await secrets.write(blob)
    await store.writeManifest(manifest)
    try {
      const ok = await store.commitAndPush(
        `sync from ${opts.config.device} (${applied} change(s))`,
      )
      await saveState(opts.configDir, state)
      // After the push, never before — see ApplyResult.secretsToDrop.
      await dropStoredSecrets(opts, secrets, blob, result?.secretsToDrop ?? [], secretsUnreadable)
      return { pushed: ok }
    } catch (e) {
      if (!(e instanceof PushRejected)) throw e
      // Nothing to undo: see runSync. A base tree this run wrote is paired with
      // a hash state.json does not hold, so it is already not an ancestor.
      return { pushed: false, rejected: e.message }
    }
  }

  if (plan.conflicts.length > 0) {
    const agent = await pickAgent(opts.mergeAgent)

    for (const c of plan.conflicts) {
      // An MCP server and a repository are a config object and a row, not text:
      // there is no line-based merge to offer. Saying so and asking which side
      // wins is the whole resolution — dropping them here silently is what used
      // to make `sync` report the same conflict forever with no way out.
      if (c.kind !== 'skill') {
        const choice = describeConflict(c)
        const pick = answer<string>(await p.select({
          message: choice.message,
          options: choice.options,
        }))
        if (pick === 'skip') {
          stillUnresolved.push(c)
          continue
        }
        const side = pick as ChoiceSide
        // A deletion travels to every other machine and, for an MCP server,
        // takes the stored credential with it. The select above says so; this
        // makes it a second, deliberate keystroke rather than one.
        if (choice.destructive[side]) {
          const sure = answer(await p.confirm({
            message: `${choice.optionFor(side)} — this cannot be undone. Go ahead?`,
            initialValue: false,
          }))
          if (!sure) {
            stillUnresolved.push(c)
            p.log.info(`${c.kind}/${c.id} left alone.`)
            continue
          }
        }
        if (opts.dryRun) {
          p.log.info(`${c.kind}/${c.id}: would take the ${side} version (dry run, nothing written)`)
          stillUnresolved.push(c)
          continue
        }
        // Carried out as the ordinary action it amounts to, so the base, the
        // manifest and the stored credentials are recorded exactly once.
        takeSide(plan, c, side)
        queuedFromConflicts.push(c)
        continue
      }

      // A dry run is described as changing nothing, and both of the next two
      // lines change something: the snapshot lands in the config directory and
      // the merge writes a tree into the cache — which is exactly why applyPlan
      // skips its backup on a dry run. Nothing here is written either.
      if (opts.dryRun) {
        p.log.info(`${c.id}: would be merged interactively (dry run, nothing written)`)
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
      // The recorded base makes this a genuine three-way merge: without it a
      // deletion on one side cannot be told from an addition on the other, and
      // every overlapping file goes to the agent needlessly.
      // Only a base state.json vouches for: a tree left behind by a run that
      // could not publish describes an agreement that never happened, and using
      // it as the ancestor would read one side's file as deleted by the other.
      // existingBaseTree checks that pairing itself, against the hash the tree
      // was saved for — a state entry merely EXISTING is not the same thing.
      const baseDir = existingBaseTree(
        opts.configDir, 'skill', c.id, state.items[stateKey('skill', c.id)]?.contentHash,
      )
      const report = await mergeTrees({
        ...(baseDir === undefined ? {} : { baseDir }),
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
        ? answer<string>(await p.select({
            message: `Accept the merge for ${c.id}?`,
            options: [
              { value: 'accept', label: 'Accept the merge (keeps both sides)' },
              { value: 'local', label: 'Keep this device’s version' },
              { value: 'remote', label: 'Take the other device’s version' },
              { value: 'skip', label: 'Decide later' },
            ],
          }))
        : answer<string>(await p.select({
            message: `${c.id} could not be merged automatically. What now?`,
            options: [
              { value: 'local', label: 'Keep this device’s version' },
              { value: 'remote', label: 'Take the other device’s version' },
              { value: 'skip', label: 'Decide later' },
            ],
          }))

      if (choice === 'skip') {
        stillUnresolved.push(c)
        p.log.info(`${c.id} left alone. Both versions are saved in ${backup}`)
        continue
      }

      const source = choice === 'accept' ? outDir : choice === 'remote' ? remoteDir : localDir

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
        ...(opts.isCcSwitchRunning === undefined ? {} : { isCcSwitchRunning: opts.isCcSwitchRunning }),
      })
      await writer.importSkill(c.id, c.resolution.apps)

      const side = { contentHash: await treeHash(localDir), apps: c.resolution.apps }
      setBase(state, 'skill', c.id, side)
      await saveBaseTree(opts.configDir, 'skill', c.id, localDir, side.contentHash)
      upsertEntry(manifest, 'skill', c.id, side, opts.config.device)

      await rm(store.itemDir('skill', c.id), { recursive: true, force: true })
      await copyTree(localDir, store.itemDir('skill', c.id))

      resolvedAny = true
      p.log.success(`${c.id} resolved — both versions kept in ${backup}`)
    }
  }

  // ---- then the straightforward actions ----
  if (plan.actions.length > 0) {
    const go = answer(await p.confirm({
      message: `Apply ${plan.actions.length} change(s)?`,
      initialValue: true,
    }))
    if (!go) {
      // The merges above already wrote to this machine. Declining the REST of
      // the plan must not throw that away: without publishing here the resolved
      // item has no base and no manifest entry, and the next run sees the same
      // conflict again.
      // A side chosen above was never written; it goes back to unresolved
      // rather than being reported as settled by an exit code of 0.
      stillUnresolved.push(...queuedFromConflicts)
      if (resolvedAny && !opts.dryRun) {
        const out = await publish(0)
        if (out.rejected !== undefined) {
          p.log.error(out.rejected)
          p.outro(pc.red('Nothing was published.'))
          return EXIT.ERROR
        }
        p.log.info(out.pushed ? 'Merge results published.' : 'Merge results recorded.')
      }
      p.outro('Nothing else applied.')
      return stillUnresolved.length > 0 ? EXIT.CONFLICT : EXIT.OK
    }
  }

  const writer = createWriter({
    paths: opts.paths,
    ...(opts.ccBin === undefined ? {} : { bin: opts.ccBin }),
    ...(opts.isCcSwitchRunning === undefined ? {} : { isCcSwitchRunning: opts.isCcSwitchRunning }),
  })
  const aspin = p.spinner()
  aspin.start('Applying')
  const result = await applyPlan(plan, {
    paths: opts.paths, writer, store, manifest, state, secrets, blob,
    device: opts.config.device, configDir: opts.configDir, dryRun: opts.dryRun,
    secretsToDrop: [],
  })
  aspin.stop('Applied')

  for (const f of result.failed) {
    p.log.error(`${f.action.kind}/${f.action.id}: ${f.error}`)
  }
  for (const a of result.pending) {
    p.log.warn(`${a.kind}/${a.id} needs you to finish it by hand`)
  }

  let rejected: string | undefined
  if (!opts.dryRun) {
    // Publish the successes even when something failed; see runSync.
    const pspin = p.spinner()
    pspin.start('Publishing')
    const out = await publish(result.applied.length, result)
    rejected = out.rejected
    pspin.stop(
      out.rejected !== undefined ? 'Not published'
      : out.pushed ? 'Published'
      : 'Nothing to publish',
    )
    if (out.rejected !== undefined) p.log.error(out.rejected)
  }

  if (result.backupDir !== null) p.log.info(`Backup: ${result.backupDir}`)

  if (result.failed.length > 0 || rejected !== undefined) {
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
