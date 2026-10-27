// Real Goldfelty screens the videos can show, with areas worth zooming into.
// They come from the app's end-to-end test run, so the wallets and balances
// are test data. The video marks them "demo wallets".
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPath } from '../store.js';

const ASSETS = fileURLToPath(new URL('../../assets/', import.meta.url));

// Hotspots are [x, y, width, height] in the screenshot's pixels.
export const SCREENS = {
  overview: {
    file: 'screens/overview.png',
    about: 'Overview page: one total value across four wallets (Rabby on Ethereum, Exodus tracked read-only, Solflare on Solana, UniSat on Bitcoin), a value chart, and holdings by asset (ETH, USDC, BTC, SOL, POL).',
    hotspots: {
      total: [215, 45, 470, 100],
      wallets: [8, 150, 215, 130],
      holdings: [225, 380, 940, 200],
    },
  },
  'overview-dark': {
    file: 'screens/overview-dark.png',
    about: 'The same overview in dark mode.',
    hotspots: { total: [215, 45, 470, 100], wallets: [8, 150, 215, 130], holdings: [225, 380, 940, 200] },
  },
  connect: {
    file: 'screens/connect.png',
    about: 'Connect a wallet: a searchable list of 30+ wallets. Browser extensions found in your browser are listed first; also Frame (for Ledger, Trezor, GridPlus), phone wallets, and read-only tracking for wallets that cannot connect, such as Exodus.',
    hotspots: { dialog: [252, 17, 700, 526], list: [290, 140, 420, 400] },
  },
  'send-review': {
    file: 'screens/send-review.png',
    about: 'Send: four wallets hold ETH and you choose which one sends. The review shows what the recipient gets, the network fee and Goldfelty’s 0.5% fee before anything is sent; then your wallet asks you to approve.',
    hotspots: { from: [480, 60, 400, 190], review: [870, 75, 365, 420] },
  },
  'browser-tab': {
    file: 'screens/browser-tab.png',
    about: 'The Goldfelty browser tab that connects extension wallets: “Connected to the app”, with Rabby Wallet and Solflare ready. One tab carries every wallet in that browser.',
    hotspots: { wallets: [400, 90, 450, 180] },
  },
  locked: {
    file: 'screens/locked.png',
    about: 'Lock screen: “Welcome back”. Goldfelty locks itself after idle time, on sleep and when the screen locks; your password unlocks it.',
    hotspots: { center: [470, 280, 320, 260] },
  },
  'track-exodus': {
    file: 'screens/track-exodus.png',
    about: 'Track Exodus: paste an address and Goldfelty counts its balances read-only, because Exodus does not let other apps connect to it.',
    hotspots: { dialog: [391, 56, 460, 384] },
  },
};

export const SCREEN_NAMES = Object.keys(SCREENS);
export const HOTSPOT_NAMES = [...new Set(Object.values(SCREENS).flatMap((s) => Object.keys(s.hotspots)))];

export function screensForPrompt() {
  return Object.entries(SCREENS)
    .map(([name, s]) => `- ${name}: ${s.about} Zoom areas: ${Object.keys(s.hotspots).join(', ')}.`)
    .join('\n');
}

function dataUrl(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
}

// Screens and logo as data URLs for the renderer. A screen you save as
// ~/.goldfelty-social/screens/<name>.png replaces the bundled one.
export function loadAssets(names) {
  const screens = {};
  for (const name of names) {
    const s = SCREENS[name];
    if (!s) continue;
    const own = dataPath(`screens/${name}.png`);
    const file = fs.existsSync(own) ? own : path.join(ASSETS, s.file);
    screens[name] = { src: dataUrl(file), hotspots: s.hotspots };
  }
  return { screens, logo: dataUrl(path.join(ASSETS, 'logo.png')) };
}
