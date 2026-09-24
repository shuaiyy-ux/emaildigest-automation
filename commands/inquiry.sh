#!/bin/bash

parse_common_args "$@"

if [[ ${#EXTRA_ARGS[@]} -eq 0 ]]; then
    echo "Error: provide a question" >&2
    echo "Usage: emaildigest inquiry \"your question\"" >&2
    exit 1
fi

question="${EXTRA_ARGS[*]}"
log "INFO" "Inquiry: $question"

run_claude \
    "$question" \
    "$SCRIPT_DIR/lib/prompts/inquiry.txt" \
    "$BUDGET" \
    "text"
