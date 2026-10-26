/**
 * The page BrowserBridge serves, as a string.
 *
 * It runs in the user's own browser, where wallet extensions announce
 * themselves through EIP-6963. It reports what it finds to the app, then
 * long-polls for requests and hands each one to the wallet it names.
 *
 * It talks to nothing but the bridge on loopback and the wallets in this
 * browser. It holds no secret and reads nothing from its own URL: the app
 * authenticates it with an HttpOnly cookie set when the one-time link is
 * opened, and tells it which wallet is wanted over the same channel.
 *
 * Scripts and styles are pinned by hash in the page's CSP (see
 * browserBridge.ts), so editing either here is all it takes; the hashes are
 * computed from this string at startup.
 */
import { BRIDGE_MARK } from './bridgeMark.ts'

export const BRIDGE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Goldfelty</title>
<style>
  :root {
    --bg: #f5f5f7; --panel: #fff; --line: rgba(0,0,0,.1); --text: #1d1d1f; --muted: #6e6e73;
    --accent: #ffc21a; --ok: #248a3d; --warn: #b25000; --bad: #d70015;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1c1c1e; --panel: #2a2a2d; --line: rgba(255,255,255,.1); --text: #f2f2f7; --muted: #a1a1a6;
      --ok: #30d158; --warn: #ff9f0a; --bad: #ff453a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, Ubuntu, sans-serif;
    -webkit-font-smoothing: antialiased; }
  main { max-width: 440px; margin: 56px auto; padding: 0 16px; }
  .head { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .mark { width: 28px; height: 28px; display: block; flex: none; }
  h1 { font-size: 15px; font-weight: 600; margin: 0; }
  .sub { color: var(--muted); font-size: 12px; }
  .panel { background: var(--panel); border-radius: 10px; border: 1px solid var(--line); overflow: hidden; }
  .row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
  .row + .row { border-top: 1px solid var(--line); }
  .row img, .row .mono { width: 24px; height: 24px; border-radius: 6px; flex: none; }
  .row .mono { display: grid; place-items: center; background: var(--line); font-weight: 600; font-size: 11px; }
  .row .name { flex: 1; font-weight: 500; }
  .row .state { font-size: 12px; color: var(--muted); }
  .row .state.ok { color: var(--ok); }
  .empty { padding: 16px 12px; color: var(--muted); }
  .status { margin: 14px 2px 0; font-size: 12.5px; color: var(--muted); min-height: 18px; }
  .status.warn { color: var(--warn); }
  .status.bad { color: var(--bad); }
  .status.ok { color: var(--ok); }
  .note { margin: 18px 2px 0; font-size: 12px; color: var(--muted); }
  .note a { color: inherit; }
  button { font: inherit; font-weight: 500; border: 0; border-radius: 6px; padding: 5px 12px;
    background: var(--accent); color: #1d1d1f; cursor: pointer; }
</style>
</head>
<body>
<main>
  <div class="head">
    <img class="mark" src="${BRIDGE_MARK}" alt="" />
    <div>
      <h1>Goldfelty</h1>
      <div class="sub" id="sub">Connecting to the app…</div>
    </div>
  </div>
  <div class="panel" id="list"><div class="empty">Looking for wallets in this browser…</div></div>
  <div class="status" id="status"></div>
  <p class="note">Keep this tab open while you use Goldfelty. It only talks to the app on this computer and to the wallets in this browser. Every transfer and signature is approved in the wallet itself.</p>
</main>
<script>
(function () {
  'use strict';
  // No secrets in this page or its URL. The app set an HttpOnly cookie when
  // the one-time link was opened, and every request below carries it.
  var PAGE = crypto.randomUUID();
  var providers = {};   // rdns -> { info, provider }
  var busy = {};        // rdns -> label of the request in flight
  var want = null;      // { rdns: [], name, homepage } the app is waiting for
  var alive = true;
  var helloTimer = null;

  var $ = function (id) { return document.getElementById(id); };
  function post(path, body) {
    body.pageId = PAGE;
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: path === '/api/bye'
    });
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function status(text, cls) { var s = $('status'); s.textContent = text || ''; s.className = 'status ' + (cls || ''); }

  function render() {
    var list = $('list');
    list.textContent = '';
    var keys = Object.keys(providers);
    if (!keys.length) {
      list.appendChild(el('div', 'empty', 'No wallet extensions found in this browser yet.'));
      return;
    }
    keys.forEach(function (rdns) {
      var info = providers[rdns].info;
      var row = el('div', 'row');
      if (typeof info.icon === 'string' && /^data:image\/(png|svg\+xml|webp|jpeg|gif);/.test(info.icon)) {
        var img = el('img');
        img.alt = '';
        img.src = info.icon;
        row.appendChild(img);
      } else {
        row.appendChild(el('span', 'mono', String(info.name || '?').charAt(0)));
      }
      row.appendChild(el('span', 'name', String(info.name)));
      row.appendChild(busy[rdns] ? el('span', 'state', busy[rdns]) : el('span', 'state ok', 'Ready'));
      list.appendChild(row);
    });
  }

  function hello() {
    var list = Object.keys(providers).map(function (rdns) {
      var i = providers[rdns].info;
      return { uuid: i.uuid, rdns: i.rdns, name: i.name, icon: i.icon || null };
    });
    return post('/api/hello', { providers: list }).then(function (r) {
      if (r.ok) $('sub').textContent = 'Connected to the app';
      else if (r.status === 403) $('sub').textContent = 'This tab is no longer linked. Open a new one from the Goldfelty app.';
    }, function () {
      $('sub').textContent = 'Can’t reach the app. Is Goldfelty open?';
    });
  }
  function helloSoon() { clearTimeout(helloTimer); helloTimer = setTimeout(hello, 150); }

  function watch(rdns, provider) {
    if (!provider || typeof provider.on !== 'function') return;
    ['accountsChanged', 'chainChanged', 'disconnect'].forEach(function (type) {
      try {
        provider.on(type, function (data) { post('/api/event', { rdns: rdns, type: type, data: data }); });
      } catch (e) {}
    });
  }

  function add(info, provider) {
    if (!info || typeof info.rdns !== 'string' || typeof info.name !== 'string' || providers[info.rdns]) return;
    if (!provider || typeof provider.request !== 'function') return;
    providers[info.rdns] = { info: info, provider: provider };
    watch(info.rdns, provider);
    render();
    helloSoon();
  }

  // EIP-6963: every wallet that supports it answers this, however many there are.
  window.addEventListener('eip6963:announceProvider', function (e) {
    if (e.detail) add(e.detail.info, e.detail.provider);
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  // Older wallets only inject window.ethereum. Name it from its flags, most
  // specific first, since several also claim to be MetaMask.
  setTimeout(function () {
    var eth = window.ethereum;
    var anyEvm = Object.keys(providers).some(function (k) { return !/^(sol|btc|tron):/.test(k); });
    if (eth && !anyEvm) {
      var guess =
        eth.isRabby ? ['io.rabby', 'Rabby'] :
        eth.isBraveWallet ? ['com.brave.wallet', 'Brave Wallet'] :
        eth.isCoinbaseWallet ? ['com.coinbase.wallet', 'Coinbase Wallet'] :
        eth.isPhantom ? ['app.phantom', 'Phantom'] :
        eth.isTrust || eth.isTrustWallet ? ['com.trustwallet.app', 'Trust Wallet'] :
        eth.isMetaMask ? ['io.metamask', 'MetaMask'] :
        ['injected', 'Browser wallet'];
      add({ uuid: 'legacy', rdns: guess[0], name: guess[1], icon: null }, eth);
    }
    hello().then(loadWant);
  }, 700);

  /* ---- Wallets for other chains ----------------------------------------------
   * Bitcoin, Solana and Tron wallets don't speak EIP-1193, so each gets a small
   * adapter with the same request() shape, answering Goldfelty's own gf_*
   * methods. Keys carry the chain family (sol:, btc:, tron:); the app decides
   * the family from the key alone. Bytes travel as base64 or hex strings, and
   * the app checks everything a wallet returns before using it. */

  function b64ToBytes(s) { var bin = atob(s); var out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function bytesToB64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
  function slug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40); }
  function adapter(key, name, icon, handlers) {
    add({ uuid: key, rdns: key, name: name, icon: typeof icon === 'string' ? icon : null }, {
      request: function (req) {
        var fn = handlers[req.method];
        if (!fn) return Promise.reject({ message: name + ' can’t do that.', code: 'UNSUPPORTED' });
        return Promise.resolve().then(function () { return fn.apply(null, req.params || []); });
      }
    });
  }
  // JSON-RPC style answers ({ result } or { error }) from Xverse and Leather.
  function rpcResult(res) {
    if (res && res.error) throw { message: res.error.message || 'The wallet declined.', code: res.error.code };
    if (res && res.status === 'error') throw { message: (res.error && res.error.message) || 'The wallet declined.', code: 4001 };
    return res && res.result !== undefined ? res.result : res;
  }

  // Solana: the Wallet Standard, which Phantom, Solflare, Backpack and others implement.
  function registerStandard(wallet) {
    try {
      if (!wallet || typeof wallet.name !== 'string' || !wallet.features) return;
      var chains = Array.prototype.slice.call(wallet.chains || []);
      if (!chains.some(function (c) { return String(c).indexOf('solana:') === 0; })) return;
      var connect = wallet.features['standard:connect'];
      var signTx = wallet.features['solana:signTransaction'];
      if (!connect || !signTx) return;
      var key = 'sol:' + slug(wallet.name);
      if (providers[key]) return;
      var accountFor = function (address) {
        var found = (wallet.accounts || []).filter(function (a) { return a.address === address; })[0];
        if (found) return Promise.resolve(found);
        return Promise.resolve(connect.connect({ silent: true })).catch(function () { return connect.connect(); }).then(function () {
          var again = (wallet.accounts || []).filter(function (a) { return a.address === address; })[0];
          if (!again) throw { message: wallet.name + ' isn’t sharing that account any more. Reconnect it in Goldfelty.', code: 'NO_ACCOUNT' };
          return again;
        });
      };
      adapter(key, wallet.name, wallet.icon, {
        gf_connect: function () {
          return connect.connect().then(function (out) {
            var accounts = (out && out.accounts) || wallet.accounts || [];
            return accounts.map(function (a) { return a.address; });
          });
        },
        gf_signSolana: function (txBase64, address) {
          return accountFor(address).then(function (account) {
            return signTx.signTransaction({ account: account, transaction: b64ToBytes(txBase64), chain: 'solana:mainnet' });
          }).then(function (out) {
            var signed = Array.isArray(out) ? out[0] : out;
            return bytesToB64(new Uint8Array(signed.signedTransaction));
          });
        }
      });
    } catch (e) {}
  }
  var standardApi = { register: function () { for (var i = 0; i < arguments.length; i++) registerStandard(arguments[i]); return function () {}; } };
  window.addEventListener('wallet-standard:register-wallet', function (e) {
    try { if (typeof e.detail === 'function') e.detail(standardApi); } catch (err) {}
  });
  try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: standardApi })); } catch (e) {}

  // Bitcoin: wallets with the UniSat-style API, then Xverse and Leather.
  function unisatStyle(key, name, p) {
    if (!p || typeof p.requestAccounts !== 'function' || typeof p.signPsbt !== 'function' || providers[key]) return;
    adapter(key, name, null, {
      gf_connect: function () {
        return p.requestAccounts().then(function (accounts) {
          return Promise.resolve(typeof p.getPublicKey === 'function' ? p.getPublicKey() : null).then(function (pk) {
            return (accounts || []).slice(0, 1).map(function (a) { return { address: a, publicKey: pk || null }; });
          });
        });
      },
      gf_signPsbt: function (psbtHex, inputs, address) {
        return p.signPsbt(psbtHex, {
          autoFinalized: false,
          toSignInputs: inputs.map(function (i) { return { index: i, address: address }; })
        });
      }
    });
  }
  function xverse(key, name, p) {
    if (!p || typeof p.request !== 'function' || providers[key]) return;
    adapter(key, name, null, {
      gf_connect: function () {
        return Promise.resolve(p.request('getAddresses', { purposes: ['payment'], message: 'Goldfelty will show this address’s balance.' }))
          .then(rpcResult, function () { return Promise.resolve(p.request('getAccounts', { purposes: ['payment'] })).then(rpcResult); })
          .then(function (r) {
            var list = (r && r.addresses) || r || [];
            return list.filter(function (a) { return !a.purpose || a.purpose === 'payment'; })
              .map(function (a) { return { address: a.address, publicKey: a.publicKey || null }; });
          });
      },
      gf_signPsbt: function (psbtHex, inputs, address) {
        var b64 = bytesToB64(new Uint8Array(psbtHex.match(/../g).map(function (h) { return parseInt(h, 16); })));
        var signInputs = {}; signInputs[address] = inputs;
        return Promise.resolve(p.request('signPsbt', { psbt: b64, signInputs: signInputs, broadcast: false }))
          .then(rpcResult).then(function (r) { return r.psbt; });
      }
    });
  }
  function leather(p) {
    if (!p || typeof p.request !== 'function' || providers['btc:leather']) return;
    adapter('btc:leather', 'Leather', null, {
      gf_connect: function () {
        return Promise.resolve(p.request('getAddresses')).then(rpcResult).then(function (r) {
          return ((r && r.addresses) || []).filter(function (a) { return a.symbol === 'BTC' && a.type === 'p2wpkh'; })
            .map(function (a) { return { address: a.address, publicKey: a.publicKey || null }; });
        });
      },
      gf_signPsbt: function (psbtHex, inputs) {
        return Promise.resolve(p.request('signPsbt', { hex: psbtHex, signAtIndex: inputs, network: 'mainnet', broadcast: false }))
          .then(rpcResult).then(function (r) { return r.hex; });
      }
    });
  }

  // Tron: TronLink and the wallets that copy its API. useGlobalWeb: the
  // object came from window.tronLink, so window.tronWeb is the same wallet's.
  function tronStyle(key, name, t, useGlobalWeb) {
    if (!t || providers[key]) return;
    var web = function () { return t.tronWeb || (useGlobalWeb && window.tronWeb) || null; };
    if (typeof t.request !== 'function' && !web()) return;
    adapter(key, name, null, {
      gf_connect: function () {
        var ask = typeof t.request === 'function'
          ? Promise.resolve(t.request({ method: 'tron_requestAccounts' })).catch(function () { return t.request({ method: 'eth_requestAccounts' }); })
          : Promise.resolve(null);
        return ask.then(function (r) {
          if (r && r.code === 4001) throw { message: 'Declined in ' + name + '.', code: 4001 };
          var w = web();
          var address = w && w.defaultAddress && w.defaultAddress.base58;
          if (!address && Array.isArray(r) && typeof r[0] === 'string') address = r[0];
          if (!address) throw { message: 'Unlock ' + name + ', then try again.', code: 'LOCKED' };
          return [address];
        });
      },
      gf_signTron: function (tx) {
        var w = web();
        if (!w || !w.trx) throw { message: 'Unlock ' + name + ', then try again.', code: 'LOCKED' };
        return w.trx.sign(tx);
      }
    });
  }

  /* Many wallets also fill in window.tronLink, window.unisat or
   * window.BitcoinProvider so sites built for TronLink, UniSat or Xverse work
   * with them. Most mark the object with their own flag; those are filed under
   * the wallet that put them there, not the one they imitate. (Seen on the
   * real extensions; see scripts/wallet-probe.mjs.) */
  var OWNER_FLAGS = [
    ['isOneKey', 'onekey', 'OneKey'], ['isFordefi', 'fordefi', 'Fordefi'], ['isTokenPocket', 'tokenpocket', 'TokenPocket'],
    ['isBackpackBitcoinWallet', 'backpack', 'Backpack'], ['isBackpack', 'backpack', 'Backpack'], ['isMagicEden', 'magic-eden', 'Magic Eden'],
    ['isTrust', 'trust', 'Trust Wallet'], ['isTrustWallet', 'trust', 'Trust Wallet'], ['isOKExWallet', 'okx', 'OKX Wallet'],
    ['isOkxWallet', 'okx', 'OKX Wallet'], ['isBitKeep', 'bitget', 'Bitget Wallet'], ['isGateWallet', 'gate', 'Gate Wallet'],
    ['isSafePal', 'safepal', 'SafePal'], ['isCtrl', 'ctrl', 'Ctrl'], ['isXDEFI', 'ctrl', 'Ctrl'], ['isCoin98', 'coin98', 'Coin98']
  ];
  function ownerOf(obj) {
    if (!obj) return null;
    for (var i = 0; i < OWNER_FLAGS.length; i++) {
      try { if (obj[OWNER_FLAGS[i][0]] === true) return { slug: OWNER_FLAGS[i][1], name: OWNER_FLAGS[i][2] }; } catch (e) {}
    }
    return null;
  }
  function hasFamilyFor(prefix, name) {
    return Object.keys(providers).some(function (k) { return k.indexOf(prefix) === 0 && providers[k].info.name === name; });
  }
  // The one EVM wallet in this browser, if there is exactly one.
  function soleEvmWallet() {
    var keys = Object.keys(providers).filter(function (k) { return !/^(sol|btc|tron):/.test(k) && k !== 'injected'; });
    return keys.length === 1 ? providers[keys[0]].info : null;
  }

  function scanOtherChains(final) {
    // Wallets' own namespaces first, so they keep their own keys.
    unisatStyle('btc:okx', 'OKX Wallet', window.okxwallet && window.okxwallet.bitcoin);
    unisatStyle('btc:bitget', 'Bitget Wallet', window.bitkeep && window.bitkeep.unisat);
    unisatStyle('btc:onekey', 'OneKey', window.$onekey && window.$onekey.btc);
    tronStyle('tron:okx', 'OKX Wallet', window.okxwallet && window.okxwallet.tronLink);
    tronStyle('tron:bitget', 'Bitget Wallet', window.bitkeep && window.bitkeep.tronLink);
    leather(window.LeatherProvider);

    // window.unisat: UniSat's, unless another wallet's flag says otherwise.
    var u = window.unisat, uo = ownerOf(u);
    if (u && !(uo && hasFamilyFor('btc:', uo.name))) unisatStyle(uo ? 'btc:' + uo.slug : 'btc:unisat', uo ? uo.name : 'UniSat', u);

    // Xverse's own namespace, else window.BitcoinProvider, which others imitate.
    if (window.XverseProviders && window.XverseProviders.BitcoinProvider) xverse('btc:xverse', 'Xverse', window.XverseProviders.BitcoinProvider);
    var bp = window.BitcoinProvider, bo = ownerOf(bp);
    if (bp && bp !== (window.XverseProviders && window.XverseProviders.BitcoinProvider) && !(bo && hasFamilyFor('btc:', bo.name))) {
      xverse(bo ? 'btc:' + bo.slug : 'btc:xverse', bo ? bo.name : 'Xverse', bp);
    }

    // window.tronLink: by its flag; else, since the real TronLink always
    // announces itself (org.tronlink.www), an unmarked one with TronLink
    // absent belongs to the only other wallet here, if there is just one.
    var t = window.tronLink || window.tron, to = ownerOf(t) || ownerOf(window.tron);
    if (t) {
      var owner = to;
      if (!owner && !providers['org.tronlink.www']) {
        // Only once every wallet has had time to announce itself.
        if (!final) return;
        var sole = soleEvmWallet();
        if (sole) owner = { slug: slug(sole.name), name: sole.name };
      }
      if (!(owner && hasFamilyFor('tron:', owner.name))) tronStyle(owner ? 'tron:' + owner.slug : 'tron:tronlink', owner ? owner.name : 'TronLink', t, true);
    }
  }
  // Some extensions inject late; look twice.
  setTimeout(function () { scanOtherChains(false); }, 600);
  setTimeout(function () { scanOtherChains(true); }, 2500);

  // Some wallets are slow to start, right after the browser opens or the
  // wallet is installed. Ask everyone again a few times, and when the tab is
  // looked at; anything already found is ignored.
  function rescan() {
    try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: standardApi })); } catch (e) {}
    scanOtherChains(true);
    checkWanted();
  }
  [5000, 10000, 20000].forEach(function (ms) { setTimeout(rescan, ms); });
  window.addEventListener('focus', rescan);

  // What the app is waiting for comes from the app, never from the URL.
  function loadWant() {
    return fetch('/api/want?pageId=' + encodeURIComponent(PAGE), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (w) { want = w && w.name ? w : null; checkWanted(); }, function () {});
  }

  function checkWanted() {
    if (!want) return;
    var found = want.rdns.some(function (r) { return providers[r]; }) ||
      Object.keys(providers).some(function (r) { return providers[r].info.name.toLowerCase() === want.name.toLowerCase(); });
    if (found) {
      status('Approve the connection in ' + want.name + '.');
      return;
    }
    var s = $('status');
    s.textContent = want.name + ' isn’t showing up in this browser. If you just opened the browser or installed it, reload this tab. If it’s in a different browser, open the link from Goldfelty there instead.';
    s.className = 'status warn';
    // Some wallets (Bitget, Ctrl) don't load into tabs opened while they are still starting up.
    var again = el('button', null, 'Reload this tab');
    again.type = 'button';
    again.addEventListener('click', function () { location.reload(); });
    s.appendChild(document.createTextNode(' '));
    s.appendChild(again);
    if (typeof want.homepage === 'string' && /^https:\/\//.test(want.homepage)) {
      var a = el('a', null, 'Get ' + want.name);
      a.href = want.homepage;
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      s.appendChild(document.createTextNode(' '));
      s.appendChild(a);
    }
  }

  var LABELS = {
    eth_requestAccounts: 'Approve connection',
    eth_sendTransaction: 'Approve transfer',
    personal_sign: 'Approve signature',
    wallet_switchEthereumChain: 'Approve network switch',
    wallet_addEthereumChain: 'Approve new network',
    gf_connect: 'Approve connection',
    gf_signPsbt: 'Approve transfer',
    gf_signSolana: 'Approve transfer',
    gf_signTron: 'Approve transfer'
  };

  function run(job) {
    var entry = providers[job.rdns];
    if (!entry) {
      return post('/api/result', { id: job.id, error: { message: 'That wallet is not in this browser.', code: 'NOT_FOUND' } });
    }
    var label = LABELS[job.method];
    if (label) {
      busy[job.rdns] = label + ' in ' + entry.info.name;
      render();
      status(label + ' in ' + entry.info.name + '.', 'warn');
    }
    return Promise.resolve()
      .then(function () { return entry.provider.request({ method: job.method, params: job.params }); })
      .then(function (result) {
        delete busy[job.rdns]; render();
        if (label) status('Done.', 'ok');
        return post('/api/result', { id: job.id, result: result });
      }, function (err) {
        delete busy[job.rdns]; render();
        var message = String((err && err.message) || 'The wallet declined.').slice(0, 300);
        if (label) status(message, 'bad');
        return post('/api/result', { id: job.id, error: { message: message, code: err && err.code } });
      });
  }

  function pump() {
    if (!alive) return;
    fetch('/api/poll?pageId=' + encodeURIComponent(PAGE), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        if (r.status === 410) return hello().then(pump);
        if (r.status === 403) { alive = false; $('sub').textContent = 'This tab is no longer linked. Open a new one from the Goldfelty app.'; return; }
        return r.json().then(function (job) {
          if (job && job.id) {
            // Do not wait for the wallet before polling again: a second wallet
            // in this tab should not queue behind the first one's prompt.
            run(job);
          }
          if (job && job.want !== undefined) { want = job.want; checkWanted(); }
          pump();
        });
      })
      .catch(function () { setTimeout(pump, 2000); });
  }
  setTimeout(pump, 800);

  window.addEventListener('pagehide', function () {
    alive = false;
    try { post('/api/bye', {}).catch(function () {}); } catch (e) {}
  });
})();
</script>
</body>
</html>`
