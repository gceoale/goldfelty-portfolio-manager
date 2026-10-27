// Voices for the characters. OpenAI or ElevenLabs if you have a key (much
// funnier delivery), otherwise the computer's own voice, otherwise silent
// with captions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { failure } from '../http.js';

const run = promisify(execFile);

const OPENAI = {
  narrator: ['echo', 'Warm, clear narrator with great comic timing, like a nature documentary host who finds this hilarious.'],
  upbeat: ['nova', 'Bright, upbeat, quick and playful.'],
  deadpan: ['onyx', 'Completely deadpan, dry and unimpressed. A beat of silence before punchlines.'],
  dramatic: ['fable', 'Wildly over-the-top dramatic, like a movie trailer voice-over.'],
  anxious: ['ash', 'Nervous, fast and slightly panicked, in a funny way.'],
  smug: ['sage', 'Smug and self-satisfied, a little condescending, playful.'],
};
const OPENAI_SPARE = ['coral', 'ballad', 'verse', 'shimmer', 'alloy'];

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

// In the cloud there is no decent built-in voice, so without a key the
// video is captions only.
export function chooseProvider(cfg, { cloud = false } = {}) {
  const want = cfg.video?.tts || 'auto';
  if (want !== 'auto' && !(cloud && want === 'system')) return want;
  if (cfg.video?.openaiApiKey || process.env.OPENAI_API_KEY) return 'openai';
  if (cfg.video?.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  return cloud ? 'none' : 'system';
}

// Gives every cast member a distinct voice for the provider.
export function castVoices(cast, provider) {
  const used = new Set();
  const out = {};
  for (const c of cast) {
    let [voice, style] = OPENAI[c.voice] || OPENAI.narrator;
    if (provider === 'openai' && used.has(voice)) voice = OPENAI_SPARE.find((v) => !used.has(v)) || voice;
    used.add(voice);
    out[c.id] = { preset: c.voice, openai: voice, style };
  }
  return out;
}

async function openaiSpeech(text, v, cfg, fetchImpl, file) {
  const key = cfg.video?.openaiApiKey || process.env.OPENAI_API_KEY;
  const res = await fetchImpl('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v.openai, input: text, instructions: v.style, response_format: 'mp3' }),
  });
  if (!res.ok) throw failure('OpenAI voice', { status: res.status, text: await res.text(), json: null });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
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
  const raw = path.join(cacheDir, `${key}.raw.${provider === 'system' ? (process.platform === 'darwin' ? 'aiff' : 'wav') : 'mp3'}`);
  if (provider === 'openai') await openaiSpeech(text, voice, config, fetchImpl, raw);
  else if (provider === 'elevenlabs') await elevenSpeech(text, voice, config, fetchImpl, raw);
  else await systemSpeech(text, voice, raw);
  let duration = await toWav(ffmpeg, raw, wav);
  fs.rmSync(raw, { force: true });
  if (duration < 0.05) duration = await silence(ffmpeg, readingTime(text), wav);
  return { file: wav, duration };
}

