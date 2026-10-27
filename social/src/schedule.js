// When to post. Pure functions of the queue, the config and the clock, so
// they're easy to test.
//
// Each platform has posting windows (local time). Each window gets one
// random minute per day, the same minute however often the app restarts,
// and at most one post goes out per window. On top of that: a daily cap, at
// most one X thread a day, and a minimum gap between posts.
import crypto from 'node:crypto';

export function parseWindow(spec) {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(String(spec).trim());
  if (!m) throw new Error(`Bad posting window "${spec}"; use HH:MM-HH:MM.`);
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (start >= end || end > 24 * 60) throw new Error(`Bad posting window "${spec}".`);
  return { start, end };
}

export function dayKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function minuteOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function targetMinute(day, platform, index, win) {
  const h = crypto.createHash('sha256').update(`${day}|${platform}|${index}`).digest();
  // Leave the last 10 minutes of a window free, so a slow tick still lands.
  const span = Math.max(1, win.end - win.start - 10);
  return win.start + (h.readUInt32BE(0) % span);
}

// history: [{ platform, kind, at: Date }] of everything posted (or, in a dry
// run, everything that would have been).
// early: minutes before a window's chosen time that still count, for a
// runner that only wakes every half hour.
export function nextDue({ platform, items, history, config, now, early = 0 }) {
  const pc = config[platform];
  const today = dayKey(now);
  const mine = history.filter((h) => h.platform === platform);
  const todays = mine.filter((h) => dayKey(h.at) === today);
  if (todays.length >= pc.dailyCap) return { item: null, why: 'daily cap reached' };

  const last = mine.reduce((a, h) => (!a || h.at > a ? h.at : a), null);
  if (last && now - last < pc.minGapMinutes * 60_000) return { item: null, why: 'too soon after the last post' };

  const minute = minuteOfDay(now);
  const windows = pc.windows.map(parseWindow);
  const index = windows.findIndex((w) => minute >= w.start && minute < w.end);
  if (index === -1) return { item: null, why: 'outside posting windows' };
  const win = windows[index];
  const inThisWindow = todays.some((h) => {
    const m = minuteOfDay(h.at);
    return m >= win.start && m < win.end;
  });
  if (inThisWindow) return { item: null, why: 'already posted in this window' };
  if (minute < targetMinute(today, platform, index, win) - early) return { item: null, why: 'waiting for this window’s time' };

  const threadsToday = todays.filter((h) => h.kind === 'thread').length;
  const candidates = items
    .filter((i) => i.platform === platform && i.status === 'approved')
    .filter((i) => !(i.kind === 'thread' && threadsToday >= (pc.threadsPerDay ?? 1)))
    .filter((i) => !(i.notBefore && new Date(i.notBefore) > now))
    .sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt)));
  return candidates.length ? { item: candidates[0], why: 'due' } : { item: null, why: 'nothing approved' };
}

// Can this item go out right now, ignoring windows? Used by "post now".
export function capCheck({ item, history, config, now }) {
  const pc = config[item.platform];
  const today = dayKey(now);
  const todays = history.filter((h) => h.platform === item.platform && dayKey(h.at) === today);
  if (todays.length >= pc.dailyCap) return `Today's ${item.platform} cap (${pc.dailyCap}) is used up.`;
  if (item.kind === 'thread' && todays.filter((h) => h.kind === 'thread').length >= (pc.threadsPerDay ?? 1)) {
    return "Today's thread has already gone out.";
  }
  return null;
}

// Everything that went out, including a thread that stopped partway.
export function historyFrom(items) {
  return items
    .filter((i) => i.postedAt && (i.status === 'posted' || i.result?.ids?.length))
    .map((i) => ({ platform: i.platform, kind: i.kind, at: new Date(i.postedAt) }));
}
