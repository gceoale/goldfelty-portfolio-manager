'use strict';
(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || sessionStorage.getItem('gs-token') || '';
  if (token) {
    try { sessionStorage.setItem('gs-token', token); } catch { /* private mode */ }
    history.replaceState(null, '', '/');
  }

  const TABS = [
    ['review', 'To review', ['draft']],
    ['approved', 'Approved', ['approved', 'posting']],
    ['manual', 'Yours to do', ['manual']],
    ['posted', 'Posted', ['posted', 'done']],
    ['failed', 'Failed', ['failed']],
    ['rejected', 'Rejected', ['rejected']],
  ];
  const NAMES = { x: 'X', reddit: 'Reddit', youtube: 'YouTube' };
  const KINDS = { post: 'Post', thread: 'Thread', self: 'Text post', video: 'Video', script: 'Video script' };
  let tab = 'review';
  let state = null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) n.append(kid);
    return n;
  };

  // Same counting as X: links are 23, most non-Latin characters and emoji 2.
  const URL_RE = /(?:https?:\/\/[^\s]+)|(?:\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|app|dev|xyz|co|ai|gg)(?:\/[^\s]*)?)/gi;
  const LIGHT = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  function xLength(text) {
    let n = 0;
    const rest = String(text).normalize('NFC').replace(URL_RE, () => { n += 23; return ''; });
    for (const { segment } of seg.segment(rest)) {
      if (/\p{Extended_Pictographic}/u.test(segment)) { n += 2; continue; }
      for (const ch of segment) {
        const cp = ch.codePointAt(0);
        n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2;
      }
    }
    return n;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'X-Token': token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (json.state) state = json.state;
    if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
    return json;
  }

  async function act(id, action, body = {}) {
    try {
      const out = await api(`/api/items/${id}/${action}`, body);
      state = out;
      render();
      return true;
    } catch (err) {
      toast(err.message);
      render();
      return false;
    }
  }

  function textField(label, value, { rows = 3, max, onInput } = {}) {
    const area = el('textarea', { rows: String(rows) });
    area.value = value || '';
    const counter = max ? el('div', { class: 'counter' }) : null;
    const update = () => {
      if (counter) {
        const n = xLength(area.value);
        counter.textContent = `${n} / ${max}`;
        counter.classList.toggle('over', n > max);
      }
      onInput?.();
    };
    area.addEventListener('input', update);
    update();
    return { node: el('div', { class: 'field' }, el('label', { text: label }), area, counter), area };
  }

  function card(item) {
    const editable = ['draft', 'approved', 'failed', 'manual'].includes(item.status);
    const c = item.content;
    const fields = [];
    const body = el('div');
    const getContent = {};

    if (item.kind === 'post') {
      const f = textField('Post', c.text, { max: state.xMax });
      fields.push(f.area);
      getContent.text = () => f.area.value;
      body.append(f.node);
      if (editable && item.alternatives?.length) {
        const alts = el('div', { class: 'alts' }, el('label', { text: 'Other openings' }));
        item.alternatives.forEach((alt, index) => {
          alts.append(el('div', { class: 'alt' },
            el('p', { text: alt }),
            el('button', { text: 'Use this', onclick: () => act(item.id, 'alt', { index }) })));
        });
        body.append(alts);
      }
    } else if (item.kind === 'thread') {
      const areas = c.tweets.map((t, i) => {
        const f = textField(`Post ${i + 1} of ${c.tweets.length}`, t, { max: state.xMax });
        body.append(f.node);
        fields.push(f.area);
        return f.area;
      });
      getContent.tweets = () => areas.map((a) => a.value);
    } else if (item.kind === 'self') {
      const sub = textField('Where (your profile is u_yourname)', c.subreddit, { rows: 1 });
      const title = textField('Title', c.title, { rows: 2 });
      const text = textField('Body (Markdown)', c.body, { rows: 10 });
      body.append(sub.node, title.node, text.node);
      fields.push(sub.area, title.area, text.area);
      getContent.subreddit = () => sub.area.value;
      getContent.title = () => title.area.value;
      getContent.body = () => text.area.value;
    } else if (item.kind === 'video') {
      body.append(el('div', { class: 'readonly', text: c.file }));
      const title = textField('Title', c.title, { rows: 1 });
      const desc = textField('Description', c.description, { rows: 4 });
      const privacy = el('select');
      for (const p of ['public', 'unlisted', 'private']) {
        const o = el('option', { value: p, text: p });
        if (p === c.privacyStatus) o.selected = true;
        privacy.append(o);
      }
      body.append(title.node, desc.node, el('div', { class: 'field' }, el('label', { text: 'Visibility' }), privacy));
      fields.push(title.area, desc.area, privacy);
      getContent.title = () => title.area.value;
      getContent.description = () => desc.area.value;
      getContent.privacyStatus = () => privacy.value;
    } else if (item.kind === 'script') {
      const title = textField('YouTube title', c.title, { rows: 1 });
      const script = textField('Script (what’s on screen is in [brackets])', c.script, { rows: 10 });
      const desc = textField('YouTube description', c.description, { rows: 3 });
      body.append(title.node, script.node, desc.node);
      fields.push(title.area, script.area, desc.area);
      getContent.title = () => title.area.value;
      getContent.script = () => script.area.value;
      getContent.description = () => desc.area.value;
    }

    const imgs = c.images || [];
    if (item.platform === 'x' && (imgs.length || editable)) {
      body.append(el('p', { class: 'basis', text: imgs.length
        ? `Images: ${imgs.map((p) => p.split(/[\\/]/).pop()).join(', ')}`
        : `No image. Posts with a screenshot get noticed more: goldfelty-social attach ${item.id} screenshot.png` }));
    }
    if (item.metrics) {
      const m = item.metrics;
      body.append(el('p', { class: 'numbers', text:
        `${m.likes} likes · ${m.reposts} reposts · ${m.replies} replies${m.views ? ` · ${m.views} views` : ''}` }));
    }

    const original = JSON.stringify(c);
    const collect = () => Object.fromEntries(Object.entries(getContent).map(([k, f]) => [k, f()]));
    const changed = () => JSON.stringify({ ...c, ...collect() }) !== original;
    for (const f of fields) f.disabled = !editable;

    const actions = el('div', { class: 'actions' });
    const save = el('button', { text: 'Save edits', onclick: () => act(item.id, 'edit', { content: collect() }) });
    const refreshSave = () => { save.hidden = !(editable && changed()); };
    for (const f of fields) f.addEventListener('input', refreshSave);
    refreshSave();

    const approveLabel = item.kind === 'script' ? 'Keep for recording' : 'Approve';
    const approve = async () => {
      if (changed() && !(await act(item.id, 'edit', { content: collect() }))) return;
      act(item.id, 'approve');
    };
    const copy = () => {
      navigator.clipboard.writeText(Object.values(collect()).flat().join('\n\n')).then(
        () => toast('Copied.'),
        () => toast('Couldn’t copy; select the text instead.'),
      );
    };

    if (item.status === 'draft') {
      actions.append(el('button', { class: 'primary', text: approveLabel, onclick: approve }), save,
        el('button', { class: 'danger', text: 'Reject', onclick: () => act(item.id, 'reject') }));
    } else if (item.status === 'approved') {
      if (state.live) actions.append(el('button', { text: 'Post now', onclick: () => act(item.id, 'post') }));
      actions.append(save, el('button', { class: 'danger', text: 'Reject', onclick: () => act(item.id, 'reject') }));
    } else if (item.status === 'failed') {
      actions.append(el('button', { class: 'primary', text: 'Try again', onclick: approve }), save,
        el('button', { class: 'danger', text: 'Reject', onclick: () => act(item.id, 'reject') }));
    } else if (item.status === 'manual') {
      actions.append(el('button', { text: 'Copy', onclick: copy }),
        el('button', { class: 'primary', text: 'Mark done', onclick: () => {
          const url = prompt('Link to it, if you have one (optional):', '') ?? null;
          if (url !== null) act(item.id, 'done', { url });
        } }), save,
        el('button', { class: 'danger', text: 'Reject', onclick: () => act(item.id, 'reject') }));
    } else if (item.status === 'rejected') {
      actions.append(el('button', { text: 'Back to review', onclick: () => act(item.id, 'restore') }));
    }

    const when = new Date(item.postedAt || item.updatedAt || item.createdAt).toLocaleString();
    const meta = el('div', { class: 'meta' },
      el('span', { class: 'tag', text: NAMES[item.platform] }),
      el('span', { text: KINDS[item.kind] }),
      el('span', { text: `· ${when}` }),
      el('span', { text: `· ${item.id}` }));
    if (item.result?.url) {
      meta.append(el('a', { href: item.result.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open' }));
    }
    return el('article', { class: 'card' }, meta, body,
      item.basis ? el('p', { class: 'basis', text: `Based on: ${item.basis}` }) : null,
      item.note ? el('p', { class: 'note', text: item.note }) : null,
      item.error ? el('p', { class: 'error', text: item.error }) : null,
      actions.childNodes.length ? actions : null);
  }

  function render() {
    if (!state) return;
    const mode = $('mode');
    const ap = state.autopilot || {};
    mode.textContent = ap.paused
      ? 'Paused: nothing is written or posted'
      : state.auto
        ? (state.live ? 'Autopilot: writing, checking and posting by itself' : 'Autopilot dry run: nothing is posted')
        : (state.live ? 'Live: approved posts go out' : 'Dry run: nothing is posted');
    mode.classList.toggle('live', state.live && !ap.paused);
    const pause = $('pause');
    pause.textContent = ap.paused ? 'Resume' : 'Pause';
    pause.onclick = async () => {
      try { state = await api(ap.paused ? '/api/resume' : '/api/pause', {}); render(); } catch (err) { toast(err.message); }
    };
    const apErr = $('aperror');
    apErr.hidden = !ap.lastError;
    apErr.textContent = ap.lastError ? `Autopilot problem (${new Date(ap.lastErrorAt).toLocaleString()}): ${ap.lastError}` : '';

    const status = $('status');
    status.replaceChildren(...['x', 'reddit', 'youtube'].map((p) => {
      const conn = state.summary.connections[p];
      const lim = state.limits[p];
      const lines = [
        el('h3', { text: NAMES[p] }),
        el('p', { class: conn.connected ? 'on' : 'off', text: conn.connected ? `Connected as ${conn.username || '…'}` : `Not connected: goldfelty-social connect ${p}` }),
      ];
      lines.push(el('p', { text: `Today: ${state.summary.postedToday[p]} of ${lim.dailyCap}${p === 'x' ? `, at most ${lim.threadsPerDay} thread` : ''}` }));
      lines.push(el('p', { text: `Windows: ${lim.windows.join(', ')}` }));
      return el('div', { class: 'acct' }, ...lines);
    }));

    const tabs = $('tabs');
    tabs.replaceChildren(...TABS.map(([key, label, statuses]) => {
      const n = state.items.filter((i) => statuses.includes(i.status)).length;
      return el('button', { class: key === tab ? 'active' : '', onclick: () => { tab = key; render(); } },
        label, el('span', { class: 'count', text: String(n) }));
    }));

    const statuses = TABS.find(([k]) => k === tab)[2];
    const items = state.items.filter((i) => statuses.includes(i.status));
    const extra = [];
    if (tab === 'posted') {
      const rows = ['x', 'reddit', 'youtube'].flatMap((p) => state.byWindow[p]
        .filter((w) => w.posts)
        .map((w) => `${NAMES[p]} ${w.window}: ${w.average} average from ${w.posts} post${w.posts === 1 ? '' : 's'}`));
      extra.push(el('div', { class: 'card insights' },
        el('div', { class: 'meta' }, el('span', { class: 'tag', text: 'How posts are doing' })),
        el('p', { class: 'basis', text: rows.length
          ? `Score by posting window (likes + 3×reposts + 2×replies): ${rows.join(' · ')}`
          : 'Numbers appear here once posts have been out a few hours. The next batch of drafts learns from the best and weakest.' }),
        el('div', { class: 'actions' }, el('button', { text: 'Refresh numbers', onclick: async () => {
          try { state = await api('/api/metrics', {}); render(); toast('Numbers updated.'); } catch (err) { toast(err.message); render(); }
        } }))));
    }
    $('list').replaceChildren(...extra, ...items.map(card));
    const empty = $('empty');
    empty.hidden = items.length > 0;
    empty.textContent = tab === 'review' ? 'Nothing to review. Write new drafts above.' : 'Nothing here.';
  }

  $('gen').addEventListener('click', async () => {
    const btn = $('gen');
    btn.disabled = true;
    btn.textContent = 'Writing… (about a minute)';
    try {
      const out = await api('/api/generate', { focus: $('focus').value });
      tab = 'review';
      render();
      toast(`${out.added} new drafts.${out.dropped.length ? ` ${out.dropped.length} left out: ${out.dropped.join('; ')}` : ''}`);
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Write new drafts';
    }
  });

  async function load() {
    try {
      state = await api('/api/state');
      render();
    } catch (err) {
      toast(err.message);
    }
  }
  load();
  // Pick up posts the scheduler sent, without disturbing edits in progress.
  setInterval(() => {
    if (!document.querySelector('textarea:focus')) load();
  }, 30000);
})();
