#!/usr/bin/env bash
# One-time setup of pull-based auto-deploy ON the production box (see infra/autodeploy.sh). Idempotent. Run as the deploy user
# (ubuntu, in the docker group, with sudo):
#
#   bash /opt/keystone/infra/autodeploy-install.sh [dir] [repo-url] [branch] [sha-running-now]
#
# Makes $dir a git checkout of the public repo (untracked files such as .env are never touched), records which commit is running
# now, and installs + starts keystone-autodeploy.timer (every minute). Remove: sudo systemctl disable --now keystone-autodeploy.timer
set -euo pipefail
DIR="${1:-/opt/keystone}"
REPO="${2:-https://github.com/Blean69/HackUTD-2026-v2.git}"
BRANCH="${3:-main}"
RUNNING="${4:-}"
RUN_AS="$(id -un)"

cd "$DIR"
if [ ! -d .git ]; then
  git init -q
  git remote add origin "$REPO"
else
  git remote set-url origin "$REPO"
fi
git fetch -q origin "$BRANCH"
mkdir -p .autodeploy
if [ ! -f .autodeploy/deployed ]; then
  # The tree was rsynced by infra/deploy.sh; align git with it. Tracked files only: .env and other untracked files stay.
  git reset -q --hard "${RUNNING:-origin/$BRANCH}"
  git rev-parse HEAD > .autodeploy/deployed
fi
echo "running now: $(cut -c1-7 .autodeploy/deployed); origin/$BRANCH: $(git rev-parse --short "origin/$BRANCH")"

sudo tee /etc/systemd/system/keystone-autodeploy.service >/dev/null <<UNIT
[Unit]
Description=Brianotron auto-deploy: origin/$BRANCH -> this box (infra/autodeploy.sh)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_AS
Environment=KEYSTONE_DIR=$DIR AUTODEPLOY_BRANCH=$BRANCH
# Always run the pipeline script from the newest origin commit (so it can update itself, and works on a checkout that predates it).
ExecStart=/bin/bash -c 'git -C $DIR fetch -q origin $BRANCH && git -C $DIR show origin/$BRANCH:infra/autodeploy.sh > $DIR/.autodeploy/run.sh && exec /bin/bash $DIR/.autodeploy/run.sh'
TimeoutStartSec=1800
Nice=5
UNIT

sudo tee /etc/systemd/system/keystone-autodeploy.timer >/dev/null <<UNIT
[Unit]
Description=Check origin/$BRANCH for new commits every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
AccuracySec=5s
Unit=keystone-autodeploy.service

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now keystone-autodeploy.timer
systemctl list-timers keystone-autodeploy.timer --no-pager | head -3
