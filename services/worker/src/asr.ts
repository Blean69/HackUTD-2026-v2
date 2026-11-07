// POST /asr: audio chunk -> ffmpeg (16 kHz mono PCM WAV) -> NVCF HTTP Parakeet route -> append_transcript.
// Returns 503 {error:"asr_unavailable"} whenever it cannot transcribe so the browser falls back to Web Speech.
// UNTESTED against the live NVIDIA endpoint (no API key was available while building); see README.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';

export interface AsrDeps {
  cfg: Config['asr'];
  appendTranscript(huddleId: string, speaker: string, text: string): Promise<void>;
  fetch?: typeof fetch;
  ffmpeg?: string;
}

export interface AsrResult {
  status: number;
  body: Record<string, unknown>;
}

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export function extensionFor(contentType: string): string {
  const t = contentType.toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  if (t.includes('wav') || t.includes('wave')) return 'wav';
  if (t.includes('mp4') || t.includes('m4a') || t.includes('aac')) return 'm4a';
  if (t.includes('mpeg') || t.includes('mp3')) return 'mp3';
  return 'bin';
}

export function runFfmpeg(bin: string, input: string, output: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-y', '-v', 'error', '-i', input, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 200)}`));
    });
  });
}

const unavailable = (reason: string): AsrResult => ({ status: 503, body: { error: 'asr_unavailable', reason } });

/** NVCF HTTP transcription response -> text. Accepts {text}, {transcript}, {transcripts:[...]} and Riva-style results. */
export function textFromAsrResponse(j: unknown): string {
  if (!j || typeof j !== 'object') return '';
  const o = j as Record<string, unknown>;
  if (typeof o.text === 'string') return o.text;
  if (typeof o.transcript === 'string') return o.transcript;
  if (Array.isArray(o.transcripts)) return o.transcripts.map(String).join(' ');
  if (Array.isArray(o.results)) {
    return o.results
      .map((r) => {
        const alts = (r as { alternatives?: { transcript?: string }[] }).alternatives;
        return alts?.[0]?.transcript ?? '';
      })
      .join(' ');
  }
  return '';
}

export async function handleAsr(params: { huddleId: string; speaker: string; body: Buffer; contentType: string }, deps: AsrDeps): Promise<AsrResult> {
  const { huddleId, speaker, body, contentType } = params;
  if (!huddleId || !speaker) return { status: 400, body: { error: 'huddle_id and speaker are required' } };
  if (!body.length) return { status: 400, body: { error: 'empty audio body' } };
  if (body.length > MAX_AUDIO_BYTES) return { status: 413, body: { error: 'audio chunk too large' } };
  if (!deps.cfg.apiKey) return unavailable('no NVIDIA_API_KEY configured');

  const dir = await mkdtemp(join(tmpdir(), 'keystone-asr-'));
  try {
    const input = join(dir, `in.${extensionFor(contentType)}`);
    const wav = join(dir, 'out.wav');
    await writeFile(input, body);
    try {
      await runFfmpeg(deps.ffmpeg ?? 'ffmpeg', input, wav);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return unavailable(code === 'ENOENT' ? 'ffmpeg is not installed' : `audio conversion failed: ${(e as Error).message.slice(0, 120)}`);
    }
    const form = new FormData();
    form.set('language', 'en-US');
    form.set('file', new Blob([new Uint8Array(await readFile(wav))], { type: 'audio/wav' }), 'chunk.wav');
    let text = '';
    try {
      const f = deps.fetch ?? fetch;
      const res = await f(`https://${deps.cfg.functionId}.invocation.api.nvcf.nvidia.com/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${deps.cfg.apiKey}`, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(deps.cfg.timeoutMs),
      });
      if (!res.ok) return unavailable(`NVIDIA ASR returned HTTP ${res.status}`);
      text = textFromAsrResponse(await res.json()).trim();
    } catch (e) {
      return unavailable(`NVIDIA ASR call failed: ${e instanceof Error ? e.message.slice(0, 120) : 'error'}`);
    }
    if (!text) return { status: 200, body: { text: '', appended: false } };
    try {
      await deps.appendTranscript(huddleId, speaker.slice(0, 60), text);
    } catch (e) {
      return { status: 409, body: { error: 'append_failed', message: e instanceof Error ? e.message : String(e), text } };
    }
    return { status: 200, body: { text, appended: true } };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
