import { spawn } from 'node:child_process'

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOptions {
  input?: string
  env?: Record<string, string>
  cwd?: string
  /**
   * Give up on a child that has not exited by then. Left unset by default:
   * git and cc-switch are allowed to take as long as they take. It matters for
   * a process that can stop answering without exiting — an AI merge agent
   * waiting on a rate limit — where the alternative is a promise that never
   * settles and an interactive spinner that turns forever.
   */
  timeoutMs?: number
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.timeoutMs === undefined
        ? {}
        // SIGTERM first so the child can tidy up; SIGKILL shortly after for one
        // that ignores it, because "timed out" has to actually end.
        : { timeout: opts.timeoutMs, killSignal: 'SIGTERM' as const }),
    })
    let stdout = ''
    let stderr = ''
    let killer: NodeJS.Timeout | undefined
    if (opts.timeoutMs !== undefined) {
      killer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs + 2000)
      killer.unref()
    }
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (e) => { clearTimeout(killer); reject(e) })
    child.on('close', (code, signal) => {
      clearTimeout(killer)
      if (signal !== null && stderr === '') {
        stderr = `${bin} was stopped after ${String(opts.timeoutMs)}ms without exiting`
      }
      // A signalled child reports a null code; 1 keeps "did it work?" answerable
      // with the same check everywhere.
      resolve({ code: code ?? 1, stdout, stderr })
    })
    // A child that exits before it has read its stdin makes the write fail with
    // EPIPE. Without a listener that is an unhandled 'error' event, which takes
    // the whole CLI down; the child's exit code is the answer we actually want,
    // so the write failure is swallowed and 'close' still resolves the promise.
    child.stdin.on('error', () => {})
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}
