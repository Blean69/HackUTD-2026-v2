# Deploying Keystone to AWS

One EC2 box runs everything: **Caddy** (HTTPS) in front of **web** (Next.js), **worker** (agents + ASR), the **voice** agent
(Pipecat: the "Talk to Keystone" button and an optional SignalWire phone line) and a **self-hosted SpacetimeDB**. Judges scan a QR
code and use the app on their phones over HTTPS (the browser mic needs HTTPS).

```
phone ──https/wss──▶ Caddy :443 ──▶ web:3000                         (/)
                               ├──▶ worker:8787  (prefix /worker stripped; /worker/phone/* answers 404)
                               ├──▶ host.docker.internal:7860 = voice    (prefix /voice stripped; host network)
                               └──▶ spacetime:3000                   (/v1/... client routes for everyone,
                                                                       publish/delete/logs only from ADMIN_IPS)
worker ──ws://spacetime:3000 (inside the compose network)──▶ spacetime
voice  ──http://127.0.0.1:8787/phone/* (x-voice-secret)──▶ worker      browser ◀──WebRTC media, UDP 32768-60999──▶ voice
```

| Thing | Value |
|---|---|
| Region / instance | us-east-1c, `i-038d84da5ba859189`, t3.medium (2 vCPU, 4 GiB + 4 GiB swap), Ubuntu 24.04, 30 GB gp3 (`vol-0e16d5acd835e1ae7`) |
| Elastic IP | `52.72.164.85` (`eipalloc-049d3027413dbed61`) |
| Security group | `sg-0959faaac722648d1` (`keystone-hackutd`): 22 from `129.110.241.55/32` only, 80 and 443 open to the world, UDP 32768-60999 open for WebRTC media (section 9) |
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
infra/deploy.sh --publish --seed              # build the module, rsync, publish it + set the worker-secret hash from .env.prod,
                                              # THEN docker compose up -d --build (first build: 5-10 min), seed. Module first, so a
                                              # new worker never starts against tables that do not exist yet.
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
curl -s https://52-72-164-85.sslip.io/voice/health                                                           # {"ok":true,"service":"keystone-voice",...}
curl -s -o /dev/null -w '%{http_code}\n' https://52-72-164-85.sslip.io/worker/phone/tools                    # 404: the phone routes are not public
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

## 9. Voice agent: the Talk button and the optional phone line

Design: `docs/voice-agent.md` and `docs/voice-selfhost.md`. What runs where:

| Piece | Where | Notes |
|---|---|---|
| `voice` container (Pipecat 1.15, Python 3.12) | **host network**, listens on `0.0.0.0:7860` | WebRTC media needs the host's UDP ports. TCP 7860 stays closed in the security group; Caddy reaches it via `host.docker.internal:7860` |
| Caddy `/voice/*` | prefix stripped | `POST /voice/api/offer` (button), `POST /voice/twiml` and `WS /voice/ws` (phone), `GET /voice/health` |
| Worker `/phone/*` | `127.0.0.1:8787` on the box | internal; needs the `x-voice-secret` header; Caddy returns 404 for `/worker/phone/*` |
| Speech and LLM | NVIDIA hosted: Nemotron ASR streaming and Magpie TTS (NVCF gRPC), Nemotron 3.5 Lightning with thinking off (OpenAI-compatible API) | one NVIDIA key; see the rate-limit note below |

**Module change** (new worker-only reducer `agent_enqueue_job`, workflow `phone`): non-breaking, so `infra/deploy.sh --publish` is enough. Never add `-c always` for it.

**AWS: one security group rule (the team runs it; nothing else changes).** WebRTC media uses random UDP ports from Linux's ephemeral range:
```bash
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id sg-0959faaac722648d1 --ip-permissions \
  'IpProtocol=udp,FromPort=32768,ToPort=60999,IpRanges=[{CidrIp=0.0.0.0/0,Description=webrtc-media}]'
```
The SignalWire phone line needs **no** rule (its media socket arrives as `wss://` on 443).

**Environment (`.env.prod`; every name is in `infra/env.prod.example`).** The voice and worker containers both read the same file.

| Variable | Needed for | Notes |
|---|---|---|
| `VOICE_SHARED_SECRET` | button and phone | **Required.** Long random string (`openssl rand -hex 24`). Without it the worker answers 503 `voice_unconfigured` to every `/phone/*` call |
| `NVIDIA_API_KEY` or `NVIDIA_VOICE_API_KEY` | button and phone | The voice key wins if set. Use a **different teammate's** key for voice: the free tier is about 40 requests/minute per account and the web agents share the other one |
| `NVIDIA_ASR_FUNCTION_ID`, `NVIDIA_ASR_SERVER`, `NVIDIA_TTS_FUNCTION_ID` | button and phone | already in the example (Nemotron ASR streaming, Magpie TTS Multilingual) |
| `NVIDIA_TTS_VOICE` | optional | default `Magpie-Multilingual.EN-US.Mia.Calm`; `Aria.Calm` is the alternative |
| `PIPECAT_ICE_SERVERS` | button | JSON list, default `[{"urls":"stun:stun.l.google.com:19302"}]`. If venue Wi-Fi blocks UDP, put a Cloudflare TURN entry **first** (`{"urls":"turn:turn.cloudflare.com:3478?transport=udp","username":"...","credential":"..."}`); aiortc uses only the first STUN and the first TURN entry |
| `NEXT_PUBLIC_VOICE_URL` | button | `https://<host>/voice`; compiled into the web image (compose passes it as a build arg, default `https://$PUBLIC_HOSTNAME/voice`), so changing it needs `infra/deploy.sh` to rebuild web |
| `PHONE_PINS` | phone | `1234:hh_rivera,5678:hh_nguyen` (optionally `pin:household:member_id`). Synthetic PINs, printed on the demo card |
| `PHONE_CALLER_SALT` | phone | random salt; caller numbers are only kept as a salted hash, never stored or logged |
| `SIGNALWIRE_SIGNING_KEY` | phone | verifies the `X-SignalWire-Signature` on `/voice/twiml`. **Empty = skipped with a logged warning**; the media socket stays protected by a short-lived signed token either way |
| `SIGNALWIRE_SPACE_URL`, `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, `SIGNALWIRE_PHONE_NUMBER` | phone | inbound: informational (the number is shown in `/voice/health`). **The callback uses all four** to place the outbound call through the SignalWire Compatibility API (see "Phone callback" below) |
| `VOICE_ENABLED`, `VOICE_MAX_CALL_SECS` (300), `VOICE_MAX_SESSIONS` (3), `PHONE_MAX_SESSIONS` (4), `VOICE_IDLE_SECS` (20), `VOICE_TRANSPORTS` (`webrtc,twilio`) | optional | `VOICE_ENABLED=0` is the kill switch (button gets 503, the number says "closed" and hangs up) |
| `VOICE_NOISE_FILTER` (`auto`) | button (phone optional) | RNNoise on the caller's audio before the VAD and the ASR: `auto` = browser only, `on` = browser and phone, `phone`, `off`. Needs the `rnnoise` extra in `services/voice/requirements.txt` (so rebuild the voice image); missing = the call runs without it |
| `VOICE_BARGE_IN_WORDS_WEBRTC` (3), `VOICE_BARGE_IN_WORDS` (2) | button / phone | words of speech that interrupt Brian in the browser / on the phone |
| `VOICE_ECHO_OVERLAP` (0.6), `VOICE_ECHO_GRACE_SECS` (1.0) | button / phone | echo guard: while Brian talks (and this long after) an interruption whose words line up in order with what he just said is ignored as his own echo; `VOICE_ECHO_OVERLAP=0` turns it off |
| `VOICE_LLM_MODEL`, `VOICE_LLM_BASE_URL`, `VOICE_LLM_API_KEY`, `VOICE_LLM_TEMPERATURE` (0.7), `VOICE_LLM_MAX_TOKENS` (110) | optional | point at the Brev box by setting base URL + model + key |

The SignalWire values may all stay empty: the Talk button needs none of them.

**Deploy.** `infra/deploy.sh` (the first build of the voice image takes about 5-10 minutes on the box: Pipecat, onnxruntime, aiortc), then the checks in section 4 plus:
```bash
ssh -i $KEY ubuntu@$HOST '/opt/keystone/infra/dc ps voice; /opt/keystone/infra/dc logs --tail=30 voice'
```
Open the site on a phone **on cellular**, tap Talk to Keystone, allow the mic, and ask "How are we doing?". `chrome://webrtc-internals` should show a selected
candidate pair with a `srflx` candidate for `52.72.164.85`. The call appears at `/agents` as a `phone` run.

### SignalWire phone number (optional, about 45 minutes, about $2.50 of the $5 deposit)

1. Sign up at signalwire.com and create a **Space** (the space URL looks like `yourspace.signalwire.com`). A trial account only takes calls from numbers you verified, so fund the account with a card (**$5 minimum**) to let judges call. Add a spend limit under Billing.
2. **Phone Numbers -> Buy a Phone Number**: search area codes 214, 469 or 972 (Dallas) and buy one with **Voice** capability (about $0.50 a month).
3. Open that number -> **Settings** (Edit Settings) -> **Handle Calls Using: cXML webhook** (also called a LaML webhook; the menu wording differs a little between dashboard versions), then:
   * **When a call comes in:** `https://<PUBLIC_HOSTNAME>/voice/twiml`, method **POST**, handler type "cXML webhook" (not "Relay" or "Script"). Leave the status callback empty. Save.
4. **API** page of the project: copy the Project ID, an API token and the **Signing Key** into `.env.prod` as `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, `SIGNALWIRE_SIGNING_KEY`, plus `SIGNALWIRE_SPACE_URL` and `SIGNALWIRE_PHONE_NUMBER` (E.164, e.g. `+12145550123`). Set `PHONE_PINS` and `PHONE_CALLER_SALT` too, then run `infra/deploy.sh` (restarts voice and worker).
5. Call the number from a cell phone. You hear the AI disclosure and are asked for the PIN: key it on the keypad (for example the Rivera PIN from the demo card). Then ask: "How are we doing?", "What's coming up this month?", "What if we buy a thirty-five thousand dollar car?" and watch the run appear at `/agents`.
6. If it fails: SignalWire Dashboard -> **Logs** (voice) shows the webhook response. `403` from `/voice/twiml` means the signing key does not match (clear `SIGNALWIRE_SIGNING_KEY` to skip the check while debugging; the service logs a warning); no audio after the PIN prompt means the WebSocket did not reach `/voice/ws`: check `curl -i https://<host>/voice/health` and `infra/dc logs voice`.

**Operate.** `infra/dc logs -f --tail=100 voice` (heard/said lines, tool timings, no secrets); kill switch: set `VOICE_ENABLED=0` and `infra/deploy.sh`;
calls end after `VOICE_MAX_CALL_SECS`, after two silent prompts ("Are you still there?", then goodbye; `VOICE_IDLE_SECS` apart), or when the tab closes; the worker also finishes any call with no traffic for 10 minutes as `error: abandoned`.
On a laptop one live call used about 190 MB and about 20% of one core (`docker stats`); the container limit is 1.2 GB. The image is about 1 GB (no torch).

### Phone callback: Brian rings back with a critical alert (docs/contracts.md section 10)

About `VOICE_CALLBACK_SECS` (15) after a **phone** call that passed the PIN ends, Brian calls the same number back **from the SignalWire number**:
"Hi, it's Brian again, sorry to call right back. I've got a critical alert on your account." He states the alert, says what he did or recommends, and
stays on the line for questions. The alert is written as a critical `alert` row (so the dashboard shows it during the call) and the call is a traced `phone` run.
Browser (WebRTC) calls and calls that never unlocked get no callback; one callback per call; a callback is never followed by another.

| Variable | Default | Notes |
|---|---|---|
| `SIGNALWIRE_SPACE_URL`, `SIGNALWIRE_PROJECT_ID`, `SIGNALWIRE_API_TOKEN`, `SIGNALWIRE_PHONE_NUMBER` | none | **All four are needed**, plus `VOICE_SHARED_SECRET` (it signs the callback tokens) and `PHONE_CALLER_SALT`. Anything missing = callbacks stay off (one line in the voice log names what) |
| `VOICE_CALLBACK_ENABLED` | `1` | `0` = kill switch for the callback only (calls still work) |
| `VOICE_CALLBACK_SECS` | `15` | wait after the first call ends; `0` = immediately |
| `VOICE_CALLBACK_RING_SECS` | `20` | SignalWire `Timeout`: stop ringing after this long (also keeps most calls out of the carrier's voicemail) |
| `VOICE_CALLBACK_AMD` | `off` | SignalWire answering-machine detection: `off`, `enable` (a machine = hang up), `detect_message_end` (waits for the beep, then leaves a short private message: no amounts, no card digits). Both add a few seconds before Brian speaks to a person. Field names follow SignalWire's LaML call API (`MachineDetection`, `AnsweredBy`); not yet tried on a live call |
| `VOICE_CALLBACK_COOLDOWN_SECS` / `VOICE_CALLBACK_MAX_PER_HOUR` | `60` / `20` | at most one callback per caller number per minute, and this many in total per hour (cost and abuse guard) |

How it works, and what it never does:
* **Outbound call:** `POST https://<space>/api/laml/2010-04-01/Accounts/<project>/Calls.json` (basic auth project:token; `From`, `To`, `Url`, `Method=POST`, `Timeout`).
  `Url` = `https://<host>/voice/twiml?cb=<token>`. SignalWire signs that webhook with the same signing key, so `SIGNALWIRE_SIGNING_KEY` verification stays on for it.
* **Token:** HMAC-signed with `VOICE_SHARED_SECRET`, **single use, valid 2 minutes**, names the household and the alert, never the phone number. The media stream then needs a second
  single-use session token that only `/twiml?cb=` hands out.
* **The caller's number** comes from the inbound webhook's `From`, lives **in the voice process's memory only** until that call ends, is used for the one dial and is dropped.
  It is never stored, sent to the worker, put in a token or logged: logs carry the salted hash (first 8 characters), and a log filter masks anything number-shaped as a backstop.
  `anonymous`/withheld numbers get no callback.
* **The alert:** the worker route `GET /phone/alert_candidates?household_id=` offers the household's real signals (open critical/warn alerts, card-testing / scam-payment / new-payee /
  duplicate rule hits from the anomaly scan, a forecast overdraft on a date, a credit-score alert). With none, one of 7 templates is filled from the household's accounts, bills and dates.
  `POST /phone/callback_alert` writes it (`agent_create_alert`, severity critical, id `callback:<household>:<call>`) and traces it on the callback's run. Both routes need `x-voice-secret`.
* Brian's goodbye on a callback-eligible call says he might ring back (the model is told to; the idle and time-limit goodbyes are fixed text).

**First live test (the team, ~10 minutes).** 1. `.env.prod` has the four `SIGNALWIRE_*` values, `SIGNALWIRE_SIGNING_KEY`, `VOICE_SHARED_SECRET`, `PHONE_CALLER_SALT`, `PHONE_PINS`;
run `infra/deploy.sh` (rebuilds voice and worker). 2. `curl -s https://<host>/voice/health` shows `"callback": true` and `infra/dc logs voice | grep callback:` shows `callback: on (15s ...)`.
3. Open the household's dashboard (Alerts) in a browser. A SignalWire **trial** account only calls numbers that are purchased or verified (docs/voice-selfhost.md), so use a verified cell or fund the account.
4. Call the number from that cell, key the PIN, ask one question, say goodbye (Brian says he might ring back), hang up. 5. About 15 seconds later the phone rings from the SignalWire number: answer.
Brian says the opening line and the alert; a new critical alert appears on the dashboard; `/agents` shows a `phone` run "Voice callback connected". Ask a question, hang up: no second call.
6. If nothing rings: `infra/dc logs voice | grep -i callback` shows `callback scheduled ...`, `callback call placed ...` or `callback not placed: SignalWire <http status> <code>` (the status and SignalWire's error code only; 401 = wrong project or token), then SignalWire Dashboard -> Logs.
No `callback scheduled` line at all means the call was not eligible: no PIN unlock, a withheld caller ID, `VOICE_CALLBACK_ENABLED=0`, a missing `SIGNALWIRE_*` value, or the one-per-minute cooldown.

## 10. Brev GPU (Nemotron on vLLM) through an SSH tunnel

Brev's public `https://8000-<id>.gobrev.dev` URLs sit behind Cloudflare, which challenges requests from AWS IPs
(`cf-mitigated: challenge`), so the box reaches the GPU through Brev's SSH gateway instead (encrypted, no Cloudflare):

- On the box: systemd unit `brev-tunnel.service` runs `ssh -N -L 0.0.0.0:8001:localhost:8000 -p <gateway-port> ubuntu@global.prd.ga.run.brev.nvidia.com`
  with a dedicated key `~/.ssh/brev_tunnel`. Port 8001 is not open in the security group, so only the box and its containers can use it.
- On the GPU: that key is in `authorized_keys` with `restrict,port-forwarding,permitopen="localhost:8000"`: forwarding to vLLM only, no shell.
- Worker: `BREV_BASE_URL=http://host.docker.internal:8001/v1` (in `.env.prod`). Voice (host network): `http://127.0.0.1:8001/v1` (compose override).
- vLLM requires `BREV_API_KEY` (Bearer). Check: `systemctl status brev-tunnel`; `curl -H "Authorization: Bearer $KEY" localhost:8001/v1/models`.
- If the Brev instance is recreated, the gateway port changes: `brev ports ls <instance>` and update the unit, then `sudo systemctl restart brev-tunnel`.
- Teardown after the event: `sudo systemctl disable --now brev-tunnel`; `brev delete keystone-nemotron` (stops billing).

## 12. Auto-deploy: every push to `main` goes live

The box deploys itself. `keystone-autodeploy.timer` runs [`infra/autodeploy.sh`](autodeploy.sh) every minute. It reads the
public GitHub repo, so no SSH key or secret is stored on GitHub, and `.env` never leaves the box. For each new commit on
`origin/main` it does the following:

1. It checks out the commit. Only tracked files change.
2. If `spacetime/` changed, it builds the module in a throwaway `node:22` container and **publishes it before any container
   restarts**, then sets the worker-secret hash. A failed publish, such as a breaking schema change, stops there, and production
   keeps running.
3. It runs `docker compose up -d --build`. Only services whose image or config changed are recreated, so a web-only change
   doesn't drop phone calls.
4. It health-checks the worker (connected to SpacetimeDB), voice and web for up to 150 s. **If any is unhealthy, it rolls back to
   the previous images.**
5. If `data/seed/` or `services/worker/src/seed.ts` changed, it runs `npm run seed`, which is idempotent.

A commit that failed isn't retried, and the next commit is tried normally.

```bash
ssh ubuntu@52.72.164.85 'journalctl -u keystone-autodeploy -f'          # watch it
ssh ubuntu@52.72.164.85 'touch /opt/keystone/.autodeploy-paused'        # PAUSE (do this before judging)
ssh ubuntu@52.72.164.85 'rm /opt/keystone/.autodeploy-paused'           # resume
ssh ubuntu@52.72.164.85 'sudo systemctl start keystone-autodeploy'      # run now instead of waiting up to a minute
```

To set it up once (idempotent), run `bash infra/autodeploy-install.sh /opt/keystone <repo-url> main` on the box. It turns
`/opt/keystone` into a git checkout; untracked files such as `.env` stay. `infra/deploy.sh` still works for `--publish --seed`,
`--rollback` and `.env` changes. It records what it deployed, and if that isn't `origin/main` the timer deploys `origin/main`
within a minute. So **push first**: GitHub `main` is the source of truth. `.env` changes are **not** picked up by the timer,
because the file isn't in git. Upload them with `infra/deploy.sh`.

A local clone can follow `main` with `infra/local-autopull.sh --install`. That's a systemd user timer that fast-forwards every
2 minutes, only when `main` is checked out and clean.
