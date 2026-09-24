#!/bin/bash

parse_common_args "$@"

search_date="$(get_search_date "$HOURS")"
log "INFO" "Digest: lookback ${HOURS}h, start date $search_date"

prompt="Do the following:
1. Search unread emails since ${search_date}
2. Read the contents of each email
3. Classify by urgency (urgent/action/fyi/low)
4. Output a summary grouped by category along with brief statistics"

run_claude \
    "$prompt" \
    "$SCRIPT_DIR/lib/prompts/digest.txt" \
    "$BUDGET" \
    "text"
