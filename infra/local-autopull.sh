#!/usr/bin/env bash
# Keeps a local clone in step with origin/main. Fast-forward only, and only when main is checked out and the working tree is clean:
# it never merges, rebases, stashes or touches uncommitted or unpushed work (those cases are skipped and logged).
#
#   infra/local-autopull.sh --install     # systemd --user timer for THIS clone, every 2 minutes
#   infra/local-autopull.sh --uninstall
#   journalctl --user -u brianotron-autopull -f
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT=brianotron-autopull

if [ "${1:-}" = --install ]; then
  d="$HOME/.config/systemd/user"; mkdir -p "$d"
  cat > "$d/$UNIT.service" <<UNITFILE
[Unit]
Description=Fast-forward $REPO to origin/main
[Service]
Type=oneshot
ExecStart=/bin/bash $REPO/infra/local-autopull.sh
UNITFILE
  cat > "$d/$UNIT.timer" <<UNITFILE
[Unit]
Description=Fast-forward $REPO to origin/main every 2 minutes
[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNITFILE
  systemctl --user daemon-reload && systemctl --user enable --now "$UNIT.timer" && systemctl --user list-timers "$UNIT.timer" --no-pager | head -2
  exit $?
fi
if [ "${1:-}" = --uninstall ]; then
  systemctl --user disable --now "$UNIT.timer" 2>/dev/null; rm -f "$HOME/.config/systemd/user/$UNIT."{service,timer}; systemctl --user daemon-reload; exit 0
fi

cd "$REPO" || exit 0
[ -d .git ] || [ -f .git ] || exit 0
git fetch -q origin main 2>/dev/null || { echo "fetch failed"; exit 0; }
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
[ "$(git symbolic-ref --short -q HEAD)" = main ] || { echo "skip: not on main"; exit 0; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "skip: uncommitted changes"; exit 0; }
git merge-base --is-ancestor HEAD origin/main || { echo "skip: local main has commits origin does not (push or merge by hand)"; exit 0; }
n="$(git rev-list --count HEAD..origin/main)"
git merge -q --ff-only origin/main && echo "fast-forwarded $n commit(s): $(git log -1 --format='%h %an: %s' | cut -c1-100)"
command -v notify-send >/dev/null && notify-send "Brianotron repo updated" "$n new commit(s) from origin/main" 2>/dev/null || true
