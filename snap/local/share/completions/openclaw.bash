# bash completion for openclaw
# Installed automatically by snapd via completer: in snapcraft.yaml.
# Update this file when new top-level commands or important subcommands are added.

_openclaw_completion() {
    local cur prev words cword
    _init_completion 2>/dev/null || {
        COMPREPLY=()
        cur="${COMP_WORDS[COMP_CWORD]}"
        prev="${COMP_WORDS[COMP_CWORD-1]}"
    }

    # All top-level commands
    local top_commands="setup onboard configure config backup doctor dashboard
        reset uninstall message memory agent agents status health sessions browser
        acp gateway daemon logs system models approvals nodes devices node sandbox
        tui cron dns docs hooks webhooks qr clawbot pairing plugins channels
        directory providers security secrets skills update completion
        --help --version"

    # Determine the first non-option word (the subcommand)
    local subcmd=""
    local i
    for (( i=1; i < COMP_CWORD; i++ )); do
        if [[ "${COMP_WORDS[i]}" != -* ]]; then
            subcmd="${COMP_WORDS[i]}"
            break
        fi
    done

    case "$subcmd" in
        config)
            COMPREPLY=( $(compgen -W "get set unset file validate --help" -- "$cur") )
            return 0
            ;;
        backup)
            COMPREPLY=( $(compgen -W "create verify status --help" -- "$cur") )
            return 0
            ;;
        gateway)
            COMPREPLY=( $(compgen -W "run status call usage-cost health probe discover --help" -- "$cur") )
            return 0
            ;;
        channels)
            COMPREPLY=( $(compgen -W "list status capabilities resolve logs add remove login logout --help" -- "$cur") )
            return 0
            ;;
        plugins)
            COMPREPLY=( $(compgen -W "list inspect enable disable uninstall install --help" -- "$cur") )
            return 0
            ;;
        message)
            COMPREPLY=( $(compgen -W "send broadcast poll react read edit delete pin search thread emoji sticker --help" -- "$cur") )
            return 0
            ;;
        memory)
            COMPREPLY=( $(compgen -W "status index search --help" -- "$cur") )
            return 0
            ;;
        agents)
            COMPREPLY=( $(compgen -W "list bindings bind unbind add set-identity delete --help" -- "$cur") )
            return 0
            ;;
        sessions)
            COMPREPLY=( $(compgen -W "cleanup --help" -- "$cur") )
            return 0
            ;;
        skills)
            COMPREPLY=( $(compgen -W "search install update list info check --help" -- "$cur") )
            return 0
            ;;
        update)
            COMPREPLY=( $(compgen -W "wizard status --help" -- "$cur") )
            return 0
            ;;
        completion)
            COMPREPLY=( $(compgen -W "--shell --install --write-state --yes --help" -- "$cur") )
            if [[ "$prev" == "--shell" || "$prev" == "-s" ]]; then
                COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "$cur") )
            fi
            return 0
            ;;
        models)
            COMPREPLY=( $(compgen -W "list set --help" -- "$cur") )
            return 0
            ;;
        daemon)
            COMPREPLY=( $(compgen -W "start stop restart status --help" -- "$cur") )
            return 0
            ;;
        acp)
            COMPREPLY=( $(compgen -W "client --help" -- "$cur") )
            return 0
            ;;
        providers)
            COMPREPLY=( $(compgen -W "list --help" -- "$cur") )
            return 0
            ;;
        security)
            COMPREPLY=( $(compgen -W "audit --help" -- "$cur") )
            return 0
            ;;
        secrets)
            COMPREPLY=( $(compgen -W "list set unset --help" -- "$cur") )
            return 0
            ;;
    esac

    # Top-level completion
    COMPREPLY=( $(compgen -W "$top_commands" -- "$cur") )
}

complete -F _openclaw_completion openclaw
