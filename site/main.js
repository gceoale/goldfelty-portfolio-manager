// Point the download buttons at the right files in the latest release.
(function () {
  'use strict'
  var REPO = 'gceoale/goldfelty-portfolio-manager'
  var primaries = document.querySelectorAll('[data-primary]')
  var specific = document.querySelectorAll('[data-asset]')
  var note = document.querySelector('[data-platform-note]')

  function guess() {
    var ua = navigator.userAgent
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
    var arm = /arm|aarch64/i.test(ua) || /arm/i.test(plat)
    if (/Mac|Darwin/i.test(plat) || /Mac OS X/i.test(ua)) return { os: 'mac', arm: arm }
    if (/Win/i.test(plat) || /Windows/i.test(ua)) return { os: 'win', arm: arm }
    if (/Linux|X11/i.test(plat) || /Linux/i.test(ua)) return { os: 'linux', arm: arm }
    return null
  }

  function find(assets, pattern) {
    for (var i = 0; i < assets.length; i++) if (pattern.test(assets[i].name)) return assets[i]
    return null
  }

  function pick(assets, g) {
    if (g.os === 'mac') return find(assets, g.arm ? /-arm64\.dmg$/ : /-x64\.dmg$/) || find(assets, /-arm64\.dmg$/)
    if (g.os === 'win') return find(assets, g.arm ? /-arm64-setup\.exe$/ : /-x64-setup\.exe$/)
    return find(assets, g.arm ? /-arm64\.AppImage$/ : /-x86_64\.AppImage$/)
  }

  var g = guess()
  var label = { mac: 'macOS', win: 'Windows', linux: 'Linux' }
  // Before the release is known, still say which platform the button is for.
  if (g) primaries.forEach(function (a) { a.textContent = 'Download for ' + label[g.os] })

  fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
    .then(function (r) { return r.json() })
    .then(function (rel) {
      if (!rel || !Array.isArray(rel.assets)) return
      specific.forEach(function (a) {
        var asset = find(rel.assets, new RegExp(a.getAttribute('data-asset')))
        if (asset) a.href = asset.browser_download_url
      })
      var asset = g && pick(rel.assets, g)
      if (asset) {
        primaries.forEach(function (a) { a.href = asset.browser_download_url })
        if (note) note.textContent = 'Free · ' + String(rel.tag_name) + ' for ' + label[g.os] + (g.arm ? ' (ARM)' : '') + ' · ' + Math.round(asset.size / 1048576) + ' MB'
      }
    })
    .catch(function () {})

  // Mac builds aren't signed by Apple yet, so macOS stops them on first launch.
  // Show how to open one, but only once someone actually downloads it.
  var MAC_CMD = 'xattr -dr com.apple.quarantine "/Applications/Goldfelty Portfolio Manager.app"'
  var dialog = null

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text) node.textContent = text
    return node
  }

  function buildDialog() {
    var d = el('dialog', 'mac-help')
    d.setAttribute('aria-labelledby', 'mac-help-title')
    var title = el('h2', null, 'Opening Goldfelty on a Mac')
    title.id = 'mac-help-title'
    d.appendChild(title)
    d.appendChild(el('p', 'muted', 'Your download has started. Goldfelty isn’t signed by Apple yet, so macOS will stop it the first time you open it.'))

    var steps = el('ol')
    steps.appendChild(el('li', null, 'Open the .dmg and drag Goldfelty into Applications.'))
    steps.appendChild(el('li', null, 'Open Goldfelty. If macOS says it can’t check the app, go to System Settings, then Privacy & Security, and click Open Anyway.'))
    var last = el('li', null, 'If macOS says the app “is damaged”, open Terminal and run this. It removes the flag macOS adds to downloaded apps, and doesn’t change the app itself.')
    var row = el('div', 'cmd')
    row.appendChild(el('code', null, MAC_CMD))
    var copy = el('button', 'btn small ghost', 'Copy')
    copy.type = 'button'
    copy.addEventListener('click', function () {
      if (!navigator.clipboard) return
      navigator.clipboard.writeText(MAC_CMD).then(function () {
        copy.textContent = 'Copied'
        setTimeout(function () { copy.textContent = 'Copy' }, 1500)
      }, function () {})
    })
    row.appendChild(copy)
    last.appendChild(row)
    steps.appendChild(last)
    d.appendChild(steps)

    var foot = el('div', 'foot')
    var more = el('a', null, 'How to check a download first')
    more.href = '/security/'
    foot.appendChild(more)
    var done = el('button', 'btn small', 'Done')
    done.type = 'button'
    done.addEventListener('click', function () { d.close() })
    foot.appendChild(done)
    d.appendChild(foot)

    // A click on the backdrop lands on the dialog itself.
    d.addEventListener('click', function (e) { if (e.target === d) d.close() })
    document.body.appendChild(d)
    return d
  }

  function isMacDownload(a) {
    var asset = a.getAttribute('data-asset') || ''
    if (/dmg/.test(asset)) return true
    return a.hasAttribute('data-primary') && !!g && g.os === 'mac'
  }

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[data-asset], a[data-primary]')
    if (!a || !isMacDownload(a)) return
    // Only when the link starts a download; if it opens the releases page instead, the visitor leaves anyway.
    if (!/\/releases\/download\//.test(a.href)) return
    if (typeof HTMLDialogElement !== 'function') return
    if (!dialog) dialog = buildDialog()
    if (!dialog.open) dialog.showModal()
  })
})()
