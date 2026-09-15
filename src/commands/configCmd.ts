import { configDir, loadConfig, saveConfig } from '../config.js'
import { emitJson, emitJsonError, line } from '../output.js'
import { EXIT } from '../cli.js'
import type { Config } from '../config.js'
import type { Io } from '../output.js'

const KEYS = ['host', 'owner', 'repo', 'branch', 'device', 'vault', 'item', 'secrets', 'excludes', 'remote'] as const
type Key = (typeof KEYS)[number]

function isKey(k: string): k is Key {
  return (KEYS as readonly string[]).includes(k)
}

export async function configCommand(
  dir: string, positionals: string[], io: Io,
): Promise<number> {
  const [sub, key, value] = positionals

  if (sub === 'path' || sub === undefined) {
    if (io.json) emitJson('config', { path: `${dir}/config.json`, dir }, io)
    else line(`${dir}/config.json`, io)
    return EXIT.OK
  }

  const config = await loadConfig(dir)
  if (config === null) {
    const msg = 'not initialized — run `oneset init`'
    if (io.json) emitJsonError('config', msg, io)
    else process.stderr.write(`oneset: ${msg}\n`)
    return EXIT.UNINITIALIZED
  }

  if (sub === 'get') {
    if (key === undefined || !isKey(key)) {
      const msg = `unknown key ${key ?? '(none)'}; valid keys: ${KEYS.join(', ')}`
      if (io.json) emitJsonError('config', msg, io)
      else process.stderr.write(`oneset: ${msg}\n`)
      return EXIT.ERROR
    }
    if (io.json) emitJson('config', { key, value: config[key] }, io)
    else line(String(Array.isArray(config[key]) ? (config[key] as string[]).join(',') : config[key]), io)
    return EXIT.OK
  }

  if (sub === 'set') {
    if (key === undefined || !isKey(key) || value === undefined) {
      const msg = `usage: oneset config set <key> <value>; valid keys: ${KEYS.join(', ')}`
      if (io.json) emitJsonError('config', msg, io)
      else process.stderr.write(`oneset: ${msg}\n`)
      return EXIT.ERROR
    }
    const next: Config = { ...config }
    if (key === 'secrets') next.secrets = value === 'true'
    else if (key === 'excludes') next.excludes = value === '' ? [] : value.split(',')
    else next[key] = value

    await saveConfig(dir, next)
    if (io.json) emitJson('config', { key, value: next[key] }, io)
    else line(`${key} = ${String(next[key])}`, io)
    return EXIT.OK
  }

  const msg = `unknown subcommand ${sub}; expected path, get or set`
  if (io.json) emitJsonError('config', msg, io)
  else process.stderr.write(`oneset: ${msg}\n`)
  return EXIT.ERROR
}

export { configDir }
