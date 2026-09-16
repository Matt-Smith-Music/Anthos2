/*
  Anthos Room Sync: the part that goes into each app.
  (c) Matt Smith

  const sync = new RoomSync({ name: 'Matt' }).connect();   // talks to the relay that served this page
  sync.now()                     relay time in ms, as this device best knows it
  sync.toAudioTime(ctx, T)       AudioContext time to schedule at, so the sound is HEARD at relay time T
  sync.createScheduler(ctx, fn)  calls fn({b, when, pos, heard, bpm, mark}) for every beat to play and books it ahead;
                                 copes with joining mid-groove, tempo and metre changes, stops and clock steps
  sync.share(key, value)         (whoever has control) tells every device in the same app, e.g. where the navigator is
  sync.on('share', fn)           ...and the others hear it: fn({key, v, from})
  sync.mark(tag, {bpm, bpb})     (whoever has control) a musical change every device makes on the same bar line;
                                 sync.markAt(beat) says which tag is in force for any beat

  How the clock lock works
  - The device pings the relay every 2 seconds (0.7 s on a poor link; a burst of 12 when it connects or wakes up).
  - Each ping gives an estimate of the gap between this device's clock and the relay's, plus how
    uncertain that estimate is (half the round trip). The least uncertain recent reading wins.
  - While music is playing, small corrections glide in (at most 5 ms a second, too small to hear).
    A jump of 15 ms or more (a phone that slept, a relay restart) is applied at once and anything
    already booked is rebooked. One odd reading is never trusted on its own: it takes three that agree.
  - A phone that was asleep (its clock stood still) plays nothing until a fresh reading confirms the lock,
    and a relay that restarted is spotted at once and measured from scratch.
*/
(function (root) {
  'use strict';

  const BURST = 12;           // pings in a quick burst
  const BURST_GAP = 60;       // ms between burst pings
  const PING_SLOW = 2000;     // ms between regular pings on a good link
  const PING_FAST = 700;      // ...and on a poor one, to catch more clean readings
  const VERIFY_GAP = 25;      // ms: a clock that stood still longer than this (phone asleep) is re-checked
  const SHARE_GAP = 50;       // ms: shared app state goes out at most 20 times a second
  const WINDOW = 32;          // readings kept
  const STEP_MS = 15;         // jump straight to a new estimate this far out
  const SLEW_MIN = 0.5;       // otherwise glide, between 0.5 and 5 ms per second
  const SLEW_MAX = 5;         // (5 ms a second is a 0.5% tempo nudge, too small to hear)
  const DRIFT_PER_SEC = 0.05; // allowance for two clocks running at slightly different speeds (50 ppm)
  const REPORT_EVERY = 4000;

  const perfNow = () => performance.now();

  function store(k, v) {
    try {
      if (v === undefined) return root.localStorage.getItem(k);
      root.localStorage.setItem(k, String(v));
    } catch (e) { /* storage blocked: fine */ }
    return null;
  }

  class RoomSync {
    constructor(opts) {
      opts = opts || {};
      this.kind = opts.kind || RoomSync.deviceKind();
      this.app = opts.app || '';
      this.name = opts.name || this.kind;
      this.url = opts.url || RoomSync.defaultUrl();
      this.dev = opts.dev || RoomSync.deviceToken();
      this.clock = opts.clock || perfNow;
      this.WS = opts.WebSocket || root.WebSocket;

      this.samples = [];
      this.best = null;
      this._fresh = null; this._against = 0;
      this.off = null; this.target = 0; this.slewAt = 0; this.slewRate = SLEW_MIN; this._hadLock = false;
      this._verify = false; this._gap = null; this._boot = null;
      this._shared = new Map(); this._shareAt = new Map(); this._sharePend = new Map();

      this.tr = null; this.teacher = null; this.roster = []; this.id = null;
      this.state = 'idle';
      this.soundState = '';

      this._fixKey = 'roomsync.fix.' + this.kind;
      const lf = Number(store(this._fixKey));
      this.localFix = Number.isFinite(lf) ? lf : 0;
      this.sharedFix = 0;
      this._savingFix = null;

      this._h = {};
      this._seq = 0;
      this._sent = new Map();
      this._retry = 0;
      this._userClosed = true;
      this._onVis = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          if (this.ws && this.ws.readyState === 1) this.remeasure();
          else if (!this._userClosed) this._open();
        }
      };
    }

    /* ----- events: status, lock, step, transport, roster, teacher, fix, denied, welcome, share ----- */
    on(ev, fn) {
      (this._h[ev] = this._h[ev] || []).push(fn);
      return () => { this._h[ev] = (this._h[ev] || []).filter(f => f !== fn); };
    }
    _emit(ev, a) {
      for (const f of (this._h[ev] || []).slice()) {
        try { f(a); } catch (e) { console.error('RoomSync ' + ev + ' handler:', e); }
      }
    }

    /* ----- connection ----- */
    connect() {
      this._userClosed = false;
      if (typeof document !== 'undefined' && !this._visBound) {
        document.addEventListener('visibilitychange', this._onVis);
        root.addEventListener('pageshow', this._onVis);
        root.addEventListener('online', this._onVis);
        this._visBound = true;
      }
      this._open();
      return this;
    }
    close() {
      this._userClosed = true;
      clearTimeout(this._reconnectTimer);
      if (this.ws) { const ws = this.ws; this._dropSocket(); try { ws.close(); } catch (e) { /* gone */ } }
      this._setState('idle');
    }
    _open() {
      clearTimeout(this._reconnectTimer);
      if (this.ws && this.ws.readyState <= 1) return;
      this._setState('connecting');
      let ws;
      try { ws = new this.WS(this.url); } catch (e) { this._setState('disconnected', String(e.message || e)); this._later(); return; }
      this.ws = ws;
      ws.onopen = () => {
        if (this.ws !== ws) return;
        this._retry = 0;
        this._setState('connected');
        this._send({ t: 'hello', name: this.name, kind: this.kind, dev: this.dev, app: this.app });
        this.remeasure();
        clearInterval(this._reporter);
        this._schedulePing();
        this._reporter = setInterval(() => this._report(), REPORT_EVERY);
      };
      ws.onmessage = ev => {
        const rx = this.clock();
        if (this.ws === ws) this._msg(ev.data, rx);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this._dropSocket();
        this._setState('disconnected');
        if (!this._userClosed) this._later();
      };
      ws.onerror = () => { /* onclose follows */ };
    }
    _dropSocket() {
      this.ws = null;
      clearTimeout(this._pinger); clearInterval(this._reporter); clearTimeout(this._burstTimer);
      for (const p of this._sharePend.values()) clearTimeout(p.timer);
      this._sharePend.clear();
      this._sent.clear();
    }
    _later() {
      clearTimeout(this._reconnectTimer);
      const wait = Math.min(8000, 400 * Math.pow(1.6, this._retry++));
      this._reconnectTimer = setTimeout(() => this._open(), wait);
    }
    _send(o) {
      if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(o)); return true; }
      return false;
    }
    _setState(s, why) { this.state = s; this._emit('status', { state: s, why }); }

    /* ----- clock lock ----- */
    remeasure() {
      // Called on connect and whenever the page comes back into view. Old readings are kept: if this
      // device slept and its clock moved, the new readings won't square with them and take over.
      // If the clock visibly stood still (a phone asleep), nothing plays until a fresh reading agrees.
      if (this.off !== null && this._gap !== null && !this._verify && Math.abs(this._gapNow() - this._gap) > VERIFY_GAP) {
        this._verify = true;
        this._emit('lock', this.lock());
      }
      this._burst(BURST);
    }
    _gapNow() { return Date.now() - this.clock(); }
    _schedulePing() {
      clearTimeout(this._pinger);
      const poor = !this.best || this.best.rtt > 10;
      this._pinger = setTimeout(() => { this._ping(); this._schedulePing(); }, poor ? PING_FAST : PING_SLOW);
    }
    _burst(count) {
      clearTimeout(this._burstTimer);
      let n = 0;
      const go = () => {
        if (n++ < count && this._ping()) this._burstTimer = setTimeout(go, BURST_GAP);
      };
      go();
    }
    _ping() {
      if (!this.ws || this.ws.readyState !== 1) return false;
      const i = ++this._seq;
      const c = this.clock();
      this._sent.set(i, c);
      if (this._sent.size > 40) this._sent.delete(this._sent.keys().next().value);
      this.ws.send('{"t":"ping","i":' + i + ',"c":' + c + '}');
      return true;
    }
    _pong(m, rx) {
      const c0 = this._sent.get(m.i);
      if (c0 === undefined) return;
      this._sent.delete(m.i);
      const r = Number(m.r), s = Number(m.s);
      const rtt = (rx - c0) - (s - r);
      if (!(rtt >= 0) || rtt > 3000) return;
      const smp = { rtt, theta: ((r - c0) + (s - rx)) / 2, at: rx };
      const best = this.best;
      if (!best) { this._add(smp); this._verify = false; this._update(rx); return; }
      const fitsOld = this._agree(smp, best);
      if (this._fresh) {
        const fitsNew = this._agree(smp, this._pick(this._fresh, rx));
        if (!fitsOld && fitsNew) this._fresh.push(smp);
        else if (!fitsOld && !fitsNew) this._fresh = [smp];
        else if (fitsOld && !fitsNew && ++this._against >= 2) this._fresh = null;
        if (this._fresh && this._fresh.length >= 3) {
          // Three readings that agree with each other and not with the old ones: the clock really moved.
          this.samples = this._fresh;
          this._fresh = null;
          this.best = null;
          this._verify = false;
          this._update(rx);
          return;
        }
      } else if (!fitsOld) {
        // One odd reading can be a hiccup. Ask again quickly and only believe it if it repeats.
        this._fresh = [smp];
        this._against = 0;
        this._burst(6);
        return;
      }
      if (fitsOld) { this._add(smp); this._verify = false; this._update(rx); }
    }
    _add(smp) {
      this.samples.push(smp);
      if (this.samples.length > WINDOW) this.samples.shift();
    }
    // Two honest readings always overlap within half their round trips (plus a little for clock speed).
    _agree(a, b) {
      const age = Math.abs(a.at - b.at) / 1000;
      return Math.abs(a.theta - b.theta) <= a.rtt / 2 + b.rtt / 2 + age * DRIFT_PER_SEC + 2;
    }
    _score(smp, t) { return smp.rtt / 2 + ((t - smp.at) / 1000) * DRIFT_PER_SEC; }
    _pick(list, t) {
      let best = null, sc = Infinity;
      for (const x of list) { const v = this._score(x, t); if (v < sc) { sc = v; best = x; } }
      return best;
    }
    _update(t) {
      if (!this.samples.length) return;
      // Best reading = shortest round trip (least room for error), newer preferred.
      // Readings nearly as good are averaged in to smooth out random delays.
      const best = this._pick(this.samples, t);
      const limit = this._score(best, t) + 0.5;
      let wsum = 0, tsum = 0;
      for (const x of this.samples) {
        if (this._score(x, t) <= limit) { const w = 1 / (0.5 + x.rtt); wsum += w; tsum += w * x.theta; }
      }
      const est = tsum / wsum;
      this.best = best;
      const cur = this.off === null ? null : this._offAt(t);
      // Before the first lock, or while nothing is playing, just take the new figure.
      const quiet = !this._hadLock || !this.playing();
      if (cur === null || quiet || Math.abs(est - cur) > STEP_MS) {
        this.off = est;
        this.target = est;
        this.slewAt = t;
        if (cur !== null && Math.abs(est - cur) > 0.05) this._emit('step', { by: est - cur, quiet });
      } else {
        // While playing, glide: fast enough to fix a few ms within about two seconds, slow enough not to hear.
        this.off = cur;
        this.target = est;
        this.slewAt = t;
        this.slewRate = Math.min(SLEW_MAX, Math.max(SLEW_MIN, Math.abs(est - cur) / 2));
      }
      if (this.samples.length >= 3 && (best.rtt <= 40 || this.samples.length >= BURST)) this._hadLock = true;
      this._gap = this._gapNow();
      this._emit('lock', this.lock());
    }
    _offAt(t) {
      if (this.off === null) return 0;
      const room = ((t - this.slewAt) / 1000) * this.slewRate;
      const d = this.target - this.off;
      return Math.abs(d) <= room ? this.target : this.off + Math.sign(d) * room;
    }
    _resetClock() {
      this.samples = []; this.best = null; this._fresh = null; this._against = 0;
      this.off = null; this.target = 0; this.slewRate = SLEW_MIN;
      this._hadLock = false; this._verify = false; this._gap = null;
      this._emit('lock', this.lock());
    }
    locked() { return this.off !== null && this._hadLock && !this._verify; }
    lock() {
      return {
        locked: this.locked(),
        err: this.best ? this.best.rtt / 2 : null,
        rtt: this.best ? this.best.rtt : null,
        readings: this.samples.length
      };
    }
    now() { const t = this.clock(); return t + this._offAt(t); }
    toLocal(T) { return T - this._offAt(this.clock()); }

    /* ----- timing fix: minus plays earlier, plus plays later ----- */
    fix() { return this.sharedFix + this.localFix; }
    nudgeFix(ms) {
      this.localFix = Math.max(-500, Math.min(500, Math.round(this.localFix + ms)));
      store(this._fixKey, this.localFix);
      this._emit('fix', this.fix());
    }
    resetFix() { this.localFix = 0; store(this._fixKey, 0); this._emit('fix', this.fix()); }
    saveFixForRoom() {
      const ms = this.fix();
      if (this._send({ t: 'cal', ms })) { this._savingFix = ms; return true; }
      return false;
    }

    /* ----- audio timing ----- */
    toAudioTime(ctx, T) {
      const t = this.clock();
      const heard = T - this._offAt(t) + this.fix();   // this device's clock, when it should be heard
      let ctxT, perfT;
      const ts = (this.clock === perfNow && typeof ctx.getOutputTimestamp === 'function') ? ctx.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
        // The browser's own pairing of "this audio sample" with "the moment it leaves the speaker"
        ctxT = ts.contextTime;
        perfT = ts.performanceTime;
      } else {
        ctxT = ctx.currentTime;
        perfT = t + ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000;
      }
      return ctxT + (heard - perfT) / 1000;
    }

    /* ----- the room's transport ----- */
    _seg(b) { const g = this.tr.segs; let s = g[0]; for (const x of g) if (x.b0 <= b) s = x; return s; }
    beatTime(b) { const s = this._seg(b); return s.t0 + (b - s.b0) * 60000 / s.bpm; }
    beatAt(T) {
      const g = this.tr.segs; let s = g[0];
      for (const x of g) if (x.t0 <= T) s = x;
      return s.b0 + (T - s.t0) * s.bpm / 60000;
    }
    tempoAt(T) { const g = this.tr.segs; let s = g[0]; for (const x of g) if (x.t0 <= T) s = x; return s.bpm; }
    barPos(b) {
      const ms = this.tr.meters; let m = ms[0];
      for (const x of ms) if (x.b0 <= b) m = x;
      const rel = b - m.b0;
      const beat = ((rel % m.bpb) + m.bpb) % m.bpb;
      return { bar: m.bar0 + Math.floor(rel / m.bpb), beat, bpb: m.bpb, downbeat: beat === 0 };
    }
    playing() { return !!(this.tr && this.tr.playing && this.tr.segs && this.tr.segs.length); }

    start(bpm, bpb) { return this._send({ t: 'start', bpm, bpb }); }
    stop() { return this._send({ t: 'stop' }); }
    setTempo(bpm) { return this._send({ t: 'tempo', bpm }); }
    setMeter(bpb) { return this._send({ t: 'meter', bpb }); }
    setName(name) { this.name = name; return this._send({ t: 'name', name }); }
    takeControl(code) { return this._send({ t: 'control', code: String(code) }); }
    releaseControl() { return this._send({ t: 'release' }); }
    isTeacher() { return !!this.teacher && this.teacher.dev === this.dev; }
    hasControl() { return !this.teacher || this.teacher.dev === this.dev; }
    setSoundState(s) { this.soundState = s; }

    /* ----- shared app state, and musical changes that land on a bar line ----- */
    share(key, v) {
      const t = this.clock();
      const last = this._shareAt.has(key) ? this._shareAt.get(key) : -1e9;
      this._shared.set(key, { v, from: this.name, at: null, mine: true });
      const pend = this._sharePend.get(key);
      if (pend) { pend.v = v; return true; }
      if (t - last >= SHARE_GAP) { this._shareAt.set(key, t); return this._send({ t: 'share', key, v }); }
      const p = { v, timer: null };
      p.timer = setTimeout(() => {
        this._sharePend.delete(key);
        this._shareAt.set(key, this.clock());
        this._send({ t: 'share', key, v: p.v });   // the latest value always goes out
      }, Math.max(0, SHARE_GAP - (t - last)));
      this._sharePend.set(key, p);
      return true;
    }
    shared(key) { const x = this._shared.get(key); return x ? x.v : undefined; }
    mark(tag, o) {
      o = o || {};
      return this._send({ t: 'mark', tag: tag === undefined ? null : tag, bpm: o.bpm, bpmEnd: o.bpmEnd, bpb: o.bpb, at: o.at });
    }
    markAt(b) {
      const ms = this.tr && this.tr.marks;
      if (!ms || !ms.length) return null;
      let x = null;
      for (const k of ms) if (k.b0 <= b) x = k;
      return x ? x.tag : null;
    }
    _report() {
      const l = this.lock();
      this._send({ t: 'report', err: l.err == null ? null : Math.round(l.err * 10) / 10, fix: this.fix(), sound: this.soundState });
    }

    _msg(data, rx) {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      switch (m.t) {
        case 'pong': this._pong(m, rx); return;
        case 'welcome':
          if (m.boot && this._boot && m.boot !== this._boot) this._resetClock();   // the relay restarted: its clock began again
          this._boot = m.boot || null;
          this.id = m.id;
          this.sharedFix = Number(m.cal) || 0;
          this.teacher = m.teacher || null;
          this.roster = m.roster || [];
          this.tr = m.tr || null;
          this._shared = new Map(Object.entries(m.shared || {}));
          this._emit('welcome', m);
          this._emit('teacher', this.teacher);
          this._emit('roster', this.roster);
          this._emit('fix', this.fix());
          this._emit('transport', this.tr);
          for (const [key, x] of this._shared) this._emit('share', { key, v: x.v, from: x.from, at: x.at, initial: true });
          return;
        case 'share':
          if (m.app !== this.app) return;
          this._shared.set(m.key, { v: m.v, from: m.from, at: m.at });
          this._emit('share', { key: m.key, v: m.v, from: m.from, at: m.at });
          return;
        case 'transport':
          if (!m.tr || (this.tr && m.tr.rev <= this.tr.rev)) return;
          this.tr = m.tr;
          this._emit('transport', this.tr);
          return;
        case 'roster': this.roster = m.list || []; this._emit('roster', this.roster); return;
        case 'teacher': this.teacher = m.teacher || null; this._emit('teacher', this.teacher); return;
        case 'cal':
          if (m.kind !== this.kind) return;
          this.sharedFix = Number(m.ms) || 0;
          if (this._savingFix !== null && this._savingFix === this.sharedFix) {
            this._savingFix = null;
            this.localFix = 0;
            store(this._fixKey, 0);
          }
          this._emit('fix', this.fix());
          return;
        case 'denied':
          if (m.teacher !== undefined) this.teacher = m.teacher;
          this._savingFix = null;
          this._emit('denied', m);
          return;
      }
    }

    createScheduler(ctx, onBeat, opts) { return new BeatScheduler(this, ctx, onBeat, opts); }

    /* ----- helpers ----- */
    static defaultUrl(loc) {
      loc = loc || root.location;
      const q = loc && loc.search ? new URLSearchParams(loc.search).get('relay') : null;
      if (q) return /^wss?:\/\//i.test(q) ? q : 'ws://' + q.replace(/\/+$/, '') + '/sync';
      return (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/sync';
    }
    static deviceKind(nav) {
      nav = nav || root.navigator || {};
      const ua = nav.userAgent || '';
      const touch = nav.maxTouchPoints || 0;
      let d;
      if (/iPhone|iPod/.test(ua)) d = 'iPhone';
      else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) d = 'iPad';
      else if (/CrOS/.test(ua)) d = 'Chromebook';
      else if (/Android/.test(ua)) d = /Mobile/.test(ua) ? 'Android phone' : 'Android tablet';
      else if (/Macintosh|Mac OS X/.test(ua)) d = 'Mac';
      else if (/Windows/.test(ua)) d = 'Windows';
      else if (/Linux/.test(ua)) d = 'Linux';
      else d = 'Device';
      if (d === 'iPhone' || d === 'iPad' || d === 'Chromebook') return d;   // one audio engine each
      const b = /Edg[A]?\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
      return d + ' (' + b + ')';
    }
    static deviceToken() {
      let t = store('roomsync.dev');
      if (!t) {
        t = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        store('roomsync.dev', t);
      }
      return t;
    }
  }

  class BeatScheduler {
    constructor(sync, ctx, onBeat, opts) {
      opts = opts || {};
      this.sync = sync;
      this.ctx = ctx;
      this.onBeat = onBeat;
      this.ahead = (opts.lookahead || 200) / 1000;   // seconds booked in advance
      this.queue = [];
      this.run = null;
      this.next = null;
      const rebook = () => this.rebook();
      this._offs = [sync.on('transport', rebook), sync.on('step', rebook), sync.on('fix', rebook)];
      this._timer = setInterval(() => this.tick(), opts.tick || 25);
    }
    destroy() {
      clearInterval(this._timer);
      this._offs.forEach(f => f());
      this.queue.forEach(q => this._kill(q));
      this.queue = [];
    }
    _kill(q) {
      for (const n of q.nodes) {
        try { if (n.stop) n.stop(0); } catch (e) { /* already stopped */ }
        try { n.disconnect(); } catch (e) { /* already disconnected */ }
      }
    }
    // Take back anything booked that hasn't sounded yet (more than 30 ms away) and book it again with the latest timing.
    rebook() {
      const tr = this.sync.tr;
      const cut = this.ctx.currentTime + 0.03;
      const keep = [];
      for (const q of this.queue) {
        let drop = false;
        if (q.when > cut) {
          if (!tr || q.run !== tr.run) drop = true;
          else if (!tr.playing) drop = tr.stopT != null && q.T >= tr.stopT;
          else drop = true;
        }
        if (drop) this._kill(q); else keep.push(q);
      }
      this.queue = keep;
      this.next = null;
      this.tick();
    }
    tick() {
      const s = this.sync, tr = s.tr, ctx = this.ctx;
      const nowA = ctx.currentTime;
      if (this.queue.length && this.queue[0].when < nowA - 1) this.queue = this.queue.filter(q => q.when >= nowA - 1);
      if (!s.playing() || !s.locked() || ctx.state !== 'running') return;
      if (this.run !== tr.run) { this.run = tr.run; this.next = null; }
      if (this.next === null) {
        let last = -1;
        for (const q of this.queue) if (q.run === tr.run && q.b > last) last = q.b;
        this.next = Math.max(0, last + 1, Math.ceil(s.beatAt(s.now()) - 1e-6));
      }
      for (let guard = 0; guard < 64; guard++) {
        const b = this.next;
        const T = s.beatTime(b);
        const when = s.toAudioTime(ctx, T);
        if (when > ctx.currentTime + this.ahead) break;
        this.next = b + 1;
        if (when < ctx.currentTime - 0.025) continue;   // too late to play cleanly (just joined, or the page was busy)
        const at = Math.max(when, ctx.currentTime);
        let nodes = null;
        try {
          nodes = this.onBeat({ b, T, when: at, pos: s.barPos(b), heard: s.toLocal(T) + s.fix(), bpm: s.tempoAt(T), mark: s.markAt(b) });
        } catch (e) { console.error('RoomSync beat handler:', e); }
        this.queue.push({ run: tr.run, b, T, when: at, nodes: Array.isArray(nodes) ? nodes : [] });
      }
    }
  }

  RoomSync.BeatScheduler = BeatScheduler;
  RoomSync.version = '2.1';
  root.RoomSync = RoomSync;
  if (typeof module !== 'undefined' && module.exports) module.exports = RoomSync;
})(typeof window !== 'undefined' ? window : globalThis);
