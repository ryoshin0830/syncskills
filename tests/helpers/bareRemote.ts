import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/util/exec.js'

/**
 * A bare git repository standing in for GitHub. Lets the whole store and the
 * two-device suite run with no network and no credentials.
 */
export async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ss-remote-'))
  await run('git', ['init', '--bare', '-b', 'main', dir])

  const seed = await mkdtemp(join(tmpdir(), 'ss-seed-'))
  await run('git', ['init', '-b', 'main', seed])
  await run('git', ['-C', seed, 'config', 'user.email', 't@example.com'])
  await run('git', ['-C', seed, 'config', 'user.name', 'test'])
  await writeFile(join(seed, 'README.md'), '# syncskills store\n')
  await run('git', ['-C', seed, 'add', '-A'])
  await run('git', ['-C', seed, 'commit', '-m', 'seed'])
  await run('git', ['-C', seed, 'push', dir, 'main'])
  return dir
}
