const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  limits: new Map(), issues: new Map(), filter: 'all', group: 'file', open: new Set(), seen: new Set(),
  shots: [], transcripts: [], runId: null, es: null, round: 0,
  baseline: null, scoreNow: null, pages: new Map(), totalPages: 0,
  stage: -1, touched: new Set(), todo: 0, t0: 0, clock: 0, status: 'idle', lastPhase: '',
  cfg: { gemini: { on: false }, github: { on: false } }, draft: new Map(), q: '',
  pr: { title: '', body: '', branch: '', repo: '', needsRepo: false, changes: 0 },
  prDirty: new Set(), review: null, prUrl: null, site: null,
  baMode: 'slide', baIdx: 0, swept: false, blinkTimer: 0, srMode: 'changes', srFold: new Set(), speaking: false,
};

const STAGES = ['setup', 'scan', 'fix', 'retest', 'review', 'pr'];
const STAGE_OF = { prepare: 'setup', crawl: 'scan', classify: 'scan', fix: 'fix', apply: 'fix', retest: 'retest', review: 'review', rebuild: 'retest', pr: 'pr' };
const NOW = {
  setup: ['Setting up the workspace', 'Cloning or copying the project'],
  scan: ['Scanning', 'Rendering pages with axe-core and reading source files'],
  fix: ['Fixing issues', 'Gemini and rule-based fixers each plan a minimal edit'],
  retest: ['Proving the fixes', 'A fresh scan checks each fix; regressions are rolled back'],
  review: ['Ready for your review', 'Edit or exclude any fix, then raise the pull request'],
  pr: ['Raising the pull request', 'Committing, pushing and opening it on GitHub'],
};
const METHOD = { deterministic: 'Rule-based', vision: 'Gemini vision', llm: 'Gemini', heuristic: 'Heuristic', human: 'Edited by you' };

function setStatus(s) { state.status = s; document.body.dataset.state = s; }

// ---------- tabs ----------
const tabs = $$('[role=tab]');
function selectTab(t) {
  for (const b of tabs) {
    const on = b === t;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
    $('#' + b.getAttribute('aria-controls')).hidden = !on;
  }
  if (t.id === 'tab-shots') { layoutCompare(); if (!state.swept && state.shots.length && state.status !== 'running') { state.swept = true; setTimeout(sweep, 350); } }
  if (t.id === 'tab-feed') { const l = $('#log'); l.scrollTop = l.scrollHeight; }
}
const goTab = (id) => selectTab($('#tab-' + id));
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (n == null) return;
    e.preventDefault();
    const nt = tabs[(n + tabs.length) % tabs.length];
    nt.focus(); selectTab(nt);
  });
});

// ---------- connections ----------
function paintConn() {
  const { gemini, github } = state.cfg;
  const g = $('#connGemini'), h = $('#connGithub');
  g.className = 'conn ' + (gemini.on ? 'on' : 'off');
  $('span', g).textContent = gemini.on ? `Gemini · ${gemini.model ?? 'connected'}` : 'Connect Gemini';
  g.title = gemini.on ? 'Gemini writes alt text, names and titles; heuristics are the fallback.' : 'Without a key only heuristics are used.';
  h.className = 'conn ' + (github.on ? 'on' : 'off');
  $('span', h).textContent = github.on ? `GitHub${github.login ? ' · @' + github.login : ''}` : 'Connect GitHub';
  h.title = github.on ? 'Ready to raise pull requests.' : 'Add a token to raise pull requests.';
  $('#sGemini').textContent = gemini.on ? 'connected' : 'not set'; $('#sGemini').className = 'pillstat ' + (gemini.on ? 'ok' : '');
  $('#sGithub').textContent = github.on ? `connected${github.login ? ' as @' + github.login : ''}` : 'not set'; $('#sGithub').className = 'pillstat ' + (github.on ? 'ok' : '');
  paintPr();
}
const loadConfig = () => fetch('/api/config').then((r) => r.json()).then((c) => { state.cfg = c; paintConn(); }).catch(() => { $('#connGemini span').textContent = 'Server unreachable'; });
loadConfig();

const dlg = $('#settings');
$$('[data-open-settings]').forEach((b) => b.addEventListener('click', () => { $('#setErr').hidden = true; dlg.showModal(); $(state.cfg.gemini.on ? '#kGithub' : '#kGemini').focus(); }));
const closeSettings = () => dlg.close();
$('#setClose').addEventListener('click', closeSettings); $('#setCancel').addEventListener('click', closeSettings);
$('#setForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const geminiKey = $('#kGemini').value.trim(), githubToken = $('#kGithub').value.trim();
  if (!geminiKey && !githubToken) return closeSettings();
  const btn = $('#setSave'); btn.disabled = true; btn.textContent = 'Verifying…'; $('#setErr').hidden = true;
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ geminiKey, githubToken }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    state.cfg = j; paintConn(); $('#kGemini').value = $('#kGithub').value = '';
    closeSettings(); toast('Connections saved and verified.');
  } catch (err) { $('#setErr').textContent = err.message; $('#setErr').hidden = false; }
  btn.disabled = false; btn.textContent = 'Save & verify';
});

// ---------- run ----------
async function start(demo) {
  const target = $('#target').value.trim();
  hideErr();
  if (!demo && !target) return showErr('Enter a website URL, a GitHub repo or a folder path, or try the demo site.');
  reset();
  $('#hero').hidden = true; $('#app').hidden = false; $('#newRun').hidden = false;
  const chip = $('#targetChip'); chip.hidden = false; chip.textContent = demo ? 'demo site' : target.replace(/^https?:\/\/(github\.com\/)?/, '').replace(/\/$/, '');
  setBusy(true); setStatus('running');
  startClock();
  setNow('Connecting to the agent…', 'Starting a new run');
  try {
    const r = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ demo, target }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    state.runId = j.id;
    const es = new EventSource(`/api/run/${j.id}/events`);
    state.es = es;
    es.onmessage = (m) => handle(JSON.parse(m.data));
    // EventSource reconnects by itself and resumes from the last event id; only give up if it is closed for good
    es.onerror = () => { if (es.readyState === EventSource.CLOSED && state.status === 'running') fail('Lost connection to the server.'); };
  } catch (e) { stopClock(); setBusy(false); setStatus('idle'); $('#hero').hidden = false; $('#app').hidden = true; $('#newRun').hidden = true; $('#targetChip').hidden = true; showErr(e.message); }
}
$('#runDemo').addEventListener('click', () => start(true));
$('#runbar').addEventListener('submit', (e) => { e.preventDefault(); start(false); });
$('#newRun').addEventListener('click', () => location.reload());
function setBusy(b) { $('#runDemo').disabled = $('#runOwn').disabled = b; }
function showErr(m) { const e = $('#err'); e.textContent = m; e.hidden = false; }
function hideErr() { $('#err').hidden = true; }
function toast(msg, label, fn) {
  const t = $('#toast'); t.innerHTML = ''; t.hidden = false;
  t.append(el('span', '', msg));
  if (label) { const b = el('button', '', label); b.onclick = () => { t.hidden = true; fn(); }; t.append(b); }
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000);
}

function reset() {
  state.es?.close(); clearInterval(state.blinkTimer); stopHear();
  Object.assign(state, { round: 0, baseline: null, scoreNow: null, stage: -1, touched: new Set(), todo: 0, shots: [], transcripts: [], lastPhase: '', totalPages: 0, prDirty: new Set(), review: null, prUrl: null, site: null, swept: false, baIdx: 0, pr: { title: '', body: '', branch: '', repo: '', needsRepo: false, changes: 0 } });
  state.issues.clear(); state.pages.clear(); state.open.clear(); state.seen.clear(); state.draft.clear(); state.srFold.clear(); state.limits.clear(); state.q = ''; $('#q').value = '';
  $('#log').innerHTML = '';
  $$('#steps li').forEach((l) => l.className = '');
  $('#roundChip').hidden = true;
  setBar(0);
  setScore(null); $('#scoreLine').textContent = 'Scanning…';
  renderTiles(); renderIssuesNow(); renderBars();
  $('#liveImg').hidden = true; $('#liveName').textContent = 'waiting for first page'; $('#liveMsg').textContent = 'Starting up…';
  $('#liveSpin').hidden = false; $('#liveShot').classList.remove('scanning'); $('#liveShot .ph').hidden = false;
  ['Shots', 'Diff', 'Sr', 'Pr'].forEach((k) => $('#r' + k).hidden = true);
  $('#baStage').hidden = true; $('#baStatic').hidden = true; $('#baList').innerHTML = ''; $('#shotEmpty').hidden = false;
  $('#diff').hidden = true; $('#diffEmpty').hidden = false; $('#dl').hidden = true; $('#diffMeta').textContent = '';
  $('#srOut').hidden = true; $('#srEmpty').hidden = false;
  $('#prForm').hidden = true; $('#shipForm').hidden = true; $('#prEmpty').hidden = false; $('#prDone').hidden = true; $('#prErr').hidden = true;
  paintMode();
  $('#reviewbar').hidden = true; $('#editHint').hidden = true;
  $('#doneIcon').hidden = true; $('#spin').hidden = false; $('#toast').hidden = true;
  goTab('overview');
}

function fail(msg) {
  stopClock(); setBusy(false); setStatus('error');
  $('#spin').hidden = true; $('#liveSpin').hidden = true; $('#liveShot').classList.remove('scanning');
  setNow('Run failed', msg);
  $('#scoreLine').textContent = 'Run failed.';
  addEv('warn', esc(msg));
  toast(msg);
  state.es?.close();
}

// ---------- clock + progress ----------
function startClock() {
  stopClock(); state.t0 = Date.now();
  const tick = () => { $('#clock').textContent = fmt(Date.now() - state.t0); };
  tick(); state.clock = setInterval(tick, 500);
}
function stopClock() { clearInterval(state.clock); }
function fmt(ms) { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function setNow(title, sub) { $('#nowTitle').textContent = title; if (sub != null) $('#nowSub').textContent = sub; }
function setBar(p) {
  p = Math.max(0, Math.min(100, Math.round(p)));
  $('#barFill').style.width = p + '%';
  $('.bar').setAttribute('aria-valuenow', p);
}
function updateBar() {
  if (state.stage < 0) return;
  let frac = 0.15;
  if (state.stage === 1 && state.totalPages) frac = Math.min(1, state.pages.size / state.totalPages);
  else if ((state.stage === 2 || state.stage === 3) && state.todo) frac = Math.min(1, state.touched.size / state.todo);
  setBar(((state.stage + frac) / STAGES.length) * 100);
}

// ---------- events ----------
function handle(ev) {
  switch (ev.type) {
    case 'start': addEv('', `Run started on <code>${esc(ev.target.split('/').slice(-2).join('/'))}</code>`, true); break;
    case 'phase': onPhase(ev); break;
    case 'round':
      state.round = ev.round; state.todo = ev.todo; state.touched = new Set();
      $('#roundChip').hidden = false; $('#roundChip').textContent = `Round ${ev.round} of up to 3`;
      addEv('', `Round ${ev.round}: <b>${ev.todo}</b> issue${ev.todo === 1 ? '' : 's'} to fix`, true);
      break;
    case 'log': onLog(ev); break;
    case 'scan': onScan(ev); break;
    case 'score': onScore(ev); break;
    case 'issue': upsertIssue(ev.issue); break;
    case 'diff': renderDiff(ev); break;
    case 'transcript': state.transcripts = ev.pages; renderTranscript(); $('#rSr').hidden = !ev.pages.length; break;
    case 'shots': state.shots = ev.pages; renderShots(); $('#rShots').hidden = false; break;
    case 'draft': onDraft(ev); break;
    case 'review': onReview(ev); break;
    case 'pr': onPr(ev); break;
    case 'expired': state.es?.close(); setStatus('error'); paintReview(); toast('This session timed out. Start a new run to keep editing.'); break;
    case 'error': fail(ev.message); break;
  }
}

function onPhase(ev) {
  const key = STAGE_OF[ev.phase];
  const idx = STAGES.indexOf(key);
  if (ev.phase === 'rebuild' || ev.phase === 'pr') { $('#spin').hidden = false; $('#doneIcon').hidden = true; setStatus('running'); paintReview(); }
  if (idx !== state.stage) state.touched = new Set();
  state.stage = idx;
  $$('#steps li').forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'active' : ''; });
  const [t, s] = NOW[key];
  const title = ev.phase === 'apply' ? 'Applying edits to your source'
    : ev.phase === 'rebuild' ? 'Re-applying your changes'
    : ev.phase === 'retest' && state.review ? 'Re-scanning with your changes'
    : ev.phase === 'classify' ? 'Sorting issues'
    : (ev.phase === 'fix' || ev.phase === 'retest') && ev.round ? `Round ${ev.round}: ${t.toLowerCase()}` : t;
  setNow(title, ev.phase === 'classify' ? 'Deciding what is safe to auto-fix and what needs a human' : s);
  const scanning = (key === 'scan' && ev.phase === 'crawl') || key === 'retest';
  $('#liveShot').classList.toggle('scanning', scanning);
  if (key === 'scan' && $('#liveImg').hidden) $('#liveMsg').textContent = 'Launching the scanner…';
  if (ev.label !== state.lastPhase) { state.lastPhase = ev.label; addPhase(ev.label, idx + 1); }
  updateBar();
}

function onLog(ev) {
  const m = ev.msg;
  const w = m.match(/Workspace ready: (\d+) rendered page.* (\d+) source/);
  if (w) state.totalPages = +w[1] + +w[2];
  const low = /planning fix|verified gone/.test(m);
  if (/verified gone/.test(m)) bumpVerified();
  const kind = ev.level === 'warn' ? 'warn' : ev.level === 'ok' ? 'ok' : /^\[i\d+\] (deterministic|vision|llm|heuristic):/.test(m) ? 'fix' : '';
  addEv(kind, esc(m).replace(/^\[(i\d+)\]/, '<code>$1</code>'), false, low);
  if (!low && !/^Round \d+ done/.test(m)) $('#nowSub').textContent = m.length > 110 ? m.slice(0, 108) + '…' : m;
}

function onScan(ev) {
  state.pages.set(ev.file, { ...(state.pages.get(ev.file) ?? { first: ev.score }), now: ev.score, issues: ev.violations, static: ev.static });
  addEv('', `Scanned <code>${esc(ev.file)}</code>: ${ev.violations} issue${ev.violations === 1 ? '' : 's'}, score <b>${ev.score}</b>${ev.static ? ' (source)' : ''}`);
  if (!ev.static && ev.shot) {
    const img = $('#liveImg');
    img.onload = () => { img.hidden = false; $('#liveShot .ph').hidden = true; };
    img.src = `/runs/${state.runId}/artifacts/${ev.shot}?t=${Date.now()}`;
    $('#liveName').textContent = ev.file + (ev.round ? ` · ${ev.label ?? 'after round ' + ev.round}` : ' · baseline');
  }
  renderBars(); updateBar();
}

// ---------- activity feed ----------
function addPhase(label, n) {
  const p = el('div', 'phase'); p.append(el('i', '', String(n)), document.createTextNode(label));
  appendFeed(p);
}
function bumpVerified() {
  const v = state.vline;
  if (v && v.isConnected && v.dataset.round === String(state.round)) { v.n++; $('.tx', v).innerHTML = `<b>${v.n}</b> fixes verified by re-scan`; return; }
  addEv('ok', '<b>1</b> fix verified by re-scan');
  state.vline = $('#log').lastElementChild; state.vline.n = 1; state.vline.dataset.round = state.round;
}
function addEv(kind, html, bold, low) {
  const e = el('div', `ev ${kind}${low ? ' low' : ''}`);
  const ic = el('span', 'ic', kind === 'ok' ? '✓' : kind === 'warn' ? '!' : kind === 'fix' ? '✎' : '•');
  const tx = el('div', 'tx'); tx.innerHTML = bold ? `<b>${html}</b>` : html;
  e.append(ic, tx, el('time', '', state.t0 ? fmt(Date.now() - state.t0) : ''));
  appendFeed(e);
}
function appendFeed(node) {
  const l = $('#log');
  l.querySelector('.empty')?.remove();
  const stick = l.scrollTop + l.clientHeight >= l.scrollHeight - 40;
  l.append(node);
  if (stick) l.scrollTop = l.scrollHeight;
}
$('#feedAll').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', on);
  $('#log').classList.toggle('verbose', on);
});

// ---------- score ----------
function setScore(n) {
  const arc = $('#arc');
  $('#scoreNum').textContent = n == null ? '–' : n;
  arc.setAttribute('stroke-dasharray', `${n ?? 0} 100`);
  arc.style.stroke = n == null ? '' : n >= 90 ? 'var(--good)' : n >= 60 ? 'var(--accent)' : 'var(--bad)';
}
function tween(from, to) {
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900);
    setScore(Math.round(from + (to - from) * (1 - (1 - k) ** 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function onScore(ev) {
  if (state.baseline == null) state.baseline = ev.score;
  tween(state.scoreNow ?? 0, ev.score);
  state.scoreNow = ev.score;
  $('#scoreLine').textContent = ev.round === 0 ? `Baseline ${ev.score}/100` : `${state.baseline} → ${ev.score} · ${ev.label.toLowerCase()}`;
  addEv(ev.round ? 'ok' : '', `${esc(ev.label)}: score <b>${ev.score}/100</b>`);
}

// ---------- overview bars ----------
function renderBars() {
  const pb = $('#pageBars'); pb.innerHTML = '';
  if (!state.pages.size) pb.innerHTML = '<li class="empty">Nothing scanned yet.</li>';
  for (const [f, p] of state.pages) {
    const li = el('li'); const changed = p.now !== p.first;
    li.append(el('span', 't', f), el('span', 'v', changed ? `${p.first} → ${p.now}` : `${p.now}`));
    const tr = el('div', 'tr'); const i = el('i', p.now >= 90 ? 'hi' : p.now < 60 ? 'lo' : ''); i.style.width = p.now + '%'; tr.append(i); li.append(tr);
    pb.append(li);
  }
  const by = new Map();
  for (const i of state.issues.values()) { const r = by.get(i.rule) ?? { n: 0, ok: 0 }; r.n++; if (i.status === 'verified') r.ok++; by.set(i.rule, r); }
  const rb = $('#ruleBars'); rb.innerHTML = '';
  if (!by.size) rb.innerHTML = '<li class="empty">Rules show up after the scan.</li>';
  for (const [rule, r] of [...by].sort((a, b) => b[1].n - a[1].n)) {
    const li = el('li'); li.append(el('span', 't', rule), el('span', 'v', `${r.ok}/${r.n} fixed`));
    const tr = el('div', 'tr'); const i = el('i', r.ok === r.n ? 'done' : ''); i.style.width = Math.max(4, (r.ok / r.n) * 100) + '%'; tr.append(i); li.append(tr);
    rb.append(li);
  }
  // who made the fixes
  const mix = new Map();
  for (const i of state.issues.values()) if (i.fix && ['verified', 'applied', 'planned'].includes(i.status)) mix.set(i.fix.method, (mix.get(i.fix.method) ?? 0) + 1);
  const bar = $('#mixBar'), lg = $('#mixLegend'); bar.innerHTML = ''; lg.innerHTML = '';
  if (!mix.size) lg.innerHTML = '<li class="empty">Fixes appear here as the agent works.</li>';
  for (const [m, n] of [...mix].sort((a, b) => b[1] - a[1])) {
    const seg = el('i', `m-${m}`); seg.style.flexGrow = n; bar.append(seg);
    const li = el('li'); li.append(el('span', `dot m-${m}`), el('span', '', METHOD[m] ?? m), el('b', '', n)); lg.append(li);
  }
}

// ---------- issues / changes ----------
const BUCKET = { verified: 'verified', applied: 'open', planned: 'open', found: 'open', manual: 'manual', failed: 'failed', reverted: 'failed', rejected: 'excluded' };
const STATUS_LABEL = { found: 'Found', planned: 'Fix planned', applied: 'Re-testing', verified: 'Verified', manual: 'Needs you', failed: 'Failed', reverted: 'Rolled back', rejected: 'Excluded' };
const TRAIL = ['found', 'planned', 'applied', 'verified'];
const RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const EDITABLE = new Set(['verified', 'failed', 'reverted', 'rejected']);
const canEdit = (i) => state.status === 'review' && !!i.fix && EDITABLE.has(i.status);
const weak = (i) => !!i.fix && i.fix.confidence < 0.6 && i.fix.method !== 'human';

function upsertIssue(i) {
  state.issues.set(i.id, i);
  if (state.stage === 2 || state.stage === 3) state.touched.add(i.id);
  renderTiles(); scheduleRender(); updateBar();
}
function renderTiles() {
  const all = [...state.issues.values()], c = (b) => all.filter((x) => BUCKET[x.status] === b).length;
  $('#tFound').textContent = all.length;
  $('#tFixed').textContent = c('verified');
  $('#tManual').textContent = c('manual');
  $('#tFail').textContent = c('failed');
  $('#fAll').textContent = all.length; $('#fOpen').textContent = c('open'); $('#fVerified').textContent = c('verified');
  $('#fManual').textContent = c('manual'); $('#fFailed').textContent = c('failed'); $('#fExcluded').textContent = c('excluded');
  $('#fCheck').textContent = all.filter(weak).length;
  const ci = $('#cIssues'); ci.hidden = !all.length; ci.textContent = all.length;
}
let timer = 0;
function scheduleRender() { if (timer) return; timer = setTimeout(() => { timer = 0; renderIssuesNow(); renderBars(); paintReview(); }, 140); }

const effRejected = (i) => state.draft.get(i.id)?.rejected ?? i.status === 'rejected';
const effValue = (i) => state.draft.get(i.id)?.value ?? i.fix?.edit?.value ?? '';
function isDirty(i) {
  const d = state.draft.get(i.id); if (!d || !i.fix) return false;
  return (d.rejected !== undefined && d.rejected !== (i.status === 'rejected')) || (d.value !== undefined && d.value.trim() !== (i.fix.edit?.value ?? ''));
}
const dirtyList = () => [...state.issues.values()].filter(isDirty);

function matches(i) {
  if (state.filter === 'check') { if (!weak(i)) return false; }
  else if (state.filter !== 'all' && BUCKET[i.status] !== state.filter) return false;
  if (!state.q) return true;
  return `${i.rule} ${i.file} ${i.help} ${i.fix?.description ?? ''} ${i.html}`.toLowerCase().includes(state.q);
}

function renderIssuesNow() {
  const host = $('#issues');
  const scroll = window.scrollY;
  const list = [...state.issues.values()].filter(matches)
    .sort((a, b) => RANK[a.impact] - RANK[b.impact] || a.rule.localeCompare(b.rule));
  host.innerHTML = '';
  if (!list.length) { host.append(el('p', 'empty', state.issues.size ? 'Nothing in this view.' : state.status === 'running' ? 'Scanning for issues…' : 'No issues yet.')); return; }
  const groups = new Map();
  for (const i of list) { const k = i[state.group]; (groups.get(k) ?? groups.set(k, []).get(k)).push(i); }
  const keys = [...groups.keys()].sort(state.group === 'impact' ? (a, b) => RANK[a] - RANK[b] : undefined);
  let n = 0;
  for (const k of keys) {
    const g = el('section', 'grp');
    const h = el('h4', '', k); h.append(el('small', '', groups.get(k).length));
    const ul = el('ul');
    const all = groups.get(k), cap = state.limits.get(state.group + k) ?? 30;
    for (const i of all.slice(0, cap)) ul.append(issueEl(i, n++));
    g.append(h, ul);
    if (all.length > cap) {
      const more = el('button', 'btn soft sm more', `Show ${Math.min(40, all.length - cap)} more of ${all.length - cap} hidden`);
      more.type = 'button'; more.addEventListener('click', () => { state.limits.set(state.group + k, cap + 40); renderIssuesNow(); });
      g.append(more);
    }
    host.append(g);
  }
  window.scrollTo(0, scroll);
}

// --- the before → after source line ---
function diffMid(b, a) {
  const n = Math.min(b.length, a.length);
  let p = 0; while (p < n && b[p] === a[p]) p++;
  const edge = (c) => c === undefined || /[\s>/]/.test(c);
  if (!edge(b[p]) && !edge(a[p])) while (p > 0 && !/[\s<]/.test(b[p - 1])) p--; // only back up when a token differs mid-way
  let q = 0; while (q < n - p && b[b.length - 1 - q] === a[a.length - 1 - q]) q++;
  while (q > 0 && !/[\s>/]/.test(b[b.length - q])) q--;
  return { pre: b.slice(0, p), bMid: b.slice(p, b.length - q), aMid: a.slice(p, a.length - q), suf: b.slice(b.length - q) };
}
function codeLine(kind, sign, pre, mid, suf) {
  const ln = el('div', `ln ${kind}`); ln.append(el('span', 'sign', sign));
  const t = el('span', 'txt'); t.append(document.createTextNode(pre));
  if (mid) t.append(el('mark', '', mid));
  t.append(document.createTextNode(suf)); ln.append(t);
  return ln;
}
const hexOk = (c) => /^#[0-9a-f]{3,8}$/i.test(c ?? '');
function morphEl(i) {
  const s = i.snippet; if (!s) return null;
  const box = el('div', 'morph');
  const d = diffMid(s.before, s.after);
  box.append(codeLine('b', '−', d.pre, s.before.startsWith('<head>') ? '' : d.bMid, d.suf));
  box.append(codeLine('a', '+', d.pre, d.aMid, d.suf));
  if (s.css) box.append(el('div', 'css', s.css));
  if (s.color && hexOk(s.color.to) && hexOk(s.color.from)) {
    const c = s.color, row = el('div', 'swatches'), isText = c.prop === 'color';
    const mk = (v) => {
      const sw = el('div', 'sw1', 'Sample text');
      if (isText) { sw.style.color = v; sw.style.background = hexOk(c.bg) ? c.bg : '#fff'; } else { sw.style.background = v; sw.style.color = hexOk(c.fg) ? c.fg : '#fff'; }
      return sw;
    };
    const first = mk(c.from);
    row.append(first, el('span', 'arrow', '→'), mk(c.to));
    const m = /contrast ([\d.]+) → ([\d.]+)/.exec(i.fix?.description ?? '');
    if (m) { const r = el('span', 'ratio'); r.append(document.createTextNode(`contrast ${m[1]} → `), el('b', '', m[2])); row.append(r); }
    box.append(row);
    // the left swatch morphs from the old colour into the new one
    box._play = () => {
      if (reduceMotion) return;
      first.style.transition = 'none';
      if (isText) first.style.color = c.from; else first.style.background = c.from;
      void first.offsetWidth;
      setTimeout(() => { first.style.transition = ''; if (isText) first.style.color = c.to; else first.style.background = c.to; }, 700);
    };
    box._play();
  }
  return box;
}

function issueEl(i, idx, readonly) {
  const editing = !readonly && canEdit(i), off = editing && effRejected(i), dirty = isDirty(i);
  const isOpen = !readonly && state.open.has(i.id);
  const d = el('div', `issue${i.status === 'planned' || i.status === 'applied' ? ' working' : ''}${off ? ' off' : ''}${dirty ? ' dirty' : ''}${isOpen ? ' open' : ''}`);
  const head = el('div', 'ihead');
  const tg = el('button', 'toggle'); tg.type = 'button'; tg.setAttribute('aria-expanded', String(isOpen));
  const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); chev.setAttribute('class', 'chev'); chev.setAttribute('viewBox', '0 0 14 14'); chev.innerHTML = '<path d="M5 3l4 4-4 4" stroke-linecap="round" stroke-linejoin="round"/>';
  const mid = el('span', 'main1');
  mid.append(el('code', 'rule', i.rule));
  mid.append(el('span', 'loc', state.group === 'file' || readonly ? (i.line ? `line ${i.line}` : '') : i.file + (i.line ? `:${i.line}` : '')));
  const lead = i.fix?.description && i.status !== 'manual' ? i.fix.description : i.help;
  mid.append(el('span', 'why', lead));
  tg.append(chev, el('span', `imp ${i.impact}`, i.impact), mid);
  head.append(tg);
  if (weak(i)) head.append(el('span', 'look', 'Worth a look'));
  const st = el('span', `st ${off ? 'rejected' : i.status}`);
  if (i.status === 'planned' || i.status === 'applied') st.append(el('span', 'spin'));
  st.append(document.createTextNode(dirty ? 'Edited · not applied' : off ? 'Excluded' : STATUS_LABEL[i.status]));
  head.append(st);
  if (editing) {
    const sw = el('label', 'switch'); sw.title = off ? 'Include this fix in the PR' : 'Leave this fix out of the PR';
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !off; cb.setAttribute('aria-label', `Include ${i.rule} fix in ${i.file}`);
    const knob = el('span', 'sw'); knob.setAttribute('aria-hidden', 'true');
    cb.addEventListener('change', () => setDraft(i, { rejected: !cb.checked }));
    sw.append(cb, knob); head.append(sw);
  }
  d.append(head);

  const m = morphEl(i);
  if (m) {
    const key = `${i.id}|${i.snippet.after}`;
    if (!state.seen.has(key) && !reduceMotion) { state.seen.add(key); d.classList.add('morphing'); d.style.setProperty('--d', Math.min(idx, 14) * 0.09 + 's'); }
    d.append(m);
  }

  const body = el('div', 'body');
  if (TRAIL.includes(i.status) || i.status === 'failed') {
    const cur = TRAIL.indexOf(i.status);
    const tr = el('div', 'trail');
    TRAIL.forEach((t, n) => tr.append(el('span', n < cur || (n === cur && t === 'verified') ? 'on' : n === cur ? 'cur' : '', ['Found', 'Fix planned', 'Applied', 'Verified'][n])));
    body.append(tr);
  }
  if (!m) body.append(el('pre', '', i.html));
  if (i.fix) {
    const meta = el('div', 'how');
    meta.textContent = `${METHOD[i.fix.method] ?? i.fix.method} · confidence ${Math.round(i.fix.confidence * 100)}%${weak(i) ? ' · a guess, please read it' : ''}`;
    body.append(meta);
    if (i.fix.edit && editing) {
      const f = el('div', 'editrow');
      const id = `ed-${i.id}`;
      const lab = el('label', '', i.fix.edit.label); lab.htmlFor = id;
      const inp = el('input'); inp.id = id; inp.type = 'text'; inp.value = effValue(i); inp.spellcheck = i.fix.edit.kind !== 'color';
      if (i.fix.edit.kind === 'color') inp.placeholder = '#1a5fb4';
      inp.addEventListener('input', () => { setDraft(i, { value: inp.value }, true); d.classList.toggle('dirty', isDirty(i)); });
      const reset = el('button', 'linkbtn', 'Reset'); reset.type = 'button';
      reset.addEventListener('click', () => { state.draft.delete(i.id); renderIssuesNow(); paintReview(); });
      f.append(lab, inp, reset);
      if (i.fix.edit.kind === 'color') {
        const sw = el('span', 'swatch'); const paint = () => { sw.style.background = /^#[0-9a-f]{6}$/i.test(inp.value) ? inp.value : 'transparent'; };
        paint(); inp.addEventListener('input', paint); f.insertBefore(sw, reset);
      }
      body.append(f);
    }
  }
  if (i.note && ['manual', 'failed', 'reverted', 'rejected'].includes(i.status)) {
    const n = el('div', 'fixline note'); if (i.status === 'manual') n.append(el('b', '', state.cfg.gemini.on ? 'Suggestion: ' : 'Note: ')); n.append(document.createTextNode(i.note)); body.append(n);
  }
  if (i.helpUrl) { const h = el('div', 'how help'); const a = el('a', '', 'Why this matters ↗'); a.href = i.helpUrl; a.target = '_blank'; a.rel = 'noopener'; h.append(a); body.append(h); }
  if (!readonly) {
    body.hidden = !isOpen;
    tg.addEventListener('click', () => {
      const open = body.hidden; body.hidden = !open; d.classList.toggle('open', open); tg.setAttribute('aria-expanded', String(open));
      if (open) state.open.add(i.id); else state.open.delete(i.id);
    });
    d.append(body);
  }
  return d;
}

function setDraft(i, patch, quiet) {
  const cur = state.draft.get(i.id) ?? {};
  state.draft.set(i.id, { ...cur, ...patch });
  if (!isDirty(i)) state.draft.delete(i.id);
  if (!quiet) renderIssuesNow();
  paintReview();
}

function replayChanges() {
  const cards = $$('#issues .issue');
  cards.forEach((c, n) => { c.classList.remove('morphing'); c.style.setProperty('--d', Math.min(n, 18) * 0.12 + 's'); });
  void $('#issues').offsetWidth;
  cards.forEach((c) => c.classList.add('morphing'));
  $$('#issues .morph').forEach((m) => m._play?.());
}
$('#playAll').addEventListener('click', replayChanges);

$$('.fchip').forEach((b) => b.addEventListener('click', () => {
  state.filter = b.dataset.f;
  $$('.fchip').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
  renderIssuesNow();
}));
$$('.seg button[data-g]').forEach((b) => b.addEventListener('click', () => {
  state.group = b.dataset.g;
  $$('.seg button[data-g]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderIssuesNow();
}));
$('#q').addEventListener('input', (e) => { state.q = e.target.value.trim().toLowerCase(); renderIssuesNow(); });

// ---------- before / after ----------
const changesFor = (file) => [...state.issues.values()].filter((i) => i.file === file && i.fix && i.snippet && i.status === 'verified');

function renderShots() {
  if (!state.shots.length) return;
  $('#shotEmpty').hidden = true;
  const sel = $('#pageSel'); const keep = state.baIdx;
  sel.innerHTML = '';
  state.shots.forEach((p, n) => sel.append(Object.assign(document.createElement('option'), { value: n, textContent: p.file + (p.static ? '  ·  source' : '') })));
  sel.value = Math.min(keep, state.shots.length - 1);
  sel.onchange = () => { state.baIdx = +sel.value; showShot(); };
  state.baIdx = +sel.value; showShot();
}

function showShot() {
  const p = state.shots[state.baIdx]; if (!p) return;
  $('#shotScores').textContent = `score ${p.beforeScore} → ${p.afterScore}`;
  const changes = changesFor(p.file);
  const list = $('#baList'); list.innerHTML = '';
  list.append(el('h3', 'h3', `${changes.length} change${changes.length === 1 ? '' : 's'} in ${p.file}${changes.length > 60 ? ' (first 60 listed)' : ''}`));
  $('#baStatic').hidden = !p.static; $('#baStage').hidden = !!p.static;
  if (p.static) $('#baStatic b').textContent = `${p.file} is a source file`;
  else {
    $('#imgBefore').src = `/runs/${state.runId}/artifacts/${p.before}`;
    $('#imgAfter').onload = layoutCompare;
    $('#imgAfter').src = `/runs/${state.runId}/artifacts/${p.after}`;
    buildPins(p, changes);
    applyMode();
  }
  changes.slice(0, 60).forEach((c, n) => {
    const card = issueEl(c, n, true);
    const badge = el('span', 'look', p.static || !c.rect ? `#${n + 1}` : `pin ${n + 1}`); badge.style.background = 'var(--good-bg)'; badge.style.color = 'var(--good)';
    $('.ihead', card).prepend(badge);
    card.dataset.pin = n + 1;
    card.addEventListener('mouseenter', () => $(`.pin[data-n="${n + 1}"]`)?.classList.add('on'));
    card.addEventListener('mouseleave', () => $(`.pin[data-n="${n + 1}"]`)?.classList.remove('on'));
    list.append(card);
  });
}

function buildPins(p, changes) {
  const host = $('#pins'); host.innerHTML = '';
  if (!p.size) return;
  changes.slice(0, 60).forEach((c, n) => {
    const r = c.rect; if (!r || r.w < 2 || r.h < 2 || r.w * r.h > 0.45 * p.size.w * p.size.h) return; // skip <html>-sized targets
    const pin = el('div', 'pin'); pin.dataset.n = n + 1; pin.style.setProperty('--d', Math.min(n, 20) * 0.06 + 's');
    pin.style.left = (r.x / p.size.w) * 100 + '%'; pin.style.top = (r.y / p.size.h) * 100 + '%';
    pin.style.width = (r.w / p.size.w) * 100 + '%'; pin.style.height = (r.h / p.size.h) * 100 + '%';
    if (r.x / p.size.w > 0.55) pin.classList.add('flip');
    const tip = el('div', 'tip');
    const s = c.snippet;
    tip.innerHTML = `<b>${esc(c.rule)}</b>\n<s>${esc(s.before)}</s>\n<u>${esc(s.after)}</u>`;
    pin.append(tip);
    pin.addEventListener('click', () => $(`#baList [data-pin="${n + 1}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    host.append(pin);
  });
}

function layoutCompare() {
  const stack = $('#stack'); if (!stack || $('#baStage').hidden) return;
  const m = state.baMode;
  $('#imgBefore').style.width = m === 'side' ? '' : stack.clientWidth + 'px';
  $('#beforeWrap').style.width = m === 'slide' ? $('#slider').value + '%' : m === 'blink' ? '100%' : '';
}
function applyMode() {
  const m = state.baMode, c = $('#cmp');
  clearInterval(state.blinkTimer); state.blinkTimer = 0;
  c.classList.toggle('side', m === 'side'); c.classList.toggle('blink', m === 'blink'); c.classList.remove('showafter');
  $('#sliderRow').hidden = m !== 'slide';
  $('#playSweep').hidden = m === 'side';
  $('#labL').hidden = $('#labR').hidden = m === 'blink'; $('#labL').textContent = 'Before';
  if (m === 'blink') startBlink(); else $('#playSweep').textContent = '▶ Play';
  layoutCompare();
}
function startBlink() {
  clearInterval(state.blinkTimer);
  let after = false;
  const paint = () => { $('#cmp').classList.toggle('showafter', after); const l = $('#labL'); l.hidden = false; l.textContent = after ? 'After' : 'Before'; };
  paint();
  state.blinkTimer = setInterval(() => { after = !after; paint(); }, 1100);
  $('#playSweep').textContent = '⏸ Pause';
}
$$('.seg button[data-m]').forEach((b) => b.addEventListener('click', () => {
  state.baMode = b.dataset.m;
  $$('.seg button[data-m]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  applyMode();
  if (state.baMode === 'slide') setTimeout(sweep, 200);
}));
let sweeping = 0;
function sweep() {
  if (state.baMode !== 'slide' || $('#baStage').hidden) return;
  const sl = $('#slider'); cancelAnimationFrame(sweeping);
  if (reduceMotion) { sl.value = 50; layoutCompare(); return; }
  const t0 = performance.now(), D = 2800;
  const ease = (k) => (k < .5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / D);
    // 100 → 0 → 50: reveals every fix, then settles in the middle
    sl.value = k < .65 ? 100 - 100 * ease(k / .65) : 50 * ease((k - .65) / .35);
    layoutCompare();
    if (k < 1) sweeping = requestAnimationFrame(step);
  };
  sweeping = requestAnimationFrame(step);
}
$('#playSweep').addEventListener('click', () => {
  if (state.baMode === 'blink') {
    if (state.blinkTimer) { clearInterval(state.blinkTimer); state.blinkTimer = 0; $('#playSweep').textContent = '▶ Play'; } else startBlink();
  } else sweep();
});
$('#slider').addEventListener('input', () => { cancelAnimationFrame(sweeping); layoutCompare(); });
addEventListener('resize', layoutCompare);

// ---------- code diff ----------
function renderDiff(ev) {
  const host = $('#diff'); host.innerHTML = '';
  const files = ev.patch.split(/^diff --git /m).filter(Boolean);
  let add = 0, del = 0;
  for (const f of files) {
    const lines = f.split('\n');
    const name = (lines[0].match(/ b\/(.+)$/) ?? [, lines[0]])[1];
    const a = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length, d = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
    add += a; del += d;
    const det = el('details', 'dfile'); det.open = true;
    const sum = el('summary'); sum.append(el('span', '', name), el('span', 'plus', `+${a}`), el('span', 'minus', `−${d}`));
    const pre = el('pre');
    let n = 0;
    for (const line of lines.slice(1)) {
      if (/^(index|---|\+\+\+|new file|deleted file)/.test(line)) continue;
      const s = el('span', line.startsWith('+') ? 'a' : line.startsWith('-') ? 'd' : line.startsWith('@@') ? 'h' : '', line || ' ');
      if (line.startsWith('+')) s.style.setProperty('--d', Math.min(n++ * 0.03, 0.9) + 's');
      pre.append(s);
    }
    det.append(sum, pre); host.append(det);
  }
  host.hidden = !files.length; $('#diffEmpty').hidden = !!files.length;
  $('#diffMeta').textContent = `${files.length} file${files.length === 1 ? '' : 's'} · +${add} / −${del} lines · branch ${ev.branch}`;
  const dl = $('#dl'); dl.href = `/runs/${state.runId}/fixes.patch?t=${Date.now()}`; dl.hidden = !files.length;
  $('#rDiff').hidden = false;
  addEv('ok', `Prepared patch on branch <code>${esc(ev.branch)}</code>`);
}

// ---------- screen reader ----------
function renderTranscript() {
  if (!state.transcripts.length) { $('#srOut').hidden = true; $('#srEmpty').hidden = false; return; }
  $('#srEmpty').hidden = true; $('#srOut').hidden = false;
  const sel = $('#srSel'), keep = +sel.value || 0;
  sel.innerHTML = '';
  state.transcripts.forEach((p, i) => sel.append(Object.assign(document.createElement('option'), { value: i, textContent: p.file })));
  sel.value = Math.min(keep, state.transcripts.length - 1);
  sel.onchange = () => drawTranscript();
  drawTranscript();
}
const keyOf = (l) => `${l.indent}|${l.text}`;
function diffLines(b, a) {
  const n = b.length, m = a.length, L = Array.from({ length: n + 1 }, () => new Int16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = keyOf(b[i]) === keyOf(a[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (keyOf(b[i]) === keyOf(a[j])) { ops.push({ t: 'same', a: a[j] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) ops.push({ t: 'del', b: b[i++] });
    else ops.push({ t: 'add', a: a[j++] });
  }
  while (i < n) ops.push({ t: 'del', b: b[i++] });
  while (j < m) ops.push({ t: 'add', a: a[j++] });
  // a run of deletions followed by additions is one line changing
  const rows = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k].t === 'same') { rows.push(ops[k++]); continue; }
    const dels = [], adds = [];
    while (k < ops.length && ops[k].t === 'del') dels.push(ops[k++]);
    while (k < ops.length && ops[k].t === 'add') adds.push(ops[k++]);
    const pairs = Math.min(dels.length, adds.length);
    for (let x = 0; x < pairs; x++) rows.push({ t: 'chg', b: dels[x].b, a: adds[x].a });
    dels.slice(pairs).forEach((d) => rows.push(d)); adds.slice(pairs).forEach((a) => rows.push(a));
  }
  return rows;
}
function drawTranscript() {
  stopHear();
  const pgI = +$('#srSel').value || 0, pg = state.transcripts[pgI]; if (!pg) return;
  const out = $('#srOut'); out.innerHTML = '';
  const mode = state.srMode, speak = [];
  const pad = (li, l) => { li.style.paddingLeft = 8 + l.indent * 14 + 'px'; return li; };
  const line = (cls, l) => pad(el('li', `${cls}${l.warn ? ' warn' : ''}`, (l.warn ? '⚠ ' : '') + l.text), l);
  let changed = 0;
  if (mode !== 'changes') {
    for (const l of pg[mode]) { const li = line('', l); out.append(li); speak.push({ li, text: l.text }); }
  } else {
    const rows = diffLines(pg.before, pg.after);
    changed = rows.filter((r) => r.t !== 'same').length;
    const isChg = (r) => !!r && r.t !== 'same';
    const near = rows.map((r, k) => isChg(r) || isChg(rows[k - 1]) || isChg(rows[k + 1]));
    let d = 0, k = 0;
    while (k < rows.length) {
      if (!near[k]) {
        let e = k; while (e < rows.length && !near[e]) e++;
        const id = `${pgI}:${k}`;
        if (e - k > 1 && !state.srFold.has(id)) {
          const f = el('li', 'fold', `⋯ ${e - k} unchanged lines`); f.addEventListener('click', () => { state.srFold.add(id); drawTranscript(); }); out.append(f);
          for (let x = k; x < e; x++) speak.push({ li: null, text: rows[x].a.text });
          k = e; continue;
        }
      }
      const r = rows[k++];
      if (r.t === 'same') { const li = line('same', r.a); out.append(li); speak.push({ li, text: r.a.text }); }
      else if (r.t === 'chg') {
        const li = pad(el('li', 'chg'), r.a); li.style.setProperty('--d', Math.min(d++, 14) * 0.16 + 's');
        li.append(el('span', 'o', (r.b.warn ? '⚠ ' : '') + r.b.text), el('span', 'n', r.a.text)); out.append(li); speak.push({ li, text: r.a.text });
      } else if (r.t === 'add') {
        const li = pad(el('li', 'add', '+ ' + r.a.text), r.a); li.style.setProperty('--d', Math.min(d++, 14) * 0.16 + 's'); out.append(li); speak.push({ li, text: r.a.text });
      } else out.append(pad(el('li', 'del', r.b.text), r.b));
    }
  }
  out._speak = speak;
  $('#srHint').textContent = mode === 'changes'
    ? (changed ? `${changed} line${changed === 1 ? '' : 's'} changed in what a screen reader announces. Struck-through is what it said before.` : 'The announced text did not change for this page.')
    : 'What a screen reader announces, in reading order. Unlabeled controls are read as just “button” or “link”.';
}
$$('.seg button[data-s]').forEach((b) => b.addEventListener('click', () => {
  state.srMode = b.dataset.s;
  $$('.seg button[data-s]').forEach((x) => x.setAttribute('aria-pressed', x === b));
  drawTranscript();
}));
function stopHear() { if ('speechSynthesis' in window) speechSynthesis.cancel(); state.speaking = false; $('#srHear').textContent = '🔊 Hear it'; $$('#srOut .speaking').forEach((x) => x.classList.remove('speaking')); }
$('#srHear').addEventListener('click', () => {
  if (!('speechSynthesis' in window)) return toast('This browser has no speech synthesis.');
  if (state.speaking) return stopHear();
  const lines = ($('#srOut')._speak ?? []).filter((s) => s.text);
  if (!lines.length) return;
  state.speaking = true; $('#srHear').textContent = '⏹ Stop';
  lines.forEach((s, n) => {
    const u = new SpeechSynthesisUtterance(s.text.replace(/, unlabeled/, ', no label'));
    u.onstart = () => { $$('#srOut .speaking').forEach((x) => x.classList.remove('speaking')); s.li?.classList.add('speaking'); s.li?.scrollIntoView({ block: 'nearest' }); };
    if (n === lines.length - 1) u.onend = () => stopHear();
    speechSynthesis.speak(u);
  });
});

// ---------- review & pull request ----------
const inReview = () => state.status === 'review';

function onReview(ev) {
  state.review = ev;
  stopClock(); setBusy(false); setStatus('review'); state.draft.clear();
  $$('#steps li').forEach((li, n) => { li.className = n < 4 ? 'done' : n === 4 ? 'active' : ''; });
  state.stage = 4; setBar((4.5 / STAGES.length) * 100);
  $('#spin').hidden = true; $('#doneIcon').hidden = false; $('#doneIcon').textContent = '✎'; $('#doneIcon').classList.add('review');
  $('#roundChip').hidden = false; $('#roundChip').textContent = ev.kind === 'rebuilt' ? 'Changes applied' : `${ev.rounds} round${ev.rounds === 1 ? '' : 's'}`;
  setNow('Ready for your review', `${ev.fixed} verified · ${ev.manual} need you${ev.skipped ? ` · ${ev.skipped} excluded` : ''}`);
  $('#liveSpin').hidden = true; $('#liveShot').classList.remove('scanning');
  $('#scoreLine').textContent = `${ev.before} → ${ev.after} · ${ev.fixed} fixed`;
  addEv('ok', `Ready for review. Score <b>${ev.before} → ${ev.after}</b>`);
  $('#rShots').hidden = $('#rDiff').hidden = $('#rPr').hidden = false;
  $('#rSr').hidden = !state.transcripts.length;
  $('#editHint').hidden = false;
  state.cfg.github.on = state.cfg.github.on || ev.hasToken;
  renderIssuesNow(); renderTiles(); renderBars(); paintReview(); paintPr(); showShot();
  if (ev.kind === 'initial') {
    state.swept = false;
    goTab('issues');
    toast(state.site ? `${ev.fixed} fixes verified on a copy of your site. Review them, then get the fix script.` : `${ev.fixed} fixes verified. Watch them change, edit any, then raise the PR.`);
  } else toast(`Changes re-verified. Score ${ev.after}/100.`);
  if (state.site) $('#editHint').innerHTML = 'Every fix shows the source line <b>before</b> and <b>after</b> on a rendered copy of the page. Edit or switch off any fix, press <b>Re-verify changes</b>, then open <b>Ship fixes</b> to get the drop-in script.';
}

function paintReview() {
  const show = inReview();
  $('#reviewbar').hidden = !show;
  if (!show) return;
  const dirty = dirtyList().length;
  const included = [...state.issues.values()].filter((i) => i.fix && EDITABLE.has(i.status) && !effRejected(i) && (i.status === 'verified' || isDirty(i))).length;
  $('#rbN').textContent = included; $('#rbLabel').textContent = state.site ? 'fixes to ship' : 'fixes in the PR';
  $('#rbEdited').textContent = dirty ? `· ${dirty} unapplied change${dirty === 1 ? '' : 's'}` : '';
  $('#reverify').disabled = !dirty;
  $('#reverify').classList.toggle('primary', !!dirty); $('#reverify').classList.toggle('soft', !dirty);
}

async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
}

$('#reverify').addEventListener('click', async () => {
  const decisions = {};
  for (const i of dirtyList()) { const d = state.draft.get(i.id); decisions[i.id] = { rejected: d.rejected ?? i.status === 'rejected', value: d.value }; }
  if (!Object.keys(decisions).length) return;
  setBusy(true); setStatus('running'); paintReview(); $('#spin').hidden = false; $('#doneIcon').hidden = true;
  startClock(); setNow('Re-applying your changes', 'Rebuilding the patch from your original source'); setBar(60);
  try { await post(`/api/run/${state.runId}/review`, { decisions }); }
  catch (e) {
    stopClock(); setBusy(false); setStatus('review'); $('#spin').hidden = true; $('#doneIcon').hidden = false;
    setNow('Ready for your review', 'Your changes were not applied'); paintReview(); renderIssuesNow();
    toast(e.message);
  }
});
$('#toPr').addEventListener('click', () => { goTab('pr'); $('#prTitle').focus(); });

function paintMode() {
  const site = !!state.site;
  const t = [...$('#tab-pr').childNodes].find((n) => n.nodeType === 3); if (t) t.textContent = site ? 'Ship fixes' : 'Pull request';
  $('#step6').textContent = site ? 'Ship fixes' : 'Pull request'; $('#step6s').textContent = site ? 'Script & report' : 'Push & open';
  $('#toPr').textContent = site ? 'Get the fixes →' : 'Review pull request →';
}
function onDraft(ev) {
  state.site = ev.site ?? null; paintMode();
  if (ev.site) {
    const s = ev.site, id = state.runId;
    $('#prEmpty').hidden = true; $('#prForm').hidden = true; $('#shipForm').hidden = false;
    $('#dlScript').href = `/runs/${id}/accessify-fixes.js?t=${Date.now()}`; $('#dlPatch2').href = `/runs/${id}/fixes.patch?t=${Date.now()}`; $('#dlReport').href = `/runs/${id}/PR.md?t=${Date.now()}`;
    $('#shipStats').textContent = `${s.fixes ?? 0} verified fixes across ${s.pages ?? 0} page${s.pages === 1 ? '' : 's'} of ${s.host} · ${((s.bytes ?? 0) / 1024).toFixed(1)} KB`;
    return;
  }
  const p = state.pr, first = !p.title;
  Object.assign(p, { branch: p.branch || ev.branch, repo: p.repo || ev.repo || '', needsRepo: ev.needsRepo, changes: ev.changes, repoKnown: ev.repo });
  const set = (key, id, v) => { if (first || !state.prDirty.has(key)) { p[key] = v; $(id).value = v; } };
  set('title', '#prTitle', ev.title); set('body', '#prBodyEdit', ev.body); set('branch', '#prBranch', p.branch);
  if (ev.repo) $('#prRepo').value = ev.repo;
  state.pr.generated = { title: ev.title, body: ev.body };
  $('#prEmpty').hidden = true; $('#prForm').hidden = false;
  paintPr();
}
[['title', '#prTitle'], ['body', '#prBodyEdit'], ['branch', '#prBranch']].forEach(([k, id]) => $(id).addEventListener('input', (e) => { state.prDirty.add(k); state.pr[k] = e.target.value; }));
$('#prRepo').addEventListener('input', (e) => { state.pr.repo = e.target.value; paintPr(); });
$('#prReset').addEventListener('click', () => { const g = state.pr.generated; if (!g) return; $('#prTitle').value = state.pr.title = g.title; $('#prBodyEdit').value = state.pr.body = g.body; state.prDirty.clear(); });

function paintPr() {
  const p = state.pr;
  $('#repoRow').hidden = !p.needsRepo;
  $('#prTarget').textContent = p.repoKnown ? `${p.repoKnown} (default branch)` : p.repo ? `${p.repo.replace(/^https?:\/\/github\.com\//, '')} (default branch)` : 'Enter a repository above';
  const dirty = dirtyList().length, busy = state.status === 'running', done = state.status === 'done';
  const checks = [
    [state.cfg.github.on, 'GitHub connected', 'Connect GitHub to push and open the PR', true],
    [!p.needsRepo || /^(https?:\/\/github\.com\/)?[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(p.repo.trim()), 'Repository set', 'Enter the repository to raise the PR against', false],
    [p.changes > 0, `${p.changes} fix${p.changes === 1 ? '' : 'es'} in the patch`, 'Every fix is excluded, so there is nothing to commit', false],
    [!dirty, 'No unapplied edits', `${dirty} edit${dirty === 1 ? '' : 's'} still need Re-verify`, false],
  ];
  const ul = $('#prChecks'); ul.innerHTML = '';
  for (const [ok, yes, no, link] of checks) {
    const li = el('li', ok ? 'ok' : 'no'); li.append(el('span', 'dotc', ok ? '✓' : '!'), document.createTextNode(ok ? yes : no));
    if (!ok && link) { const b = el('button', 'linkbtn', 'Open settings'); b.type = 'button'; b.addEventListener('click', () => dlg.showModal()); li.append(b); }
    ul.append(li);
  }
  const ready = checks.every((c) => c[0]) && inReview();
  const b = $('#raise');
  b.disabled = !ready;
  b.textContent = busy && state.stage === 5 ? 'Raising…' : done ? 'Pull request opened ✓' : 'Raise pull request';
  $('#raiseNote').textContent = ready ? 'Pushes the branch and opens the PR. Nothing has been pushed yet.' : '';
}

$('#raise').addEventListener('click', async () => {
  const p = state.pr;
  $('#prErr').hidden = true;
  setBusy(true); setStatus('running'); paintReview(); $('#spin').hidden = false; $('#doneIcon').hidden = true;
  startClock(); setNow('Raising the pull request', 'Committing, pushing and opening it on GitHub');
  $$('#steps li').forEach((li, n) => { li.className = n < 5 ? 'done' : 'active'; }); setBar((5.4 / STAGES.length) * 100);
  try { await post(`/api/run/${state.runId}/pr`, { title: $('#prTitle').value, body: $('#prBodyEdit').value, branch: $('#prBranch').value, repo: p.needsRepo ? $('#prRepo').value : undefined }); }
  catch (e) {
    stopClock(); setBusy(false); setStatus('review'); $('#spin').hidden = true; $('#doneIcon').hidden = false;
    $$('#steps li').forEach((li, n) => { li.className = n < 4 ? 'done' : n === 4 ? 'active' : ''; });
    setNow('Ready for your review', 'The pull request was not raised');
    const box = $('#prErr'); box.textContent = e.message; box.hidden = false; paintReview(); paintPr();
  }
});

function onPr(ev) {
  if (ev.mode !== 'opened') return;
  state.prUrl = ev.url;
  stopClock(); setBusy(false); setStatus('done');
  $$('#steps li').forEach((l) => l.className = 'done'); setBar(100);
  $('#spin').hidden = true; $('#doneIcon').hidden = false; $('#doneIcon').textContent = '✓'; $('#doneIcon').classList.remove('review');
  setNow('Pull request is open', ev.url);
  const box = $('#prDone'); box.hidden = false; box.innerHTML = '';
  const a = el('a', 'btn primary', 'Open on GitHub ↗'); a.href = ev.url; a.target = '_blank'; a.rel = 'noopener';
  box.append(el('div', 'pd-t', ev.reused ? 'Existing pull request updated' : 'Pull request opened'), el('div', 'pd-s', `${ev.repo}${ev.fork ? ' · pushed from your fork' : ''} · branch ${ev.branch}`), a);
  $('#rPr').hidden = false; $('#prErr').hidden = true; $('#roundChip').textContent = 'PR open';
  paintReview(); paintPr(); goTab('pr');
  toast('Pull request opened.', 'Open on GitHub', () => window.open(ev.url, '_blank', 'noopener'));
}

$('#copySnip').addEventListener('click', async (e) => {
  try { await navigator.clipboard.writeText('<script src="/accessify-fixes.js" defer></script>'); e.currentTarget.textContent = 'Copied'; setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1500); } catch { toast('Copy failed. Select the text and copy it.'); }
});
