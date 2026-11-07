#!/bin/bash
# Cloud-init user-data for the Keystone box (AWS Lightsail Ubuntu 24.04, or EC2 Ubuntu 24.04).
# Runs once as root on first boot: 4 GB swap (so `next build` doesn't get OOM-killed on a 4 GB machine),
# Docker Engine + compose plugin from Docker's official apt repo, rsync, and the `ubuntu` user in the docker group.
# Progress log: /var/log/keystone-bootstrap.log   Done marker: /var/lib/cloud/instance/boot-finished (cloud-init)
set -euxo pipefail
exec > >(tee -a /var/log/keystone-bootstrap.log) 2>&1

export DEBIAN_FRONTEND=noninteractive

# --- 4 GB swap (idempotent) ---------------------------------------------------------------------------------------
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  [ -f /swapfile ] || { fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096; }
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=20' > /etc/sysctl.d/99-keystone-swap.conf
sysctl -p /etc/sysctl.d/99-keystone-swap.conf || true

# --- Docker Engine + buildx + compose plugin ----------------------------------------------------------------------
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Cap container log growth (a long event, three services, chatty agents).
cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
systemctl restart docker

usermod -aG docker ubuntu
mkdir -p /opt/keystone && chown ubuntu:ubuntu /opt/keystone

docker --version
docker compose version
free -h
touch /var/lib/cloud/keystone-ready
echo "keystone bootstrap complete"
