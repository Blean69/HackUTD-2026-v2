# Phone line, self-hosted variant (design, 2026-11-07, nothing built yet)

Alternative to the paid-Twilio plan in `docs/voice-agent.md`. Everything from that doc's pipeline (Pipecat 1.15 `bot.py`, Nemotron ASR,
Lightning with tools, Magpie TTS, Silero + Smart Turn, worker `/phone/*` routes, PIN gate, disclosure, `agent_run` workflow `phone`)
is reused **unchanged**. Only the edge changes: PSTN -> SIP trunk DID -> our own SIP server on the EC2 box -> the same bot.
Marks: **[V]** checked today on the primary source listed at the bottom; **[V-va]** verified today in `docs/voice-agent.md`;
**[U]** unverified (from memory or a secondary source): confirm before spending money or hours on it.
Status note: the four parallel verification passes (Fonoster, SIP alternatives, carriers, Google Voice/WebRTC) had not reported
back when this file was written, so most product and price facts below are **[U]**. Check the starred rows of the decision table first.

## Decisions

| Question | Decision | Why / confidence |
|---|---|---|
| SIP server | **Asterisk (host network) + AudioSocket**, plus a ~120-line shim that re-speaks the call as Twilio Media Streams JSON to the existing Pipecat `/ws` | Smallest footprint (tens of MB) [U], most mature open-source PBX, and `bot.py` keeps using `TwilioFrameSerializer` [V-va], so zero pipeline rework |
| Fonoster | **No, not tonight** | Multi-service platform (Routr + Asterisk + APIServer + NATS + Postgres + more) [U]; RAM too high for a box with ~2.9 GB free; hours of setup [U] |
| LiveKit SIP | **Plan B for the SIP server** | Well documented, Pipecat has a LiveKit transport [U], but 3 new services (server, sip, Redis) and its own media ports [U] |
| jambonz | **No** | Heaviest stack (FreeSWITCH, drachtio, rtpengine, MySQL, Redis) [U]; self-hosting licence terms changed [U] |
| FreeSWITCH + mod_audio_fork | **No** | Module must be compiled; FreeSWITCH packages need a SignalWire token [U] |
| DID (the number) * | **Telnyx SIP trunk, Dallas 214/469/972 number**; backup **VoIP.ms** | ~$1/mo + under 1 cent/min [U]. Telnyx bonus: the same number can be flipped to TeXML `<Stream>` -> `TelnyxFrameSerializer` [V-va] if Asterisk misbehaves. Both need a funded, verified account [U] |
| Free DID? * | **None worth it** | Callcentric's free DID was NY-only and is not Dallas [U]; free DIDs are out of area and slow to provision |
| Google Voice * | **No** | Workspace SIP Link needs paid GV licences and a certified SBC, not Asterisk [U]; consumer GV has no SIP/API and the Obihai route is dead [U] |
| No-number fallback | **"Talk to Keystone" button, SmallWebRTC**, same `bot.py` (already rung 2 in voice-agent.md) | $0; needs a UDP range open and host networking (section 5) |
| Security | Security-group allowlist of the carrier's signaling IPs on 5060; RTP range open; pjsip ACL; fail2ban as belt and braces | Scanners hit 5060 within minutes of it opening [U, common experience] |
| Cost | **~$15-25 cash out (prepaid deposit), ~$4-6 actually used** | DID ~$1 + 300 min x ~$0.005-0.01 [U] |
| Setup time | **~3.5-4.5 h** of work, plus carrier verification wait (can be hours) [U] | Start the carrier signup first, in parallel with everything else |

## 1. Fonoster

- What it is: an open-source "programmable telecom" stack (Twilio alternative), MIT [U]. Current releases bundle **Routr** (Fonoster's SIP
  proxy/registrar, Node + Java edgeport) [U], **Asterisk** as the media server [U], an **APIServer** (gRPC behind Envoy) [U], **NATS** [U],
  **Postgres** [U], an identity/auth service, the **Dashboard**, and **Autopilot** (built-in LLM voice agent with pluggable STT/TTS) [U].
- Voice apps: the `@fonoster/voice` SDK runs your Node "voice server"; verbs include `answer`, `say`, `gather`, `play`, `hangup` and a
  bidirectional `stream` [U]. Media reaches the app via Asterisk external media (AudioSocket-style, 8 kHz slin) [U]. Pipecat has **no
  Fonoster serializer** [U]; Node code could read/write the stream, but then we would hand-roll VAD, turn-taking and the Riva clients that
  Pipecat already gives us (voice-agent.md 2.1 rejected that).
- Footprint: about a dozen containers [U]; Routr's Java edgeport alone typically wants ~0.5-1 GB [U]. Estimated 2-3 GB total [U]: does
  not fit next to our ~1.1 GB on 4 GB + swap without swapping during calls. It would need a second instance (t3.medium ~$0.04/h [V, DEPLOY.md]).
- Maturity/time: active project, small community [U]; self-hosted installs need several env files, keys and trunk/number/app objects
  created through its API or dashboard [U]. Realistic first inbound call tonight: **4-8 h** [U]. Verdict: skip; Asterisk is the piece of
  Fonoster we actually need.

## 2. Self-hosted alternatives (same axes)

| | Asterisk + AudioSocket (pick) | LiveKit server + SIP | jambonz | FreeSWITCH + audio_fork | Pipecat built-in SIP |
|---|---|---|---|---|---|
| Components | 1 process | livekit-server, livekit-sip, Redis [U] | ~8 services [U] | FreeSWITCH + module build [U] | none: only provider serializers (Twilio, Telnyx, Plivo, Exotel...) [V-va partial] and Daily dial-in (paid) [U] |
| RAM | ~50-150 MB [U] | ~300-500 MB [U] | 2+ GB, t3.large+ [U] | ~200 MB [U] | n/a |
| Bot audio | TCP, 8 kHz 16-bit slin, 20 ms frames, UUID + audio + hangup (+ DTMF in newer versions) messages [U] | WebRTC room; Pipecat `LiveKitTransport` joins it [U] | WebSocket `listen` verb, L16 [U] | WebSocket, L16 [U] | n/a |
| Pipecat glue | ~120-line shim to Twilio JSON (section 7) | Transport exists [U] | Custom serializer [U] | Custom serializer [U] | n/a |
| Setup tonight | **2-3 h** [U] | 2.5-3.5 h [U] | 5+ h | 5+ h | n/a |

- **Asterisk** facts used below: PJSIP NAT options `local_net`, `external_media_address`, `external_signaling_address`, endpoint
  `direct_media=no`, `rtp_symmetric`, `force_rport`, `rewrite_contact` [V]; RTP range set in `rtp.conf` (sample 10000-20000), strict RTP on
  by default [V]; `res_pjsip_acl` (`type=acl`, `permit`/`deny`) filters all inbound SIP [V]; `logger.conf` can write a `security` channel for
  fail2ban [V]. Ubuntu 24.04's `asterisk` apt package is Asterisk 20.x and should include `app_audiosocket` [U]; there is no official
  Docker image, community images exist [U]. Newer Asterisk (22.x) also has a WebSocket external-media channel that could drop the shim [U].
- **Lowest-effort path:** Asterisk answers, `AudioSocket()` dials the shim on 127.0.0.1, the shim opens `ws://127.0.0.1:7860/ws` and
  talks Twilio Media Streams protocol, `bot.py` is the Twilio bot from voice-agent.md with `auto_hang_up=False`.

## 3. The phone number (cannot be self-hosted)

| Provider | Dallas DID | $/month | Inbound $/min | Signup friction | Trial inbound | Notes |
|---|---|---|---|---|---|---|
| **Telnyx** (pick) | yes [U] | ~$1.00 [U] | ~$0.0035-0.005 [U] | card + eKYC for US numbers ("Level 2") [U], voice-agent.md says it "can take time" [U] | only from the verified number [V-va] | Same number also works with TeXML `<Stream>` (no SIP server) [V-va] |
| VoIP.ms (backup) | yes [U] | ~$0.85 [U] | ~$0.009-0.01 [U] | prepaid, ~$15 minimum [U]; manual account review, hours [U] | no trial | Pick the Dallas POP; per-DID SIP URI routing to our IP [U] |
| Flowroute | yes [U] | ~$1.35 [U] | ~$0.009 [U] | self-serve status unclear [U] | | |
| SignalWire | yes [U] | ~$1 [U] | ~$0.0066 [U] | trial credit, restrictions [U] | [U] | Also has its own stream API (Twilio-compatible LaML) [U] |
| Twilio Elastic SIP | yes [V-va: 214/469 local] | $1.15 [V-va] | ~$0.0034-0.0085 [U] | card upgrade | trial = verified callers only [V-va] | If we upgrade Twilio anyway, Media Streams is simpler than SIP |
| Callcentric free DID | no, NY only [U] | $0 | per-channel limits [U] | | | Not Dallas, possibly discontinued [U] |

Rule: whichever account gets verified first wins; buy the number only after the account is fully enabled for US numbers.

## 4. Google Voice: no

- **Workspace SIP Link** lets Google Voice users reach the PSTN through your own carrier/SBC [U]; it needs Google Workspace, paid Google
  Voice Standard/Premier licences [U] and an SBC from Google's certified list (commercial SBCs such as AudioCodes/Ribbon; Asterisk is not
  on it) [U], with mutual TLS + SRTP [U]. Not achievable tonight, and it costs more than a $1 DID.
- **Consumer Google Voice** has no SIP endpoint and no API [U]. The Obihai/OBi route (the only semi-official SIP-ish bridge) ended with
  Poly's end of support [U]; XMPP/"GVSIP" hacks are unsupported and violate the spirit of the ToS on automated use [U]. Call forwarding to a
  linked number needs code verification and may refuse VoIP numbers [U], and would only add a hop in front of a DID we must buy anyway.
- **Verdict: do not use Google Voice.** It cannot legitimately hand calls to our SIP server without paid Workspace licences + certified SBC.

## 5. Free no-number fallback: WebRTC button

- Same `bot.py`, `SmallWebRTCTransport` [V-va]; page posts the SDP offer to `/voice/api/offer` through Caddy (HTTPS, which mobile browsers
  require for the mic [U]; iOS Safari supports getUserMedia over HTTPS [U]).
- EC2 is 1:1 NAT: the instance only knows its private IP; the internet gateway maps the Elastic IP to it [V]. So host candidates are
  private; configure a STUN server (`stun:stun.l.google.com:19302`) so aiortc emits a server-reflexive candidate with 52.72.164.85 [U].
  aiortc picks ephemeral UDP ports (Linux default 32768-60999) with no documented range knob [U]: run the voice container with
  `network_mode: host` (no Docker NAT) and open that UDP range in the security group.
- Restrictive venue Wi-Fi blocking UDP: add TURN. Cheapest: Cloudflare Realtime TURN free tier [U] or Metered free tier [U]; self-hosted
  coturn needs 3478 UDP/TCP, 5349 TCP and a relay range [U]. Judges on cellular usually work without TURN [U].

## 6. AWS networking (team runs these; this doc changes nothing)

Default quota is 60 inbound rules per security group [V], enough for an allowlist. Rules for `sg-0959faaac722648d1`:

| Port | Proto | Source | For |
|---|---|---|---|
| 5060 | UDP (and TCP) | carrier signaling IPs only (Telnyx/VoIP.ms publish them [U]) | SIP |
| 10000-20000 | UDP | 0.0.0.0/0 (carrier media ranges are wide [U]; strict RTP protects us [V]) | RTP |
| 32768-60999 | UDP | 0.0.0.0/0 | SmallWebRTC media |
| 5061 | TCP | carrier IPs | only if using SIP TLS (optional) |
| 3478/5349 | UDP+TCP / TCP | 0.0.0.0/0 | only if self-hosting coturn (skip) |

```bash
SG=sg-0959faaac722648d1; R=us-east-1   # one line per carrier signaling IP/CIDR
aws ec2 authorize-security-group-ingress --region $R --group-id $SG --ip-permissions \
  'IpProtocol=udp,FromPort=5060,ToPort=5060,IpRanges=[{CidrIp=<CARRIER_SIG_IP>/32,Description=sip-trunk}]'
aws ec2 authorize-security-group-ingress --region $R --group-id $SG --ip-permissions \
  'IpProtocol=udp,FromPort=10000,ToPort=20000,IpRanges=[{CidrIp=0.0.0.0/0,Description=rtp}]' \
  'IpProtocol=udp,FromPort=32768,ToPort=60999,IpRanges=[{CidrIp=0.0.0.0/0,Description=webrtc}]'
```
- NAT in Asterisk: `external_*_address=52.72.164.85`, `local_net` = the VPC CIDR (check `ip -4 addr` on the box, likely 172.31.0.0/16 [U])
  plus 127.0.0.0/8 and 172.16.0.0/12 (Docker), `direct_media=no`, `rtp_symmetric=yes`, `force_rport=yes`, `rewrite_contact=yes` [V].
- Run Asterisk with host networking: publishing 10,000 UDP ports through Docker's userland proxy is slow and fragile [U].
- TLS/SRTP: plain UDP + RTP between carrier and AWS is normal for trunks; TLS on 5061 + SRTP is possible with Telnyx [U] but costs a
  cert in Asterisk; skip for the demo (synthetic data only).
- Scanners: (1) the security group allowlist means nobody else reaches 5060 at all; (2) pjsip `type=acl` permits only the carrier [V];
  (3) no `anonymous` endpoint, no registrations, the dialplan context only reaches AudioSocket (no outbound route = no toll fraud);
  (4) fail2ban `asterisk` jail on the security log [V for the log channel] if 5060 is ever opened wider.

## 7. Plan

**Stack:** Telnyx (or VoIP.ms) DID -> UDP 5060 -> Asterisk 20 (host) -> `AudioSocket(uuid,127.0.0.1:9092)` -> shim (inside the voice
service) -> `ws://127.0.0.1:7860/ws` (Twilio protocol) -> Pipecat bot -> worker `/phone/*` -> SpacetimeDB. WebRTC button hits the same bot.

```yaml
  # infra/docker-compose.yml additions
  asterisk:
    image: andrius/asterisk:20          # [U] community image; alternative: `apt install asterisk` on the host
    network_mode: host                  # SIP 5060 + RTP 10000-20000 straight on the host
    restart: always
    volumes: ["./asterisk:/etc/asterisk:ro"]
    mem_limit: 300m
  voice:
    build: { context: ../services/voice }
    image: keystone-voice:latest
    network_mode: host                  # WebRTC UDP without Docker NAT; listens 0.0.0.0:7860 (SG keeps it closed), 127.0.0.1:9092
    restart: always
    env_file: ../.env
    environment: { WORKER_URL: "http://127.0.0.1:8787", AUDIOSOCKET_BIND: "127.0.0.1:9092" }
    mem_limit: 1200m
  worker:   # add to the existing service so the host-networked voice service can reach it
    ports: ["127.0.0.1:8787:8787"]
  caddy:    # add to the existing service
    extra_hosts: ["host.docker.internal:host-gateway"]
```
```caddy
	handle /worker/phone/* { respond 404 }            # before /worker/*, as in voice-agent.md
	handle /voice/* {
		uri strip_prefix /voice
		reverse_proxy host.docker.internal:7860 { flush_interval -1 }   # only the WebRTC offer + page; SIP never touches Caddy
	}
```
```ini
; infra/asterisk/pjsip.conf (Telnyx shown; VoIP.ms is the same shape)
[udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
local_net=172.31.0.0/16
local_net=172.16.0.0/12
local_net=127.0.0.0/8
external_media_address=52.72.164.85
external_signaling_address=52.72.164.85
[trunk-acl]
type=acl
deny=0.0.0.0/0.0.0.0
permit=<CARRIER_SIG_IP>/32
[trunk]
type=endpoint
context=from-trunk
disallow=all
allow=ulaw
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
[trunk-id]
type=identify
endpoint=trunk
match=<CARRIER_SIG_IP>
; infra/asterisk/extensions.conf
[from-trunk]
exten => _X.,1,Answer()
 same => n,Set(U=${FILTER(0-9a-f-,${SHELL(cat /proc/sys/kernel/random/uuid)})})
 same => n,Set(R=${CURL(http://127.0.0.1:7860/callmeta,u=${U}&h=${SHA1(${CALLER_SALT}${CALLERID(num)})})})  ; [U] POST; only a hash leaves Asterisk
 same => n,AudioSocket(${U},127.0.0.1:9092)
 same => n,Hangup()
```
(`rtp.conf`: `rtpstart=10000`, `rtpend=20000` [V]. `logger.conf`: `security => security` for fail2ban [V]. `modules.conf`: autoload, but
`noload` chan_sip/IAX if present.) The caller hash replaces Twilio's `<Parameter name="from">`; the worker compares it the same way.

**Shim** (`services/voice/audiosocket_bridge.py`, ~120 lines, asyncio): per TCP connection read the 3-byte header (kind, 16-bit length)
[U: kinds 0x00 hangup, 0x01 UUID, 0x03 DTMF, 0x10 slin audio, 0xff error]; on UUID open the local WS and send Twilio `connected` +
`start` (`streamSid` = UUID, `customParameters.from_hash` from `/callmeta`); audio: slin 8 kHz -> mu-law -> base64 `media` event; DTMF ->
`dtmf` event (Pipecat turns it into `InputDTMFFrame` [V-va]); WS `media` back -> mu-law -> slin -> 0x10 frames of 320 bytes; ignore `mark`,
drop pending audio on `clear`; WS close or bot hang-up -> send 0x00. Pipecat's websocket output paces audio at real time [U], so the shim
forwards without buffering. Construct `TwilioFrameSerializer(..., params=TwilioFrameSerializer.InputParams(auto_hang_up=False))` [U name].

**Env (`.env.prod`, never committed):** `TELEPHONY=asterisk|twilio|telnyx`, `CALLER_HASH_SALT` (also passed to Asterisk as `CALLER_SALT`),
`AUDIOSOCKET_BIND=127.0.0.1:9092`, `CARRIER_SIG_IPS`, `PUBLIC_IP=52.72.164.85`, `STUN_URL=stun:stun.l.google.com:19302`,
`TURN_URL/TURN_USER/TURN_PASS` (optional), plus every voice var from voice-agent.md section 4 (Twilio ones become optional).

**Steps (in order):**
1. (10 min, then wait) Start Telnyx signup + verification; in parallel VoIP.ms as backup. Do not buy until one is enabled.
2. (45 min) Shim + `/callmeta` + `TELEPHONY` switch in `services/voice`; test locally by running the shim against the bot with a recorded
   8 kHz WAV fed over a fake AudioSocket client (no Asterisk needed).
3. (40 min) Asterisk config files under `infra/asterisk/`; compose changes; deploy; `asterisk -rx "pjsip show endpoints"`.
4. (15 min, team) Security-group rules above. Carrier: SIP connection with IP auth -> 52.72.164.85:5060 UDP, codec PCMU, number assigned.
5. (30 min) First call from a cell phone; fix one-way audio (almost always NAT: `external_media_address`, RTP range, SG).
6. (30 min) WebRTC button: host networking, STUN, open UDP range; test on cellular.
7. (20 min) Hardening: ACL, no outbound routes, fail2ban, `VOICE_ENABLED` kill switch, carrier spend limit.

**Test plan:** `sngrep`/`pjsip set logger on` shows INVITE -> 200 OK; `rtp set debug on` shows packets both ways; 10 calls from 3
carriers (AT&T, T-Mobile, Verizon phones); DTMF PIN on each; barge-in in hall noise; 3 simultaneous calls while watching
`docker stats` and the CPU credit balance (t3.medium earns 24 credits/h, 20% baseline per vCPU, Unlimited by default [V]); hang-up from both
ends leaves no stuck `agent_run` (reaper); `nmap -sU -p5060` from a non-allowlisted network shows filtered.

**Top risks and mitigations**
1. **Carrier verification not done in time** (KYC/manual review) [U]: sign up with two carriers now; ladder rung 3 below.
2. **One-way or no audio from NAT/RTP misconfig**: the config above, host networking, `rtp set debug on`; budget 30 min, then rung 2.
3. **AudioSocket shim details (DTMF message, pacing, serializer params) are unverified**: spike step 2 with a fake client before deploy;
   spoken-PIN `verify_pin` tool as DTMF fallback.
4. RAM/CPU on the t3.medium: Asterisk is small, the voice service is the same 1.2 GB budget as voice-agent.md; resize per its spike S4.

**Fallback ladder** (each rung reuses the same `bot.py`):
1. Telnyx/VoIP.ms DID -> self-hosted Asterisk -> shim -> bot (this doc).
2. Same Telnyx number, TeXML `<Stream>` -> `TelnyxFrameSerializer` [V-va], no SIP server (minutes to switch).
3. WebRTC "Talk to Keystone" button + QR, no number at all ($0).
4. Paid Twilio Media Streams as in `docs/voice-agent.md` (~$0.013/min [V-va]).

## Sources
- AWS: https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html (1:1 NAT, instance sees only private IP) ,
  https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html (60 rules per SG) ,
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html (t3.medium credits, Unlimited default)
- Asterisk: https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Configuring-res_pjsip-to-work-through-NAT/ ,
  https://raw.githubusercontent.com/asterisk/asterisk/master/configs/samples/rtp.conf.sample ,
  https://raw.githubusercontent.com/asterisk/asterisk/master/configs/samples/logger.conf.sample ,
  https://docs.asterisk.org/Latest_API/API_Documentation/Module_Configuration/res_pjsip_acl/
- Reused from `docs/voice-agent.md` (verified there today): Twilio trial/pricing, Telnyx TeXML stream + Pipecat serializer, SmallWebRTC.
- To verify before acting (all [U] above): https://github.com/fonoster/fonoster , https://docs.livekit.io/sip/ , https://docs.jambonz.org ,
  https://telnyx.com/pricing/elastic-sip , https://voip.ms/residential/pricing , https://support.google.com/a/answer/ (Google Voice SIP Link) ,
  https://docs.pipecat.ai/server/services/transport/small-webrtc , https://developers.cloudflare.com/realtime/turn/
