import { readJson, writeJson } from './store.js';

// The most each account will post in a day. config.json can lower these,
// never raise them.
export const HARD_LIMITS = {
  x: { dailyCap: 3, threadsPerDay: 1 },
  reddit: { dailyCap: 1 },
  youtube: { dailyCap: 1 },
};

export const DEFAULTS = {
  anthropicApiKey: '',
  model: 'claude-opus-5-5',
  effort: 'medium',
  x: {
    clientId: '',
    clientSecret: '',
    dailyCap: 3,
    threadsPerDay: 1,
    minGapMinutes: 120,
    windows: ['09:00-11:00', '13:00-15:00', '18:00-20:00'],
  },
  reddit: {
    clientId: '',
    clientSecret: '',
    dailyCap: 1,
    minGapMinutes: 720,
    windows: ['10:00-12:00'],
  },
  youtube: {
    clientId: '',
    clientSecret: '',
    dailyCap: 1,
    minGapMinutes: 720,
    privacyStatus: 'public',
    windows: ['16:00-19:00'],
  },
  video: {
    auto: true,
    ffmpeg: '',
  },
  ports: { oauth: 8787, ui: 8788 },
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) {
    return over === undefined ? base : over;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = k in base ? merge(base[k], v) : v;
  }
  return out;
}

export function normalizeConfig(raw) {
  const cfg = merge(DEFAULTS, raw);
  for (const [platform, limits] of Object.entries(HARD_LIMITS)) {
    for (const [key, max] of Object.entries(limits)) {
      const n = Number(cfg[platform][key]);
      cfg[platform][key] = Number.isFinite(n) ? Math.max(0, Math.min(max, Math.floor(n))) : max;
    }
  }
  if (!['public', 'unlisted', 'private'].includes(cfg.youtube.privacyStatus)) {
    cfg.youtube.privacyStatus = 'private';
  }
  return cfg;
}

export function loadConfig() {
  return normalizeConfig(readJson('config.json', {}));
}

export function saveConfig(cfg) {
  writeJson('config.json', cfg);
}

export function anthropicKey(cfg) {
  return process.env.ANTHROPIC_API_KEY || cfg.anthropicApiKey || '';
}
