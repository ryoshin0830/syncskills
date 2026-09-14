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
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}
