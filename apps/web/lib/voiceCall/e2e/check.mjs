// Browser check for the microphone path: explicit audio constraints, hold-to-talk and the speakerphone guard.
//
// Real Chrome with FAKE media devices, the REAL PipecatClient + SmallWebRTCTransport and our own session.ts / voice.ts (bundled with
// esbuild into a throwaway page). The Pipecat server is faked inside the page: a second RTCPeerConnection answers the offer and speaks
// RTVI on the data channel, so the whole call path runs without the voice service. SpeechRecognition is stubbed (headless Chrome
// cannot recognise speech) to prove Table Mode pauses/resumes it and hands it our processed track.
//
//   mkdir -p /tmp/mic-check && cd /tmp/mic-check && npm init -y && npm i playwright-core esbuild
//   node <repo>/apps/web/lib/voiceCall/e2e/check.mjs              # CHROME=/path/to/chrome to override /usr/bin/google-chrome; PORT=4173
//
// (Neither dependency is in the web app's package.json; they are resolved from the directory you run this in.) It starts and stops its own
// static server and browser, and needs no dev server, voice service or worker. About 2 minutes. Exit code 1 if any check fails.
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const req = createRequire(path.join(process.cwd(), "noop.js"));
const { chromium } = req("playwright-core");
const { build } = req("esbuild");

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "../../..");
const SITE = fs.mkdtempSync(path.join(os.tmpdir(), "mic-check-"));
fs.writeFileSync(path.join(SITE, "index.html"), '<!doctype html><meta charset="utf-8"><title>voice harness</title><body><script src="/bundle.js"></script></body>');
await build({
  stdin: { contents: 'import "@/lib/voiceCall/session";\nimport "@/lib/voice";', resolveDir: WEB, loader: "ts" },
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: path.join(SITE, "bundle.js"),
  alias: { "@": WEB },
  define: { "process.env.NODE_ENV": '"development"', "process.env.NEXT_PUBLIC_VOICE_URL": '"http://localhost:7860"', "process.env.NEXT_PUBLIC_WORKER_URL": '"http://localhost:8787"' },
  banner: { js: 'var process = globalThis.process || { env: {}, platform: "browser", versions: {}, argv: [], nextTick: function (f) { setTimeout(f, 0); } };' },
  logLevel: "warning",
});

const PORT = Number(process.env.PORT ?? 4173);
const ORIGIN = `http://localhost:${PORT}`;
const VOICE = "http://localhost:7860";
const WORKER = "http://localhost:8787";

const server = http.createServer((req, res) => {
  const f = path.join(SITE, req.url === "/" ? "index.html" : req.url.split("?")[0]);
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404).end(); return; }
    res.writeHead(200, { "content-type": f.endsWith(".js") ? "text/javascript" : "text/html" }).end(buf);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--no-sandbox",
  ],
});

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "   " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Injected into every page before the app code: records getUserMedia, hosts the fake Brian, stubs SpeechRecognition. */
function initScript() {
  const md = navigator.mediaDevices;
  const orig = md.getUserMedia.bind(md);
  window.__gum = [];
  md.getUserMedia = async (c) => {
    const s = await orig(c);
    window.__gum.push({ constraints: JSON.parse(JSON.stringify(c)), stream: s });
    return s;
  };
  window.__audioTracks = () => window.__gum.flatMap((g) => g.stream.getAudioTracks());

  // ---------------------------------------------------------------- fake Brian
  const bot = (window.__bot = { received: [], dc: null, pc: null, rx: null });
  bot.say = (type, data) => bot.dc.send(JSON.stringify({ label: "rtvi-ai", type, id: String(Math.random()), data }));
  bot.messages = (pred) => bot.received.filter((m) => pred(m.msg));
  bot.answer = async (offer) => {
    const pc = new RTCPeerConnection({ iceServers: [] });
    bot.pc = pc;
    pc.ondatachannel = (e) => {
      bot.dc = e.channel;
      e.channel.onmessage = (m) => {
        let j;
        try { j = JSON.parse(m.data); } catch { return; } // keep-alive "ping: ..."
        bot.received.push({ at: performance.now(), msg: j });
        if (j.type === "client-ready") bot.say("bot-ready", { version: "2.3.0", about: {} });
      };
    };
    pc.ontrack = (e) => {
      if (e.track.kind !== "audio") return;
      bot.rx = e.receiver;
      // The receiver only reports decoded energy while something plays it. (Bytes on the wire are useless here: a young WebRTC
      // connection sends ~1.7 KB/s of start-up overhead even for a disabled track.)
      const el = new Audio();
      el.srcObject = new MediaStream([e.track]);
      el.volume = 0.01;
      el.play().catch(() => {});
      bot.el = el;
    };
    const ac = new AudioContext();
    await ac.resume();
    const osc = ac.createOscillator();
    const g = ac.createGain();
    g.gain.value = 0.02;
    const dest = ac.createMediaStreamDestination();
    osc.connect(g).connect(dest);
    osc.start();
    await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
    const tx = pc.getTransceivers().find((t) => t.receiver.track.kind === "audio");
    await tx.sender.replaceTrack(dest.stream.getAudioTracks()[0]);
    tx.direction = "sendrecv";
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") {
      await new Promise((res) => pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && res()));
    }
    return { sdp: pc.localDescription.sdp, type: "answer", pc_id: "fake-1" };
  };
  /** Audio energy that arrived at the fake server over `ms`. */
  bot.energy = async (ms) => {
    const get = async () => {
      let e = 0, d = 0;
      let bytes = 0, pk = 0, lvl = 0;
      (await bot.rx.getStats()).forEach((s) => { if (s.type === "inbound-rtp" && s.kind === "audio") { e = s.totalAudioEnergy ?? 0; d = s.totalSamplesDuration ?? 0; bytes = s.bytesReceived ?? 0; pk = s.packetsReceived ?? 0; lvl = s.audioLevel ?? 0; } });
      return { e, d, bytes, pk, lvl };
    };
    let peak = 0;
    const a = await get();
    const t0 = performance.now();
    while (performance.now() - t0 < ms) { await new Promise((r) => setTimeout(r, 100)); peak = Math.max(peak, (await get()).lvl); }
    const b = await get();
    return { energy: b.e - a.e, seconds: b.d - a.d, bytes: b.bytes - a.bytes, packets: b.pk - a.pk, peakLevel: peak };
  };

  // ---------------------------------------------------------------- SpeechRecognition stand-in (headless Chrome cannot recognise speech)
  window.__sr = { log: [], inst: null };
  class FakeSR {
    constructor() { window.__sr.inst = this; this.active = false; }
    start(track) {
      window.__sr.log.push({ op: "start", at: performance.now(), track: track ? { kind: track.kind, enabled: track.enabled, ready: track.readyState, settings: track.getSettings() } : null });
      this.active = true;
    }
    stop() {
      window.__sr.log.push({ op: "stop", at: performance.now() });
      if (!this.active) return;
      this.active = false;
      setTimeout(() => { // like Chrome: deliver what was heard as a final phrase, then end
        this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: "hello there" } } } });
        this.onend?.();
      }, 30);
    }
    abort() { this.active = false; }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
}

async function newPage(opts = {}) {
  const context = await browser.newContext({ permissions: ["microphone"], ...opts });
  await context.addInitScript(initScript);
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => logs.push({ type: m.type(), text: m.text() }));
  page.on("pageerror", (e) => logs.push({ type: "pageerror", text: e.message }));
  return { context, page, logs };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

// =================================================================================================== Talk call
async function callTests() {
  console.log("\n=== Talk call (Pipecat client + SmallWebRTC transport, fake Brian) ===");
  const { context, page, logs } = await newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await context.route(`${VOICE}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    if (url.pathname === "/health") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: '{"ok":true}' });
    if (url.pathname === "/api/offer" && req.method() === "POST") {
      const answer = await page.evaluate((o) => window.__bot.answer(o), JSON.parse(req.postData()));
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(answer) });
    }
    return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: "{}" }); // ICE trickle PATCH
  });

  await page.goto(ORIGIN + "/");
  await page.waitForFunction(() => !!window.__keystoneVoice?.call);
  const V = (fn, ...a) => page.evaluate(([f, args]) => window.__keystoneVoice.call[f](...args), [fn, a]);
  const S = () => page.evaluate(() => { const s = window.__keystoneVoice.call.getCallState(); return { phase: s.phase, pushToTalk: s.pushToTalk, talkHeld: s.talkHeld, halfDuplex: s.halfDuplex, botSpeaking: s.botSpeaking, micLive: s.micLive, muted: s.muted, processing: s.processing, error: s.error }; });
  const trackEnabled = () => page.evaluate(() => window.__audioTracks().at(-1)?.enabled);
  const botGot = (state) => page.evaluate((st) => window.__bot.messages((m) => m.type === "client-message" && m.data?.t === "ptt" && m.data?.d?.state === st).length, state);
  const botGotMsg = (t) => page.evaluate((tt) => window.__bot.messages((m) => m.type === "client-message" && m.data?.t === tt).length, t);

  let s = await S();
  check("phone-like viewport: speakerphone guard defaults ON", s.halfDuplex === true);
  check("hold-to-talk defaults OFF", s.pushToTalk === false);

  await V("startCall", { householdId: "hh_rivera", displayName: "Tester" }, { skipExplainer: true });
  await page.waitForFunction(() => ["live", "error"].includes(window.__keystoneVoice.call.getCallState().phase), null, { timeout: 40000 });
  s = await S();
  check("call reaches 'live' against the fake Brian", s.phase === "live", JSON.stringify(s.error));
  if (s.phase !== "live") return;

  // --- constraints
  const gum = await page.evaluate(() => window.__gum.map((g) => g.constraints));
  check("exactly one getUserMedia (no hidden second capture)", gum.length === 1, `calls=${gum.length}`);
  const want = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  check("getUserMedia asked for EC + NS + AGC + mono", JSON.stringify(gum[0]?.audio) === JSON.stringify(want), JSON.stringify(gum[0]));
  const settings = await page.evaluate(() => window.__audioTracks()[0].getSettings());
  console.log("      track.getSettings() =", JSON.stringify({ echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression, autoGainControl: settings.autoGainControl, channelCount: settings.channelCount, sampleRate: settings.sampleRate }));
  check("browser APPLIED all four (track.getSettings())", settings.echoCancellation === true && settings.noiseSuppression === true && settings.autoGainControl === true && settings.channelCount === 1);
  check("session state exposes the same report", s.processing?.allApplied === true);
  // The bot's audio arrives with the remote track's "unmute" (first RTP packet), which can trail "live" by a moment.
  await page.waitForFunction(() => document.querySelector("audio")?.srcObject instanceof MediaStream, null, { timeout: 8000 }).catch(() => {});
  const devLog = logs.find((l) => l.text.startsWith("[voice] mic settings (call)"));
  check("dev console logged the settings once", logs.filter((l) => l.text.startsWith("[voice] mic settings (call)")).length === 1 && !!devLog);
  const playback = logs.find((l) => l.text.startsWith("[voice] playback"));
  check("dev console logged the playback wiring", !!playback);

  // --- playback wiring
  const audio = await page.evaluate(() => { const els = [...document.querySelectorAll("audio")]; const a = els[0]; return { n: els.length, playsinline: a?.hasAttribute("playsinline"), hasStream: a?.srcObject instanceof MediaStream, tracks: a?.srcObject?.getAudioTracks().length, live: a?.srcObject?.getAudioTracks()[0]?.readyState }; });
  check("one <audio playsinline> bound to the remote MediaStream", audio.n === 1 && audio.playsinline && audio.hasStream && audio.tracks === 1 && audio.live === "live", JSON.stringify(audio));

  // --- baseline: not push-to-talk, track live, audio reaches the server
  check("mic track enabled while talking normally", (await trackEnabled()) === true && s.micLive === true);
  await sleep(1500);
  // NB: Chrome caches getStats() for about a second, so byte-rate checks use settle delays and 4 s windows.
  const baseE = await page.evaluate(() => window.__bot.energy(4000));
  console.log("      server-side audio, mic open:", JSON.stringify({ energy: baseE.energy, bytes: baseE.bytes }));

  // --- hold-to-talk
  await V("setPushToTalk", true);
  s = await S();
  check("setPushToTalk(true): track disabled, micLive false", (await trackEnabled()) === false && s.pushToTalk && !s.micLive);
  check("preference remembered in localStorage", (await page.evaluate(() => localStorage.getItem("keystone.voice.pushToTalk"))) === "1");
  await sleep(300);
  check("bot told ptt/enabled", (await botGot("enabled")) === 1);
  await sleep(2000);
  const idleE = await page.evaluate(() => window.__bot.energy(4000));
  console.log("      server-side audio, mic gated:", JSON.stringify({ energy: idleE.energy, bytes: idleE.bytes }));
  check("gated mic: the server decodes exactly zero audio energy", idleE.energy === 0 && baseE.energy > 1e-5, `gated=${idleE.energy.toExponential(2)} open=${baseE.energy.toExponential(2)} per 4 s`);

  await V("pressTalk");
  s = await S();
  check("pressTalk(): track enabled, talkHeld, micLive", (await trackEnabled()) === true && s.talkHeld && s.micLive);
  await sleep(300);
  check("bot told ptt/pressed", (await botGot("pressed")) === 1);
  await sleep(1500);
  const heldE = await page.evaluate(() => window.__bot.energy(4000));
  console.log("      server-side audio, button held:", JSON.stringify({ energy: heldE.energy, bytes: heldE.bytes }));
  check("held mic: the server decodes real audio again", heldE.energy > 1e-5 && heldE.energy > baseE.energy * 0.2, `held=${heldE.energy.toExponential(2)} open=${baseE.energy.toExponential(2)}`);

  await V("releaseTalk");
  s = await S();
  check("releaseTalk(): talkHeld false at once, mic still open for the short tail", !s.talkHeld && (await trackEnabled()) === true && (await botGot("released")) === 0);
  await sleep(500);
  s = await S();
  check("after the tail: track disabled, micLive false", (await trackEnabled()) === false && !s.micLive);
  check("bot told ptt/released (exactly once)", (await botGot("released")) === 1);
  const order = await page.evaluate(() => window.__bot.received.filter((m) => m.msg.type === "client-message" && m.msg.data?.t === "ptt").map((m) => m.msg.data.d.state));
  check("ptt message order enabled > pressed > released", JSON.stringify(order) === '["enabled","pressed","released"]', JSON.stringify(order));
  await V("releaseTalk");
  await sleep(100);
  check("releaseTalk() is idempotent", (await botGot("released")) === 1);

  // --- mute still wins
  await V("pressTalk");
  await V("toggleMute");
  s = await S();
  check("Mute wins over a held talk button", (await trackEnabled()) === false && !s.micLive && s.muted);
  await V("toggleMute");
  await V("releaseTalk");
  await sleep(450);

  // --- push-to-talk off again
  await V("setPushToTalk", false);
  s = await S();
  check("setPushToTalk(false): mic live again", (await trackEnabled()) === true && s.micLive && !s.pushToTalk);
  check("bot told ptt/disabled", (await botGot("disabled")) === 1);

  // --- speakerphone guard
  await V("setHalfDuplex", true);
  await page.evaluate(() => window.__bot.say("bot-started-speaking"));
  await sleep(150);
  s = await S();
  check("bot-started-speaking: botSpeaking, track disabled, micLive false", s.botSpeaking && (await trackEnabled()) === false && !s.micLive);
  await V("interrupt");
  s = await S();
  check("interrupt(): mic re-enabled immediately while the bot is still speaking", (await trackEnabled()) === true && s.micLive && s.botSpeaking);
  check("bot got the interrupt client message", (await botGotMsg("interrupt")) === 1);
  await page.evaluate(() => window.__bot.say("user-stopped-speaking"));
  await sleep(150);
  s = await S();
  check("user-stopped-speaking ends the interrupt window (guard back on)", (await trackEnabled()) === false && !s.micLive);
  await page.evaluate(() => window.__bot.say("bot-stopped-speaking"));
  await sleep(120);
  s = await S();
  check("bot-stopped-speaking: mic stays closed during the playout tail", s.botSpeaking && (await trackEnabled()) === false);
  await sleep(600);
  s = await S();
  check("after the tail: botSpeaking false, mic open", !s.botSpeaking && (await trackEnabled()) === true && s.micLive);

  await V("setHalfDuplex", false);
  await page.evaluate(() => window.__bot.say("bot-started-speaking"));
  await sleep(150);
  s = await S();
  check("guard OFF: bot speech does not touch the mic", s.botSpeaking && (await trackEnabled()) === true && s.micLive);
  await page.evaluate(() => window.__bot.say("bot-stopped-speaking"));
  await sleep(600);
  await V("setHalfDuplex", true);

  // --- hang up releases the mic
  await V("hangUp");
  await sleep(800);
  const ended = await page.evaluate(() => window.__audioTracks().every((t) => t.readyState === "ended"));
  s = await S();
  check("hangUp(): mic track ended (indicator off), controls reset", ended && !s.micLive && !s.talkHeld && !s.botSpeaking);

  // --- second call with push-to-talk persisted: nothing leaks before the first press
  await page.reload();
  await page.waitForFunction(() => !!window.__keystoneVoice?.call);
  await V("setPushToTalk", true);
  s = await S();
  check("after reload the saved preference is picked up", s.pushToTalk === true || (await page.evaluate(() => localStorage.getItem("keystone.voice.pushToTalk"))) === "1");
  await V("startCall", { householdId: "hh_rivera", displayName: "Tester" }, { skipExplainer: true });
  await page.waitForFunction(() => window.__keystoneVoice.call.getCallState().phase === "live", null, { timeout: 40000 });
  check("call started in hold-to-talk: track is disabled from the very first moment", (await trackEnabled()) === false);
  check("call started in hold-to-talk: bot is told ptt/enabled as soon as the call is live", (await botGot("enabled")) === 1);
  await sleep(3000); // let the sender's start-up probing settle
  const e2 = await page.evaluate(() => window.__bot.energy(4000));
  await V("setPushToTalk", false);
  await sleep(2000);
  const e3 = await page.evaluate(() => window.__bot.energy(4000));
  console.log("      second call, server-side decoded energy over 4 s: gated", e2.energy.toExponential(2), "then open", e3.energy.toExponential(2));
  check("...and the server decodes zero audio until the first press", e2.energy === 0 && e3.energy > 1e-5, `gated=${e2.energy.toExponential(2)} open=${e3.energy.toExponential(2)}`);
  await V("hangUp");
  await sleep(500);

  const bad = logs.filter((l) => l.type === "pageerror");
  check("no uncaught page errors", bad.length === 0, bad.map((b) => b.text).join(" | "));
  await context.close();
}

// =================================================================================================== Table Mode
async function tableTests(workerUp) {
  console.log(`\n=== Table Mode (VoiceCapture), NVIDIA ASR worker ${workerUp ? "UP" : "DOWN"} ===`);
  const { context, page, logs } = await newPage();
  const asrPosts = [];
  await context.route(`${WORKER}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (!workerUp) return route.abort();
    if (url.pathname === "/health") return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: '{"ok":true}' });
    if (url.pathname === "/asr") {
      if (route.request().method() === "POST") asrPosts.push({ at: Date.now(), size: (route.request().postDataBuffer() ?? Buffer.alloc(0)).length });
      return route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: '{"ok":true}' });
    }
    return route.fulfill({ status: 404, headers: CORS });
  });
  await page.goto(ORIGIN + "/");
  await page.waitForFunction(() => !!window.__keystoneVoice?.table);
  const T = (fn, ...a) => page.evaluate(([f, args]) => window.__keystoneVoice.table[f](...args), [fn, a]);
  const trackEnabled = () => page.evaluate(() => window.__audioTracks().at(-1)?.enabled);
  const srOps = () => page.evaluate(() => window.__sr.log.map((l) => l.op));
  await page.evaluate(() => {
    window.__finals = []; window.__errors = [];
    window.__cap = new window.__keystoneVoice.table.VoiceCapture(
      { onFinal: (t) => window.__finals.push(t), onInterim() {}, onError: (e) => window.__errors.push(e), onMode() {} },
      { huddleId: "h1", speaker: "Ana" },
    );
  });
  const mode = workerUp ? "PTT already ON before Start" : "PTT toggled while running";
  if (workerUp) await T("setTablePushToTalk", true);
  await page.evaluate(() => window.__cap.start());
  await sleep(300);

  const gum = await page.evaluate(() => window.__gum.map((g) => g.constraints));
  const want = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  check("Table Mode opens ONE constrained stream", gum.length === 1 && JSON.stringify(gum[0].audio) === JSON.stringify(want), JSON.stringify(gum));
  const settings = await page.evaluate(() => window.__audioTracks()[0].getSettings());
  check("browser APPLIED all four", settings.echoCancellation && settings.noiseSuppression && settings.autoGainControl && settings.channelCount === 1);
  check("dev console logged the settings once", logs.filter((l) => l.text.startsWith("[voice] mic settings (table-mode)")).length === 1);

  if (!workerUp) {
    const first = await page.evaluate(() => window.__sr.log[0]);
    check("recognizer was handed our processed track (Chromium start(track))", first?.op === "start" && first.track?.kind === "audio" && first.track.settings.noiseSuppression === true && first.track.settings.echoCancellation === true, JSON.stringify(first));
    check("listening: micLive, track enabled", (await page.evaluate(() => window.__cap.micLive)) === true && (await trackEnabled()) === true);

    await T("setTablePushToTalk", true);
    await sleep(200);
    check("hold-to-talk ON pauses recognition (stop) and disables the track", (await srOps()).at(-1) === "stop" && (await trackEnabled()) === false && !(await page.evaluate(() => window.__cap.micLive)));
    check("pausing flushed what was heard as a final phrase", (await page.evaluate(() => window.__finals)).length === 1);
    const before = (await srOps()).length;
    await sleep(1500);
    check("no recognition while idle", (await srOps()).length === before);

    await T("pressTablePushToTalk");
    await sleep(150);
    const startsAfter = await page.evaluate(() => window.__sr.log.filter((l) => l.op === "start").at(-1));
    check("press resumes recognition with our track", (await srOps()).at(-1) === "start" && startsAfter.track?.enabled === true && (await trackEnabled()) === true);
    const st = await page.evaluate(() => window.__keystoneVoice.table.getTableVoice());
    check("useTableVoice state: running + held + micLive", st.running && st.held && st.micLive && st.pushToTalk, JSON.stringify(st));
    await T("releaseTablePushToTalk");
    await sleep(100);
    check("release: short tail, still listening", (await srOps()).at(-1) === "start" && (await trackEnabled()) === true);
    await sleep(500);
    check("after the tail: recognition stopped, track disabled", (await srOps()).at(-1) === "stop" && (await trackEnabled()) === false);
    check("release delivered a second final phrase", (await page.evaluate(() => window.__finals)).length === 2);

    await T("setTablePushToTalk", false);
    await sleep(200);
    check("hold-to-talk OFF resumes continuous listening", (await srOps()).at(-1) === "start" && (await trackEnabled()) === true);
    check("preference remembered", (await page.evaluate(() => localStorage.getItem("keystone.voice.pushToTalk"))) === "0");
  } else {
    // ASR worker path: MediaRecorder segments are only produced (and posted) while listening.
    await sleep(5600);
    check(`[${mode}] idle for 5.6 s: nothing recorded or posted`, asrPosts.length === 0, `posts=${asrPosts.length}`);
    check("track disabled while idle", (await trackEnabled()) === false);
    await T("pressTablePushToTalk");
    await sleep(1500);
    await T("releaseTablePushToTalk");
    await sleep(1200);
    check("press+release flushes ONE segment to POST /asr right away", asrPosts.length === 1 && asrPosts[0].size > 800, JSON.stringify(asrPosts));
    await sleep(2500);
    check("and nothing more while idle again", asrPosts.length === 1);
  }

  await page.evaluate(() => window.__cap.stop());
  await sleep(800);
  const ended = await page.evaluate(() => window.__audioTracks().every((t) => t.readyState === "ended"));
  check("stop() releases the mic", ended);
  const bad = logs.filter((l) => l.type === "pageerror");
  check("no uncaught page errors", bad.length === 0, bad.map((b) => b.text).join(" | "));
  await context.close();
}

async function desktopDefaults() {
  console.log("\n=== Desktop defaults ===");
  const { context, page } = await newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(ORIGIN + "/");
  await page.waitForFunction(() => !!window.__keystoneVoice?.call);
  const s = await page.evaluate(() => window.__keystoneVoice.call.getCallState());
  check("desktop: speakerphone guard defaults OFF, hold-to-talk OFF", s.halfDuplex === false && s.pushToTalk === false);
  await context.close();
}

try {
  await desktopDefaults();
  await callTests();
  await tableTests(false);
  await tableTests(true);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(SITE, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
