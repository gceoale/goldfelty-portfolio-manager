// Point the main button at the right installer, and show the current fee.
(function () {
  'use strict'
  var REPO = 'gceoalexyt-ops/goldfelty-portfolio-manager'
  var note = document.getElementById('platform-note')
  var primary = document.getElementById('primary')

  function guess() {
    var ua = navigator.userAgent
    var plat = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || ''
    var arm = /arm|aarch64/i.test(ua) || /arm/i.test(plat)
    if (/Mac|Darwin/i.test(plat) || /Mac OS X/i.test(ua)) return { os: 'mac', arm: arm }
    if (/Win/i.test(plat) || /Windows/i.test(ua)) return { os: 'win', arm: arm }
    if (/Linux|X11/i.test(plat) || /Linux/i.test(ua)) return { os: 'linux', arm: arm }
    return null
  }

  function pick(assets, g) {
    var want
    if (g.os === 'mac') want = g.arm ? /-arm64\.dmg$/ : /-x64\.dmg$/
    else if (g.os === 'win') want = g.arm ? /-arm64-setup\.exe$/ : /-x64-setup\.exe$/
    else want = g.arm ? /-arm64\.AppImage$/ : /-x86_64\.AppImage$/
    for (var i = 0; i < assets.length; i++) if (want.test(assets[i].name)) return assets[i]
    return null
  }

  function setNote(parts) {
    note.textContent = ''
    parts.forEach(function (p) {
      if (typeof p === 'string') note.appendChild(document.createTextNode(p))
      else {
        var a = document.createElement('a')
        a.href = p.href
        a.textContent = p.text
        note.appendChild(a)
      }
    })
  }

  var g = guess()
  if (primary && note) {
    fetch('https://api.github.com/repos/' + REPO + '/releases/latest')
      .then(function (r) { return r.json() })
      .then(function (rel) {
        if (!rel || !rel.assets) return
        var label = { mac: 'macOS', win: 'Windows', linux: 'Linux' }
        var asset = g && pick(rel.assets, g)
        if (asset) {
          primary.href = asset.browser_download_url
          primary.textContent = 'Download for ' + label[g.os] + (g.arm ? ' (ARM)' : '')
          setNote([String(rel.tag_name) + ', ' + Math.round(asset.size / 1048576) + ' MB. ', { href: rel.html_url, text: 'Other platforms' }])
        } else {
          setNote([String(rel.tag_name) + '. ', { href: rel.html_url, text: 'Choose a build' }])
        }
      })
      .catch(function () {})
  }

})()
