// Local-first store. The UI reads only from memory and re-renders instantly;
// the network is asynchronous replication that catches up behind it.
//
// Sync contract with the Worker:
//   - every row carries a server-assigned `rev`
//   - clients pull `GET /api/sync?since=<lastRev>`
//   - `lastRev` advances ONLY from a pull response. Never from a mutate
//     response: another device may hold a lower rev we haven't seen yet, and
//     trusting our own write's rev would skip straight past it.

const LS_CACHE = 'wt.cache.v1';
const LS_QUEUE = 'wt.queue.v1';
const LS_CLIENT = 'wt.client.v1';

const uid = () =>
  Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);

function loadClientId() {
  let v = localStorage.getItem(LS_CLIENT);
  if (!v) {
    v = uid();
    localStorage.setItem(LS_CLIENT, v);
  }
  return v;
}

export const newId = uid;

class Store {
  constructor() {
    this.clientId = loadClientId();
    this.jobs = new Map();
    this.shifts = new Map();
    this.payments = new Map();
    this.lastRev = 0;
    this.status = 'connecting'; // connecting | live | offline
    this.lastError = null;
    this.listeners = new Set();
    this.queue = [];
    this.ws = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pollTimer = null;
    this.flushing = false;

    this.#restore();
  }

  // --- persistence -------------------------------------------------------

  #restore() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_CACHE) || 'null');
      if (raw) {
        for (const j of raw.jobs || []) this.jobs.set(j.id, j);
        for (const s of raw.shifts || []) this.shifts.set(s.id, s);
        for (const p of raw.payments || []) this.payments.set(p.id, p);
        this.lastRev = raw.lastRev || 0;
      }
      this.queue = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]');
    } catch {
      // A corrupt cache must never brick the app: drop it and re-pull.
      this.jobs.clear(); this.shifts.clear(); this.payments.clear();
      this.lastRev = 0;
      this.queue = [];
    }
  }

  #persist() {
    try {
      localStorage.setItem(LS_CACHE, JSON.stringify({
        lastRev: this.lastRev,
        jobs: [...this.jobs.values()],
        shifts: [...this.shifts.values()],
        payments: [...this.payments.values()],
      }));
      localStorage.setItem(LS_QUEUE, JSON.stringify(this.queue));
    } catch {
      // Quota exceeded — the server is still the source of truth, so this is
      // recoverable on next pull. Don't let it break the write path.
    }
  }

  // --- reads -------------------------------------------------------------

  get data() {
    return {
      jobs: this.activeJobs,
      shifts: [...this.shifts.values()].filter((s) => !s.deleted),
      payments: [...this.payments.values()].filter((p) => !p.deleted),
    };
  }

  get activeJobs() {
    return [...this.jobs.values()]
      .filter((j) => !j.deleted)
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.created_ms - b.created_ms);
  }

  job(id) { return this.jobs.get(id) || null; }

  /** The single currently-open shift, if any. */
  get openShift() {
    return [...this.shifts.values()].find((s) => !s.deleted && (s.end_ms === null || s.end_ms === undefined)) || null;
  }

  // --- subscriptions -----------------------------------------------------

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit() {
    this.#persist();
    for (const fn of this.listeners) {
      try { fn(this); } catch (e) { console.error('listener failed', e); }
    }
  }

  #setStatus(s, err = null) {
    if (this.status === s && this.lastError === err) return;
    this.status = s;
    this.lastError = err;
    this.#emit();
  }

  // --- writes ------------------------------------------------------------

  /**
   * Apply ops locally at once, then replicate. The UI never waits on the
   * network; a failed send stays queued and retries.
   */
  mutate(ops) {
    for (const { type, op, data } of ops) {
      const map = { job: this.jobs, shift: this.shifts, payment: this.payments }[type];
      if (!map) continue;
      if (op === 'delete') {
        const cur = map.get(data.id);
        if (cur) map.set(data.id, { ...cur, deleted: 1 });
      } else {
        map.set(data.id, { ...(map.get(data.id) || {}), ...data, deleted: 0 });
      }
    }
    this.queue.push(ops);
    this.#emit();
    this.#flush();
  }

  async #flush() {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const batch = this.queue[0];
        const res = await fetch('/api/mutate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ops: batch, origin: this.clientId }),
        });
        if (res.status === 401) { this.#setStatus('offline', 'Session expired — reload to sign in.'); return; }
        if (!res.ok) {
          // 4xx means this batch will never succeed; drop it rather than
          // wedging the queue behind a permanently-bad write.
          if (res.status >= 400 && res.status < 500) { this.queue.shift(); this.#persist(); continue; }
          throw new Error('HTTP ' + res.status);
        }
        this.queue.shift();
        this.#persist();
      }
      await this.pull();
    } catch (e) {
      this.#setStatus('offline', String(e.message || e));
    } finally {
      this.flushing = false;
    }
  }

  // --- pull --------------------------------------------------------------

  async pull() {
    try {
      const res = await fetch('/api/sync?since=' + this.lastRev, { cache: 'no-store' });
      if (res.status === 401) { this.#setStatus('offline', 'Session expired — reload to sign in.'); return; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();

      for (const j of d.jobs) this.jobs.set(j.id, j);
      for (const s of d.shifts) this.shifts.set(s.id, s);
      for (const p of d.payments) this.payments.set(p.id, p);
      this.lastRev = d.rev;

      this.status = 'live';
      this.lastError = null;
      this.#emit();
    } catch (e) {
      this.#setStatus('offline', String(e.message || e));
    }
  }

  // --- realtime ----------------------------------------------------------

  connect() {
    this.pull();
    this.#openSocket();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.pull();
        this.#flush();
        if (!this.ws || this.ws.readyState > 1) this.#openSocket();
      }
    });
    window.addEventListener('online', () => { this.#flush(); this.pull(); this.#openSocket(); });
  }

  #openSocket() {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    clearTimeout(this.reconnectTimer);

    let ws;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      this.#setStatus('live');
      this.#stopPolling();
      clearInterval(this.pingTimer);
      // Auto-answered by the Durable Object without waking it, so this is
      // effectively free — it just stops idle intermediaries dropping us.
      this.pingTimer = setInterval(() => {
        if (ws.readyState === 1) ws.send('ping');
      }, 45000);
    };

    ws.onmessage = (ev) => {
      if (ev.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      // Skip our own echo; we already applied it optimistically.
      if (msg.type === 'changed' && msg.origin !== this.clientId) this.pull();
    };

    ws.onclose = () => { clearInterval(this.pingTimer); this.#scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  #scheduleReconnect() {
    // Fall back to polling while the socket is down so the app still converges.
    this.#startPolling();
    const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempt++);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.#openSocket(), delay);
  }

  #startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible') this.pull();
    }, 15000);
  }

  #stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // --- export ------------------------------------------------------------

  exportJson() {
    const d = this.data;
    return JSON.stringify({ exportedAt: new Date().toISOString(), ...d }, null, 2);
  }

  exportCsv() {
    const jobName = (id) => this.job(id)?.name ?? id;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const iso = (t) => (t ? new Date(t).toISOString() : '');
    const lines = ['record,job,start,end,hours,break_hours,amount,set_aside,note'];
    for (const s of this.data.shifts.sort((a, b) => a.start_ms - b.start_ms)) {
      const worked = (s.end_ms ? (s.end_ms - s.start_ms) : 0);
      let brk = 0;
      for (const b of s.breaks || []) if (b.e) brk += b.e - b.s;
      lines.push(['shift', esc(jobName(s.job_id)), iso(s.start_ms), iso(s.end_ms),
        ((worked - brk) / 3600000).toFixed(4), (brk / 3600000).toFixed(4), '', '', esc(s.note)].join(','));
    }
    for (const p of this.data.payments.sort((a, b) => a.paid_ms - b.paid_ms)) {
      lines.push(['payment', esc(jobName(p.job_id)), iso(p.paid_ms), '', '', '',
        (p.amount_cents / 100).toFixed(2), (p.set_aside_cents / 100).toFixed(2), esc(p.note)].join(','));
    }
    return lines.join('\n');
  }
}

export const store = new Store();
