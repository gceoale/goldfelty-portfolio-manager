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
})()
