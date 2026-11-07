# Voice line without paid Twilio: WebRTC first, optional PSTN, all-NVIDIA speech (design, 2026-11-07, nothing built yet)

Alternative to the paid-Twilio edge in `docs/voice-agent.md`. Its pipeline is reused unchanged (Pipecat 1.15 `bot.py`, worker `/phone/*`
routes, PIN gate, disclosure, `agent_run` workflow `phone`). What changes: the primary entry point is a **browser "Talk to Keystone"
button** (no number, no carrier approval, $0), PSTN is optional, and **all inference is NVIDIA** (Cartesia/ElevenLabs fallbacks are dropped).
Marks: **[V]** I read it on the linked primary source today. **[V-h]** a parallel research pass read it on the linked primary source today
(not re-read by me). **[V-va]** verified today in `docs/voice-agent.md` or `docs/nvidia-stack.md`. **[U]** unverified or my estimate.
No accounts, purchases, installs or AWS changes were made.

## Decisions

| Question | Decision | Basis |
|---|---|---|
| Primary path | **WebRTC button (Pipecat SmallWebRTC)** in the web app, QR on the demo card | $0, no approval. Same `bot.py`, second transport [V-va] |
| WebRTC networking | Voice container on **host networking**, STUN in `PIPECAT_ICE_SERVERS`, open **UDP 32768-60999** | Without ICE servers the bot offers host (private) candidates only [V]; aioice binds random ports [V-h] |
| TURN | Not by default. If venue Wi-Fi blocks UDP: Cloudflare Realtime TURN, 1,000 GB/month free [V] | Cellular usually works with STUN only [V-h] |
| PSTN | **Optional.** No carrier is guaranteed review-free. Closest: **SignalWire** (card + $5 leaves trial, no KYC documented) [V] | Telnyx needs a fraud review [V]; VoIP.ms may flag for ID review [V-h]; Twilio may ask for a government ID [V-h] |
| PSTN glue | SignalWire cXML `<Connect><Stream>` to our `/voice/ws`, Twilio-compatible events, PCMU 8 kHz [V] | No SIP server needed. Reuses `TwilioFrameSerializer`; compatibility is [U], test first |
| Self-hosted SIP | **Not needed for the demo.** If wanted: Asterisk 23 + `chan_websocket` + `pipecat-asterisk` | Community transport, 23 stars, tested on Pipecat 1.8.1 [V] |
| Fonoster | **Not on this box tonight** (correction: no longer uses Asterisk; now speaks the Twilio protocol, so Pipecat works unchanged [V]) | 11 containers, no RAM figure published, Docker daemon change, Envoy wants 80/443 [V] |
| LiveKit SIP | Plan B SIP server only | Server + SIP + Redis (Redis required for SIP) [V-h]; official Pipecat transport with DTMF [V] |
| Google Voice | **No** | SIP Link needs Voice Standard/Premier + a certified commercial SBC [V]; consumer GV has no SIP and says forwarding to an automated system is unsupported [V] |
| ASR | **Hosted Nemotron ASR streaming** (NVCF, `NvidiaSTTService` default) | Already wired [V-va]; self-host NIM needs 4-13 GB VRAM [V] |
| LLM | **Nemotron 3.5 Lightning** per turn, thinking off; **Ultra** as async analyst | 3B active, function calling, `enable_thinking` toggle [V] |
| TTS | **Magpie TTS Multilingual**, voice `EN-US.Mia.Calm` or `Aria.Calm` (pick by ear) | Streaming, emotion variants [V]. Magpie Flow is zero-shot cloning, 20 s max, no preset voices [V] |
| Speech-to-speech | **No tonight** (Nemotron-VoiceChat 12B, PersonaPlex 7B exist; neither documents tool calling) | [V] |
| Hosting of inference | **Hosted NVCF tonight**; Brev only for the LLM failover already in nvidia-stack.md 5b | Self-hosting all three on one 80 GB GPU is possible on paper [U] but adds start-up time and gRPC exposure work |
| Cost | **$0** primary. Optional SignalWire: $5 deposit, about $2.50 used [V prices] | |
| Time | WebRTC button **~1.5-2 h** after the voice-agent.md MVP; SignalWire add-on ~45 min | [U] |

## 1. Primary: "Talk to Keystone" WebRTC button

- Signaling (Pipecat v1.15.0 runner): `POST /api/offer` (SDP offer plus `request_data`), `PATCH /api/offer` for trickle ICE, ICE servers from
  `--ice-servers` or `PIPECAT_ICE_SERVERS` (bare URLs or JSON objects with TURN credentials). Source comment: without them "it only ever offers
  host candidates" [V]. JS client: `@pipecat-ai/small-webrtc-transport`, `webrtcRequestParams: {endpoint: '/voice/api/offer'}`; `iceServers`
  default empty [V-h].
- EC2 is 1:1 NAT: the instance only knows its private IP, the internet gateway maps the Elastic IP [V]. So STUN is required to get a
  server-reflexive candidate with 52.72.164.85 [V for the mechanism, U for our box].
- Ports: aioice opens sockets on port 0 and aiortc has no port-range option [V-h], so the OS picks from Linux's ephemeral range 32768-60999
  [V-h]. Docker cannot publish a random UDP range, so the voice container needs `network_mode: host` [V-h]. Security groups are stateful,
  so the bot's outbound packets to STUN/TURN need no inbound rule [V-h].
- aiortc uses only the **first** STUN and the **first** TURN server; `turns:` works over TCP only [V-h]. Cloudflare TURN: `turn.cloudflare.com`
  UDP 3478/443, TCP 3478/80, TLS 5349/443; credentials via its `generate-ice-servers` API, valid up to 48 h [V-h]; free 1,000 GB then
  $0.05/GB [V]. Needs a Cloudflare account (signup, not an approval) [U]. Metered free tier is 500 MB/month [V-h]. Self-hosted coturn:
  3478 UDP/TCP, 5349 TLS, relay 49152-65535 [V-h] (skip tonight).
- Browser: `getUserMedia` needs HTTPS [V-h]; Caddy already serves HTTPS. iOS needs a tap to start mic and playback [U], which the button gives.
- PIN: no DTMF in a browser, so the page shows a 4-digit keypad and sends the PIN in `request_data`; the bot calls `/phone/identify` as before.
  Bonus: WebRTC audio is wideband, which should help ASR on dollar amounts in hall noise [U].

## 2. Optional PSTN with no approval step

| Provider | Gate to receive calls from judges | Number $/mo | Inbound $/min | Bot hookup | Verdict |
|---|---|---|---|---|---|
| **SignalWire** | Card + fund at least $5 leaves trial; KYC or manual review not mentioned [V]. Trial: calls only to/from purchased or verified numbers, 1 number [V] | $0.50 [V] | $0.0066 PSTN [V] (+$0.003 if forwarded over SIP [V]) | `<Connect><Stream>` WebSocket, PCMU 8k or L16 16/24k [V] | **Best fit**. Dallas stock [U], stream fee [U] |
| VoIP.ms | $15 prepaid [V-h]; new accounts "may be flagged" for a Persona ID review, no time stated [V-h] | $1.10 [V-h] | $0.009 [V-h] | SIP URI `1{DID}@IP:port` [V-h] (needs our SIP server) | Fallback; not guaranteed instant |
| Twilio paid | Legal name, phone, some customers must upload a government ID [V-h]; $20 suggested start [U] | $1.15 [V-va] | $0.0085 + streams $0.0044 [V-va] | Media Streams, native Pipecat [V-va] | Fallback; may hit ID review |
| Telnyx | Paid tier needs fraud review (LinkedIn/GitHub or AI eval), verified mobile, service address, card, 2FA [V] | $1.00 [V] | from $0.0032 [V] | TeXML stream [V-va] | **Out** (approval) |
| Flowroute | Government ID, EIN, company domain, manual "Pending Approval" [V-h] | $1.00 [V-h] | $0.005 [V-h] | SIP | Out |
| Callcentric | Free DID is gone; $1 "Dollar Unlimited" only NY/NJ/MA/IL [V-h] | $1-2.95 [V-h] | | SIP | Out (not Dallas) |
| IPComms | 30-day free test number, but SMS + photo-ID check [V-h] | $1.50 [V-h] | $0.009 [V-h] | SIP | Out (ID check) |

Plainly: **no PSTN option is guaranteed to need zero review.** SignalWire's documented path is a card and $5; if its signup asks for more,
skip PSTN entirely. **Google Voice: no.** SIP Link requires Voice Standard or Premier licences [V] and an SBC from AudioCodes, Cisco, Oracle or
Ribbon with mutual TLS on `siplink.telephony.goog:5672` and a certificate from DigiCert/Entrust/GlobalSign/GoDaddy/Sectigo [V]. Consumer GV:
"Forwarding calls from your Google Voice number to an automated system is unsupported" [V], and its policy says not to automate the system
to place calls [V-h]; the OBiTALK portal closed 2024-10-31 [V-h].

## 3. If the team still wants a self-hosted SIP server (optional, after the demo works)

- **Asterisk 23 + `chan_websocket` + `pipecat-asterisk` (pick).** `chan_websocket` ships in 23.0.0, 22.6.0, 21.11.0, 20.16.0; Asterisk reframes
  and times audio, sends `MEDIA_XOFF` at ~900 queued frames, supports `FLUSH_MEDIA`, `DTMF_END` and `HANGUP` messages [V]. `pipecat-asterisk`
  0.1.4 (2026-09-09, BSD-2, Python 3.12+) gives `AsteriskWebsocketTransport` / `AsteriskFrameSerializer` on FastAPI websockets; Asterisk dials
  out to the bot [V]; example dialplan `Dial(WebSocket/pipecat/c(slin16))` [V-h]; its tests used Pipecat 1.8.1, so 1.15 is [U].
  Ubuntu 24.04's `asterisk-modules` has `app/chan/res_audiosocket.so` and `res_ari.so` but **not** `chan_websocket.so` [V], so use a container:
  `andrius/asterisk` (the Docker Hub text still shows `latest`=22.5.2 [V], its GitHub README says `latest`=23 with chan_websocket [V-h]; pin a
  23.x tag and check `asterisk -V`). AudioSocket plus a ~120-line Twilio-protocol relay remains the fallback on the apt package [U].
  NAT: `external_media_address`/`external_signaling_address`=EIP, `local_net`=VPC CIDR, `direct_media=no`, `rtp_symmetric`, `force_rport`,
  `rewrite_contact` [V]; `rtp.conf` range [V]; `res_pjsip_acl` `permit`/`deny` [V]; `security` log channel for fail2ban [V].
- **Fonoster v0.52.1** (released 2026-11-07, three releases that day) [V]: bundle runs nats, postgres, routr-one 2.31.6, rtpengine, roomr,
  appbridge, autopilot, minio, apiserver, envoy, dashboard; no Asterisk [V]. Install docs list only ~6 GB disk, Docker Compose v2, curl, openssl
  (no RAM/CPU minimum) and require `"userland-proxy": false` (otherwise ~4,000 proxy processes run the machine out of memory) [V]. Envoy binds
  0.0.0.0:80/443 [V] (clashes with Caddy). Ports 5060 UDP/TCP and 10000-11999 UDP [V]. Its `twilio` stream protocol works with an unchanged
  `TwilioFrameSerializer` (`auto_hang_up=False`, tested on pipecat-ai 1.12.0); it "won't dial localhost or a private IP" [V]. README warns of
  breaking changes [V-h]. RAM estimate 1.1-2.2 GB [U]. Verdict: zero glue code, but too many moving parts for this box tonight; fine on a
  second instance later.
- **LiveKit**: server v1.13.11, SIP v1.23.0, Redis required for SIP [V-h]; official compose is three host-network services with
  `sip_port: 5060`, `rtp_port: 10000-20000`, `use_external_ip: true` [V/V-h]; trunk via `lk sip inbound create` (`numbers`,
  `allowed_addresses`) [V] plus a dispatch rule [V-h]; Pipecat `LiveKitTransport` turns SIP DTMF into `InputDTMFFrame` [V]; no official sizing
  [V], ~150-300 MB [U]. Plan B only.
- **No:** jambonz (self-hosting needs a licence key; mini package wants 4 vCPU / 8 GB) [V-h]; FreeSWITCH (packages need a SignalWire token,
  community `mod_audio_stream` is one-way) [V-h].

## 4. All-NVIDIA voice stack

- **ASR.** Hosted: `nemotron-asr-streaming`, NVCF fn `bb0837de-...`, default of `NvidiaSTTService` [V-va]. Self-host NIM:
  `nvcr.io/nim/nvidia/nemotron-asr-streaming:latest`, gRPC 50051, HTTP 9000, `--shm-size=8GB`, `NIM_TAGS_SELECTOR="name=nemotron-asr-streaming,type=en-US"` [V];
  GPU memory 4 GB (batch 32), 13 GB (batch 128, default), 23 GB (batch 512); needs compute capability 8.0+ and 16 GB+ VRAM [V]. Speech NIM
  26.10.0 (2026-11-06) moved it to 8-speaker diarization and ~5x more streams [V].
- **LLM.** Nemotron 3.5 Lightning 30B-A3B: 3B active, function calling, `enable_thinking` toggle, temp 1.0 / top_p 0.95, released 2026-08-11 [V].
  Ultra stays the async analyst (voice-agent.md 2.3). Brev vLLM NVFP4 recipe: nvidia-stack.md 5b (25.2 GB weights, 40-80 GB GPU) [V-va].
- **TTS.** Magpie TTS Multilingual v4.0, 22.05 kHz, streaming + offline [V]. EN-US speakers **Aria, Jason, Leo, Mia, Ray** with Angry/Calm/Happy/Sad,
  and **Sofia** neutral only [V]; names `Magpie-Multilingual.EN-US.<Speaker>[.<Emotion>]` [V]. Magpie TTS **Flow**: flow-matching zero-shot
  voice conversion from a 5 s prompt, 22.05 kHz, 20 s maximum, no preset voices or streaming documented [V]; the NIM ships "Magpie TTS
  Zeroshot" (Female/Male, no emotions) [V]. Most human for a live call: Multilingual with a `.Calm` style (streaming + prosody control);
  Flow would need a consented voice sample and per-sentence calls [U, judge by ear in spike S2]. NIM `nvcr.io/nim/nvidia/magpie-tts-multilingual`:
  12.58 GB at batch 8, 16 GB+ VRAM [V].
- **Speech-to-speech.** Nemotron-VoiceChat: 12B, full duplex, English only, persona via text role prompts, NGC 2026-03-16, hosted endpoint,
  self-host on H100 with vLLM; tool calling not documented [V]. PersonaPlex-7B-v1: Moshi-based full duplex, 24 kHz, English, A100/H100, NVIDIA
  Open Model License + CC-BY-4.0, no tool calling documented [V]. Letting one of them talk while Nemotron runs tools would need a custom
  text-injection bridge and would weaken the "every number comes from a traced tool call" story [U]. Not tonight; a good "next" slide.
- **Brev single GPU (stretch).** ASR 4 GB + TTS 12.6 GB [V] + Lightning NVFP4 ~25 GB weights [V-va] + KV cache fits an 80 GB A100/H100 if vLLM
  is capped (`--gpu-memory-utilization 0.5`, `--max-model-len 32768`) [U]; a 48 GB L40S is tight, and the TTS support list names L40, not L40S [V].
  Brev's page lists H100 at ~$1.99/h (estimates) [V], so $60 is roughly 30 h [U]. Unknowns: first-start download and engine time [U],
  and exposing gRPC 50051 through a Brev share URL [U] (the voice service may have to run on the Brev box). **Tonight: hosted NVCF**, warm gRPC
  channels at connect, one retry, pre-rendered greeting; move speech to Brev only if spike S2 shows throttling or cold starts.
```bash
# Brev A100/H100 80 GB, stretch only. Pipecat then points NvidiaSTTService/NvidiaTTSService at these hosts without SSL [U param names].
echo "$NGC_API_KEY" | docker login nvcr.io -u '$oauthtoken' --password-stdin
docker run -d --name asr --runtime=nvidia --gpus '"device=0"' --shm-size=8GB -e NGC_API_KEY -e NIM_HTTP_API_PORT=9000 -e NIM_GRPC_API_PORT=50051 \
  -e NIM_TAGS_SELECTOR="name=nemotron-asr-streaming,type=en-US" -p 50051:50051 nvcr.io/nim/nvidia/nemotron-asr-streaming:latest      # [V]
docker run -d --name tts --runtime=nvidia --gpus '"device=0"' --shm-size=8GB -e NGC_API_KEY -e NIM_HTTP_API_PORT=9001 -e NIM_GRPC_API_PORT=50052 \
  -p 50052:50052 nvcr.io/nim/nvidia/magpie-tts-multilingual:latest                                                                    # [U] same pattern
# LLM: the vllm serve line from docs/nvidia-stack.md 5b plus --gpu-memory-utilization 0.5 --max-model-len 32768                       [U]
```

## 5. AWS networking (the team runs these; nothing was changed)

Default quota: 60 inbound rules per security group [V]. Needed for the primary path only:
```bash
aws ec2 authorize-security-group-ingress --region us-east-1 --group-id sg-0959faaac722648d1 --ip-permissions \
  'IpProtocol=udp,FromPort=32768,ToPort=60999,IpRanges=[{CidrIp=0.0.0.0/0,Description=webrtc-media}]'
```
- SignalWire PSTN adds **no** rule (its stream arrives as `wss://` on 443). Self-hosted SIP (section 3) would add UDP 5060 from the carrier's
  signaling IPs only (VoIP.ms 208.100.60.0/24 [V-h]; Twilio 54.172.60.0/30, 54.244.51.0/30 [V-h]; Telnyx 192.76.120.10, 64.16.250.10 [V];
  SignalWire publishes no static list [V-h]) plus UDP 10000-20000 for RTP.
- Host networking means the voice process listens on the box itself: bind HTTP to 0.0.0.0:7860 (the security group keeps 7860 closed) so the
  Caddy container can reach it via `host.docker.internal`, and publish the worker on 127.0.0.1:8787 for the voice process.
- t3.medium earns 24 CPU credits/h (20% baseline per vCPU) and is Unlimited by default [V]; watch `CPUCreditBalance` during the 3-call test.

## 6. Plan

```yaml
  # infra/docker-compose.yml (additions / changes)
  voice:
    build: { context: ../services/voice }
    image: keystone-voice:latest
    network_mode: host                    # WebRTC UDP straight on the host; no ports/expose allowed in this mode
    restart: always
    env_file: ../.env
    environment: { VOICE_HTTP: "0.0.0.0:7860", WORKER_URL: "http://127.0.0.1:8787", VOICE_TRANSPORTS: "webrtc,twilio" }
    mem_limit: 1200m
  worker:   { ports: ["127.0.0.1:8787:8787"] }                          # add to the existing service
  caddy:    { extra_hosts: ["host.docker.internal:host-gateway"] }      # add to the existing service
```
```caddy
	handle /worker/phone/* { respond 404 }               # before /worker/*, as in voice-agent.md
	handle /voice/* {
		uri strip_prefix /voice
		reverse_proxy host.docker.internal:7860 { flush_interval -1 }  # /api/offer (WebRTC), /ws (SignalWire stream), /twiml
	}
```
**Env** (`.env.prod`): `PIPECAT_ICE_SERVERS=stun:stun.l.google.com:19302` (or a Cloudflare TURN JSON object, first entry wins),
`VOICE_TRANSPORTS`, `CALLER_HASH_SALT`, `VOICE_SHARED_SECRET`, `NVIDIA_VOICE_API_KEY`, `NVIDIA_ASR_FUNCTION_ID`, `NVIDIA_TTS_FUNCTION_ID`,
`NVIDIA_TTS_VOICE=Magpie-Multilingual.EN-US.Mia.Calm`, `VOICE_LLM_MODEL=nvidia/nemotron-3.5-lightning-30b-a3b`, `VOICE_LLM_FALLBACK_URL=$BREV_BASE_URL`,
optional `SIGNALWIRE_PROJECT_ID`/`SIGNALWIRE_TOKEN` (signature check) and `SIGNALWIRE_NUMBER`. Delete `VOICE_TTS_PROVIDER` and `CARTESIA_API_KEY`.

**Steps** (after the voice-agent.md MVP, Phase 1 steps 1-2, exists):
1. (15 min) Compose and Caddy changes above; `PIPECAT_ICE_SERVERS`; deploy. Team adds the one UDP rule.
2. (45 min) Web: "Talk to Keystone" button with `@pipecat-ai/client-js` + small-webrtc transport, PIN keypad, mute/hang-up, live caption of
   "Heard:/Said:" from the trace; QR to `/me?talk=1`.
3. (20 min) Test from phones on AT&T, T-Mobile, Verizon cellular and on the venue Wi-Fi. If Wi-Fi fails: Cloudflare TURN (15 min).
4. (optional, 45 min) SignalWire: fund $5, buy a 214/469/972 number if offered, cXML `<Connect><Stream url="wss://$PUBLIC_HOSTNAME/voice/ws"/>`,
   `TwilioFrameSerializer(auto_hang_up=False)`, call it from three carriers.
5. (20 min) Hardening: `VOICE_ENABLED` kill switch, 5-minute cap, 3 concurrent sessions, spend cap on SignalWire.

**Test plan:** `chrome://webrtc-internals` shows a selected srflx (or relay) pair with 52.72.164.85; 10 button sessions from 3 phones;
PIN, barge-in and the three demo questions under hall noise; 3 simultaneous sessions while watching `docker stats` and CPU credits;
hang-up and tab close both finish the `agent_run`; the trace shows Nemotron ASR, Lightning and Magpie badges only.

**Top risks**
1. **Venue Wi-Fi blocks UDP or client isolation** -> button connects but no audio. Mitigate: tell judges to use cellular, keep a Cloudflare
   TURN credential ready (first TURN entry only, `turns:` is TCP-only in aiortc) [V-h].
2. **Hosted NVCF speech throttles or cold-starts** (speech pages warn about other users' traffic) [V-va]. Mitigate: warm channels at connect,
   one retry, pre-rendered greeting, short replies; Brev self-host (section 4) as stretch.
3. **Host-networking side effects** (Caddy cannot use the service name; the voice process shares the host's ports). Mitigate: the explicit
   `host.docker.internal` route, worker on loopback, test before the judging window.

**Fallback ladder** (same `bot.py` every time): 1) WebRTC button with STUN -> 2) same button over Cloudflare TURN -> 3) SignalWire number with
`<Connect><Stream>` -> 4) Twilio paid or VoIP.ms (possible ID review) -> 5) self-hosted Asterisk 23 + pipecat-asterisk behind any carrier,
only for the "own SIP server" story.

## Sources
- Pipecat: https://raw.githubusercontent.com/pipecat-ai/pipecat/v1.15.0/src/pipecat/runner/run.py , https://docs.pipecat.ai/api-reference/server/services/transport/livekit.md ,
  https://docs.pipecat.ai/api-reference/server/services/serializers/asterisk.md , https://pypi.org/project/pipecat-asterisk/ , https://github.com/NikolayShakin/pipecat-asterisk ,
  [V-h] https://docs.pipecat.ai/api-reference/client/js/transports/small-webrtc.md , https://github.com/aiortc/aiortc/blob/main/src/aiortc/rtcicetransport.py
- WebRTC/TURN: https://developers.cloudflare.com/realtime/pricing/ ; [V-h] https://developers.cloudflare.com/realtime/turn/ , https://www.metered.ca/pricing ,
  https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf , https://docs.kernel.org/networking/ip-sysctl.html , https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Carriers: https://signalwire.com/docs/platform/trial-mode.md , https://signalwire.com/pricing/voice , https://signalwire.com/docs/compatibility-api/cxml/reference/voice/stream ,
  https://telnyx.com/pricing/elastic-sip , https://telnyx.com/phone-numbers/texas , https://developers.telnyx.com/docs/account-setup/account-upgrade.md ,
  https://developers.telnyx.com/docs/account-setup/levels-and-capabilities/trial , .../paid , https://sip.telnyx.com/ ;
  [V-h] https://wiki.voip.ms/article/Service_Cost , https://wiki.voip.ms/article/Account_Verification , https://wiki.voip.ms/article/SIP_URI , https://wiki.voip.ms/article/Choosing_Server
  (VoIP.ms blocks automated fetches; read by the helper in a browser), https://help.twilio.com/articles/223183208-Upgrading-to-a-paid-Twilio-Account ,
  https://www.twilio.com/docs/sip-trunking/ip-addresses , https://www.flowroute.com/pricing/ , https://support.bcmone.com/docs/sign-up-for-a-flowroute-account ,
  https://www.callcentric.com/dids/dollar_unlimited_phone_number , https://www.ipcomms.net/ , https://signalwire.com/docs/platform/allow-signalwire-ips-through-your-firewall
- Google Voice: https://knowledge.workspace.google.com/admin/voice/sip-link-requirements?hl=en , https://support.google.com/voice/answer/165221?hl=en ;
  [V-h] https://support.google.com/voice/answer/9230450?hl=en , https://knowledge.workspace.google.com/admin/voice/compare-voice-subscriptions
- SIP servers: https://github.com/fonoster/fonoster/releases , https://github.com/fonoster/fonoster/blob/main/ops/bundle/compose.yaml ,
  https://docs.fonoster.com/self-hosting/install-compose , https://docs.fonoster.com/streams/bring-your-app , https://docs.asterisk.org/Configuration/Channel-Drivers/WebSocket ,
  https://packages.ubuntu.com/noble/amd64/asterisk-modules/filelist , https://hub.docker.com/r/andrius/asterisk , https://docs.livekit.io/home/self-hosting/sip-server/ ,
  https://docs.livekit.io/sip/trunk-inbound/ , https://docs.asterisk.org/Configuration/Channel-Drivers/SIP/Configuring-res_pjsip/Configuring-res_pjsip-to-work-through-NAT/ ,
  https://docs.asterisk.org/Latest_API/API_Documentation/Module_Configuration/res_pjsip_acl/ ; [V-h] https://github.com/andrius/asterisk , https://raw.githubusercontent.com/livekit/sip/main/docker-compose.yaml ,
  https://docs.jambonz.org/self-hosting/overview/licensing , https://docs.jambonz.org/self-hosting/debian-package , https://github.com/amigniter/mod_audio_stream
- NVIDIA: https://docs.nvidia.com/nim/speech/latest/asr/deploy-asr-models/nemotron-asr-streaming.html , https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/asr.html ,
  https://docs.nvidia.com/nim/speech/latest/reference/support-matrix/tts.html , https://docs.nvidia.com/nim/speech/latest/tts/voices.html , https://docs.nvidia.com/nim/speech/latest/about/release-notes.html ,
  https://build.nvidia.com/nvidia/magpie-tts-multilingual.md , https://build.nvidia.com/nvidia/magpie-tts-flow.md , https://build.nvidia.com/nvidia/nemotron-voicechat.md ,
  https://build.nvidia.com/nvidia/nemotron-3.5-lightning-30b-a3b.md , https://github.com/NVIDIA/PersonaPlex , https://huggingface.co/nvidia/personaplex-7b-v1/blob/main/README.md ,
  https://www.nvidia.com/en-us/launchables/pricing
- AWS: https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html , https://docs.aws.amazon.com/vpc/latest/userguide/amazon-vpc-limits.html ,
  https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html ; [V-h] https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html
