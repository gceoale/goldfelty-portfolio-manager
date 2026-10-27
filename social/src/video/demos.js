// Real moments in the Goldfelty app that a Short can show: a screen, an
// optional click, and the screen it leads to. The screens come from the
// app's own end-to-end run (`E2E_SCALE=2 E2E_CLEAN=1 npm run e2e`), so the
// wallets and balances are test data; the video marks them "demo wallets".
//
// Every rectangle is [x, y, width, height] and every point [x, y], in the
// app's 1240x800 layout; the images themselves are drawn at 2x.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));

export const DEMOS = {
  connect: {
    about: 'Connecting a wallet: Rabby Wallet is picked from a list of 30+ wallets, and it is connected.',
    from: 'connect-sheet',
    to: 'connected',
    focus: [270, 80, 470, 300],
    click: [390, 230],
    after: [250, 60, 560, 220],
  },
  'one-total': {
    about: 'The overview going from one wallet ($8,800) to four wallets (Ethereum, Solana, Bitcoin, and Exodus tracked read-only) adding up to one total ($22,322).',
    from: 'overview-one',
    to: 'overview',
    focus: [235, 70, 470, 70],
    click: null,
    after: [8, 60, 520, 230],
  },
  send: {
    about: 'Sending ETH: the review lists the network fee and Goldfelty’s 0.5% fee before anything is sent; click Send; it’s on its way.',
    from: 'send-review',
    to: 'sent',
    focus: [920, 60, 310, 440],
    click: [1078, 470],
    after: [380, 50, 480, 240],
  },
  exodus: {
    about: 'Tracking Exodus, which can’t connect to other apps: paste its address, click Track, and its balances count, read-only.',
    from: 'track-exodus',
    to: 'exodus-wallet',
    focus: [380, 50, 480, 400],
    click: [800, 416],
    after: [8, 50, 960, 190],
  },
  dark: {
    about: 'The overview switching from light to dark mode.',
    from: 'overview',
    to: 'overview-dark',
    focus: [0, 0, 1240, 640],
    click: null,
    after: [0, 0, 1240, 640],
  },
  wallets: {
    about: 'The wallet list: Rabby Wallet, Exodus (read-only), Solflare and UniSat, each with its balance.',
    from: 'overview',
    to: 'overview',
    focus: [0, 0, 1240, 640],
    click: null,
    after: [8, 150, 215, 125],
  },
};

export const DEMO_NAMES = Object.keys(DEMOS);

export function demosForPrompt() {
  return Object.entries(DEMOS)
    .map(([name, d]) => `- ${name}: ${d.about}`)
    .join('\n');
}

function dataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', woff2: 'font/woff2' }[ext];
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

// Screens, fonts and logo as data URLs for the renderer.
export function loadAssets(demoNames) {
  const screens = {};
  for (const name of demoNames) {
    const d = DEMOS[name];
    if (!d) continue;
    for (const s of [d.from, d.to]) {
      if (!screens[s]) screens[s] = dataUrl(path.join(ASSETS, 'screens', `${s}.jpg`));
    }
  }
  return {
    screens,
    demos: Object.fromEntries(demoNames.filter((n) => DEMOS[n]).map((n) => [n, DEMOS[n]])),
    logo: dataUrl(path.join(ASSETS, 'logo.png')),
    serif: dataUrl(path.join(ASSETS, 'fonts', 'instrument-serif.woff2')),
    serifItalic: dataUrl(path.join(ASSETS, 'fonts', 'instrument-serif-italic.woff2')),
  };
}
