/*
  Anthos Sync: the one Sync button and room panel for every app in the suite.
  (c) Matt Smith

  Two ways for an app to use it (scripts at the end of the page):
    <script src="room-sync.js"></script>
    <script src="anthos-sync.js"></script>

  1. Simple apps hand over three things they can do, and carry on as before:
       AnthosSync.register({ ctx(), play(bpm, whenAudioTime), stop(), setTempo(bpm) }, 'Chord Trainer');
       Play button:  if (!AnthosSync.play(bpm)) startLocally();   // true = the room will call play() on every device
       Stop button:  if (!AnthosSync.stop()) stopLocally();
     A device joining while the room plays comes in at the next bar line. A tempo change from the room
     restarts everyone together where the new tempo begins.

  2. Apps that need more (World Beats) mount it and use the connection directly:
       const room = AnthosSync.mount({ app: 'world-beats', place: someElement });

  room.sync           the RoomSync connection (null until this device joins)
  room.joined()       this device is in the room
  room.locked()       ...and in time with it
  room.leading()      this device is the teacher
  room.following()    someone else is the teacher, so their device steers
  room.leaderName()   the teacher's name, or ''
  room.statusText()   one plain sentence about the connection
  room.on('change', fn)       anything about the room changed
  room.on('join', fn(sync))   the connection now exists (once)
  room.on('transport', fn)    Start, Stop, tempo, metre or a musical change arrived

  Opened from anywhere other than the Mac running Room Sync (the GitHub site, a file on a laptop),
  the button offers to reopen this same app from the Mac.
*/
(function (root) {
  'use strict';
  const doc = root.document;
  const KEY = 'anthos.sync.';
  const load = k => { try { return root.localStorage.getItem(KEY + k); } catch (e) { return null; } };
  const save = (k, v) => { try { root.localStorage.setItem(KEY + k, String(v)); } catch (e) { /* storage blocked */ } };
  const APP_NAMES = { metronome: 'Test metronome', 'world-beats': 'World Beats', 'chord-trainer': 'Chord Trainer', 'scale-trainer': 'Scale Trainer' };
  const slug = v => String(v || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  const appName = id => APP_NAMES[id] || (id ? (id.charAt(0).toUpperCase() + id.slice(1)).replace(/[-_]+/g, ' ') : '');
  const shortKind = k => String(k || '').replace(/\s*\(.*\)$/, '');
  const reduced = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CSS = `
.asx-btn,.asx-sheet,.asx-panel{--asx-a:var(--asx-accent,#62d6ff);--asx-ink:#eaf0fa;--asx-mute:#9fb0cc;--asx-line:#2b3b59;--asx-card:#142036;--asx-well:#0d1626;font-family:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.asx-btn *,.asx-sheet *,.asx-panel *{box-sizing:border-box}
.asx-btn{display:inline-flex;align-items:center;gap:8px;min-height:40px;padding:0 16px 0 12px;border-radius:999px;border:1px solid var(--asx-line);background:var(--asx-well);color:var(--asx-ink);font-size:15px;font-weight:700;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;white-space:nowrap}
.asx-btn[data-state=on]{border-color:var(--asx-a)}
.asx-btn:focus-visible,.asx-b:focus-visible,.asx-in:focus-visible{outline:3px solid var(--asx-a);outline-offset:2px}
.asx-float{position:fixed;z-index:2147483000;top:max(10px,env(safe-area-inset-top));right:max(10px,env(safe-area-inset-right))}
.asx-dot{width:10px;height:10px;border-radius:50%;flex:none;background:#66748f}
.asx-btn[data-state=wait] .asx-dot,.asx-dot[data-s=wait]{background:#ffb547}
.asx-btn[data-state=on] .asx-dot,.asx-dot[data-s=on]{background:#41d98a;box-shadow:0 0 0 3px rgba(65,217,138,.2)}
.asx-btn[data-state=lost] .asx-dot{background:#ff6b6b}
@media (prefers-reduced-motion:no-preference){.asx-btn[data-state=wait] .asx-dot{animation:asx-pulse 1s ease-in-out infinite}}
@keyframes asx-pulse{50%{opacity:.3}}
.asx-sheet{position:fixed;inset:0;z-index:2147483001;display:flex;align-items:flex-end;justify-content:center;background:rgba(4,8,15,.62)}
.asx-sheet[hidden]{display:none}
.asx-card{width:100%;max-width:520px;max-height:88vh;overflow:auto;background:var(--asx-card);color:var(--asx-ink);border:1px solid var(--asx-line);border-bottom:0;border-radius:20px 20px 0 0;padding:16px 18px calc(18px + env(safe-area-inset-bottom))}
@media (min-width:640px){.asx-sheet{align-items:center}.asx-card{border-radius:20px;border-bottom:1px solid var(--asx-line)}}
.asx-top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.asx-title{margin:0;font-size:21px;font-weight:800;color:var(--asx-a)}
.asx-panel{color:var(--asx-ink);font-size:16px;line-height:1.45}
.asx-status{margin:0 0 12px;font-size:17px;font-weight:650;text-wrap:balance}
.asx-sec{margin-top:14px;padding-top:14px;border-top:1px solid var(--asx-line)}
.asx-h{margin:0 0 6px;font-size:15px;font-weight:750;color:var(--asx-mute)}
.asx-p{margin:0 0 10px}
.asx-hint{margin:10px 0 0;font-size:14px;color:var(--asx-mute)}
.asx-msg{margin:8px 0 0;font-size:15px;font-weight:650;color:var(--asx-a)}
.asx-hint:empty,.asx-msg:empty{display:none}
.asx-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.asx-gap{margin-top:14px}
.asx-lab{display:grid;gap:6px;font-size:15px;color:var(--asx-mute)}
.asx-in{min-height:44px;width:100%;padding:8px 12px;border-radius:12px;border:1px solid var(--asx-line);background:var(--asx-well);color:var(--asx-ink);font:inherit;font-size:17px}
.asx-code{flex:1 1 8em;width:auto;letter-spacing:.15em}
.asx-b{min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--asx-line);background:#1c2a44;color:var(--asx-ink);font:inherit;font-size:16px;font-weight:700;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.asx-b:disabled{opacity:.45;cursor:default}
.asx-b.asx-go{background:var(--asx-a);border-color:var(--asx-a);color:#06121f}
.asx-b.asx-quiet{background:transparent}
.asx-wide{width:100%;margin-top:8px}
.asx-panel [hidden]{display:none!important}
.asx-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.asx-li{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;background:var(--asx-well)}
.asx-who{flex:1;min-width:0;overflow-wrap:anywhere}
.asx-who small{display:block;color:var(--asx-mute);font-size:13px}
.asx-tag{font-size:13px;font-weight:750;color:#06121f;background:var(--asx-a);padding:2px 9px;border-radius:999px}
.asx-toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483002;max-width:min(92vw,420px);padding:10px 16px;border-radius:12px;background:#142036;color:#eaf0fa;border:1px solid var(--asx-accent,#62d6ff);font:650 15px/1.35 ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s}
.asx-toast.on{opacity:1}
@media (prefers-reduced-motion:reduce){.asx-toast{transition:none}}
`;

  const PANEL = `
<p class="asx-status" data-asx="status"></p>
<div class="asx-row" data-asx="joinrow"><button type="button" class="asx-b asx-go" data-asx="join">Join the room</button></div>
<div data-asx="inroom">
  <label class="asx-lab">Your name<input class="asx-in" data-asx="name" maxlength="24" autocomplete="off" autocapitalize="words" enterkeyhint="done"></label>
  <section class="asx-sec">
    <h3 class="asx-h">Who’s in control</h3>
    <p class="asx-p" data-asx="teachtext"></p>
    <div class="asx-row" data-asx="coderow">
      <input class="asx-in asx-code" data-asx="code" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="Teacher code" aria-label="Teacher code" enterkeyhint="go">
      <button type="button" class="asx-b" data-asx="take">Take control</button>
    </div>
    <button type="button" class="asx-b" data-asx="release" hidden>Hand back control</button>
    <p class="asx-msg" data-asx="teachmsg" aria-live="polite"></p>
  </section>
  <section class="asx-sec">
    <h3 class="asx-h" data-asx="fixhead">Timing on this device</h3>
    <p class="asx-p" data-asx="fixtext"></p>
    <div class="asx-row">
      <button type="button" class="asx-b" data-asx="earlier">Earlier</button>
      <button type="button" class="asx-b" data-asx="later">Later</button>
      <button type="button" class="asx-b asx-quiet" data-asx="reset">Reset</button>
    </div>
    <button type="button" class="asx-b asx-wide" data-asx="save">Save for every device like this</button>
    <p class="asx-msg" data-asx="fixmsg" aria-live="polite"></p>
    <p class="asx-hint">If this device sounds late, tap Earlier until it sounds as one with the others.</p>
  </section>
  <section class="asx-sec">
    <h3 class="asx-h" data-asx="roomhead">In the room</h3>
    <ul class="asx-list" data-asx="list"></ul>
  </section>
  <p class="asx-hint" data-asx="awake"></p>
  <div class="asx-row asx-gap"><button type="button" class="asx-b asx-quiet" data-asx="leave">Leave the room</button></div>
</div>`;

  const AWAY = `
<p class="asx-p">Playing together works when this app is opened from the Mac running Room Sync.</p>
<label class="asx-lab">Address the Mac shows<input class="asx-in" data-asx="addr" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="192.168.1.20:8080" enterkeyhint="go"></label>
<button type="button" class="asx-b asx-go asx-wide" data-asx="open">Open from the Mac</button>
<p class="asx-msg" data-asx="addrmsg" aria-live="polite"></p>`;

  let opts = null, sync = null, joinedFlag = false, everConnected = false, pendingAct = '';
  let btn = null, sheet = null, sheetBody = null, sheetMode = '', lastFocus = null, wake = null;
  let adapter = null, aRun = -1, aSegKey = '', aTimers = [], tempoTimer = 0, toastEl = null, toastTimer = 0;
  const panels = [];
  const handlers = {};

  function on(ev, fn) {
    (handlers[ev] = handlers[ev] || []).push(fn);
    return () => { handlers[ev] = (handlers[ev] || []).filter(f => f !== fn); };
  }
  function emit(ev, a) {
    for (const f of (handlers[ev] || []).slice()) {
      try { f(a); } catch (e) { console.error('AnthosSync ' + ev + ' handler:', e); }
    }
  }

  let whereP = null;
  function servedByRelay() {
    if (!whereP) {
      const proto = root.location.protocol;
      whereP = (proto === 'http:' || proto === 'https:')
        ? root.fetch('/room-sync/where', { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : null))
          .then(j => (j && j.app === 'anthos-room-sync' ? j : null))
          .catch(() => null)
        : Promise.resolve(null);
    }
    return whereP;
  }

  function style() {
    if (doc.getElementById('asx-style')) return;
    const s = doc.createElement('style');
    s.id = 'asx-style';
    s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }
  const sayAll = (key, text) => { for (const p of panels) if (p.r[key]) p.r[key].textContent = text; };

  function buildPanel(el) {
    const wrap = doc.createElement('div');
    wrap.className = 'asx-panel';
    wrap.innerHTML = PANEL;
    el.appendChild(wrap);
    const r = {};
    wrap.querySelectorAll('[data-asx]').forEach(n => { r[n.dataset.asx] = n; });
    r.join.addEventListener('click', () => join(true));
    r.leave.addEventListener('click', leave);
    r.name.value = load('name') || '';
    r.name.addEventListener('change', () => setName(r.name.value));
    r.name.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); r.name.blur(); } });
    const take = () => {
      if (!sync) return;
      const code = r.code.value.trim();
      if (!code) { r.teachmsg.textContent = 'Type the teacher code first.'; r.code.focus(); return; }
      pendingAct = 'take';
      sync.takeControl(code);
      r.code.value = '';
      sayAll('teachmsg', '');
    };
    r.take.addEventListener('click', take);
    r.code.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); take(); } });
    r.release.addEventListener('click', () => { if (sync) sync.releaseControl(); });
    const nudge = ms => { if (!sync) return; pendingAct = ''; sayAll('fixmsg', ''); if (ms) sync.nudgeFix(ms); else sync.resetFix(); };
    r.earlier.addEventListener('click', () => nudge(-5));
    r.later.addEventListener('click', () => nudge(5));
    r.reset.addEventListener('click', () => nudge(0));
    r.save.addEventListener('click', () => {
      if (!sync) return;
      if (!sync.hasControl()) { sayAll('fixmsg', 'Only ' + sync.teacher.name + ' can save this for everyone.'); return; }
      pendingAct = 'save';
      sayAll('fixmsg', sync.saveFixForRoom() ? 'Saving…' : 'Not connected to the Mac.');
    });
    r.awake.textContent = ('wakeLock' in root.navigator) ? ''
      : 'Keep this screen on while you play. On iPhone and iPad: Settings › Display & Brightness › Auto-Lock › Never.';
    panels.push({ el: wrap, r });
    return wrap;
  }

  function buildAway(el) {
    const wrap = doc.createElement('div');
    wrap.className = 'asx-panel';
    wrap.innerHTML = AWAY;
    el.appendChild(wrap);
    const addr = wrap.querySelector('[data-asx=addr]');
    const msg = wrap.querySelector('[data-asx=addrmsg]');
    addr.value = load('addr') || '';
    const go = () => {
      const v = addr.value.trim().replace(/^[a-z]+:\/\//i, '').replace(/[/?#].*$/, '');
      if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(v)) {
        msg.textContent = 'Type the address the Mac shows, like 192.168.1.20:8080.';
        addr.focus();
        return;
      }
      save('addr', v);
      let file = root.location.pathname.split('/').pop() || '';
      if (!/\.html?$/i.test(file)) file = '';
      msg.textContent = 'Opening…';
      root.location.href = 'http://' + v + '/' + encodeURIComponent(file) + '?sync=1';
    };
    wrap.querySelector('[data-asx=open]').addEventListener('click', go);
    addr.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  }

  function ensureSheet() {
    if (sheet) return;
    sheet = doc.createElement('div');
    sheet.className = 'asx-sheet';
    sheet.hidden = true;
    sheet.innerHTML = '<div class="asx-card" role="dialog" aria-modal="true" aria-labelledby="asx-title">' +
      '<div class="asx-top"><h2 class="asx-title" id="asx-title">Play together</h2>' +
      '<button type="button" class="asx-b asx-quiet" data-asx="close">Close</button></div><div data-asx="body"></div></div>';
    if (opts.accent) sheet.style.setProperty('--asx-accent', opts.accent);
    doc.body.appendChild(sheet);
    sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
    sheet.querySelector('[data-asx=close]').addEventListener('click', closeSheet);
    doc.addEventListener('keydown', e => { if (e.key === 'Escape' && sheet && !sheet.hidden) closeSheet(); });
    sheetBody = sheet.querySelector('[data-asx=body]');
  }
  function openSheet(mode) {
    ensureSheet();
    if (sheetMode !== mode) {
      sheetBody.textContent = '';
      for (let i = panels.length - 1; i >= 0; i--) if (!doc.contains(panels[i].el)) panels.splice(i, 1);
      if (mode === 'away') buildAway(sheetBody); else buildPanel(sheetBody);
      sheetMode = mode;
    }
    lastFocus = doc.activeElement;
    sheet.hidden = false;
    const f = sheet.querySelector(mode === 'away' ? '[data-asx=addr]' : '[data-asx=close]');
    if (f) f.focus({ preventScroll: true });
    update();
  }
  function closeSheet() {
    if (!sheet || sheet.hidden) return;
    sheet.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
  }

  function statusText() {
    if (!joinedFlag || !sync) return 'Not in the room.';
    if (sync.state !== 'connected') return everConnected ? 'Lost the Mac. Trying again…' : 'Joining the room…';
    if (!sync.locked()) return 'Finding the room\u2019s clock…';
    const e = sync.lock().err;
    return 'In time with the room, to within ' + Math.max(1, Math.ceil(e || 0)) + '\u00a0ms.';
  }
  function buttonState() {
    if (!joinedFlag || !sync) return 'off';
    if (sync.state !== 'connected') return everConnected ? 'lost' : 'wait';
    return sync.locked() ? 'on' : 'wait';
  }
  function fixText() {
    const sh = sync.sharedFix, lo = sync.localFix;
    const d = v => Math.abs(v) + ' ms ' + (v < 0 ? 'earlier' : 'later');
    const parts = [];
    if (sh) parts.push('Every ' + sync.kind + ' plays ' + d(sh) + '.');
    if (lo) parts.push((sh ? 'This one plays a further ' : 'This one plays ') + d(lo) + '.');
    return parts.length ? parts.join(' ') : 'No timing fix.';
  }
  const dotState = x => (x.err == null || x.err > 8 ? 'wait' : 'on');
  function renderList(ul, head) {
    const list = (sync.roster || []).slice()
      .sort((a, b) => (Number(b.teacher) - Number(a.teacher)) || String(a.name).localeCompare(String(b.name)));
    head.textContent = 'In the room (' + list.length + ')';
    const sig = JSON.stringify(list.map(x => [x.id, x.name, x.kind, x.app, x.teacher, dotState(x)])) + '|' + sync.id;
    if (ul.dataset.sig === sig) return;
    ul.dataset.sig = sig;
    ul.textContent = '';
    for (const x of list) {
      const li = doc.createElement('li');
      li.className = 'asx-li';
      const dot = doc.createElement('span');
      dot.className = 'asx-dot';
      dot.dataset.s = dotState(x);
      const who = doc.createElement('span');
      who.className = 'asx-who';
      const b = doc.createElement('b');
      b.textContent = x.name + (x.id === sync.id ? ' (you)' : '');
      const sm = doc.createElement('small');
      sm.textContent = [x.kind, appName(x.app)].filter(Boolean).join(', ');
      who.append(b, sm);
      li.append(dot, who);
      if (x.teacher) {
        const tg = doc.createElement('span');
        tg.className = 'asx-tag';
        tg.textContent = 'Teacher';
        li.append(tg);
      }
      ul.append(li);
    }
  }

  function update() {
    if (btn) {
      btn.dataset.state = buttonState();
      btn.setAttribute('aria-label', 'Play together. ' + statusText());
    }
    for (const { r } of panels) {
      r.status.textContent = statusText();
      r.joinrow.hidden = joinedFlag;
      r.inroom.hidden = !joinedFlag || !sync;
      if (!joinedFlag || !sync) continue;
      const t = sync.teacher, me = sync.isTeacher();
      r.teachtext.textContent = !t ? 'Nobody is in control, so anyone can start and stop.'
        : me ? 'You\u2019re in control. Everyone follows you.'
        : t.name + ' is in control. Everyone follows them.';
      r.coderow.hidden = me;
      r.take.textContent = t && !me ? 'Take over' : 'Take control';
      r.release.hidden = !me;
      r.fixhead.textContent = 'Timing on this ' + shortKind(sync.kind);
      r.fixtext.textContent = fixText();
      r.save.textContent = 'Save for every ' + sync.kind;
      r.save.disabled = sync.localFix === 0;
      if (doc.activeElement !== r.name) r.name.value = sync.name;
      renderList(r.list, r.roomhead);
    }
    emit('change', api);
  }

  function toast(text) {
    if (!toastEl) {
      toastEl = doc.createElement('div');
      toastEl.className = 'asx-toast';
      toastEl.setAttribute('role', 'status');
      doc.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400);
  }
  const panelOpen = () => !!(opts && opts.inline) || !!(sheet && !sheet.hidden);

  /* ----- simple apps: turn the room's transport into play/stop calls at the right audio time ----- */
  function clearA() { aTimers.forEach(clearTimeout); aTimers = []; }
  function nextBarBeat(x) {
    const ms = sync.tr.meters || [];
    if (!ms.length) return Math.ceil(x);
    let m = ms[0];
    for (const e of ms) if (e.b0 <= x + 1e-9) m = e;
    return m.b0 + Math.ceil((x - m.b0) / m.bpb - 1e-9) * m.bpb;
  }
  function startAdapterAt(b) {
    const T = sync.beatTime(b);
    const bpm = sync.tempoAt(T + 1);
    const wait = Math.max(0, sync.toLocal(T) + sync.fix() - root.performance.now() - 250);   // a moment before it begins
    aTimers.push(setTimeout(() => {
      if (!adapter || !joinedFlag) return;
      let ctx = null;
      try { ctx = adapter.ctx ? adapter.ctx() : null; } catch (e) { ctx = null; }
      const when = ctx ? sync.toAudioTime(ctx, T) : 0;
      root.__asxLast = { b, T, bpm, when, epoch: ctx && ctx.getOutputTimestamp ? root.performance.timeOrigin + ctx.getOutputTimestamp().performanceTime + (when - ctx.getOutputTimestamp().contextTime) * 1000 : null };
      try { adapter.play(Math.round(bpm), when, T / 1000); } catch (e) { console.error('Room Sync: play', e); }
    }, wait));
  }
  function adapterTransport(tr) {
    if (!adapter || !sync || !joinedFlag) return;
    if (!tr || !tr.playing || !tr.segs || !tr.segs.length) {
      if (aRun !== -1) {
        aRun = -1; aSegKey = '';
        clearA();
        const wait = tr && tr.stopT != null ? Math.max(0, sync.toLocal(tr.stopT) + sync.fix() - root.performance.now()) : 0;
        aTimers.push(setTimeout(() => { try { adapter.stop(); } catch (e) { console.error('Room Sync: stop', e); } }, wait));
      }
      return;
    }
    const last = tr.segs[tr.segs.length - 1];
    if (tr.run !== aRun) {
      aRun = tr.run;
      clearA();
      const nowT = sync.now();
      const b = sync.beatTime(0) < nowT + 300 ? nextBarBeat(sync.beatAt(nowT + 500)) : 0;   // already under way: next bar line
      startAdapterAt(b);
      aSegKey = last.b0 + ':' + last.bpm;
      return;
    }
    const key = last.b0 + ':' + last.bpm;
    if (key !== aSegKey && last.b0 > 0) {   // the tempo changes ahead: everyone restarts together where it begins
      aSegKey = key;
      clearA();
      startAdapterAt(last.b0);
    }
  }

  function onDenied(m) {
    const who = sync.teacher ? sync.teacher.name : 'The teacher';
    if (m.why === 'code') sayAll('teachmsg', 'That code isn\u2019t right.');
    else if (m.why === 'wait') sayAll('teachmsg', 'Too many wrong codes. Try again in a minute.');
    else if (pendingAct === 'save') sayAll('fixmsg', 'Only ' + who + ' can save this for everyone.');
    else sayAll('teachmsg', who + ' is in control.');
    if (!panelOpen() && m.why === 'teacher') toast(who + ' is in control.');
    pendingAct = '';
    emit('denied', m);
    update();
  }

  async function join(fromUser) {
    const where = await servedByRelay();
    if (!where) { if (fromUser) openSheet('away'); update(); return false; }
    if (!root.RoomSync) { console.error('Room Sync: room-sync.js did not load.'); return false; }
    if (!sync) {
      let name = load('name');
      if (!name) {
        name = shortKind(root.RoomSync.deviceKind()) + ' ' + (10 + Math.floor(Math.random() * 90));
        save('name', name);
      }
      sync = new root.RoomSync({ name, app: opts.app || '' });
      sync.on('status', s => { if (s.state === 'connected') everConnected = true; update(); });
      sync.on('lock', update);
      sync.on('roster', update);
      sync.on('teacher', () => {
        if (pendingAct === 'take' && sync.isTeacher()) { sayAll('teachmsg', ''); pendingAct = ''; }
        update();
      });
      sync.on('fix', () => {
        if (pendingAct === 'save' && sync.localFix === 0) { sayAll('fixmsg', 'Saved for every ' + sync.kind + '.'); pendingAct = ''; }
        update();
      });
      sync.on('denied', onDenied);
      sync.on('transport', tr => { adapterTransport(tr); emit('transport', tr); });
      emit('join', sync);
    }
    joinedFlag = true;
    save('on', '1');
    sync.connect();
    wakeOn();
    update();
    return true;
  }
  function leave() {
    joinedFlag = false;
    everConnected = false;
    save('on', '0');
    if (sync) sync.close();
    if (adapter && aRun !== -1) { aRun = -1; clearA(); try { adapter.stop(); } catch (e) { /* app gone */ } }
    wakeOff();
    update();
  }
  function setName(v) {
    v = String(v || '').replace(/[<>]/g, '').trim().slice(0, 24);
    if (!v) return;
    save('name', v);
    if (sync) sync.setName(v);
    update();
  }

  async function wakeOn() {
    if (!('wakeLock' in root.navigator) || !joinedFlag || wake || doc.visibilityState !== 'visible') return;
    try {
      wake = await root.navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } catch (e) { wake = null; }
  }
  function wakeOff() { if (wake) { wake.release().catch(() => {}); wake = null; } }

  function mount(o) {
    if (opts) return api;
    opts = o || {};
    style();
    btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'asx-btn';
    btn.dataset.asx = 'button';
    btn.dataset.state = 'off';
    btn.innerHTML = '<span class="asx-dot" aria-hidden="true"></span><span>Sync</span>';
    if (opts.accent) btn.style.setProperty('--asx-accent', opts.accent);
    if (opts.place) opts.place.appendChild(btn);
    else { btn.classList.add('asx-float'); doc.body.appendChild(btn); }
    if (opts.inline) {
      const p = buildPanel(opts.inline);
      if (opts.accent) p.style.setProperty('--asx-accent', opts.accent);
    }
    btn.addEventListener('click', async () => {
      const where = await servedByRelay();
      if (!where) { openSheet('away'); return; }
      if (!joinedFlag) await join(true);
      if (opts.inline) opts.inline.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'start' });
      else openSheet('room');
    });
    doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') wakeOn(); });
    const params = new URLSearchParams(root.location.search);
    const asked = params.get('sync') === '1';
    const want = opts.auto === true || asked || load('on') === '1';
    if (asked && root.history && root.history.replaceState) {
      params.delete('sync');
      const q = params.toString();
      root.history.replaceState(null, '', root.location.pathname + (q ? '?' + q : '') + root.location.hash);
    }
    servedByRelay().then(w => { if (w && want) join(false); else update(); });
    update();
    return api;
  }

  const api = {
    mount,
    on,
    get sync() { return sync; },
    joined: () => joinedFlag,
    locked: () => !!(joinedFlag && sync && sync.locked()),
    leading: () => !!(joinedFlag && sync && sync.isTeacher()),
    following: () => !!(joinedFlag && sync && sync.teacher && !sync.isTeacher()),
    leaderName: () => (sync && sync.teacher ? sync.teacher.name : ''),
    statusText,
    join: () => join(true),
    leave,
    open: () => servedByRelay().then(w => openSheet(w ? 'room' : 'away')),
    close: closeSheet,
    toast,
    /* simple apps (see the top of this file) */
    register(a, name) {
      adapter = a || null;
      const go = () => mount({ app: slug(name), title: name || '' });
      if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', go); else go();
      return api;
    },
    play(bpm) {
      if (!joinedFlag || !sync || sync.state !== 'connected') return false;
      if (!sync.hasControl()) { toast((sync.teacher ? sync.teacher.name : 'The teacher') + ' is in control.'); return true; }
      sync.start(Math.round(bpm || 120), (sync.tr && sync.tr.bpb) || 4);
      return true;
    },
    stop() {
      if (!joinedFlag || !sync || sync.state !== 'connected') return false;
      if (!sync.hasControl()) { toast((sync.teacher ? sync.teacher.name : 'The teacher') + ' is in control.'); return true; }
      sync.stop();
      return true;
    },
    tempo(bpm) {
      if (!joinedFlag || !sync) return;
      clearTimeout(tempoTimer);
      tempoTimer = setTimeout(() => { if (sync.hasControl()) sync.setTempo(Math.round(bpm)); }, 300);
    },
    now: () => (sync ? sync.now() / 1000 : 0)
  };
  root.AnthosSync = api;
})(window);
