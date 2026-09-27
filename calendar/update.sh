#!/usr/bin/env bash
# Pull-deploy for the calendar MCP server of the gaffer Hermes profile on hostinger-1.
#
# Runs inside the Hermes container as user hermes, started by host cron every 15 minutes:
#   docker exec -u hermes hermes-agent-ldox-hermes-agent-1 /opt/data/profiles/gaffer/calendar/bin/update.sh
#
# When main on GitHub has a commit that is not live yet, it installs that commit into
# releases/<sha> with npm ci, makes one real list-calendars call, and only then points
# `current` at it and restarts the gateway. On any failure the running release stays live,
# the commit is marked failed (not retried; delete releases/<sha>.failed to retry), and a
# Telegram message goes out. Keeps the live release and the one before it.
#
# Testing: CALENDAR_UPDATE_REF=<branch> reads that branch instead of main. Run it by hand only.

set -uo pipefail

REPO=Mwalek/hermes-mcp-servers
REF=${CALENDAR_UPDATE_REF:-main}
BASE=/opt/data/profiles/gaffer/calendar
REL=$BASE/releases
ACCOUNT=bosunsmailbag@gmail.com
LOG=/opt/data/profiles/gaffer/logs/calendar-update.log

export GOOGLE_OAUTH_CREDENTIALS=$BASE/gcp-oauth.keys.json
export GOOGLE_CALENDAR_MCP_TOKEN_PATH=$BASE/tokens.json

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG"; }
notify() {
  log "$*"
  local subject="Calendar MCP upgrade"
  # A run against another branch is a test; say so, so it never reads like a real failure.
  [ "$REF" = main ] || subject="[TEST: $REF] Calendar MCP upgrade"
  (cd /tmp && hermes -p gaffer send --to telegram -q -s "$subject" "$*") >> "$LOG" 2>&1 \
    || log "telegram notice failed"
}

# One run at a time.
exec 9> "$BASE/update.lock"
flock -n 9 || exit 0

mkdir -p "$REL"

sha=$(curl -fsS --max-time 20 "https://api.github.com/repos/$REPO/commits/$REF" | jq -r .sha 2>/dev/null)
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  log "could not read $REF of $REPO; will try again next run"
  exit 0
fi

prev=$(readlink "$BASE/current" 2>/dev/null); prev=${prev##*/}
[ "$sha" = "$prev" ] && exit 0
[ -e "$REL/$sha.failed" ] && exit 0

dir=$REL/$sha
fail() {
  touch "$REL/$sha.failed"
  rm -rf "$dir"
  notify "Upgrade to ${sha:0:7} failed: $1. Still running ${prev:0:7}. Log: $LOG"
  exit 1
}

log "$REF is ${sha:0:7}, live is ${prev:-none}; installing"
rm -rf "$dir" && mkdir -p "$dir"

for f in package.json package-lock.json probe.mjs; do
  curl -fsS --max-time 30 -o "$dir/$f" "https://raw.githubusercontent.com/$REPO/$sha/calendar/$f" \
    || fail "download of $f"
done

(cd "$dir" && npm ci --no-fund --no-audit >> "$LOG" 2>&1) || fail "npm ci"

result=$(cd "$dir" && node probe.mjs call "$ACCOUNT" 2>/dev/null) || fail "real call: $result"
log "$result"

# Switch atomically: a new link, renamed over the old one.
ln -sfn "releases/$sha" "$BASE/current.new" && mv -Tf "$BASE/current.new" "$BASE/current" \
  || fail "switching the current link"

if ! (cd /tmp && hermes -p default gateway restart >> "$LOG" 2>&1); then
  notify "${sha:0:7} is installed and linked, but the gateway restart failed. Log: $LOG"
  exit 1
fi

# Keep the live release and the previous one.
for d in "$REL"/*/; do
  d=${d%/}; name=${d##*/}
  [ "$name" = "$sha" ] || [ "$name" = "$prev" ] || rm -rf "$d"
done

notify "Upgraded to ${sha:0:7} (was ${prev:0:7}). ${result}"
