// Voices for the characters. By default Kokoro, a free open-source voice
// model that runs on this machine (no key, no cost); ElevenLabs if you add a
// key; the computer's own voice or captions only if you choose them.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { failure } from '../http.js';

const run = promisify(execFile);

export const PROVIDERS = ['auto', 'kokoro', 'elevenlabs', 'system', 'none'];

// Kokoro voices per delivery style, with a speaking speed that sells it.
const KOKORO = {
  narrator: ['bm_george', 1.0],
  upbeat: ['af_heart', 1.08],
  deadpan: ['am_michael', 0.92],
  dramatic: ['am_fenrir', 0.88],
  anxious: ['af_bella', 1.18],
  smug: ['bf_emma', 1.0],
};
const KOKORO_SPARE = ['am_puck', 'af_sarah', 'bm_lewis', 'am_eric', 'af_aoede', 'bf_isabella', 'am_adam'];
const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// ElevenLabs premade voices; override with video.elevenlabsVoices in config.
const ELEVEN = {
  narrator: 'pNInz6obpgDQGcFmaJgB',
  upbeat: 'EXAVITQu4vr4xnSDxMaL',
  deadpan: 'TxGEqnHWrfWFTfGW9XjX',
  dramatic: 'VR6AewLTigWG4xSOukaG',
  anxious: 'ErXwobaYiN019PkySvjV',
  smug: '21m00Tcm4TlvDq8ikWAM',
};

const SAY = { narrator: 'Daniel', upbeat: 'Samantha', deadpan: 'Fred', dramatic: 'Daniel', anxious: 'Karen', smug: 'Moira' };
const ESPEAK = { narrator: 'en-gb+m3', upbeat: 'en-us+f3', deadpan: 'en-us+m1', dramatic: 'en-gb+m7', anxious: 'en-us+f4', smug: 'en-us+m3' };

export function chooseProvider(cfg) {
  const want = cfg.video?.tts || 'auto';
  if (want !== 'auto' && PROVIDERS.includes(want)) return want;
  if (cfg.video?.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  return 'kokoro';
}

// Gives every cast member a distinct voice.
export function castVoices(cast) {
  const used = new Set();
  const out = {};
  for (const c of cast) {
    let [voice, speed] = KOKORO[c.voice] || KOKORO.narrator;
    if (used.has(voice)) voice = KOKORO_SPARE.find((v) => !used.has(v)) || voice;
    used.add(voice);
    out[c.id] = { preset: c.voice, kokoro: voice, speed };
  }
  return out;
}

export function modelDir() {
  return process.env.GOLDFELTY_SOCIAL_MODELS || path.join(os.homedir(), '.cache', 'goldfelty-social', 'models');
}

// The model (about 90 MB) downloads once, then loads in a couple of seconds.
let kokoro = null;
export function loadKokoro() {
  if (!kokoro) {
    kokoro = (async () => {
      const [{ KokoroTTS }, { env }] = await Promise.all([import('kokoro-js'), import('@huggingface/transformers')]);
      env.cacheDir = modelDir();
      return KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu' });
    })().catch((err) => {
      kokoro = null;
      throw new Error(`Couldn't load the Kokoro voice model: ${err.message}`);
    });
  }
  return kokoro;
}

async function kokoroSpeech(text, v, file) {
  const tts = await loadKokoro();
  const audio = await tts.generate(text, { voice: v.kokoro, speed: v.speed });
  await audio.save(file);
}

async function elevenSpeech(text, v, cfg, fetchImpl, file) {
  const key = cfg.video?.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY;
  const id = cfg.video?.elevenlabsVoices?.[v.preset] || ELEVEN[v.preset] || ELEVEN.narrator;
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
  });
  if (!res.ok) throw failure('ElevenLabs voice', { status: res.status, text: await res.text(), json: null });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function systemSpeech(text, v, file) {
  if (process.platform === 'darwin') {
    await run('say', ['-v', SAY[v.preset] || 'Samantha', '-o', file, text]);
  } else if (process.platform === 'win32') {
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
      `$s.SetOutputToWaveFile($env:GS_OUT); $s.Speak($env:GS_TEXT); $s.Dispose()`;
    await run('powershell', ['-NoProfile', '-Command', ps], { env: { ...process.env, GS_OUT: file, GS_TEXT: text } });
  } else {
    const bin = spawnSync('espeak-ng', ['--version']).status === 0 ? 'espeak-ng' : 'espeak';
    await run(bin, ['-v', ESPEAK[v.preset] || 'en-us', '-s', '175', '-w', file, text]);
  }
}

// Converts to 48 kHz mono WAV, trims silence at both ends, and returns the
// duration in seconds.
export async function toWav(ffmpeg, input, output) {
  const trim = 'silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse';
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-af', trim, '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', output]);
  return wavDuration(output);
}

export function wavDuration(file) {
  const buf = fs.readFileSync(file);
  let off = 12;
  let rate = 48000;
  let channels = 1;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === 'data') {
      return size / (rate * channels * (bits / 8));
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${file}`);
}

export async function silence(ffmpeg, seconds, output) {
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=mono`, '-t', seconds.toFixed(3), '-c:a', 'pcm_s16le', '-fflags', '+bitexact', output]);
  return seconds;
}

export function readingTime(text) {
  return 0.4 + text.split(/\s+/).filter(Boolean).length * 0.36;
}

// Speaks one line into cacheDir and returns { file, duration }.
export async function speak({ text, voice, provider, config, ffmpeg, cacheDir, fetchImpl = globalThis.fetch }) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = crypto.createHash('sha256').update(JSON.stringify([provider, voice, text])).digest('hex').slice(0, 24);
  const wav = path.join(cacheDir, `${key}.wav`);
  if (fs.existsSync(wav)) return { file: wav, duration: wavDuration(wav) };
  if (provider === 'none') return { file: wav, duration: await silence(ffmpeg, readingTime(text), wav) };
  const ext = provider === 'elevenlabs' ? 'mp3' : provider === 'system' && process.platform === 'darwin' ? 'aiff' : 'wav';
  const raw = path.join(cacheDir, `${key}.raw.${ext}`);
  if (provider === 'kokoro') await kokoroSpeech(text, voice, raw);
  else if (provider === 'elevenlabs') await elevenSpeech(text, voice, config, fetchImpl, raw);
  else await systemSpeech(text, voice, raw);
  let duration = await toWav(ffmpeg, raw, wav);
  fs.rmSync(raw, { force: true });
  if (duration < 0.05) duration = await silence(ffmpeg, readingTime(text), wav);
  return { file: wav, duration };
}

