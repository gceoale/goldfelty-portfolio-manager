// Social autopilot dashboard. Everything from the API is rendered with
// textContent: post text and log lines come from the runner, and this page
// holds the admin token.
(function () {
  'use strict'
  var API = 'https://api.goldfelty.com/v1/admin/social'
  var KEY = 'goldfelty-admin-token'
  var NAMES = { x: 'X', reddit: 'Reddit', youtube: 'YouTube' }
  var HELP = {
    x: {
      where: 'developer.x.com',
      href: 'https://developer.x.com/en/portal/projects-and-apps',
      steps: 'Create a project and app. Under User authentication settings: OAuth 2.0, type Web App, Read and write, and the callback URL below. Copy the OAuth 2.0 Client ID and Client Secret.'
    },
    reddit: {
      where: 'reddit.com/prefs/apps',
      href: 'https://www.reddit.com/prefs/apps',
      steps: 'Create another app, type web app, with the redirect URI below. The client ID is under the app name; the secret is labelled secret.'
    },
    youtube: {
      where: 'Google Cloud Console',
      href: 'https://console.cloud.google.com/apis/credentials',
      steps: 'Enable YouTube Data API v3, set up the OAuth consent screen, then Create credentials > OAuth client ID > Web application, with the redirect URI below.'
    }
  }
  var $ = function (id) { return document.getElementById(id) }
  var token = ''
  var data = null

  function stored() { try { return sessionStorage.getItem(KEY) || '' } catch (e) { return '' } }
  function store(t) { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY) } catch (e) {} }

  function el(tag, props, kids) {
    var n = document.createElement(tag)
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'text') n.textContent = props[k]
      else if (k === 'class') n.className = props[k]
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), props[k])
      else n.setAttribute(k, props[k])
    })
    ;(kids || []).forEach(function (c) { if (c) n.appendChild(c) })
    return n
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { authorization: 'Bearer ' + token }, cache: 'no-store', referrerPolicy: 'no-referrer' }
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json'
      opts.body = JSON.stringify(body)
    }
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {} }).then(function (j) {
        if (r.status === 401) throw new Error('That token isn’t right.')
        if (r.status === 503) throw new Error('Admin access isn’t set up on the API yet (no ADMIN_TOKEN).')
        if (r.status === 429) throw new Error('Too many requests. Wait a minute.')
        if (!r.ok) throw new Error(j.message || 'The API answered ' + r.status + '.')
        return j
      })
    })
  }

  function ago(iso) {
    if (!iso) return ''
    var s = (Date.now() - new Date(iso).getTime()) / 1000
    if (s < 90) return 'just now'
    if (s < 5400) return Math.round(s / 60) + ' min ago'
    if (s < 129600) return Math.round(s / 3600) + ' h ago'
    return Math.round(s / 86400) + ' days ago'
  }
  function when(iso) {
    return iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
  }
  function get(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? undefined : o[k] }, obj)
  }

  function banner(text, good) {
    var b = $('banner')
    b.textContent = text
    b.className = 'banner ' + (good ? 'good' : 'bad')
    b.hidden = !text
  }

  // ---- render --------------------------------------------------------------

  function renderRun() {
    var paused = data.control.paused
    var anyConnected = ['x', 'reddit', 'youtube'].some(function (p) { return data.connections[p].connected })
    var keySet = get(data.config, 'anthropicApiKey.set')
    var ready = anyConnected && keySet
    var pill = $('state')
    pill.textContent = paused ? 'Paused' : ready ? 'Running' : 'Waiting for setup'
    pill.className = 'pill ' + (paused ? 'off' : ready ? 'on' : '')
    $('toggle').textContent = paused ? 'Resume' : 'Pause'
    var last = data.runs[data.runs.length - 1]
    var text
    if (!last) text = 'No runs yet. The first one starts within half an hour.'
    else {
      text = 'Last run ' + ago(last.at) + ': ' + (last.summary || 'nothing due')
      var hours = (Date.now() - new Date(last.at).getTime()) / 3600000
      if (hours > 3) text += '. That’s a while: check the Social autopilot workflow on GitHub (Actions tab).'
    }
    $('last-run').textContent = text
    var err = data.autopilot.lastError
    $('last-error').hidden = !err
    $('last-error').textContent = err ? 'Last problem (' + when(data.autopilot.lastErrorAt) + '): ' + err : ''
  }

  function renderChecklist() {
    var todo = []
    if (!get(data.config, 'anthropicApiKey.set')) todo.push('Add your Anthropic API key below. Nothing gets written without it.')
    if (!['x', 'reddit', 'youtube'].some(function (p) { return data.connections[p].connected })) todo.push('Connect at least one account.')
    if (!data.config.timezone) todo.push('Check your time zone below and press Save, so posts go out in your daytime.')
    var box = $('checklist')
    box.textContent = ''
    todo.forEach(function (t) { box.appendChild(el('div', { class: 'callout', text: t })) })
  }

  function copyRow(text) {
    var btn = el('button', { class: 'btn small plain', type: 'button', text: 'Copy' })
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(text).then(function () { btn.textContent = 'Copied' }, function () {})
    })
    return el('div', { class: 'copy' }, [el('code', { text: text }), btn])
  }

  function renderAccounts() {
    var box = $('accounts')
    box.textContent = ''
    ;['x', 'reddit', 'youtube'].forEach(function (p) {
      var c = data.connections[p]
      var cfg = data.config[p] || {}
      var name = c.username ? (p === 'x' ? '@' + c.username : p === 'reddit' ? 'u/' + c.username : c.username) : ''
      var status = c.connected ? 'Connected as ' + name : 'Not connected'
      var hasKeys = cfg.clientId && (p !== 'youtube' || get(cfg, 'clientSecret.set'))
      var connect = el('button', { class: 'btn', type: 'button', text: c.connected ? 'Reconnect' : 'Connect' })
      connect.disabled = !hasKeys
      connect.addEventListener('click', function () {
        connect.disabled = true
        api('POST', '/connect/' + p).then(function (r) { location.assign(r.url) }, function (e) { banner(e.message); connect.disabled = false })
      })
      var actions = el('div', { class: 'actions' }, [connect])
      if (c.connected) {
        actions.appendChild(el('button', {
          class: 'btn plain', type: 'button', text: 'Disconnect',
          onclick: function () {
            if (!confirm('Disconnect ' + NAMES[p] + '? Posting there stops until you connect again.')) return
            api('POST', '/disconnect/' + p).then(load, function (e) { banner(e.message) })
          }
        }))
      }
      var id = el('input', { type: 'text', autocomplete: 'off', placeholder: 'Client ID' })
      id.value = cfg.clientId || ''
      var secret = el('input', { type: 'password', autocomplete: 'off', placeholder: get(cfg, 'clientSecret.set') ? 'Secret saved (…' + cfg.clientSecret.ends + '). Type to replace.' : 'Client secret' + (p === 'reddit' ? ' (leave empty for an installed app)' : '') })
      var saveKeys = el('button', {
        class: 'btn small', type: 'button', text: 'Save keys',
        onclick: function () {
          var set = {}
          if (id.value.trim() && id.value.trim() !== cfg.clientId) set[p + '.clientId'] = id.value.trim()
          if (secret.value.trim()) set[p + '.clientSecret'] = secret.value.trim()
          if (!Object.keys(set).length) return
          api('PUT', '/config', { set: set }).then(function () { banner(NAMES[p] + ' keys saved.', true); load() }, function (e) { banner(e.message) })
        }
      })
      var help = HELP[p]
      var details = el('details', {}, [
        el('summary', { text: hasKeys ? 'Developer app keys' : 'Set up: developer app keys' }),
        el('p', { class: 'hint' }, [document.createTextNode('In '), el('a', { href: help.href, target: '_blank', rel: 'noopener noreferrer', text: help.where }), document.createTextNode(': ' + help.steps)]),
        el('div', { class: 'field' }, [el('label', { text: 'Callback / redirect URL' }), copyRow(data.callbacks[p])]),
        el('div', { class: 'field' }, [el('label', { text: 'Client ID' }), id]),
        el('div', { class: 'field' }, [el('label', { text: 'Client secret' }), secret]),
        saveKeys
      ])
      if (!hasKeys) details.open = true
      var extra = c.error ? el('div', { class: 'err', text: c.error }) : null
      var mods = p === 'reddit' && c.connected
        ? el('p', { class: 'hint', text: 'Posts go to u/' + c.username + (c.moderated && c.moderated.length ? ' and subreddits you moderate (' + c.moderated.join(', ') + ')' : '') + ' only.' })
        : null
      box.appendChild(el('div', { class: 'card' }, [
        el('h3', { text: NAMES[p] }),
        el('div', { class: 'who ' + (c.connected ? 'ok' : 'no'), text: status }),
        extra, mods, actions, details
      ]))
    })
  }

  var SECRET_INPUTS = ['anthropicApiKey']
  var WINDOW_INPUTS = ['x.windows', 'reddit.windows', 'youtube.windows']

  function renderSettings() {
    SECRET_INPUTS.forEach(function (k) {
      var v = get(data.config, k) || {}
      $(k).value = ''
      $(k).placeholder = v.set ? 'Saved (…' + v.ends + '). Type to replace.' : 'Not set'
      var label = document.querySelector('.saved[data-for="' + k + '"]')
      label.textContent = ''
      if (v.set) {
        label.appendChild(el('button', {
          class: 'btn small plain', type: 'button', text: 'Remove',
          onclick: function () { api('PUT', '/config', { clear: [k] }).then(load, function (e) { banner(e.message) }) }
        }))
      }
    })
    var tz = $('timezone')
    if (!tz.options.length) {
      var zones = []
      try { zones = Intl.supportedValuesOf('timeZone') } catch (e) { zones = ['UTC'] }
      zones.forEach(function (z) { tz.appendChild(el('option', { value: z, text: z.replace(/_/g, ' ') })) })
    }
    var zone = data.config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    if (!Array.prototype.some.call(tz.options, function (o) { return o.value === zone })) {
      tz.insertBefore(el('option', { value: zone, text: zone.replace(/_/g, ' ') }), tz.firstChild)
    }
    tz.value = zone
    $('youtube.privacyStatus').value = get(data.config, 'youtube.privacyStatus') || 'public'
    $('video.auto').checked = get(data.config, 'video.auto') !== false
    var defaults = { 'x.windows': ['09:00-11:00', '13:00-15:00', '18:00-20:00'], 'reddit.windows': ['10:00-12:00'], 'youtube.windows': ['16:00-19:00'] }
    WINDOW_INPUTS.forEach(function (k) { $(k).value = (get(data.config, k) || defaults[k]).join(', ') })
  }

  function saveSettings() {
    var set = {}
    SECRET_INPUTS.forEach(function (k) { if ($(k).value.trim()) set[k] = $(k).value.trim() })
    if ($('timezone').value) set.timezone = $('timezone').value
    set['youtube.privacyStatus'] = $('youtube.privacyStatus').value
    set['video.auto'] = $('video.auto').checked
    WINDOW_INPUTS.forEach(function (k) {
      set[k] = $(k).value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
    })
    $('settings-status').textContent = 'Saving…'
    api('PUT', '/config', { set: set }).then(function () {
      $('settings-status').textContent = 'Saved.'
      load()
    }, function (e) { $('settings-status').textContent = e.message })
  }

  function item(i, removable) {
    var meta = el('div', { class: 'meta' }, [
      el('span', { class: 'tag', text: NAMES[i.platform] || i.platform }),
      el('span', { text: { post: 'Post', thread: 'Thread', self: 'Text post', video: 'Short' }[i.kind] || i.kind }),
      el('span', { text: when(i.at) })
    ])
    if (i.url) meta.appendChild(el('a', { href: i.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open' }))
    if (removable) {
      meta.appendChild(el('button', {
        class: 'btn small plain right', type: 'button', text: 'Remove',
        onclick: function (ev) {
          ev.target.disabled = true
          api('POST', '/items/' + i.id + '/remove').then(function () {
            banner('Removed. It won’t be posted.', true)
            ev.target.closest('.item').remove()
          }, function (e) { banner(e.message); ev.target.disabled = false })
        }
      }))
    }
    var kids = [meta, el('div', { class: 'text', text: i.text })]
    if (i.metrics) {
      var m = i.metrics
      kids.push(el('div', { class: 'nums', text: m.likes + ' likes · ' + m.reposts + ' reposts · ' + m.replies + ' replies' + (m.views ? ' · ' + m.views + ' views' : '') }))
    }
    if (i.error || (i.note && !removable)) kids.push(el('div', { class: 'why', text: i.error || i.note }))
    return el('div', { class: 'item' }, kids)
  }

  function renderList(id, items, removable, empty) {
    var box = $(id)
    box.textContent = ''
    if (!items.length) box.appendChild(el('p', { class: 'empty', text: empty }))
    items.forEach(function (i) { box.appendChild(item(i, removable)) })
  }

  function render() {
    renderRun()
    renderChecklist()
    renderAccounts()
    renderSettings()
    if (document.activeElement !== $('facts')) $('facts').value = data.facts || ''
    renderList('upcoming', data.queue.upcoming, true, 'Nothing approved yet. Autopilot writes a batch when the stock runs low.')
    renderList('posted', data.queue.posted, false, 'Nothing posted yet.')
    renderList('turned-down', data.queue.turnedDown, false, 'Nothing turned down.')
    var body = $('runs').querySelector('tbody')
    body.textContent = ''
    data.runs.slice().reverse().forEach(function (r) {
      body.appendChild(el('tr', {}, [el('td', { text: when(r.at) }), el('td', { text: (r.ok ? '' : 'Problem: ') + (r.summary || '') })]))
    })
    $('log').textContent = data.log.map(function (l) { return when(l.at) + '  ' + l.line }).reverse().join('\n') || 'Nothing yet.'
    $('app').hidden = false
  }

  function load() {
    $('status').textContent = 'Loading…'
    return api('GET', '').then(function (d) {
      data = d
      store(token)
      $('status').textContent = 'Updated ' + new Date().toLocaleTimeString()
      render()
    }, function (e) { $('status').textContent = e.message })
  }

  // ---- events ----------------------------------------------------------------

  var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  if (!secure) {
    $('token').disabled = true
    $('status').textContent = 'This page isn’t on HTTPS, so it won’t take your token. Open https://' + location.host + '/admin/social/ instead.'
  }

  // Back from a platform's sign-in page.
  var q = new URLSearchParams(location.search)
  if (q.get('platform')) {
    var p = NAMES[q.get('platform')] || q.get('platform')
    if (q.get('connected')) banner(p + ' connected' + (q.get('connected') !== 'yes' ? ' as ' + q.get('connected') : '') + '.', true)
    else if (q.get('error')) banner(p + ': ' + q.get('error'))
    history.replaceState(null, '', location.pathname)
  }

  $('signin').addEventListener('submit', function (e) {
    e.preventDefault()
    var t = $('token').value.trim()
    $('token').value = ''
    if (t && secure) { token = t; load() }
  })
  $('forget').addEventListener('click', function () {
    store('')
    token = ''
    data = null
    $('app').hidden = true
    $('status').textContent = 'Token forgotten.'
  })
  $('toggle').addEventListener('click', function () {
    var pause = !data.control.paused
    if (pause && !confirm('Pause everything? Nothing is written or posted until you resume.')) return
    api('POST', pause ? '/pause' : '/resume').then(load, function (e) { banner(e.message) })
  })
  $('refresh').addEventListener('click', load)
  $('save-settings').addEventListener('click', saveSettings)
  $('save-facts').addEventListener('click', function () {
    $('facts-status').textContent = 'Saving…'
    api('PUT', '/facts', { text: $('facts').value }).then(function () { $('facts-status').textContent = 'Saved.' }, function (e) { $('facts-status').textContent = e.message })
  })

  var existing = secure ? stored() : ''
  if (existing) { token = existing; load() }
})()
