import { spawn } from 'node:child_process'

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOptions {
  input?: string
  env?: Record<string, string>
  cwd?: string
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    // A child that exits before it has read its stdin makes the write fail with
    // EPIPE. Without a listener that is an unhandled 'error' event, which takes
    // the whole CLI down; the child's exit code is the answer we actually want,
    // so the write failure is swallowed and 'close' still resolves the promise.
    child.stdin.on('error', () => {})
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}
