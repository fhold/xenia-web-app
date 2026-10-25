#!/usr/bin/env bash
# Update an existing installation to the latest version.
#
#   ./update.sh            back up the database, pull, install, build, restart
#   ./update.sh --dry-run  only show what would happen
#
# Settings are taken from the environment, then from the systemd unit, then
# from the defaults in the README:
#   XENIA_SERVICE  systemd service name            (default xenia-app.service)
#   DB_PATH        database file                   (default backend/data/xenia.db)
#   PORT           port of the app, for the check  (default 3001)
#
# Your own commits are kept: the update is merged with them. Updates come from
# the remote "upstream" if there is one (a fork: origin is your fork, upstream
# the original), else from the branch this one tracks; XENIA_UPDATE_FROM=<ref>
# overrides both. If your commits conflict with the update, nothing is changed.
#
# The running app is not touched until everything is built. If a step fails,
# the script stops and prints how to go back.
set -euo pipefail

repo="$(cd "$(dirname "$0")" && pwd)"
cd "$repo"

dry=0
case "${1:-}" in
  "") ;;
  --dry-run) dry=1 ;;
  -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
esac

say()  { printf '\n== %s\n' "$*"; }
fail() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$dry" = 1 ]; then echo "  would run: $*"; else "$@"; fi; }

service="${XENIA_SERVICE:-xenia-app.service}"
has_service=0
if command -v systemctl >/dev/null 2>&1 &&
   systemctl list-unit-files "$service" --no-legend 2>/dev/null | grep -q .; then
  has_service=1
fi

# A value from the environment, else from the unit's Environment=, else default.
setting() {
  local name="$1" default="$2" value="${!1:-}"
  if [ -z "$value" ] && [ "$has_service" = 1 ]; then
    value="$(systemctl show -p Environment --value "$service" | tr ' ' '\n' |
             sed -n "s/^$name=//p" | tail -n1)"
  fi
  echo "${value:-$default}"
}
db_path="$(setting DB_PATH "$repo/backend/data/xenia.db")"
port="$(setting PORT 3001)"

# --- Checks -----------------------------------------------------------------
say "Checks"
command -v node >/dev/null || fail "node not found (Node.js 24 is required, see .nvmrc)"
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ] || fail "Node.js $node_major found, 24 or newer is required"

# Building as root leaves root-owned files the app user can no longer replace.
owner="$(stat -c %U "$repo/.git")"
[ "$(id -un)" = "$owner" ] ||
  fail "run this as '$owner' (the owner of the repository), not as $(id -un)"

[ -z "$(git status --porcelain --untracked-files=no)" ] ||
  fail "there are local changes to tracked files — commit or stash them first (git status)"

echo "  database: $db_path"
echo "  service:  $([ "$has_service" = 1 ] && echo "$service" || echo "none found — restart by hand")"

if [ -f "$db_path" ]; then
  open="$(node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    console.log(db.prepare("select count(*) n from shot where ended_at is null").get().n);
  ' "$db_path")"
  [ "$open" = 0 ] || fail "a brew is running — update after it has finished"
else
  echo "  (no database yet — nothing to back up)"
fi

# --- What is new ------------------------------------------------------------
say "Looking for a new version"
# A fork pulls from "upstream" (the original), a plain clone from its own branch.
if [ -n "${XENIA_UPDATE_FROM:-}" ]; then src="$XENIA_UPDATE_FROM"
elif git remote get-url upstream >/dev/null 2>&1; then src="upstream/main"
else src="@{u}"; fi
if [ "$src" = "@{u}" ]; then git fetch --quiet
else git fetch --quiet "${src%%/*}"; fi
old="$(git rev-parse HEAD)"
new="$(git rev-parse "$src" 2>/dev/null)" || fail "cannot find $src — set XENIA_UPDATE_FROM=<remote>/<branch>"
name="$src"; [ "$src" = "@{u}" ] && name="$(git rev-parse --abbrev-ref '@{u}')"
behind="$(git rev-list --count "$old..$new")"
# Anything here that the update lacks rules out a fast-forward; shown are only
# real changes, not the merges of earlier updates.
own="$(git rev-list --count "$new..$old")"
own_shown="$(git rev-list --count --no-merges "$new..$old")"
# The build records the commit it was made from. A checkout pulled by hand
# (e.g. to get this script) is newer than its build and gets built here.
stamp="$repo/backend/dist/.built-from"
built="$(cat "$stamp" 2>/dev/null || true)"
if [ "$behind" = 0 ]; then
  if [ "$built" = "$old" ]; then
    echo "  already up to date ($(git log -1 --format='%h %cs' HEAD))"
    exit 0
  fi
  echo "  code is current ($(git log -1 --format='%h %cs' HEAD)), but not built yet"
else
  echo "  $behind new commit(s) from $name:"
  git log --format='    %h %cs %s' "$old..$new" | head -n 20
  if [ "$own" != 0 ]; then
    echo "  your $own_shown own commit(s) are kept:"
    git log --no-merges --format='    %h %cs %s' "$new..$old" | head -n 20
    # Try the merge in memory first — on a conflict nothing is touched.
    if ! merged="$(git merge-tree --write-tree --name-only --no-messages "$old" "$new")"; then
      fail "your own commits conflict with the update in:
$(printf '%s\n' "$merged" | tail -n +2 | sed 's/^/    /')
  Nothing was changed. Merge by hand (git merge $name), resolve, commit,
  then run ./update.sh again."
    fi
  fi
fi

# --- Back up the database ---------------------------------------------------
backup=""
if [ -f "$db_path" ]; then
  say "Backing up the database"
  backup="$db_path.bak-$(date +%Y%m%d-%H%M%S)-before-update"
  if [ "$dry" = 1 ]; then
    echo "  would back up to $backup"
  else
    # An online backup — a plain copy of a WAL database can be inconsistent.
    node --no-warnings -e '
      const { DatabaseSync, backup } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      backup(db, process.argv[2]).then(() => db.close());
    ' "$db_path" "$backup"
    echo "  $backup"
  fi
fi

rollback() {
  printf '\nTo go back to the previous version:\n'
  if [ "$behind" != 0 ]; then
    printf '  cd %s && git reset --hard %s\n' "$repo" "${old:0:7}"
  else
    printf '  cd %s && git reflog   # find the commit before your last pull, then git reset --hard <it>\n' "$repo"
  fi
  printf '  (cd backend && npm ci && npm run build) && (cd frontend && npm ci && npm run build)\n'
  [ -n "$backup" ] && printf '  only if the new version has already run: stop the app, then\n    cp %s %s  (and delete %s-wal / -shm)\n' \
    "$backup" "$db_path" "$db_path"
  printf '  restart the app\n'
}
trap 'rc=$?; [ "$rc" = 0 ] || [ "$dry" = 1 ] || rollback' EXIT

# --- Update and build -------------------------------------------------------
if [ "$behind" != 0 ]; then
  say "Getting the new version"
  if [ "$own" = 0 ]; then run git merge --ff-only --quiet "$new"
  else run git merge --quiet --no-edit -m "Update from $name" "$new"; fi
fi

say "Installing dependencies and building"
for pkg in backend frontend; do
  echo "  $pkg"
  if [ "$dry" = 1 ]; then
    echo "  would run: npm ci && npm run build (in $pkg)"
  else
    (cd "$pkg" && npm ci --no-audit --no-fund --loglevel=error && npm run build) ||
      fail "$pkg did not build — the running app was not touched"
  fi
done

[ "$dry" = 1 ] || git rev-parse HEAD > "$stamp"

# --- Restart ----------------------------------------------------------------
if [ "$has_service" = 0 ]; then
  if [ "$dry" = 1 ]; then say "Dry run — nothing was changed"
  else say "Done — now restart the app (it still runs the old version)"; fi
  exit 0
fi

say "Restarting $service"
if [ "$(id -u)" = 0 ]; then run systemctl restart "$service"
else run sudo systemctl restart "$service"; fi

if [ "$dry" = 1 ]; then
  echo "  would wait for http://localhost:$port/health"
  say "Dry run — nothing was changed"
  exit 0
fi

for _ in $(seq 1 30); do
  if node -e 'fetch(process.argv[1]).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
       "http://localhost:$port/health"; then
    now="$(git rev-parse --short HEAD)"
    if [ "$behind" != 0 ]; then say "Updated ${old:0:7} → $now${backup:+ — backup: $backup}"
    else say "Built and restarted $now${backup:+ — backup: $backup}"; fi
    exit 0
  fi
  sleep 1
done
fail "the app does not answer on http://localhost:$port/health — check: journalctl -u $service"
