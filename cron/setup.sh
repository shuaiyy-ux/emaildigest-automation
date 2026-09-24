#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/config.sh"

EMAILDIGEST_BIN="$SCRIPT_DIR/emaildigest"
LOG_FILE="$EMAILDIGEST_LOG_DIR/cron.log"

echo "=== EmailDigest cron setup ==="
echo ""

# Show existing relevant cron entries
echo "Existing emaildigest entries in cron:"
crontab -l 2>/dev/null | grep emaildigest || echo "  (none)"
echo ""

# Entries to add
DIGEST_ENTRY="$EMAILDIGEST_CRON_DIGEST  $EMAILDIGEST_BIN digest >> $LOG_FILE 2>&1"
CLASSIFY_ENTRY="$EMAILDIGEST_CRON_CLASSIFY  $EMAILDIGEST_BIN classify >> $LOG_FILE 2>&1"

echo "The following cron entries will be added:"
echo ""
echo "  Digest:   $DIGEST_ENTRY"
echo "  Classify: $CLASSIFY_ENTRY"
echo ""
read -p "Confirm add? (y/N) " confirm

if [[ "$confirm" != [yY] ]]; then
    echo "Cancelled"
    exit 0
fi

# Add to crontab (keep existing entries, remove old emaildigest entries)
(crontab -l 2>/dev/null | grep -v "$EMAILDIGEST_BIN"; echo "$DIGEST_ENTRY"; echo "$CLASSIFY_ENTRY") | crontab -

echo ""
echo "✅ Cron entries added"
echo ""
echo "Verify:"
crontab -l | grep emaildigest
echo ""
echo "Log file: $LOG_FILE"
echo "To remove: run 'crontab -e' and delete the matching lines"
