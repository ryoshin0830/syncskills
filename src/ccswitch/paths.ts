import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CcPaths {
  /** cc-switch's configuration home, normally ~/.cc-switch */
  home: string
  /** The SQLite database holding skills, MCP servers and repositories */
  db: string
  /** The directory holding skill content; app skill dirs symlink into it */
  skillsDir: string
}

/**
 * cc-switch honours CC_SWITCH_CONFIG_DIR and CC_SWITCH_TEST_HOME, which is what
 * lets the integration tests point it at a throwaway home instead of the user's.
 */
export function resolveCcPaths(env: NodeJS.ProcessEnv = process.env): CcPaths {
  const home = env.CC_SWITCH_CONFIG_DIR ?? env.CC_SWITCH_TEST_HOME ?? join(env.HOME ?? homedir(), '.cc-switch')
  return { home, db: join(home, 'cc-switch.db'), skillsDir: join(home, 'skills') }
}
