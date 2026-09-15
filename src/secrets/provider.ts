/**
 * Every MCP environment value lives here, in one blob, so that the git
 * repository can hold configuration without ever holding a credential.
 */
export interface SecretBlob {
  schemaVersion: 1
  mcp: Record<string, { env: Record<string, string> }>
}

export interface SecretProvider {
  read(): Promise<SecretBlob>
  write(blob: SecretBlob): Promise<void>
  check(): Promise<{ ok: boolean; detail: string }>
}

export function emptyBlob(): SecretBlob {
  return { schemaVersion: 1, mcp: {} }
}

/** Used by --no-secrets: values stay on this machine and nothing is stored. */
export function nullProvider(): SecretProvider {
  return {
    async read() { return emptyBlob() },
    async write() { /* deliberately does nothing */ },
    async check() { return { ok: true, detail: 'secrets disabled (--no-secrets)' } },
  }
}

/** Used by tests, so the whole engine can run without `op` installed. */
export function memoryProvider(initial: SecretBlob = emptyBlob()): SecretProvider {
  let current = structuredClone(initial)
  return {
    async read() { return structuredClone(current) },
    async write(b) { current = structuredClone(b) },
    async check() { return { ok: true, detail: 'in-memory provider' } },
  }
}
