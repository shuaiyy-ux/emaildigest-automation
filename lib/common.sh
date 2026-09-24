#!/bin/bash

log() {
    local level="$1"; shift
    local now; now="$(date '+%Y-%m-%d %H:%M:%S')"
    local log_file="$EMAILDIGEST_LOG_DIR/${now%% *}.log"
    echo "[$now] [$level] $*" >> "$log_file"
    if [[ "$level" == "ERROR" ]]; then
        echo "[$now] [$level] $*" >&2
    fi
}

# Gmail search uses YYYY/MM/DD format
get_search_date() {
    local hours="${1:-$EMAILDIGEST_DEFAULT_HOURS}"
    if [[ "$(uname)" == "Darwin" ]]; then
        date -v-"${hours}"H "+%Y/%m/%d"
    else
        date -d "${hours} hours ago" "+%Y/%m/%d"
    fi
}

check_dependencies() {
    local missing=()
    command -v claude &>/dev/null || missing+=("claude")
    command -v jq &>/dev/null || missing+=("jq")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "Error: missing dependencies: ${missing[*]}" >&2
        echo "Install them and retry." >&2
        exit 1
    fi
}

run_claude() {
    local prompt="$1"
    local prompt_file="${2:-}"
    local budget="${3:-$EMAILDIGEST_MAX_BUDGET}"
    local output_format="${4:-text}"

    local tools_readonly="mcp__claude_ai_Gmail__gmail_search_messages,mcp__claude_ai_Gmail__gmail_read_message,mcp__claude_ai_Gmail__gmail_read_thread,mcp__claude_ai_Gmail__gmail_get_profile,mcp__claude_ai_Gmail__gmail_list_labels,mcp__claude_ai_Gmail__gmail_list_drafts"
    local tools_full="${tools_readonly},mcp__claude_ai_Gmail__gmail_create_draft"
    local tools="${tools_full}"
    if [[ -n "${EMAILDIGEST_READONLY:-}" ]]; then
        tools="${tools_readonly}"
    fi

    # Locked down like lib/claude-cli.ts, except --strict-mcp-config: this
    # owner-only CLI exists to use the claude.ai Gmail connector, which strict
    # mode would unload. The prompt goes on stdin so it is never parsed as a flag.
    local -a cmd=(
        claude -p
        --model "$EMAILDIGEST_MODEL"
        --max-budget-usd "$budget"
        --tools ""
        --setting-sources ""
        --disable-slash-commands
        --permission-mode dontAsk
        --allowedTools "$tools"
    )

    if [[ -f "$SCRIPT_DIR/lib/safety.txt" ]]; then
        cmd+=(--append-system-prompt "$(cat "$SCRIPT_DIR/lib/safety.txt")")
    fi

    if [[ -n "$prompt_file" && -f "$prompt_file" ]]; then
        cmd+=(--append-system-prompt "$(cat "$prompt_file")")
    fi

    if [[ "$output_format" == "json" ]]; then
        cmd+=(--output-format json)
    fi

    local log_file="$EMAILDIGEST_LOG_DIR/$(date '+%Y-%m-%d').log"
    log "INFO" "Calling claude: ${prompt:0:200}..."
    log "INFO" "Budget limit: \$${budget}"

    # Empty working directory: no CLAUDE.md or repo files in the session.
    local workdir="${EMAILDIGEST_CLAUDE_CWD:-${TMPDIR:-/tmp}/emaildigest-claude-cwd}"
    mkdir -p "$workdir"

    local result exit_code=0
    result=$(cd "$workdir" && printf '%s' "$prompt" | "${cmd[@]}" 2>>"$log_file") || exit_code=$?

    if [[ $exit_code -ne 0 ]]; then
        log "ERROR" "claude exit code: $exit_code"
        echo "Error: Claude invocation failed (exit code: $exit_code)" >&2
        return $exit_code
    fi

    if [[ "$output_format" == "json" ]]; then
        echo "$result" | jq -r '.result // .'
    else
        echo "$result"
    fi

    log "INFO" "Call complete"
}

parse_common_args() {
    HOURS="$EMAILDIGEST_DEFAULT_HOURS"
    BUDGET="$EMAILDIGEST_MAX_BUDGET"
    EXTRA_ARGS=()

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --hours)
                [[ $# -ge 2 ]] || { echo "Error: --hours requires an argument" >&2; exit 1; }
                HOURS="$2"; shift 2 ;;
            --budget)
                [[ $# -ge 2 ]] || { echo "Error: --budget requires an argument" >&2; exit 1; }
                BUDGET="$2"; shift 2 ;;
            *)
                EXTRA_ARGS+=("$1"); shift ;;
        esac
    done
}
