#!/usr/bin/env bash
# Pull-based continuous deployment. Runs ON the production box from a systemd timer (keystone-autodeploy.timer, every minute;
# installed by infra/autodeploy-install.sh). Nothing is pushed to the box and no secret leaves it: the box reads the public GitHub
# repo, and .env (production secrets) stays where it is, untracked.
#
# On a new commit on origin/$AUTODEPLOY_BRANCH:
#   1. check out the commit (tracked files only; .env and other untracked files are never touched)
#   2. spacetime/ changed: build the module in a throwaway node container and publish it FIRST, then set the worker-secret hash.
#      A publish that fails (a breaking schema change) stops here: the running containers are left alone.
#   3. docker compose up -d --build (compose only recreates services whose image or config changed, so a web-only change does not
#      drop phone calls)
#   4. health checks (worker connected to SpacetimeDB, voice, web); unhealthy after HEALTH_SECS -> roll back to the previous images
#   5. seed data or seed code changed: npm run seed (idempotent)
# A commit that failed is remembered and not retried; the next commit is tried normally.
#
# Pause (judging!): touch /opt/keystone/.autodeploy-paused     Resume: rm /opt/keystone/.autodeploy-paused
# Logs: journalctl -u keystone-autodeploy -f        Manual run: sudo systemctl start keystone-autodeploy
#
# The whole script is one function, read by bash before it runs, so checking out a new version of this file mid-run is safe.
main() {
  set -uo pipefail
  local DIR="${KEYSTONE_DIR:-/opt/keystone}" BRANCH="${AUTODEPLOY_BRANCH:-main}" HEALTH_SECS="${AUTODEPLOY_HEALTH_SECS:-150}"
  local STATE="$DIR/.autodeploy"
  cd "$DIR" || { echo "no $DIR"; return 1; }
  mkdir -p "$STATE"
  exec 9>"$STATE/lock"
  flock -n 9 || return 0
  if [ -f "$DIR/.autodeploy-paused" ]; then return 0; fi

  git fetch -q origin "$BRANCH" 2>/dev/null || { echo "git fetch failed (network?); will retry"; return 0; }
  local NEW OLD
  NEW="$(git rev-parse "origin/$BRANCH")"
  OLD="$(cat "$STATE/deployed" 2>/dev/null || git rev-parse HEAD)"
  [ "$NEW" = "$OLD" ] && return 0
  [ "$NEW" = "$(cat "$STATE/failed" 2>/dev/null)" ] && return 0

  log() { echo "[autodeploy ${NEW:0:7}] $*"; }
  local CHANGED
  if git cat-file -e "${OLD%-dirty}^{commit}" 2>/dev/null; then
    CHANGED="$(git diff --name-only "${OLD%-dirty}" "$NEW")"
  else
    CHANGED="ALL"
  fi
  changed() { [ "$CHANGED" = ALL ] || grep -qE "$1" <<<"$CHANGED"; }
  log "deploying $(git log -1 --format='%an: %s' "$NEW" | cut -c1-120) (was ${OLD:0:7})"

  local PREV_HEAD
  PREV_HEAD="$(git rev-parse HEAD)"
  fail() {
    log "FAILED: $*. Production keeps running the previous version."
    echo "$NEW" > "$STATE/failed"
    git reset -q --hard "$PREV_HEAD"
  }
  git reset -q --hard "$NEW" || { fail "git checkout"; return 1; }

  local DB WORKER_SECRET HASH
  DB="$(grep -E '^SPACETIME_DB=' .env | tail -1 | cut -d= -f2- | tr -d "\"'" )"; DB="${DB:-keystone}"

  # ---- 2. module first --------------------------------------------------------------------------------------------------------
  if changed '^spacetime/'; then
    log "spacetime/ changed: building the module"
    # the image's /usr/local/bin/spacetime is a symlink: copy the real CLI binary (a regular file) so it can be bind-mounted
    [ -f "$STATE/spacetime" ] && [ ! -L "$STATE/spacetime" ] || { rm -f "$STATE/spacetime"; docker cp keystone-spacetime-1:/opt/spacetime/spacetimedb-cli "$STATE/spacetime"; } || { fail "copying the spacetime CLI"; return 1; }
    if ! docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/npm \
        -v "$DIR/spacetime:/src" -v "$STATE/spacetime:/usr/local/bin/spacetime:ro" -w /src node:22-bookworm \
        sh -c 'npm ci --no-audit --no-fund --loglevel=error && spacetime build -p .' 2>&1 | tail -n 5; then
      fail "module build"; return 1
    fi
    [ -f spacetime/dist/bundle.js ] || { fail "module build produced no bundle"; return 1; }
    log "publishing the module to $DB (non-breaking only)"
    docker cp spacetime/dist/bundle.js keystone-spacetime-1:/tmp/bundle.js || { fail "copying the bundle"; return 1; }
    if ! docker exec keystone-spacetime-1 spacetime publish -s local -j /tmp/bundle.js "$DB" -y </dev/null 2>&1 | tail -n 3; then
      fail "module publish (breaking schema change? that needs a manual deploy with a data wipe)"; return 1
    fi
    WORKER_SECRET="$(grep -E '^WORKER_SECRET=' .env | tail -1 | cut -d= -f2- | tr -d "\"'")"
    HASH="$(printf '%s' "$WORKER_SECRET" | sha256sum | cut -d' ' -f1)"; WORKER_SECRET=""
    docker exec keystone-spacetime-1 spacetime call -s local "$DB" admin_set_worker_secret_hash "\"$HASH\"" </dev/null >/dev/null 2>&1 \
      && log "worker-secret hash set" || log "warning: could not set the worker-secret hash"
  fi

  # ---- 3. containers ----------------------------------------------------------------------------------------------------------
  local svc
  for svc in web worker voice tools; do docker tag "keystone-$svc:latest" "keystone-$svc:prev" 2>/dev/null || true; done
  if ! infra/dc up -d --build --remove-orphans </dev/null >"$STATE/compose.log" 2>&1; then
    tail -n 15 "$STATE/compose.log"
    fail "docker compose build/up"; return 1
  fi
  grep -E "Recreated|Started" "$STATE/compose.log" | tail -n 8

  # ---- 4. health --------------------------------------------------------------------------------------------------------------
  local t=0 ok=0 w v web
  while [ "$t" -lt "$HEALTH_SECS" ]; do
    w="$(curl -fsS -m 4 http://127.0.0.1:8787/health 2>/dev/null | jq -r '.spacetime // empty' 2>/dev/null)"
    v="$(curl -fsS -m 4 http://127.0.0.1:7860/health 2>/dev/null | jq -r '.ok // empty' 2>/dev/null)"
    web="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' keystone-web-1 2>/dev/null)"
    if [ "$w" = connected ] && [ "$v" = true ] && { [ "$web" = healthy ] || [ "$web" = running ]; }; then ok=1; break; fi
    sleep 5; t=$((t + 5))
  done
  if [ "$ok" != 1 ]; then
    log "unhealthy after ${HEALTH_SECS}s (worker=${w:-down} voice=${v:-down} web=${web:-?}): rolling back to the previous images"
    for svc in web worker voice tools; do docker tag "keystone-$svc:prev" "keystone-$svc:latest" 2>/dev/null || true; done
    fail "health check"
    infra/dc up -d --no-build </dev/null >/dev/null 2>&1 || true
    return 1
  fi

  # ---- 5. seed ----------------------------------------------------------------------------------------------------------------
  if changed '^data/seed/|^services/worker/src/seed\.ts$'; then
    log "seed data changed: npm run seed"
    infra/dc exec -T worker npm run seed </dev/null 2>&1 | tail -n 2 || log "warning: seed failed"
  fi

  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -f --filter 'until=48h' >/dev/null 2>&1 || true
  echo "$NEW" > "$STATE/deployed"
  rm -f "$STATE/failed"
  log "live in ${t}s of health checks"
}
main "$@"
exit $?
