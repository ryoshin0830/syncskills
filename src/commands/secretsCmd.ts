import pc from 'picocolors'
import { onePasswordProvider } from '../secrets/onepassword.js'
import { nullProvider } from '../secrets/provider.js'
import { emitJson, emitJsonError, line } from '../output.js'
import { EXIT } from '../cli.js'
import type { Config } from '../config.js'
import type { Io } from '../output.js'

export async function secretsCommand(
  opts: { config: Config; token?: string; useSecrets: boolean },
  sub: string | undefined,
  io: Io,
): Promise<number> {
  const provider = opts.useSecrets && opts.token !== undefined && opts.token !== ''
    ? onePasswordProvider({ vault: opts.config.vault, item: opts.config.item, token: opts.token })
    : nullProvider()

  const action = sub ?? 'list'

  if (action === 'check') {
    const c = await provider.check()
    if (io.json) emitJson('secrets', { ok: c.ok, detail: c.detail }, io)
    else line(`${c.ok ? pc.green('✓') : pc.red('✗')} ${c.detail}`, io)
    return c.ok ? EXIT.OK : EXIT.ERROR
  }

  if (action === 'list') {
    const blob = await provider.read()
    // Key names only. A value is never printed, in any mode.
    const servers = Object.entries(blob.mcp)
      .map(([id, v]) => ({ id, keys: Object.keys(v.env).sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))

    if (io.json) {
      emitJson('secrets', { vault: opts.config.vault, item: opts.config.item, servers }, io)
    } else if (servers.length === 0) {
      line('No secrets stored.', io)
    } else {
      for (const s of servers) line(`  ${s.id.padEnd(24)} ${pc.dim(s.keys.join(', '))}`, io)
    }
    return EXIT.OK
  }

  const msg = `unknown subcommand ${action}; expected list or check`
  if (io.json) emitJsonError('secrets', msg, io)
  else process.stderr.write(`oneset: ${msg}\n`)
  return EXIT.ERROR
}
