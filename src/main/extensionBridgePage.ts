/**
 * The page served by ExtensionBridge, as a string.
 *
 * It runs in the user's real browser, where the wallet extension injects
 * `window.ethereum`. It connects, then long-polls the bridge for things to
 * sign and hands each one to the extension. Closing the tab ends the link,
 * which the page states plainly so nobody closes it mid-transfer.
 */
export const BRIDGE_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Connect your wallet to Goldfelty</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: radial-gradient(900px 500px at 70% -10%, rgba(212,160,23,.12), transparent 60%), #0b0c10;
    color: #eef0f5;
  }
  .card {
    width: 100%; max-width: 440px; background: #121319; border: 1px solid #22242d;
    border-radius: 16px; padding: 28px; text-align: center;
  }
  .mark {
    width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 13px; display: grid;
    place-items: center; font-weight: 800; font-size: 21px; color: #251a03;
    background: linear-gradient(140deg, #e8c35e, #b8870c);
  }
  h1 { font-size: 19px; margin: 0 0 8px; letter-spacing: -.02em; }
  p { margin: 0 0 16px; color: #a2a7b5; font-size: 14px; }
  button {
    width: 100%; height: 44px; border: 0; border-radius: 10px; font: inherit; font-weight: 600;
    background: #d4a017; color: #1a1406; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: not-allowed; }
  .status { margin-top: 16px; padding: 12px; border-radius: 10px; font-size: 13.5px; display: none; }
  .ok { background: rgba(63,185,138,.14); color: #3fb98a; display: block; }
  .err { background: rgba(226,96,79,.14); color: #e2604f; display: block; }
  .warn { background: rgba(226,160,63,.14); color: #e2a03f; display: block; }
  .addr { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; word-break: break-all; margin-top: 6px; }
  .keep { margin-top: 18px; font-size: 12.5px; color: #6e7383; }
  .pulse { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb98a; margin-right: 6px; animation: p 1.6s ease-in-out infinite; }
  @keyframes p { 0%,100% { opacity: 1 } 50% { opacity: .3 } }
</style>
</head>
<body>
<div class="card">
  <div class="mark">G</div>
  <h1>Connect your wallet</h1>
  <p id="lede">Goldfelty Portfolio Manager is asking to connect to the wallet extension in this browser.</p>
  <button id="go">Connect wallet</button>
  <div id="status" class="status"></div>
  <div class="keep" id="keep"></div>
</div>
<script>
(function () {
  var TOKEN = new URLSearchParams(location.search).get('token');
  var CHAIN_IDS = __CHAIN_IDS__;
  var go = document.getElementById('go');
  var status = document.getElementById('status');
  var keep = document.getElementById('keep');
  var lede = document.getElementById('lede');
  var running = false;

  function show(cls, html) { status.className = 'status ' + cls; status.innerHTML = html; }

  function api(path, body) {
    return fetch(path + '?token=' + encodeURIComponent(TOKEN), {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
  }

  function providerName(p) {
    if (!p) return 'Browser wallet';
    if (p.isMetaMask) return 'MetaMask';
    if (p.isRabby) return 'Rabby';
    if (p.isBraveWallet) return 'Brave Wallet';
    if (p.isCoinbaseWallet) return 'Coinbase Wallet';
    if (p.isPhantom) return 'Phantom';
    return 'Browser wallet';
  }

  if (!window.ethereum) {
    go.disabled = true;
    lede.textContent = 'No wallet extension found in this browser.';
    show('err', 'Install MetaMask, Rabby or another extension wallet, then reload this page. If you have one installed, make sure it is enabled for this site.');
    return;
  }

  go.addEventListener('click', function () {
    go.disabled = true;
    go.textContent = 'Check your wallet…';
    window.ethereum.request({ method: 'eth_requestAccounts' })
      .then(function (accounts) {
        return window.ethereum.request({ method: 'eth_chainId' }).then(function (chainId) {
          return api('/api/connect', {
            accounts: accounts,
            chainIds: CHAIN_IDS,
            providerName: providerName(window.ethereum)
          }).then(function () {
            show('ok', '<strong>Connected as ' + providerName(window.ethereum) + '</strong>'
              + '<div class="addr">' + accounts.join('<br>') + '</div>');
            keep.innerHTML = '<span class="pulse"></span>Leave this tab open. Closing it disconnects the wallet from Goldfelty.';
            go.textContent = 'Connected';
            running = true;
            pump();
          });
        });
      })
      .catch(function (err) {
        go.disabled = false;
        go.textContent = 'Connect wallet';
        show('err', err && err.message ? err.message : 'The wallet refused the connection.');
      });
  });

  // Long-poll the bridge for anything Goldfelty wants signed.
  function pump() {
    if (!running) return;
    api('/api/poll')
      .then(function (r) { return r.json(); })
      .then(function (job) {
        if (!job || !job.id) { pump(); return; }
        show('warn', 'Goldfelty is requesting <strong>' + job.method + '</strong>. Approve it in your wallet.');
        return window.ethereum.request({ method: job.method, params: job.params })
          .then(function (result) {
            show('ok', 'Approved. You can leave this tab open for the next one.');
            return api('/api/result', { id: job.id, result: result });
          })
          .catch(function (err) {
            show('err', (err && err.message) || 'Rejected in wallet.');
            return api('/api/result', { id: job.id, error: (err && err.message) || 'Rejected in wallet' });
          })
          .then(function () { pump(); });
      })
      .catch(function () { setTimeout(pump, 2000); });
  }

  window.addEventListener('beforeunload', function () {
    // Best effort: tell the app the link is going away.
    navigator.sendBeacon && navigator.sendBeacon('/api/disconnect?token=' + encodeURIComponent(TOKEN), '{}');
  });

  if (window.ethereum.on) {
    window.ethereum.on('accountsChanged', function (accounts) {
      if (!accounts.length) { running = false; show('err', 'The wallet disconnected.'); return; }
      api('/api/connect', { accounts: accounts, chainIds: CHAIN_IDS, providerName: providerName(window.ethereum) });
    });
  }
})();
</script>
</body>
</html>`
