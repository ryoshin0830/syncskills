import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  // One file, no runtime dependencies: `npx syncskills` then has nothing to
  // resolve or install beyond the tarball itself. Splitting would also move the
  // entrypoint guard into a chunk, where import.meta.url no longer matches argv.
  splitting: false,
  noExternal: [/.*/],
  banner: { js: '#!/usr/bin/env node' },
})
