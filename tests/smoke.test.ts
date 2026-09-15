import { describe, it, expect, beforeAll } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/util/exec.js'

/**
 * These run against the BUILT artifact, not the sources. Unit tests all passed
 * while the built CLI printed nothing at all — only a smoke test catches a
 * bundler turning the entrypoint into a library.
 */
beforeAll(async () => {
  const r = await run('npm', ['run', 'build'])
  expect(r.code, r.stderr).toBe(0)
}, 180_000)

describe('built CLI', () => {
  it('produces dist/cli.js', () => {
    expect(existsSync('dist/cli.js')).toBe(true)
  })

  it('prints root help and exits 0', async () => {
    const r = await run('node', ['dist/cli.js', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('syncskills')
    expect(r.stdout).toContain('EXIT CODES')
    expect(r.stdout.length).toBeGreaterThan(400)
  })

  it('prints per-command help for every command', async () => {
    for (const c of ['init', 'sync', 'status', 'push', 'pull', 'diff',
                     'conflicts', 'secrets', 'doctor', 'config', 'completion']) {
      const r = await run('node', ['dist/cli.js', c, '--help'])
      expect(r.code, `${c} --help exited ${r.code}`).toBe(0)
      expect(r.stdout, `${c} --help lacks USAGE`).toContain('USAGE')
      expect(r.stdout, `${c} --help lacks --json`).toContain('--json')
    }
  }, 60_000)

  it('exits 3 with a JSON envelope when not initialized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-smoke-'))
    const r = await run('node', ['dist/cli.js', 'status', '--json'], {
      env: { SYNCSKILLS_CONFIG_DIR: join(dir, 'nothing-here') },
    })
    expect(r.code).toBe(3)
    const env = JSON.parse(r.stdout) as { ok: boolean; error: string; schemaVersion: number }
    expect(env.ok).toBe(false)
    expect(env.schemaVersion).toBe(1)
    expect(env.error).toMatch(/not initialized/)
  })

  it('exits 1 and names the problem for an unknown command', async () => {
    const r = await run('node', ['dist/cli.js', 'bogus', '--json'])
    expect(r.code).toBe(1)
    expect((JSON.parse(r.stdout) as { error: string }).error).toMatch(/unknown command/)
  })

  it('prints its version', async () => {
    const r = await run('node', ['dist/cli.js', '--version'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toMatch(/^syncskills \d+\.\d+\.\d+/)
  })

  /**
   * The dangerous case: a mistyped --dry-run used to be dropped silently, and
   * the run went ahead for real.
   */
  it('exits 1 on a mistyped flag instead of ignoring it', async () => {
    for (const typo of ['--dry-runn', '--yess', '--no-secretss']) {
      const r = await run('node', ['dist/cli.js', 'sync', typo])
      expect(r.code, typo).toBe(1)
      expect(r.stderr, typo).toMatch(/unknown flag/)
    }
  }, 30_000)

  it('reports a mistyped flag through the JSON envelope too', async () => {
    const r = await run('node', ['dist/cli.js', 'sync', '--jsonn', '--json'])
    expect(r.code).toBe(1)
    const env = JSON.parse(r.stdout) as { ok: boolean; error: string }
    expect(env.ok).toBe(false)
    expect(env.error).toMatch(/unknown flag/)
  })

  it('exits 1 on an unknown --only kind rather than syncing everything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-only-'))
    const r = await run('node', ['dist/cli.js', 'sync', '--only', 'skil'], {
      env: { SYNCSKILLS_CONFIG_DIR: join(dir, 'nothing-here') },
    })
    expect(r.code).toBe(1)
  })

  it('emits a shell completion script for each supported shell', async () => {
    for (const shell of ['zsh', 'bash', 'fish']) {
      const r = await run('node', ['dist/cli.js', 'completion', shell])
      expect(r.code, shell).toBe(0)
      expect(r.stdout, shell).toContain('syncskills')
    }
  }, 30_000)

  it('runs doctor and reports machine-readable checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-smoke2-'))
    const r = await run('node', ['dist/cli.js', 'doctor', '--json'], {
      env: { SYNCSKILLS_CONFIG_DIR: join(dir, 'nothing-here') },
    })
    const env = JSON.parse(r.stdout) as { data: { checks: { name: string }[] } }
    const names = env.data.checks.map((c) => c.name)
    for (const expected of ['node', 'node:sqlite', 'git', 'gh', 'cc-switch']) {
      expect(names, `doctor omits ${expected}`).toContain(expected)
    }
  }, 30_000)

  it('never prints a SQLite experimental warning to a user', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-smoke3-'))
    const r = await run('node', ['dist/cli.js', 'doctor'], {
      env: { SYNCSKILLS_CONFIG_DIR: join(dir, 'nothing-here') },
    })
    expect(r.stderr).not.toMatch(/ExperimentalWarning/)
  }, 30_000)

  it('ships no runtime dependencies, so npx has nothing to resolve', async () => {
    const pkg = JSON.parse(
      await (await import('node:fs/promises')).readFile('package.json', 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies ?? {}).toEqual({})
  })

  it('starts fast enough for npx to feel instant', async () => {
    const t = Date.now()
    await run('node', ['dist/cli.js', '--help'])
    expect(Date.now() - t).toBeLessThan(1500)
  })
})
