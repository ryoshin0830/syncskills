export interface Envelope {
  schemaVersion: 1
  ok: boolean
  command: string
  data: unknown
  warnings: string[]
  error?: string
}

export interface Io {
  json: boolean
  quiet: boolean
  verbose: boolean
  warnings: string[]
}

/**
 * `ok` mirrors the exit code, so a script can branch on either and get the same
 * answer. A command that ends in a conflict or a refusal reports ok: false even
 * though it produced a complete, well-formed result.
 */
export function emitJson(command: string, data: unknown, io: Io, ok = true): void {
  const env: Envelope = {
    schemaVersion: 1, ok, command, data, warnings: io.warnings,
  }
  process.stdout.write(JSON.stringify(env, null, 2) + '\n')
}

export function emitJsonError(command: string, message: string, io: Io): void {
  const env: Envelope = {
    schemaVersion: 1, ok: false, command, data: null, warnings: io.warnings, error: message,
  }
  process.stdout.write(JSON.stringify(env, null, 2) + '\n')
}

export function line(text: string, io: Io): void {
  if (!io.quiet) process.stdout.write(text + '\n')
}
