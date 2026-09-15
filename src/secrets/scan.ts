const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: '1Password service account token', re: /\bops_[A-Za-z0-9+/=_-]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/** A long, mixed value assigned to a credential-named field. */
const ASSIGNED =
  /"[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*"\s*:\s*"([^"]{24,})"/gi

function looksRandom(s: string): boolean {
  if (/^\$\{[^}]+\}$/.test(s)) return false            // ${VAR} placeholder
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(s)) return false // $VAR
  if (/^sha256:[0-9a-f]{64}$/.test(s)) return false     // our own content hash
  if (/^op:\/\//.test(s)) return false                   // a 1Password reference
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false
  return new Set(s).size >= 16
}

/**
 * The last line of defence before a push. The stripping in ccswitch/read.ts is
 * the primary protection; this exists to catch a bug in that stripping, because
 * a credential that reaches a git history cannot be taken back.
 */
export function scanForSecrets(text: string): string[] {
  const found: string[] = []
  for (const p of PATTERNS) {
    if (p.re.test(text)) found.push(`possible ${p.name}`)
  }
  for (const m of text.matchAll(ASSIGNED)) {
    if (looksRandom(m[1]!)) {
      found.push('high-entropy value assigned to a credential-named field')
    }
  }
  return [...new Set(found)]
}
