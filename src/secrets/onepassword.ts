import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../util/exec.js'
import { emptyBlob } from './provider.js'
import type { SecretBlob, SecretProvider } from './provider.js'

/**
 * Stores every MCP credential in a single 1Password secure note, reached with a
 * service-account token. One token on each machine restores everything, which
 * is why the git repository can stay completely free of secrets.
 */
export function onePasswordProvider(opts: {
  vault: string
  item: string
  token: string
  opBin?: string
}): SecretProvider {
  const bin = opts.opBin ?? 'op'
  const env = { OP_SERVICE_ACCOUNT_TOKEN: opts.token }

  const op = (args: string[], input?: string) =>
    run(bin, args, input === undefined ? { env } : { env, input })

  return {
    async check() {
      const who = await op(['whoami'])
      if (who.code !== 0) {
        return { ok: false, detail: `op whoami failed: ${who.stderr.trim() || 'is op installed?'}` }
      }
      const vaults = await op(['vault', 'list', '--format', 'json'])
      if (vaults.code !== 0) {
        return { ok: false, detail: `op vault list failed: ${vaults.stderr.trim()}` }
      }
      let names: string[]
      try {
        names = (JSON.parse(vaults.stdout) as { name: string }[]).map((v) => v.name)
      } catch {
        return { ok: false, detail: 'could not parse the vault list returned by op' }
      }
      return names.includes(opts.vault)
        ? { ok: true, detail: `vault "${opts.vault}" is reachable` }
        : {
            ok: false,
            detail: `vault "${opts.vault}" is not accessible with this token; ` +
                    `available: ${names.join(', ') || '(none)'}`,
          }
    },

    async read() {
      const r = await op(['read', `op://${opts.vault}/${opts.item}/notesPlain`])
      if (r.code !== 0) {
        // A missing item means no secrets are stored yet, which is the normal
        // state on a fresh setup — not an error.
        if (/isn't an item|not found|no item matched/i.test(r.stderr)) return emptyBlob()
        throw new Error(`op read failed: ${r.stderr.trim()}`)
      }
      const text = r.stdout.trim()
      if (text.length === 0) return emptyBlob()

      let parsed: SecretBlob
      try {
        parsed = JSON.parse(text) as SecretBlob
      } catch (e) {
        throw new Error(
          `the 1Password item "${opts.item}" in vault "${opts.vault}" does not contain valid ` +
          `JSON: ${(e as Error).message}. syncskills will not overwrite it; fix or rename it.`,
        )
      }
      if (parsed.schemaVersion !== 1) {
        throw new Error(`unsupported secret blob schema version ${parsed.schemaVersion}`)
      }
      if (parsed.mcp === null || typeof parsed.mcp !== 'object') {
        throw new Error(`the secret blob in "${opts.item}" has no mcp object`)
      }
      return parsed
    },

    async write(blob) {
      // op is explicit that sensitive values must go through a template file
      // rather than command arguments: argv is visible to any other process on
      // the machine via ps. The file is owner-only and removed straight after.
      const template = JSON.stringify({
        title: opts.item,
        category: 'SECURE_NOTE',
        fields: [
          {
            id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain',
            value: JSON.stringify(blob, null, 2),
          },
        ],
      })

      const dir = await mkdtemp(join(tmpdir(), 'syncskills-op-'))
      const file = join(dir, 'item.json')
      try {
        await writeFile(file, template, { mode: 0o600 })

        const exists = await op(['item', 'get', opts.item, '--vault', opts.vault, '--format', 'json'])
        // The template carries the title and category; passing either as a flag
        // as well is rejected as a conflicting definition.
        const args = exists.code === 0
          ? ['item', 'edit', opts.item, '--vault', opts.vault, '--template', file]
          : ['item', 'create', '--vault', opts.vault, '--template', file]

        const r = await op(args)
        if (r.code !== 0) {
          const verb = exists.code === 0 ? 'edit' : 'create'
          throw new Error(`op item ${verb} failed: ${r.stderr.trim()}`)
        }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}
