import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatch } from '../src/dispatch.js'
import { parseOnly } from '../src/flags.js'
import { parseArgs, EXIT } from '../src/cli.js'
import type { Config } from '../src/config.js'

let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'ss-dispatch-'))
})

async function writeConfig(over: Partial<Config> = {}): Promise<void> {
  const c: Config = {
    schemaVersion: 1, host: 'github.com', owner: 'o', repo: 'r', branch: 'main',
    device: 'dev', vault: 'agent', item: 'syncskills', secrets: false, excludes: [],
    remote: join(tmpdir(), 'ss-no-such-remote-at-all.git'),
    ...over,
  }
  await writeFile(join(configDir, 'config.json'), JSON.stringify(c))
}

/** Run a command the way the entry point does, capturing stdout. */
async function capture(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = []
  const original = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true }) as
    typeof process.stdout.write
  const errOriginal = process.stderr.write.bind(process.stderr)
  process.stderr.write = (() => true) as typeof process.stderr.write
  try {
    const args = parseArgs([...argv, '--config', configDir])
    const code = await dispatch(args, args.flags.json === true)
    return { code, out: chunks.join('') }
  } finally {
    process.stdout.write = original
    process.stderr.write = errOriginal
  }
}

describe('the --json envelope is unconditional', () => {
  it('survives a command that fails deep inside, not just one that returns a code', async () => {
    await writeConfig()
    // Cloning a remote that does not exist throws out of gather(). A script
    // reading stdout must still get an envelope rather than empty input.
    const { code, out } = await capture(['status', '--json'])

    expect(code).toBe(EXIT.ERROR)
    const envelope = JSON.parse(out) as { ok: boolean; command: string; error?: string }
    expect(envelope.ok).toBe(false)
    expect(envelope.command).toBe('status')
    expect(envelope.error).toBeTypeOf('string')
  })

  it('does not swallow the failure when --json was not asked for', async () => {
    await writeConfig()
    const { code, out } = await capture(['status'])
    expect(code).toBe(EXIT.ERROR)
    expect(out).toBe('')
  })
})

describe('parseOnly', () => {
  it('still refuses a kind it does not know', () => {
    expect(() => parseOnly('skil')).toThrow(/unknown kind/)
  })
})
