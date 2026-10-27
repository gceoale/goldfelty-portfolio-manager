// Everything the app keeps lives in one folder, readable only by you.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir() {
  return process.env.GOLDFELTY_SOCIAL_HOME || path.join(os.homedir(), '.goldfelty-social');
}

export function dataPath(name) {
  return path.join(dataDir(), name);
}

export function ensureDataDir() {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
}

export function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(fallback);
    throw new Error(`Couldn't read ${dataPath(name)}: ${err.message}`);
  }
}

// Write to a temp file and rename, so a crash never leaves half a file.
export function writeJson(name, value) {
  ensureDataDir();
  const file = dataPath(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function appendLog(line) {
  ensureDataDir();
  fs.appendFileSync(dataPath('activity.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}
