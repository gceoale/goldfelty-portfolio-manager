// Owner dashboard. Everything is rendered with textContent: account data is
// user-supplied, and this page holds an admin token.
(function () {
  'use strict'
  var API = 'https://api.goldfelty.com/v1/admin/stats'
  var REPO = 'gceoale/goldfelty-portfolio-manager'
  var KEY = 'goldfelty-admin-token'
  var $ = function (id) { return document.getElementById(id) }

  function stored() {
    try { return sessionStorage.getItem(KEY) || '' } catch (e) { return '' }
  }
  function store(token) {
    try { token ? sessionStorage.setItem(KEY, token) : sessionStorage.removeItem(KEY) } catch (e) {}
  }

  function money(value, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency, maximumFractionDigits: 0 }).format(value)
    } catch (e) {
      return Math.round(value) + ' ' + currency
    }
  }
  function date(iso) {
    return iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : ''
  }
  function row(cells) {
    var tr = document.createElement('tr')
    cells.forEach(function (c) {
      var td = document.createElement('td')
      td.textContent = c.text == null ? '' : String(c.text)
      if (c.num) td.className = 'num'
      tr.appendChild(td)
    })
    return tr
  }
  function fill(tableId, rows) {
    var body = $(tableId).querySelector('tbody')
    body.textContent = ''
    rows.forEach(function (r) { body.appendChild(r) })
  }

  function load(token) {
    $('status').textContent = 'Loading…'
    fetch(API, { headers: { authorization: 'Bearer ' + token }, cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (r) {
        if (r.status === 401) throw new Error('That token isn’t right.')
        if (r.status === 503) throw new Error('Admin access isn’t set up on the API yet (no ADMIN_TOKEN).')
        if (r.status === 429) throw new Error('Too many tries. Wait a minute.')
        if (!r.ok) throw new Error('The API answered ' + r.status + '.')
        return r.json()
      })
      .then(function (s) {
        store(token)
        $('status').textContent = 'Updated ' + new Date().toLocaleTimeString()
        render(s)
      })
      .catch(function (e) {
        $('status').textContent = e.message || 'Couldn’t reach api.goldfelty.com.'
      })
  }

  function render(s) {
    $('stats').hidden = false
    $('totals-section').hidden = false
    $('people-section').hidden = false
    $('users').textContent = Number(s.users || 0).toLocaleString()
    $('week').textContent = Number(s.newThisWeek || 0).toLocaleString()
    $('sharing').textContent = Number(s.sharing || 0).toLocaleString()
    fill('totals', (s.totals || []).map(function (t) {
      var users = Number(t.users) || 0
      var total = Number(t.total) || 0
      return row([{ text: t.currency }, { text: users.toLocaleString(), num: true }, { text: money(total, t.currency), num: true }, { text: users ? money(total / users, t.currency) : '', num: true }])
    }))
    fill('people', (s.accounts || []).map(function (a) {
      var shared = a.value !== null && a.value !== undefined
      return row([
        { text: a.username },
        { text: a.email },
        { text: date(a.createdAt) },
        { text: shared ? a.wallets : '', num: true },
        { text: shared ? money(Number(a.value), a.currency) : 'Not shared', num: true },
        { text: shared ? date(a.reportedAt) : '' }
      ])
    }))
  }

  function downloads() {
    fetch('https://api.github.com/repos/' + REPO + '/releases?per_page=100')
      .then(function (r) { return r.json() })
      .then(function (releases) {
        if (!Array.isArray(releases)) return
        var n = 0
        releases.forEach(function (rel) {
          (rel.assets || []).forEach(function (a) {
            if (!/\.(txt|yml|blockmap)$/.test(a.name)) n += Number(a.download_count) || 0
          })
        })
        $('downloads').textContent = n.toLocaleString()
      })
      .catch(function () {})
  }

  // Demo mode (/admin/?demo): made-up numbers for screenshots and for checking
  // how the page looks at scale. Nothing is fetched and no token is needed.
  // The same data comes out every time (seeded random numbers).
  var DEMO = { users: 3246523, downloads: 5048723, newThisWeek: 41870, sharing: 1298609, shown: 500, max: 57000000, min: 3 }

  function demoStats() {
    var seed = 20261027
    function rand() {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296
    }
    function pick(list) { return list[Math.floor(rand() * list.length)] }
    var first = ['alex', 'sam', 'jordan', 'taylor', 'casey', 'riley', 'morgan', 'jamie', 'drew', 'avery', 'quinn', 'blake', 'reese', 'parker', 'rowan', 'emery', 'sage', 'kai', 'noa', 'lee']
    var second = ['gold', 'stack', 'hodl', 'moon', 'chain', 'block', 'ledger', 'vault', 'coin', 'sats', 'whale', 'fox', 'bear', 'bull', 'node', 'mint', 'byte', 'hash', 'peak', 'wave']
    var day = 86400000
    var now = Date.now()
    var accounts = []
    var sum = 0
    for (var i = 0; i < DEMO.shown; i++) {
      // Spread from $57M at the top down to $3 at the bottom, denser near the
      // small end, the way real balances tend to be.
      var t = i / (DEMO.shown - 1)
      var value = i === 0 ? DEMO.max : i === DEMO.shown - 1 ? DEMO.min
        : DEMO.min * Math.pow(DEMO.max / DEMO.min, Math.pow(1 - t, 2) * (0.97 + rand() * 0.06))
      if (i > 0 && i < DEMO.shown - 1) value = Math.min(DEMO.max - 1, Math.max(DEMO.min + 1, Math.round(value)))
      sum += value
      var name = pick(first) + '_' + pick(second) + Math.floor(rand() * 1000)
      accounts.push({
        username: name,
        email: name + '@example.com',
        createdAt: new Date(now - Math.floor(rand() * 730) * day).toISOString(),
        wallets: 1 + Math.floor(rand() * 9),
        value: value,
        currency: 'USD',
        reportedAt: new Date(now - Math.floor(rand() * 5) * day).toISOString()
      })
    }
    accounts.sort(function (a, b) { return b.value - a.value })
    return {
      users: DEMO.users,
      newThisWeek: DEMO.newThisWeek,
      sharing: DEMO.sharing,
      totals: [{ currency: 'USD', users: DEMO.sharing, total: (sum / DEMO.shown) * DEMO.sharing }],
      accounts: accounts
    }
  }

  var demo = /[?&]demo(=|&|$)/.test(location.search)
  if (demo) {
    $('status').textContent = ''
    $('downloads').textContent = DEMO.downloads.toLocaleString()
    render(demoStats())
    return
  }

  // Over plain HTTP anyone on the network path could read the token or change
  // this page, so it is only ever typed in over HTTPS.
  var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  if (!secure) {
    $('token').disabled = true
    $('status').textContent = 'This page isn’t on HTTPS, so it won’t take your token. Open https://' + location.host + '/admin/ instead. If that doesn’t load, turn on “Enforce HTTPS” in the repository’s Pages settings.'
  }

  $('signin').addEventListener('submit', function (e) {
    e.preventDefault()
    var token = $('token').value.trim()
    $('token').value = ''
    if (token && secure) load(token)
  })
  $('forget').addEventListener('click', function () {
    store('')
    $('status').textContent = 'Token forgotten.'
    $('stats').hidden = true
    $('totals-section').hidden = true
    $('people-section').hidden = true
  })

  downloads()
  var existing = secure ? stored() : ''
  if (existing) load(existing)
})()
