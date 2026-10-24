/**
 * The page BrowserBridge serves, as a string.
 *
 * It runs in the user's own browser, where wallet extensions announce
 * themselves through EIP-6963. It reports what it finds to the app, then
 * long-polls for requests and hands each one to the wallet it names.
 *
 * It talks to nothing but the bridge on 127.0.0.1 and the wallets in this
 * browser. It holds no secret and reads nothing from its own URL: the app
 * authenticates it with an HttpOnly cookie set when the one-time link is
 * opened, and tells it which wallet is wanted over the same channel.
 *
 * Scripts and styles are pinned by hash in the page's CSP (see
 * browserBridge.ts), so editing either here is all it takes; the hashes are
 * computed from this string at startup.
 */
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
  .mark { width: 28px; height: 28px; border-radius: 7px; background: var(--accent); color: #1d1d1f;
    display: grid; place-items: center; font-weight: 700; font-size: 15px; }
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
    <div class="mark">G</div>
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
    if (eth && !Object.keys(providers).length) {
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
    s.textContent = want.name + ' isn’t installed in this browser. If it’s in a different browser, open the link from Goldfelty there instead.';
    s.className = 'status warn';
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
    wallet_addEthereumChain: 'Approve new network'
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
