import { DatabaseSync } from 'node:sqlite'

const [, , db, kind, arg1, arg2] = process.argv
const ALL = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'grokbuild']
const d = new DatabaseSync(db)
const setsFor = (list) => ALL.map((a) => 'enabled_' + a + ' = ' + (list.includes(a) ? 1 : 0)).join(', ')

if (kind === 'deeplink') {
  const url = new URL(arg1)
  const apps = (url.searchParams.get('apps') ?? '').split(',').filter(Boolean)
  const doc = JSON.parse(Buffer.from(url.searchParams.get('config'), 'base64url').toString('utf8'))
  for (const [sid, cfg] of Object.entries(doc.mcpServers)) {
    const row = d.prepare('SELECT id FROM mcp_servers WHERE id = ?').get(sid)
    if (row === undefined) {
      const cols = ALL.map((a) => 'enabled_' + a).join(',')
      const vals = ALL.map((a) => (apps.includes(a) ? 1 : 0)).join(',')
      d.prepare('INSERT INTO mcp_servers (id,name,server_config,' + cols + ') VALUES (?,?,?,' + vals + ')')
        .run(sid, sid, JSON.stringify(cfg))
    } else {
      // cc-switch's deeplink import is additive for apps and leaves the config alone.
      const on = ALL.filter((a) => apps.includes(a)).map((a) => 'enabled_' + a + ' = 1').join(', ')
      if (on.length > 0) d.prepare('UPDATE mcp_servers SET ' + on + ' WHERE id = ?').run(sid)
    }
  }
} else if (kind === 'repo') {
  const spec = arg1
  const verb = arg2
  const [owner, rest] = spec.split('/')
  const name = (rest ?? '').split('@')[0]
  const branch = spec.includes('@') ? spec.split('@')[1] : 'main'
  if (verb === 'remove') {
    d.prepare('DELETE FROM skill_repos WHERE owner = ? AND name = ?').run(owner, name)
  } else if (verb === 'enable' || verb === 'disable') {
    d.prepare('UPDATE skill_repos SET enabled = ? WHERE owner = ? AND name = ?')
      .run(verb === 'enable' ? 1 : 0, owner, name)
  } else {
    const existing = d.prepare('SELECT owner FROM skill_repos WHERE owner = ? AND name = ?').get(owner, name)
    if (existing === undefined) {
      d.prepare('INSERT INTO skill_repos (owner,name,branch,enabled) VALUES (?,?,?,1)').run(owner, name, branch)
    } else {
      d.prepare('UPDATE skill_repos SET branch = ? WHERE owner = ? AND name = ?').run(branch, owner, name)
    }
  }
} else if (kind === 'skill') {
  const list = (arg2 ?? '').split(',').filter(Boolean)
  const row = d.prepare('SELECT id FROM skills WHERE directory = ?').get(arg1)
  if (row === undefined) {
    const cols = ALL.map((a) => 'enabled_' + a).join(',')
    const vals = ALL.map((a) => (list.includes(a) ? 1 : 0)).join(',')
    d.prepare('INSERT INTO skills (id,name,directory,' + cols + ') VALUES (?,?,?,' + vals + ')')
      .run('local:' + arg1, arg1, arg1)
  } else {
    d.prepare('UPDATE skills SET ' + setsFor(list) + ' WHERE directory = ?').run(arg1)
  }
} else if (kind === 'mcp') {
  const list = (arg2 ?? '').split(',').filter(Boolean)
  d.prepare('UPDATE mcp_servers SET ' + setsFor(list) + ' WHERE id = ?').run(arg1)
}

d.close()
