import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fake executable that records the arguments it was called with. Lets the
 * writer's process invocations be asserted without running the real cc-switch.
 */
export interface Stub {
  dir: string
  bin: string
  log: string
  calls(): Promise<string[]>
}

export async function makeStubBin(name: string, exitCode = 0): Promise<Stub> {
  const dir = await mkdtemp(join(tmpdir(), 'ss-stub-'))
  const bin = join(dir, name)
  const log = join(dir, 'calls.log')
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${exitCode}\n`,
  )
  await chmod(bin, 0o755)
  await writeFile(log, '')
  return {
    dir,
    bin,
    log,
    async calls() {
      const t = await readFile(log, 'utf8')
      return t.split('\n').filter((l) => l.length > 0)
    },
  }
}
