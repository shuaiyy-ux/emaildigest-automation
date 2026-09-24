#!/bin/bash
# EmailDigest configuration file
# Edit the variables below to match your environment

# ===== Basic settings =====
EMAILDIGEST_MODEL="sonnet"                # Model: sonnet (fast/cheap) or opus (stronger/pricier)
EMAILDIGEST_DEFAULT_HOURS=24              # Default hours to look back
EMAILDIGEST_MAX_BUDGET="100.00"           # Max budget per invocation (USD); set high to effectively uncap
EMAILDIGEST_LOG_DIR="$SCRIPT_DIR/logs"    # Log directory

# ===== Mail settings =====
# Note: the UCI-Mail label and school email address are hardcoded directly in prompt files and TypeScript code

# ===== Email category labels =====
EMAILDIGEST_CATEGORIES="academic,assignment,job,admin,promotion,newsletter,social,notification,spam"

# ===== Scheduled jobs =====
EMAILDIGEST_CRON_DIGEST="0 8 * * 1-5"    # Weekday digest at 8 AM
EMAILDIGEST_CRON_CLASSIFY="0 */6 * * *"  # Classify every 6 hours
