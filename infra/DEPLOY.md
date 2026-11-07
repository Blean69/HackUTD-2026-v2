# Deploying Keystone to AWS

One EC2 box runs everything: **Caddy** (HTTPS) in front of **web** (Next.js), **worker** (agents + ASR) and a **self-hosted
SpacetimeDB**. Judges scan a QR code and use the app on their phones over HTTPS (the browser mic needs HTTPS).

```
phone ──https/wss──▶ Caddy :443 ──▶ web:3000                         (/)
                               ├──▶ worker:8787  (prefix /worker stripped)
                               └──▶ spacetime:3000                   (/v1/... client routes for everyone,
                                                                       publish/delete/logs only from ADMIN_IPS)
worker ──ws://spacetime:3000 (inside the compose network)──▶ spacetime
```

| Thing | Value |
|---|---|
| Region / instance | us-east-1c, `i-038d84da5ba859189`, t3.medium (2 vCPU, 4 GiB + 4 GiB swap), Ubuntu 24.04, 30 GB gp3 (`vol-0e16d5acd835e1ae7`) |
| Elastic IP | `52.72.164.85` (`eipalloc-049d3027413dbed61`) |
| Security group | `sg-0959faaac722648d1` (`keystone-hackutd`): 22 from `129.110.241.55/32` only, 80 and 443 open to the world |
| SSH | `ssh -i ~/.ssh/keystone-hackutd.pem ubuntu@52.72.164.85` (key pair `keystone-hackutd`) |
| App dir on the box | `/opt/keystone` (owned by `ubuntu`), env file `/opt/keystone/.env`, compose wrapper `/opt/keystone/infra/dc` |
| Hostnames | `52-72-164-85.sslip.io` (works immediately) or `keystone.tenvor.io` (after the A record, step 2) |

## First deploy

```bash
cd HackUTD-2026                               # repo root on your laptop
cp infra/env.prod.example .env.prod
WORKER_SECRET="$(openssl rand -hex 32)"       # step 3a: a new strong secret; it goes in .env.prod only, never in source
sed -i.bak "s/^WORKER_SECRET=.*/WORKER_SECRET=$WORKER_SECRET/" .env.prod && rm .env.prod.bak; unset WORKER_SECRET
$EDITOR .env.prod                             # paste NVIDIA_API_KEY, TENVOR_*, PLAID_* ... from your local .env
infra/deploy.sh --publish --seed              # rsync + docker compose up -d --build (first build: 5-10 min), publish the module,
                                              # set the worker-secret hash from .env.prod, seed
```
No source file is edited for production: the module ships with the public dev hash as its default and `--publish` overrides it
at runtime (step 3a). Details follow.

---

## 1. Box (EC2, already provisioned)

Everything above exists; the user-data (reference copy: `infra/user-data.sh`) installed Docker CE + the compose plugin,
added 4 GB of swap (so `next build` does not get OOM-killed on 4 GiB), created `/opt/keystone`, and touched
`/var/lib/cloud/keystone-ready`, which `deploy.sh` waits for. Sanity check (read-only):

```bash
aws sts get-caller-identity
aws ec2 describe-instances --region us-east-1 --instance-ids i-038d84da5ba859189 --query 'Reservations[0].Instances[0].[State.Name,PublicIpAddress]' --output text
ssh -i ~/.ssh/keystone-hackutd.pem ubuntu@52.72.164.85 'ls /var/lib/cloud/keystone-ready; docker compose version; free -h | head -3; df -h / | tail -1'
chmod 400 ~/.ssh/keystone-hackutd.pem          # if ssh complains about key permissions
```

**SSH is only open from `129.110.241.55/32`.** From any other network (home, hotspot) you get a timeout. Open your own IP,
and close it again afterwards (these change AWS state, the team runs them):

```bash
MYIP="$(curl -s https://checkip.amazonaws.com)"
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id sg-0959faaac722648d1 --protocol tcp --port 22 --cidr "$MYIP/32"
# ... work ...
aws ec2 revoke-security-group-ingress    --region us-east-1 --group-id sg-0959faaac722648d1 --protocol tcp --port 22 --cidr "$MYIP/32"
```

If you must rebuild the box: EC2, Ubuntu 24.04, t3.medium, 30 GB gp3, the security group above, `--user-data file://infra/user-data.sh`,
associate the Elastic IP. (A t3 in "unlimited" credit mode can bill a little extra CPU if the build pegs it for long; irrelevant at this scale.)

<details><summary>Alternative: AWS Lightsail instead of EC2 (4 GB, $24/month)</summary>

```bash
R=us-east-2; export AWS_PAGER=""
aws lightsail create-instances --region $R --instance-names keystone --availability-zone ${R}a \
  --blueprint-id ubuntu_24_04 --bundle-id medium_3_0 --user-data "$(cat infra/user-data.sh)"      # NOT medium_ipv6_3_0 (IPv6 only)
aws lightsail allocate-static-ip --region $R --static-ip-name keystone-ip
aws lightsail attach-static-ip   --region $R --static-ip-name keystone-ip --instance-name keystone
for p in 22 80 443; do aws lightsail open-instance-public-ports --region $R --instance-name keystone --port-info fromPort=$p,toPort=$p,protocol=TCP; done
aws lightsail get-static-ip --region $R --static-ip-name keystone-ip --query staticIp.ipAddress --output text
aws lightsail download-default-key-pair --region $R --query privateKeyBase64 --output text > ~/.ssh/lightsail-$R.pem && chmod 400 ~/.ssh/lightsail-$R.pem
```
Then `infra/deploy.sh -H <static-ip> -i ~/.ssh/lightsail-$R.pem` (same everything; ADMIN_IPS and SSH rules are yours to set).
Teardown: `aws lightsail delete-instance --instance-name keystone --force-delete-add-ons` and `aws lightsail release-static-ip --static-ip-name keystone-ip` (same `--region`).
</details>

## 2. Hostname / DNS

Pick one and set it in `.env.prod` (`PUBLIC_HOSTNAME`, `NEXT_PUBLIC_WORKER_URL=https://<host>/worker`,
`NEXT_PUBLIC_SPACETIME_URI=wss://<host>`):

* **`52-72-164-85.sslip.io`**: no DNS work, resolves to `52.72.164.85` by itself. Caddy gets a Let's Encrypt certificate on first
  start (ports 80 and 443 are open). sslip.io is a shared domain, so if Let's Encrypt ever says "too many certificates",
  Caddy falls back to ZeroSSL on its own.
* **`keystone.tenvor.io`**: tenvor.io is not in Route 53, so add the record where the zone lives:
  `keystone  A  52.72.164.85  TTL 300`. (Cloudflare: set the record to "DNS only", grey cloud.) Check, then deploy:
  `dig +short keystone.tenvor.io @1.1.1.1` must print `52.72.164.85`. Deploy only after it does, otherwise Let's Encrypt
  fails validation and backs off.

Switching later: edit the three lines in `.env.prod`, run `infra/deploy.sh` (rebuilds web, new cert for the new name).
The NEXT_PUBLIC values are compiled into the web image; they are not read at runtime.

## 3. Database (self-hosted SpacetimeDB on the box)

**3a. Worker secret (the repo is public, so the default one is not a secret).** Nothing in the source tree changes for production.

* The module's `register_worker` accepts `WORKER_SECRET` if its SHA-256 equals (1) the value in a **private** one-row table, when an
  operator has set one, otherwise (2) the hash of the public dev secret `keystone-dev-secret`, which is what `npm test` and local
  development use.
* The row is set with the reducer `admin_set_worker_secret_hash(sha256_hex)`. Only the identity that **published** the database
  may call it: the module's `init` records the publisher (verified on SpacetimeDB 2.14.1: it is the identity of the CLI that ran
  `spacetime publish`; here that is the CLI inside the spacetime container). `register_worker` then rejects the dev secret.
* `infra/deploy.sh --publish` (or just `--set-worker-hash`) does it: it hashes `WORKER_SECRET` from `.env.prod` on your laptop and
  runs `spacetime call ... admin_set_worker_secret_hash` inside the spacetime container, the same way the module is published.
  Only the hex digest travels; the secret is never printed or sent. Re-running is harmless (same digest = no change).
* By hand (the digest is computed locally; the secret itself is not sent):
  ```bash
  HASH="$(printf '%s' "$WORKER_SECRET" | sha256sum | cut -d' ' -f1)"          # macOS: shasum -a 256
  ssh -i ~/.ssh/keystone-hackutd.pem ubuntu@52.72.164.85 \
    "/opt/keystone/infra/dc exec -T spacetime spacetime call -s local keystone admin_set_worker_secret_hash '\"$HASH\"'"
  ```
  Pass `'""'` instead of the digest to clear the override (back to the dev default).
* **Rotating** the secret: change `WORKER_SECRET` in `.env.prod`, `infra/deploy.sh --set-worker-hash`, then `infra/deploy.sh`
  (restarts the worker with the new value; the old secret stops working for new registrations immediately).
* **Window to know about:** between a fresh publish and the hash call, the module still accepts the public dev secret
  (`--publish` closes that window within seconds). A worker that registered in that window stays registered. If you ever
  suspect that, wipe with `-c always` (step 3c) and publish again with `--publish --seed`. A `-c always` publish also clears the
  override and the recorded publisher, which is why `--publish` always sets the hash again afterwards.
* **Database published before this change** (it exists, but `init` never recorded a publisher, because `init` does not re-run on a
  republish): after `--publish` the hash call answers `not allowed`. Bootstrap once with the public dev secret, which is accepted
  only while no override exists, then set the hash. The first caller that sets it is recorded as the publisher from then on:
  ```bash
  ssh -i ~/.ssh/keystone-hackutd.pem ubuntu@52.72.164.85 \
    "/opt/keystone/infra/dc exec -T spacetime spacetime call -s local keystone register_worker '\"keystone-dev-secret\"' '\"deploy\"'"
  infra/deploy.sh --set-worker-hash
  ```
  (This path exists only because the publisher cannot be known for old databases; a stranger cannot use it once the override is set.)

**3b. Start the stack** (this also starts the `spacetime` container with its persistent volume; the worker keeps retrying until the DB exists):

```bash
infra/deploy.sh
```

**3c. Publish the module.** Easiest: `infra/deploy.sh --publish` (builds with your local `spacetime` CLI, publishes from inside the
spacetime container, then sets the worker-secret hash, step 3a). The two options below are the same thing by hand; after either
one run `infra/deploy.sh --set-worker-hash`. Only requests from `ADMIN_IPS` (default `129.110.241.55/32`) get through Caddy for publish; everyone else
receives `403 SpacetimeDB management API is restricted to the team`. To add a laptop: add its IP to `ADMIN_IPS` in `.env.prod` (space separated) and run `infra/deploy.sh`.

*Option A: from your laptop over HTTPS* (the flow the SpacetimeDB docs describe):

```bash
spacetime server add --url https://52-72-164-85.sslip.io aws      # nickname "aws"; use keystone.tenvor.io if that is your host
spacetime login                                                    # once; opens the browser (the same login works for Maincloud)
spacetime publish -s aws -p spacetime keystone
```
The database name must equal `SPACETIME_DB` / `NEXT_PUBLIC_SPACETIME_DB` (`keystone`). If you get `401 Invalid token: InvalidSignature`,
your CLI is most likely still carrying a login token that your *local* `spacetime start` issued (that server's key is not this server's key; this is what happened when it was tried against a second local server): run
`spacetime logout && spacetime login`, or use Option B. (Option A could not be exercised end to end in the sandbox where this was
written because it needs an interactive browser login; Option B was.)

*Option B: publish from inside the box* (verified end to end; the container's own CLI identity lives in the persistent volume, so
updates keep working, and nothing needs a login):

```bash
KEY=~/.ssh/keystone-hackutd.pem; HOST=52.72.164.85
spacetime build -p spacetime                                         # -> spacetime/dist/bundle.js
scp -i $KEY spacetime/dist/bundle.js ubuntu@$HOST:/tmp/bundle.js
ssh -i $KEY ubuntu@$HOST 'docker cp /tmp/bundle.js keystone-spacetime-1:/tmp/bundle.js && docker exec keystone-spacetime-1 spacetime publish -s local -j /tmp/bundle.js keystone -y'
```
Re-run the same three lines after every module change (or `infra/deploy.sh --publish`). For a breaking schema change add `-c always`
(wipes the data, then seed again; the worker-secret hash is wiped too, so run `--set-worker-hash` or use `--publish`) to either option.
Option A publishes as your laptop's identity, not the container's: the hash call must then come from that same identity
(`spacetime call -s aws keystone admin_set_worker_secret_hash '"<sha256>"'`), not from `deploy.sh --set-worker-hash`.

**3d. Seed (once; idempotent).** Inside the worker container, which has `data/seed` mounted read-only at `/data/seed`:

```bash
ssh -i ~/.ssh/keystone-hackutd.pem ubuntu@52.72.164.85 '/opt/keystone/infra/dc exec -T worker npm run seed'
# or let deploy.sh wait for "worker connected to SpacetimeDB" first:  infra/deploy.sh --seed   (add --publish to do 3c + 3d in one go)
```

<details><summary>Alternative: SpacetimeDB Maincloud instead of the container</summary>

Maincloud database names are global; use something like `keystone-hackutd26`. Apply the HACKUTD2026 credit code to the account you publish from. In `.env.prod` swap the four DATABASE
lines for the commented Maincloud block (`wss://maincloud.spacetimedb.com`), then:

```bash
spacetime login
spacetime publish -s maincloud -p spacetime keystone-hackutd26
spacetime call -s maincloud keystone-hackutd26 admin_set_worker_secret_hash "\"$(printf '%s' "$WORKER_SECRET" | sha256sum | cut -d' ' -f1)\""   # step 3a, same identity as the publish
infra/deploy.sh --maincloud --seed                                       # starts only caddy + web + worker
```
Browsers then connect straight to Maincloud; Caddy serves nothing under `/v1`.
</details>

## 4. Verify

```bash
curl -s https://52-72-164-85.sslip.io/worker/health | jq '{ok, spacetime, demo_mode, nvidia, jobs_run}'    # spacetime must say "connected"
curl -sI https://52-72-164-85.sslip.io/ | head -1                                                           # HTTP/2 200
curl -s -o /dev/null -w '%{http_code}\n' https://52-72-164-85.sslip.io/v1/database/keystone/logs            # 403 from a non-team network
```
Then open the site **on a phone** (cellular, not the team Wi-Fi): the badge in the header must read **Live** (not "Demo data" or
"Connecting"), open `/me` to land in the Rivera room, press the mic: the browser must offer the microphone (a padlock with a valid cert is what unlocks it).
Open it on two phones and check that a change shows up on both.

## 5. Operate

```bash
export KEY=~/.ssh/keystone-hackutd.pem HOST=52.72.164.85
ssh -i $KEY ubuntu@$HOST '/opt/keystone/infra/dc ps'
ssh -i $KEY ubuntu@$HOST '/opt/keystone/infra/dc logs -f --tail=100 worker web caddy spacetime'     # tail logs (Ctrl-C to stop)
ssh -i $KEY ubuntu@$HOST '/opt/keystone/infra/dc restart worker'
ssh -i $KEY ubuntu@$HOST 'docker stats --no-stream; free -h; df -h /'
```

**Update** (code or `.env.prod` changed): run `infra/deploy.sh` again. It rsyncs, uploads the env file, rebuilds what changed and recreates only
those containers; the database volume is untouched. Module changes additionally need step 3c again (`infra/deploy.sh --publish`). Changing a `NEXT_PUBLIC_*` value rebuilds web.

**Roll back** the app to the previous deploy (web + worker images, one step back): `infra/deploy.sh --rollback`.
To go further back: `git checkout <good-commit>` locally and `infra/deploy.sh`. The database is not rolled back by either; to revert the
module, publish the old commit's module (step 3c) and, if the schema changed, add `-c always` and seed again.

**Reset the demo data** without touching the box: publish with `-c always`, then seed.

**Troubleshooting.** `spacetime: "error: ..."` in `/worker/health` means the module is not published under `SPACETIME_DB`, or the worker-secret hash in the module was not set to the hash of `WORKER_SECRET` (`infra/dc logs worker` says `invalid worker secret`; fix: `infra/deploy.sh --set-worker-hash`). Badge says "Demo data": the web image was built with the wrong `NEXT_PUBLIC_SPACETIME_*`, fix `.env.prod` and redeploy.
Browser warns about the certificate: the cert is not issued yet, `infra/dc logs caddy` (DNS wrong, port 80 blocked, or rate limited). `403` when publishing: your IP is not in `ADMIN_IPS`.
Disk filling: `docker system df`, `docker image prune -af`. Back to a clean slate: `infra/dc down` (keeps volumes) or `infra/dc down -v` (also deletes the database and the certificates).

## 6. QR code

```bash
npx qrcode -o qr.png -w 800 https://52-72-164-85.sslip.io/me      # or https://keystone.tenvor.io/me ; /me opens the demo room
```
(`qrencode -o qr.png -s 12 -m 2 <url>` also works.) `qr.png` is excluded from the rsync. Test it with a phone off the team Wi-Fi before printing.

## 7. Cost

| Item | Rate | For a 3-day event | If left running a month |
|---|---|---|---|
| EC2 t3.medium on-demand, us-east-1 | ≈ $0.0416/h | ≈ $3.00 | ≈ $30 |
| EBS gp3 30 GB | ≈ $0.08/GB-month | ≈ $0.25 | ≈ $2.40 |
| Public IPv4 / Elastic IP | $0.005/h, attached or not | ≈ $0.36 | ≈ $3.65 |
| Data transfer out | first 100 GB/month free | ≈ $0 | ≈ $0 |

Roughly **$1.15 per day**, about **$3.75 per 3-day event**; it only gets expensive if forgotten. (Lightsail 4 GB would be $24/month, prorated hourly, with a static IP included.)
Prices are approximate on-demand figures; the EC2 console and Cost Explorer are the source of truth. Set a Billing alarm if the account does not have one.

## 8. Teardown (after the event)

```bash
export AWS_PAGER="" R=us-east-1
# 0. optional: save anything you want to keep (nothing important lives only on the box: code is in git, data is seeded)
# 1. the instance (its root volume vol-0e16d5acd835e1ae7 is deleted with it: DeleteOnTermination=true)
aws ec2 terminate-instances --region $R --instance-ids i-038d84da5ba859189
aws ec2 wait instance-terminated --region $R --instance-ids i-038d84da5ba859189
# 2. the Elastic IP (billed while allocated, even unattached)
aws ec2 release-address --region $R --allocation-id eipalloc-049d3027413dbed61
# 3. security group (only works once the instance is gone) and key pair
aws ec2 delete-security-group --region $R --group-id sg-0959faaac722648d1
aws ec2 delete-key-pair --region $R --key-name keystone-hackutd
rm -f ~/.ssh/keystone-hackutd.pem
# 4. verify nothing is left (all four should print nothing / empty lists)
aws ec2 describe-instances --region $R --filters Name=tag:project,Values=hackutd-2026 Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId'
aws ec2 describe-addresses --region $R --query 'Addresses[?Tags[?Value==`hackutd-2026`]].AllocationId'
aws ec2 describe-volumes   --region $R --filters Name=tag:project,Values=hackutd-2026 --query 'Volumes[].VolumeId'
aws ec2 describe-security-groups --region $R --filters Name=group-name,Values=keystone-hackutd --query 'SecurityGroups[].GroupId'
```
Also: delete the `keystone` (or `sslip`) DNS record at your DNS provider; `spacetime server remove aws` on laptops that added it; if you used Maincloud, `spacetime delete -s maincloud keystone-hackutd26`.
The self-hosted database lives in the `keystone_spacetime_home` Docker volume and disappears with the instance.
