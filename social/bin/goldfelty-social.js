#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { DEFAULTS, saveConfig } from '../src/config.js';
import { dataPath, ensureDataDir } from '../src/store.js';
import { loadFacts } from '../src/generate.js';
import { loadQueue, saveQueue, findItem, itemText, recoverInterrupted } from '../src/queue.js';
import { redirectUri } from '../src/oauth.js';
import { createServer } from '../src/ui/server.js';
import * as app from '../src/app.js';
import { score, byWindow, REFRESH_MS } from '../src/metrics.js';
import { autopilotStep, setPaused, loadState as loadAutopilot, saveState as saveAutopilot } from '../src/autopilot.js';
import { install as installService, uninstall as uninstallService } from '../src/service.js';
import { anthropicKey } from '../src/config.js';
import { makeClient } from '../src/generate.js';
import { makeVideo, SAMPLE as SAMPLE_VIDEO } from '../src/video/make.js';

const HELP = `goldfelty-social: posts and Shorts for Goldfelty's own accounts, on autopilot or approved by you.

  init                         Create config.json and facts.md
  status                       Accounts, today's posts, queue
  generate [--focus TEXT]      Write new drafts with Claude
           [--x N] [--threads N] [--reddit N] [--scripts N]
  service install              Run on autopilot in the background, from login, for good
  service uninstall            Stop and remove the background service
  pause / resume               Stop or restart all writing and posting
  cloud-run                    One run with state on api.goldfelty.com (GOLDFELTY_ADMIN_TOKEN);
                               what the scheduled GitHub workflow runs
  ui [--live]                  Open the review page
  run [--live] [--auto] [--no-ui]
                               Post approved items on schedule (dry run without --live);
                               --auto also writes, checks and approves posts itself
  list [--status S]            List queue items
  show ID                      Show one item
  approve ID...                Approve items
  reject ID...                 Reject items
  done ID [--url URL]          Mark a manual item as done
  post ID --live               Post one approved item now (caps still apply)
  video [--sample] [--format F] [--queue]
                               Write and render a funny Short now (--sample: the built-in
                               script, no Claude needed; --queue: add it for YouTube)
  attach ID [IMAGE...]         Put up to 4 images on an X post (none clears them)
  stats                        How recent posts did, and which posting times work
  upload FILE --title T [--description D] [--privacy public|unlisted|private]
                               Queue your own video for YouTube
  connect x|reddit|youtube     Sign in to an account
  disconnect x|reddit|youtube  Forget an account's sign-in

Data: ${dataPath('')}`;

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

function printItem(item, full = false) {
  const text = itemText(item).replace(/\s+/g, ' ');
  console.log(`${item.id}  ${item.status.padEnd(8)}  ${item.platform.padEnd(7)} ${item.kind.padEnd(6)}  ${full ? '' : text.slice(0, 70)}`);
  if (full) {
    console.log('');
    console.log(itemText(item));
    if (item.basis) console.log(`\nBased on: ${item.basis}`);
    if (item.note) console.log(`Note: ${item.note}`);
    if (item.error) console.log(`Error: ${item.error}`);
    if (item.result?.url) console.log(`Link: ${item.result.url}`);
  }
}

function int(v, fallback) {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`"${v}" should be a whole number from 0 to 20.`);
  return n;
}

async function startUi(deps, live, auto = false) {
  const ui = createServer({ deps, port: deps.config.ports.ui, live, auto });
  await ui.listen();
  console.log(`Review page: ${ui.url}`);
  openBrowser(ui.url);
  return ui;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      live: { type: 'boolean', default: false },
      auto: { type: 'boolean', default: false },
      'no-ui': { type: 'boolean', default: false },
      focus: { type: 'string' },
      x: { type: 'string' },
      threads: { type: 'string' },
      reddit: { type: 'string' },
      scripts: { type: 'string' },
      status: { type: 'string' },
      url: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      privacy: { type: 'string' },
      format: { type: 'string' },
      sample: { type: 'boolean', default: false },
      queue: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, ...args] = positionals;
  if (!cmd || values.help || cmd === 'help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'init') {
    ensureDataDir();
    if (fs.existsSync(dataPath('config.json'))) console.log(`Already there: ${dataPath('config.json')}`);
    else {
      saveConfig(DEFAULTS);
      console.log(`Created ${dataPath('config.json')}`);
    }
    loadFacts();
    console.log(`Facts for posts: ${dataPath('facts.md')}`);
    console.log(`\nRedirect URL to register with X, Reddit and Google: ${redirectUri(DEFAULTS)}`);
    console.log('Next: add your API keys to config.json (see README), then run: goldfelty-social connect x');
    return;
  }

  const deps = app.makeDeps();

  switch (cmd) {
    case 'status': {
      const s = app.summary(deps);
      for (const p of app.PLATFORM_IDS) {
        const c = s.connections[p];
        console.log(
          `${p.padEnd(8)} ${c.connected ? `connected as ${c.username}` : 'not connected'}; ` +
            `posted today ${s.postedToday[p]} of ${deps.config[p].dailyCap}`,
        );
      }
      console.log(`\nQueue: ${Object.entries(s.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'empty'}`);
      return;
    }
    case 'generate': {
      const counts = {
        xPosts: int(values.x, 6),
        xThreads: int(values.threads, 1),
        redditPosts: int(values.reddit, 1),
        videoScripts: int(values.scripts, 1),
      };
      console.log('Writing drafts…');
      const { added, dropped } = await app.generateDrafts(deps, { counts, focus: values.focus || '' });
      for (const item of added) printItem(item);
      console.log(`\n${added.length} new drafts. Review them with: goldfelty-social ui`);
      for (const d of dropped) console.log(`Left out (${d.reason}): ${itemText(d.item).slice(0, 60).replace(/\s+/g, ' ')}…`);
      return;
    }
    case 'list': {
      const items = loadQueue().items.filter((i) => !values.status || i.status === values.status);
      if (!items.length) console.log('Nothing here.');
      for (const item of items) printItem(item);
      return;
    }
    case 'show':
      printItem(findItem(loadQueue(), args[0] || ''), true);
      return;
    case 'approve':
    case 'reject':
      if (!args.length) throw new Error(`Which item? goldfelty-social ${cmd} ID`);
      for (const id of args) {
        const item = cmd === 'approve' ? app.approveItem(id, deps) : app.rejectItem(id, deps);
        console.log(`${item.id}: ${item.status}${item.note ? `. ${item.note}` : ''}`);
      }
      return;
    case 'done': {
      const item = app.markDoneItem(args[0] || '', values.url || '', deps);
      console.log(`${item.id}: done`);
      return;
    }
    case 'post': {
      if (!values.live) throw new Error('Add --live to post for real.');
      const item = await app.postNow(args[0] || '', deps);
      if (item.status !== 'posted') process.exitCode = 1;
      return;
    }
    case 'video': {
      const spec = values.sample ? JSON.parse(fs.readFileSync(SAMPLE_VIDEO, 'utf8')) : null;
      const client = spec ? null : makeClient(anthropicKey(deps.config));
      const made = await makeVideo(deps, { client, spec, format: values.format || '' });
      console.log(`\n${made.file}\n"${made.spec.title}" · ${made.duration.toFixed(0)} seconds`);
      if (made.review) console.log(`Funny ${made.review.funny}/10, hook ${made.review.hook}/10, premium ${made.review.premium}/10: ${made.review.notes}`);
      if (values.queue) {
        const item = app.addVideo(made.file, { title: made.spec.title, description: made.spec.description, premise: made.spec.premise, format: made.spec.format }, deps);
        console.log(`Queued ${item.id} as a draft. Approve it with: goldfelty-social approve ${item.id}`);
      }
      return;
    }
    case 'attach': {
      if (!args[0]) throw new Error('Which item? goldfelty-social attach ID image.png');
      const item = app.attachImages(args[0], args.slice(1), deps);
      console.log(`${item.id}: ${item.content.images.length} image(s). Status: ${item.status}.`);
      return;
    }
    case 'stats': {
      const { updated, errors } = await app.refreshNumbers(deps, { force: true });
      for (const e of errors) console.log(`Couldn't read numbers from ${e}`);
      const items = loadQueue().items;
      const measured = items
        .filter((i) => i.status === 'posted' && i.metrics)
        .sort((a, b) => score(b.metrics) - score(a.metrics));
      console.log(`Updated ${updated} posts.\n`);
      if (!measured.length) console.log('No numbers yet: they appear once posts have been out a while.');
      for (const i of measured.slice(0, 10)) {
        const m = i.metrics;
        console.log(`${String(Math.round(score(m))).padStart(5)}  ${i.platform.padEnd(7)} ${m.likes}♥ ${m.reposts}⟳ ${m.replies}💬  ${itemText(i).replace(/\s+/g, ' ').slice(0, 60)}`);
      }
      const windows = byWindow(items, deps.config);
      console.log('\nAverage score by posting window:');
      for (const p of app.PLATFORM_IDS) {
        for (const w of windows[p]) console.log(`  ${p.padEnd(8)} ${w.window}  ${w.posts ? `${w.average} from ${w.posts} posts` : 'no data yet'}`);
      }
      return;
    }
    case 'upload': {
      if (!args[0]) throw new Error('Which file? goldfelty-social upload FILE --title "..."');
      if (values.privacy && !['public', 'unlisted', 'private'].includes(values.privacy)) {
        throw new Error('--privacy must be public, unlisted or private.');
      }
      const item = app.addVideo(
        args[0],
        { title: values.title, description: values.description, privacyStatus: values.privacy },
        deps,
      );
      console.log(`Queued ${item.id} as a draft. Approve it in the review page or with: goldfelty-social approve ${item.id}`);
      return;
    }
    case 'connect': {
      const info = await app.connectPlatform(args[0], deps, { openBrowser });
      console.log(`Connected ${args[0]} as ${info.username}.`);
      if (args[0] === 'reddit') {
        console.log(`This app will post only to u_${info.username}${info.moderated?.length ? ` and subreddits you moderate (${info.moderated.join(', ')})` : ''}.`);
      }
      return;
    }
    case 'disconnect':
      if (!app.PLATFORM_IDS.includes(args[0])) throw new Error('Use x, reddit or youtube.');
      app.disconnectPlatform(args[0], deps);
      console.log(`Forgot the ${args[0]} sign-in. You can also revoke access in that site's settings.`);
      return;
    case 'ui': {
      const ui = await startUi(deps, values.live);
      console.log('Press Ctrl+C to stop.');
      process.on('SIGINT', () => ui.close().then(() => process.exit(0)));
      return;
    }
    case 'run': {
      const release = app.takeRunLock();
      const q = loadQueue();
      const recovered = recoverInterrupted(q);
      if (recovered) {
        saveQueue(q);
        console.log(`${recovered} item(s) were interrupted mid-post last time; they're under Failed. Check the account before retrying.`);
      }
      const live = values.live;
      const auto = values.auto;
      const client = auto ? makeClient(anthropicKey(deps.config)) : null;
      console.log(live ? 'Live: approved items will be posted on schedule.' : 'Dry run: nothing will be posted. Add --live to post.');
      if (auto) console.log('Autopilot: writes, checks and approves posts by itself. Stop it with: goldfelty-social pause');
      const ui = values['no-ui'] ? null : await startUi(deps, live, auto);
      const dryHistory = [];
      let busy = false;
      let lastNumbers = 0;
      const loop = async () => {
        if (busy) return;
        busy = true;
        try {
          if (loadAutopilot().paused) return;
          if (auto) {
            try {
              await autopilotStep(deps, { app, client });
            } catch (err) {
              const s = loadAutopilot();
              s.lastError = err.message;
              s.lastErrorAt = new Date().toISOString();
              saveAutopilot(s);
              console.error(`Autopilot: ${err.message}`);
            }
          }
          await app.tick(deps, { live, dryHistory });
          // Read how posts are doing a few times a day; the next batch of
          // drafts learns from it.
          if (live && Date.now() - lastNumbers > REFRESH_MS) {
            lastNumbers = Date.now();
            const { errors } = await app.refreshNumbers(deps);
            for (const e of errors) console.error(`Numbers: ${e}`);
          }
        } catch (err) {
          console.error(`Scheduler: ${err.message}`);
        } finally {
          busy = false;
        }
      };
      await loop();
      const timer = setInterval(loop, 30_000);
      const stop = async () => {
        clearInterval(timer);
        await ui?.close();
        release();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'cloud-run': {
      // One run against api.goldfelty.com; see src/cloud.js.
      const { cloudRun } = await import('../src/cloud.js');
      const out = await cloudRun({ api: process.env.GOLDFELTY_SOCIAL_API || undefined, token: process.env.GOLDFELTY_ADMIN_TOKEN });
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Social autopilot\n${out.summary.join('; ') || 'Nothing due.'}\n`);
      }
      return;
    }
    case 'pause':
      setPaused(true);
      console.log('Paused: nothing will be written or posted until: goldfelty-social resume');
      return;
    case 'resume':
      setPaused(false);
      console.log('Resumed.');
      return;
    case 'service': {
      if (args[0] === 'install') {
        const conns = app.connections(deps);
        const none = app.PLATFORM_IDS.filter((p) => !conns[p].connected);
        if (none.length === app.PLATFORM_IDS.length) throw new Error('Connect at least one account first: goldfelty-social connect x');
        if (!deps.config.anthropicApiKey) {
          if (!process.env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY (or anthropicApiKey in config.json) first.');
          // Background services don't see your shell's variables, so keep
          // the key in config.json (readable only by you).
          const raw = JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8'));
          raw.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
          saveConfig(raw);
          console.log(`Saved your Anthropic API key to ${dataPath('config.json')} for the background service.`);
        }
        if (none.length) console.log(`Not connected (skipped until you connect): ${none.join(', ')}`);
        installService((m) => console.log(m));
      } else if (args[0] === 'uninstall') {
        uninstallService((m) => console.log(m));
      } else {
        throw new Error('Use: goldfelty-social service install|uninstall');
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${cmd}". Run goldfelty-social help.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
