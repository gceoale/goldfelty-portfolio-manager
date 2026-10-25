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
        $('stats').hidden = false
        $('totals-section').hidden = false
        $('people-section').hidden = false
        $('users').textContent = Number(s.users || 0).toLocaleString()
        $('week').textContent = Number(s.newThisWeek || 0).toLocaleString()
        $('sharing').textContent = Number(s.sharing || 0).toLocaleString()
        fill('totals', (s.totals || []).map(function (t) {
          var users = Number(t.users) || 0
          var total = Number(t.total) || 0
          return row([{ text: t.currency }, { text: users, num: true }, { text: money(total, t.currency), num: true }, { text: users ? money(total / users, t.currency) : '', num: true }])
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
      })
      .catch(function (e) {
        $('status').textContent = e.message || 'Couldn’t reach api.goldfelty.com.'
      })
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
