#!/usr/bin/env bash
# Deploy Keystone to the EC2 box over SSH: rsync the repo + env file, then `docker compose up -d --build`
# (Caddy + web + worker + self-hosted SpacetimeDB). Run from anywhere on your laptop. See infra/DEPLOY.md.
#
#   infra/deploy.sh [-H <ip-or-dns>] [-i <key.pem>] [--publish] [--seed]
#   infra/deploy.sh --set-worker-hash          # only (re)set the worker-secret hash in the published module
#   infra/deploy.sh --rollback
#   infra/deploy.sh --maincloud      # DB on Maincloud: do not run the spacetime container
#
# Options
#   -H, --host HOST      SSH host: the Elastic IP or a DNS name      [env KEYSTONE_HOST, default 52.72.164.85]
#   -i, --key PATH       SSH private key (.pem)                      [env KEYSTONE_KEY, default ~/.ssh/keystone-hackutd.pem]
#   -u, --user NAME      SSH user (default: ubuntu)                  [env KEYSTONE_USER]
#       --dir PATH       install dir on the box (default /opt/keystone)  [env KEYSTONE_DIR]
#   -e, --env FILE       production env file to upload as <dir>/.env on the box (default: <repo>/.env.prod)
#       --maincloud      the database lives on Maincloud: start only caddy + web + worker (no spacetime container)
#       --publish        after the stack is up: `spacetime build` here, publish the bundle from inside the spacetime container
#                        (self-hosted DB only), then set the worker-secret hash (see --set-worker-hash)
#       --set-worker-hash  call the module's admin_set_worker_secret_hash with sha256(WORKER_SECRET from the env file),
#                        inside the spacetime container. Needs no source edit; the secret itself is never printed or sent
#       --seed           after the stack is up, run the worker seed once (needs the module published first)
#       --rollback       do not deploy: switch web+worker back to the images from the previous deploy
#       --skip-checks    skip the local .env sanity checks
#   -h, --help
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${KEYSTONE_HOST:-52.72.164.85}"                    # EC2 t3.medium Elastic IP (us-east-1)
KEY="${KEYSTONE_KEY:-$HOME/.ssh/keystone-hackutd.pem}"
SSH_USER="${KEYSTONE_USER:-ubuntu}"
ENV_FILE="$ROOT/.env.prod"
MAINCLOUD=0
SEED=0
PUBLISH=0
SET_HASH=0
ROLLBACK=0
CHECKS=1
REMOTE_DIR="${KEYSTONE_DIR:-/opt/keystone}"           # created and owned by ubuntu by the box's user-data
READY_MARKER="/var/lib/cloud/keystone-ready"          # touched by the user-data when Docker + swap are done

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { echo "deploy.sh: $*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    -H|--host) HOST="${2:?missing value for $1}"; shift 2 ;;
    -i|--key) KEY="${2:?missing value for $1}"; shift 2 ;;
    -u|--user) SSH_USER="${2:?missing value for $1}"; shift 2 ;;
    -e|--env) ENV_FILE="${2:?missing value for $1}"; shift 2 ;;
    --dir) REMOTE_DIR="${2:?missing value for $1}"; shift 2 ;;
    --maincloud) MAINCLOUD=1; shift ;;
    --seed) SEED=1; shift ;;
    --publish) PUBLISH=1; shift ;;
    --set-worker-hash) SET_HASH=1; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    --skip-checks) CHECKS=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$HOST" ] || die "need --host (or KEYSTONE_HOST)"
[ -n "$KEY" ] || die "need --key (or KEYSTONE_KEY)"
[ -f "$KEY" ] || die "ssh key not found: $KEY"
case "$REMOTE_DIR" in /*) ;; *) die "--dir must be an absolute path (is '$REMOTE_DIR')" ;; esac
if [ "$MAINCLOUD" = 1 ] && { [ "$PUBLISH" = 1 ] || [ "$SET_HASH" = 1 ]; }; then
  die "--publish / --set-worker-hash work inside the self-hosted spacetime container; with --maincloud use \`spacetime publish -s maincloud\` and \`spacetime call -s maincloud <db> admin_set_worker_secret_hash\` (DEPLOY.md)"
fi
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$PWD/$ENV_FILE" ;; esac

SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15)
TARGET="$SSH_USER@$HOST"
rssh() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
# ssh options as ONE string for rsync -e; the key path is quoted so spaces survive
RSYNC_SSH="ssh -i '$KEY' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -o ConnectTimeout=15"

# ---- rollback: no rsync, no build ------------------------------------------------------------------------------------
if [ "$ROLLBACK" = 1 ]; then
  log "Rolling back web + worker to the previous deploy's images on $HOST"
  rssh 'bash -s' -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
D=docker; docker info >/dev/null 2>&1 || D="sudo docker"
for svc in web worker; do
  $D image inspect "keystone-$svc:prev" >/dev/null 2>&1 || { echo "no keystone-$svc:prev image: nothing to roll back to" >&2; exit 1; }
  $D tag "keystone-$svc:prev" "keystone-$svc:latest"
done
# the voice service is optional (it came later): roll it back too when a previous image exists
if $D image inspect keystone-voice:prev >/dev/null 2>&1; then $D tag keystone-voice:prev keystone-voice:latest; fi
if [ "$D" = docker ]; then infra/dc up -d --no-build; else sudo infra/dc up -d --no-build; fi
echo "rolled back."
REMOTE
  exit 0
fi

# ---- local sanity checks on the env file (values are never printed) --------------------------------------------------
[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE  (create it: cp $ROOT/infra/env.prod.example $ROOT/.env.prod, then fill it in)"
[ -d "$ROOT/data/seed" ] || die "missing $ROOT/data/seed (the worker seed files)"

envval() { # last KEY=value in the file, minus quotes / trailing comment / CR; empty if absent. Never sourced or eval'd.
  local line
  line="$(grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 || true)"
  line="${line#*=}"
  line="$(printf '%s' "$line" | tr -d '\r' | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
  printf '%s' "$line"
}

if [ "$CHECKS" = 1 ]; then
  log "Checking $(basename "$ENV_FILE")"
  errs=0
  bad() { echo "  FAIL: $*" >&2; errs=$((errs + 1)); }
  PUB="$(envval PUBLIC_HOSTNAME)"
  SECRET="$(envval WORKER_SECRET)"
  DB="$(envval SPACETIME_DB)"
  WDB="$(envval NEXT_PUBLIC_SPACETIME_DB)"
  SURI="$(envval SPACETIME_URI)"
  WURI="$(envval NEXT_PUBLIC_SPACETIME_URI)"
  WURL="$(envval NEXT_PUBLIC_WORKER_URL)"

  { [ -n "$PUB" ] && [ "$PUB" != localhost ]; } || bad "PUBLIC_HOSTNAME must be your real DNS name (keystone.tenvor.io), not '${PUB:-empty}'"
  [ -n "$SECRET" ] || bad "WORKER_SECRET is empty"
  [ "$SECRET" != "keystone-dev-secret" ] || bad "WORKER_SECRET is still the public dev secret"
  [ "${#SECRET}" -ge 16 ] || bad "WORKER_SECRET is shorter than 16 characters (use: openssl rand -hex 32)"
  case "$SECRET" in *'$'*) bad "WORKER_SECRET contains a '\$' (compose would interpolate it)" ;; esac
  [ -n "$DB" ] && [ "$DB" = "$WDB" ] || bad "SPACETIME_DB ('${DB}') and NEXT_PUBLIC_SPACETIME_DB ('${WDB}') must be set and identical"
  [ "$WURL" = "https://$PUB/worker" ] || bad "NEXT_PUBLIC_WORKER_URL must be https://$PUB/worker (is '${WURL}')"
  if [ "$MAINCLOUD" = 0 ]; then
    [ "$SURI" = "ws://spacetime:3000" ] || bad "self-hosted DB: SPACETIME_URI must be ws://spacetime:3000 (is '${SURI}'); for Maincloud pass --maincloud"
    [ "$WURI" = "wss://$PUB" ] || bad "self-hosted DB: NEXT_PUBLIC_SPACETIME_URI must be wss://$PUB (is '${WURI}')"
  else
    case "$SURI" in wss://*) ;; *) bad "Maincloud: SPACETIME_URI must be wss://maincloud.spacetimedb.com (is '${SURI}')" ;; esac
    case "$WURI" in wss://*) ;; *) bad "Maincloud: NEXT_PUBLIC_SPACETIME_URI must be wss://maincloud.spacetimedb.com (is '${WURI}')" ;; esac
    [ "$WURI" != "wss://$PUB" ] || bad "Maincloud: NEXT_PUBLIC_SPACETIME_URI points at your own host"
  fi
  if [ "$errs" -gt 0 ]; then die "$errs check(s) failed (override with --skip-checks if you know better)"; fi
  echo "  ok"
fi

# ---- module publish + worker-secret hash (self-hosted DB: run inside the spacetime container) --------------------------
# The module's default worker-secret hash is the PUBLIC dev one. Production overrides it at runtime with the module's
# admin_set_worker_secret_hash reducer (callable only by the identity that published the database), so no source file is
# ever edited. The hash is derived here from WORKER_SECRET in the env file; the secret never leaves this shell, and
# only the hex digest is sent over ssh.
SECRET_SHA256=""
compute_worker_hash() {
  local secret; secret="$(envval WORKER_SECRET)"
  [ -n "$secret" ] || die "WORKER_SECRET is empty in $(basename "$ENV_FILE")"
  [ "$secret" != "keystone-dev-secret" ] || die "WORKER_SECRET in $(basename "$ENV_FILE") is still the public dev secret"
  SECRET_SHA256="$(printf '%s' "$secret" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1)"
  secret=""
  case "$SECRET_SHA256" in *[!0-9a-f]*|"") die "could not compute the SHA-256 of WORKER_SECRET" ;; esac
  [ "${#SECRET_SHA256}" -eq 64 ] || die "could not compute the SHA-256 of WORKER_SECRET"
}

db_name() { local n; n="$(envval SPACETIME_DB)"; printf '%s' "${n:-keystone}"; }

build_module() {
  command -v spacetime >/dev/null 2>&1 || die "--publish needs the spacetime CLI on this machine (it runs \`spacetime build\`); see DEPLOY.md step 3c"
  # A fresh checkout or git worktree has no spacetime/node_modules, and the build needs them.
  if [ ! -d "$ROOT/spacetime/node_modules" ]; then
    log "Installing module dependencies (npm ci in spacetime/)"
    ( cd "$ROOT/spacetime" && npm ci --no-audit --no-fund --loglevel=error ) || die "npm ci failed in spacetime/"
  fi
  log "Building the module (spacetime build -p spacetime)"
  ( cd "$ROOT" && spacetime build -p spacetime ) 2>&1 | tail -n 3
  [ "${PIPESTATUS[0]}" -eq 0 ] || die "spacetime build failed (see the lines above)"
  [ -f "$ROOT/spacetime/dist/bundle.js" ] || die "spacetime/dist/bundle.js was not produced by the build"
}

publish_module() {
  log "Publishing $(db_name) from inside the spacetime container (non-breaking: add -c always yourself only for a wipe)"
  rsync -a -e "$RSYNC_SSH" "$ROOT/spacetime/dist/bundle.js" "$TARGET:/tmp/keystone-bundle.js"
  rssh 'bash -s' -- "$REMOTE_DIR" "$(db_name)" <<'REMOTE'
set -euo pipefail
cd "$1"
D=docker; docker info >/dev/null 2>&1 || D="sudo docker"
DC="infra/dc"; [ "$D" = docker ] || DC="sudo infra/dc"
$DC up -d spacetime </dev/null   # no-op when it is already running; starts it on a first deploy
for i in $(seq 1 20); do
  $DC exec -T spacetime spacetime server ping local </dev/null >/dev/null 2>&1 && break
  echo "waiting for the spacetime container ($i/20)"; sleep 3
done
$DC cp /tmp/keystone-bundle.js spacetime:/tmp/bundle.js </dev/null
rm -f /tmp/keystone-bundle.js
$DC exec -T spacetime spacetime publish -s local -j /tmp/bundle.js "$2" -y </dev/null
REMOTE
}

set_worker_hash() {
  [ "$MAINCLOUD" = 0 ] || die "with --maincloud, set the hash yourself: spacetime call -s maincloud <db> admin_set_worker_secret_hash '\"<sha256 of WORKER_SECRET>\"' (DEPLOY.md, Maincloud box)"
  compute_worker_hash
  log "Setting the worker-secret hash in the module (sha256 ${SECRET_SHA256:0:8}...; the secret is not sent)"
  if ! rssh 'bash -s' -- "$REMOTE_DIR" "$(db_name)" "$SECRET_SHA256" <<'REMOTE'
set -uo pipefail
cd "$1"
D=docker; docker info >/dev/null 2>&1 || D="sudo docker"
DC="infra/dc"; [ "$D" = docker ] || DC="sudo infra/dc"
out="$($DC exec -T spacetime spacetime call -s local "$2" admin_set_worker_secret_hash "\"$3\"" </dev/null 2>&1)"; rc=$?
if [ $rc -ne 0 ]; then
  printf '%s\n' "$out" | grep -v "$3" >&2
  case "$out" in
    *"not allowed"*)
      echo "The spacetime container's CLI identity is not this database's publisher. If the database was published BEFORE the" >&2
      echo "admin reducer existed (init, which records the publisher, did not run), bootstrap once, then re-run --set-worker-hash:" >&2
      echo "  infra/dc exec -T spacetime spacetime call -s local $2 register_worker '\"keystone-dev-secret\"' '\"deploy\"'" >&2
      echo "(works only while no hash override exists yet; DEPLOY.md, 'Database published before the admin reducer')" >&2 ;;
  esac
  exit $rc
fi
echo "worker-secret hash set."
REMOTE
  then
    die "could not set the worker-secret hash"
  fi
}

# ---- wait for the box (first boot: cloud-init is still installing Docker) --------------------------------------------
log "Connecting to $TARGET"
rssh 'bash -s' -- "$READY_MARKER" "$REMOTE_DIR" <<'REMOTE'
set -u
for i in $(seq 1 90); do
  [ -f "$1" ] && command -v docker >/dev/null 2>&1 && break
  echo "waiting for first-boot setup ($1)... $i"; sleep 5
done
command -v docker >/dev/null 2>&1 && [ -f "$1" ] || { echo "first-boot setup not finished (docker / $1 missing): check /var/log/cloud-init-output.log on the box" >&2; exit 1; }
[ -d "$2" ] && [ -w "$2" ] || { echo "$2 does not exist or is not writable by $USER" >&2; exit 1; }
free -h | sed -n '1,3p'
REMOTE

# ---- hash only: no rsync, no build ------------------------------------------------------------------------------------
if [ "$SET_HASH" = 1 ] && [ "$PUBLISH" = 0 ] && [ "$SEED" = 0 ]; then
  set_worker_hash
  exit 0
fi

# Build the module before touching the box: a module that does not compile stops the deploy here.
if [ "$PUBLISH" = 1 ]; then build_module; fi

# ---- ship the code + env ---------------------------------------------------------------------------------------------
log "Syncing repo to $TARGET:$REMOTE_DIR"
rsync -az --delete -e "$RSYNC_SSH" \
  --exclude 'node_modules' --exclude '.next' --exclude '.git' --exclude '*.swp' --exclude '*.swo' \
  --exclude '.env' --exclude '.env.*' --exclude '__pycache__' --exclude '.venv' --exclude '.DS_Store' \
  --exclude '.cache' --exclude '.data' --exclude '.worker-token' --exclude '*.log' --exclude 'dist' \
  --exclude 'qr.png' \
  "$ROOT/" "$TARGET:$REMOTE_DIR/"

log "Uploading $(basename "$ENV_FILE") as $REMOTE_DIR/.env (mode 600)"
rsync -a --chmod=F600 -e "$RSYNC_SSH" "$ENV_FILE" "$TARGET:$REMOTE_DIR/.env"

# ---- module publish + worker-secret hash, BEFORE the new worker starts ------------------------------------------------
# A new worker subscribes to the new module's tables; started against the old module, every subscription fails ("no such
# table") and imports, agents and the phone PIN check all stop. Publishes are non-breaking (new tables and columns only), so
# the old worker keeps running fine against the new module until it is replaced below.
if [ "$PUBLISH" = 1 ]; then
  publish_module
  set_worker_hash
fi

# ---- build + start ---------------------------------------------------------------------------------------------------
log "docker compose up -d --build on the box (first build takes several minutes)"
rssh 'bash -s' -- "$MAINCLOUD" "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
MAINCLOUD="$1"
cd "$2"
chmod +x infra/dc infra/deploy.sh 2>/dev/null || true
D=docker; docker info >/dev/null 2>&1 || D="sudo docker"
DC="infra/dc"; [ "$D" = docker ] || DC="sudo infra/dc"
SERVICES=()                                                   # empty = every service, including spacetime
if [ "$MAINCLOUD" = 1 ]; then SERVICES=(caddy web worker voice); fi
# keep the images that are currently running so `deploy.sh --rollback` can go back one deploy
for svc in web worker voice; do $D tag "keystone-$svc:latest" "keystone-$svc:prev" 2>/dev/null || true; done
$DC up -d --build --remove-orphans "${SERVICES[@]}"
$DC ps
$D image prune -f >/dev/null || true
$D builder prune -f --filter 'until=48h' >/dev/null || true   # keep the 30 GB disk from filling up over many deploys
REMOTE

# ---- optional worker-secret hash (with --publish it was already set above) ---------------------------------------------
if [ "$PUBLISH" = 0 ] && [ "$SET_HASH" = 1 ]; then set_worker_hash; fi

# ---- optional seed ---------------------------------------------------------------------------------------------------
if [ "$SEED" = 1 ]; then
  log "Waiting for the worker to connect to SpacetimeDB, then seeding"
  rssh 'bash -s' -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
cd "$1"
D=docker; docker info >/dev/null 2>&1 || D="sudo docker"
DC="infra/dc"; [ "$D" = docker ] || DC="sudo infra/dc"
state=""
for i in $(seq 1 30); do
  state="$($DC exec -T worker node -e "fetch('http://127.0.0.1:8787/health').then(r=>r.json()).then(j=>process.stdout.write(String(j.spacetime)),()=>process.stdout.write('unreachable'))" </dev/null 2>/dev/null || true)"
  [ "$state" = connected ] && break
  echo "worker spacetime state: ${state:-unknown} (attempt $i/30)"; sleep 4
done
if [ "$state" != connected ]; then
  echo "worker never connected to SpacetimeDB. Last worker logs:" >&2
  $DC logs --tail=25 worker </dev/null >&2 || true
  echo "Did you publish the module and set the hash for THIS WORKER_SECRET (infra/deploy.sh --publish, or DEPLOY.md step 3)?" >&2
  exit 1
fi
# </dev/null: this script arrives on stdin, and docker exec would otherwise swallow the rest of it
$DC exec -T worker npm run seed </dev/null
REMOTE
fi

# ---- smoke test from the laptop (non-fatal: DNS may not have propagated yet) -----------------------------------------
PUBLIC="$(envval PUBLIC_HOSTNAME 2>/dev/null || true)"
if [ -n "${PUBLIC:-}" ] && [ "$PUBLIC" != localhost ] && command -v curl >/dev/null 2>&1; then
  log "Checking https://$PUBLIC/worker/health"
  ok=0
  for i in 1 2 3 4 5 6 7 8; do
    if out="$(curl -fsS -m 10 "https://$PUBLIC/worker/health" 2>/dev/null)"; then echo "$out" | head -c 400; echo; ok=1; break; fi
    echo "not reachable yet (attempt $i/8; DNS or the certificate may still be settling)"; sleep 8
  done
  [ "$ok" = 1 ] || echo "WARNING: https://$PUBLIC/worker/health did not answer. Check: dig +short $PUBLIC ; infra/dc logs caddy (on the box)." >&2
fi

log "Done. Site: https://${PUBLIC:-<your-host>}/   Logs: ssh -i $KEY $TARGET '$REMOTE_DIR/infra/dc logs -f --tail=100 worker web caddy'"
