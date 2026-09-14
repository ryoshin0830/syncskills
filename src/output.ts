import pc from 'picocolors'

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

export function emitJson(command: string, data: unknown, io: Io): void {
  const env: Envelope = {
    schemaVersion: 1, ok: true, command, data, warnings: io.warnings,
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

export function detail(text: string, io: Io): void {
  if (io.verbose && !io.quiet) process.stdout.write(pc.dim(text) + '\n')
}
