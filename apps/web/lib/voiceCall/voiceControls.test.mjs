// Unit tests for the pure parts of hold-to-talk, the speakerphone guard, the remembered preferences and the mic report.
// The web app has no JS test runner; Node 24 runs TypeScript directly, so:
//
//     cd apps/web && node --test lib/voiceCall/voiceControls.test.mjs
//
// (The browser behaviour is covered by the Playwright check described in docs/design-system.md "Voice controls API".)
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { botStuckAfterMs, micGateOpen } from "./gate.ts";
import { MIC_CONSTRAINTS, micConstraints, processingFromSettings } from "./audio.ts";

const base = { muted: false, pushToTalk: false, held: false, halfDuplex: false, botSpeaking: false, interrupted: false };
const gate = (over) => micGateOpen({ ...base, ...over });

describe("micGateOpen", () => {
  it("is open by default", () => assert.equal(gate({}), true));
  it("mute always wins", () => {
    assert.equal(gate({ muted: true }), false);
    assert.equal(gate({ muted: true, pushToTalk: true, held: true }), false);
  });
  it("hold-to-talk: open only while held", () => {
    assert.equal(gate({ pushToTalk: true }), false);
    assert.equal(gate({ pushToTalk: true, held: true }), true);
  });
  it("hold-to-talk ignores the speakerphone guard (pressing while the bot talks is a barge-in)", () => {
    assert.equal(gate({ pushToTalk: true, held: true, halfDuplex: true, botSpeaking: true }), true);
  });
  it("speakerphone guard closes the mic while the bot speaks", () => {
    assert.equal(gate({ halfDuplex: true, botSpeaking: true }), false);
    assert.equal(gate({ halfDuplex: true, botSpeaking: false }), true);
  });
  it("guard off: bot speech never closes the mic", () => assert.equal(gate({ halfDuplex: false, botSpeaking: true }), true));
  it("Interrupt re-opens the mic at once", () => {
    assert.equal(gate({ halfDuplex: true, botSpeaking: true, interrupted: true }), true);
  });
  it("Interrupt does not override Mute", () => assert.equal(gate({ halfDuplex: true, botSpeaking: true, interrupted: true, muted: true }), false));
});

describe("botStuckAfterMs", () => {
  it("is short when the remote level is measurable and long when it is not", () => {
    assert.ok(botStuckAfterMs(true) < botStuckAfterMs(false));
    assert.ok(botStuckAfterMs(false) >= 30_000);
  });
});

describe("mic constraints and report", () => {
  it("requests all three processing stages and mono", () => {
    assert.deepEqual({ ...MIC_CONSTRAINTS }, { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 });
    assert.deepEqual(micConstraints(), { ...MIC_CONSTRAINTS });
  });
  it("prefers (never insists on) a remembered device", () => {
    assert.deepEqual(micConstraints("abc").deviceId, { ideal: "abc" });
  });
  it("reports confirmed settings", () => {
    const r = processingFromSettings({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, "Fake mic");
    assert.equal(r.allApplied, true);
    assert.equal(r.channelCount, 1);
    assert.equal(r.deviceLabel, "Fake mic");
  });
  it("treats a setting the browser does not report (Safari) as unknown, not as applied", () => {
    const r = processingFromSettings({ echoCancellation: true });
    assert.equal(r.noiseSuppression, null);
    assert.equal(r.allApplied, false);
  });
  it("reports a stage the browser turned off", () => {
    const r = processingFromSettings({ echoCancellation: true, noiseSuppression: false, autoGainControl: true });
    assert.equal(r.noiseSuppression, false);
    assert.equal(r.allApplied, false);
  });
});

// ---------------------------------------------------------------------------------------------- preferences

function installBrowser({ phone = false, storage = {}, storageThrows = false } = {}) {
  const store = { ...storage };
  globalThis.window = {
    matchMedia: (q) => ({ matches: phone && (q.includes("coarse") || q.includes("max-width")) }),
    addEventListener() {},
  };
  globalThis.localStorage = storageThrows
    ? { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } }
    : { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  return store;
}

async function freshPrefs() {
  // A fresh module instance per test: the module caches what it read from localStorage.
  return import(`./prefs.ts?${Math.random()}`);
}

describe("voice preferences", () => {
  beforeEach(() => {
    delete globalThis.window;
    delete globalThis.localStorage;
  });

  it("defaults: hold-to-talk off; speakerphone guard on for phones, off elsewhere", async () => {
    installBrowser({ phone: true });
    assert.deepEqual({ ...(await freshPrefs()).getVoicePrefs() }, { pushToTalk: false, halfDuplex: true });
    installBrowser({ phone: false });
    assert.deepEqual({ ...(await freshPrefs()).getVoicePrefs() }, { pushToTalk: false, halfDuplex: false });
  });

  it("remembers the choice in localStorage and a stored choice beats the phone default", async () => {
    const store = installBrowser({ phone: true });
    const a = await freshPrefs();
    a.setPushToTalkPref(true);
    a.setHalfDuplexPref(false);
    assert.equal(store["keystone.voice.pushToTalk"], "1");
    assert.equal(store["keystone.voice.halfDuplex"], "0");
    const b = await freshPrefs(); // a "new page load"
    assert.deepEqual({ ...b.getVoicePrefs() }, { pushToTalk: true, halfDuplex: false });
  });

  it("notifies subscribers once per real change and hands out a new snapshot object", async () => {
    installBrowser();
    const p = await freshPrefs();
    let n = 0;
    p.subscribeVoicePrefs(() => n++);
    const before = p.getVoicePrefs();
    p.setPushToTalkPref(true);
    p.setPushToTalkPref(true); // no change
    assert.equal(n, 1);
    assert.notEqual(p.getVoicePrefs(), before);
  });

  it("survives a localStorage that throws (private mode): value lives in memory", async () => {
    installBrowser({ storageThrows: true });
    const p = await freshPrefs();
    assert.equal(p.getVoicePrefs().pushToTalk, false);
    p.setPushToTalkPref(true);
    assert.equal(p.getVoicePrefs().pushToTalk, true);
  });

  it("renders the server-safe defaults when there is no window", async () => {
    const p = await freshPrefs();
    assert.deepEqual({ ...p.getVoicePrefs() }, { pushToTalk: false, halfDuplex: false });
  });
});
