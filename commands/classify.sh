#!/bin/bash

parse_common_args "$@"

search_date="$(get_search_date "$HOURS")"
log "INFO" "Classify: lookback ${HOURS}h, start date $search_date"

prompt="Do the following:
1. Search emails since ${search_date}
2. Read each email
3. Classify each email into one of these categories: ${EMAILDIGEST_CATEGORIES}
4. Output the classification result as JSON"

run_claude \
    "$prompt" \
    "$SCRIPT_DIR/lib/prompts/classify.txt" \
    "$BUDGET" \
    "text"
