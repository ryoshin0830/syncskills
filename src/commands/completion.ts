import { emitJson, emitJsonError, line } from '../output.js'
import { EXIT } from '../cli.js'
import type { Io } from '../output.js'

const COMMANDS =
  'init sync status push pull diff conflicts secrets doctor config completion help'
// Every flag any command takes. Completion is a menu, not a validator — which
// command accepts which is decided in dispatch, where a wrong one is refused.
const FLAGS =
  '--json --yes --dry-run --only --merge-agent --no-secrets --profile --config --version --verbose --quiet --no-tui --help'

const ZSH = `#compdef oneset
_oneset() {
  local -a cmds
  cmds=(${COMMANDS.split(' ').map((c) => `'${c}'`).join(' ')})
  _arguments -C '1:command:->cmd' '*::arg:->args'
  case $state in
    cmd) _describe 'command' cmds ;;
    args) _values 'flag' ${FLAGS.split(' ').map((f) => `'${f}'`).join(' ')} ;;
  esac
}
_oneset "$@"`

const BASH = `_oneset() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS}" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "${FLAGS}" -- "$cur") )
  fi
}
complete -F _oneset oneset`

const FISH = `complete -c oneset -f
${COMMANDS.split(' ').map((c) => `complete -c oneset -n __fish_use_subcommand -a ${c}`).join('\n')}
${FLAGS.split(' ').map((f) => `complete -c oneset -l ${f.replace(/^--/, '')}`).join('\n')}`

export function completionCommand(shell: string | undefined, io: Io): number {
  const scripts: Record<string, string> = { zsh: ZSH, bash: BASH, fish: FISH }

  if (shell === undefined || scripts[shell] === undefined) {
    const msg = `usage: oneset completion <zsh|bash|fish>`
    if (io.json) {
      emitJsonError('completion', msg, io)
    } else {
      process.stderr.write(`oneset: ${msg}\n`)
    }
    return EXIT.ERROR
  }

  if (io.json) {
    emitJson('completion', { shell, script: scripts[shell] }, io)
  } else {
    line(scripts[shell]!, io)
  }
  return EXIT.OK
}
