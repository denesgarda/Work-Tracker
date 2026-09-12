// Expenses: an optional, separate ledger of business costs per job, with the
// receipts attached. Nothing here feeds the time-to-money figures — those are
// untouched by anything in this file.

import * as X from './expenses.js';
import { makeZip } from './zip.js';
import { uploadAttachment, deleteAttachment, fileUrl, isImage } from './files.js';

// Meals are 50% deductible by law; everything else starts at 100% and can be
// changed per category in Setup.
const SUGGESTED = [
  ['Equipment', 100], ['Software & subscriptions', 100], ['Props & wardrobe', 100],
  ['Supplies', 100], ['Phone & internet', 100], ['Travel', 100], ['Meals', 50],
  ['Advertising & marketing', 100], ['Education & courses', 100], ['Home office', 100],
  ['Professional fees', 100], ['Other', 100],
];

const cents = (v) => Math.round((parseFloat(v) || 0) * 100);

async function pool(items, size, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
}

export function initExpenses(ctx) {
  const {
    store, newId, $, esc, money, money0, openSheet, closeSheet, toast, deleteWithUndo,
    toDateInput, fromDateInput, currentJobId, jobOptions, fillJobSelect, download,
  } = ctx;

  const st = { job: '', year: String(new Date().getFullYear()), category: '', status: '', limit: 60 };
  const cats = () => store.activeCategories;

  const period = (year) => (year
    ? { from: new Date(+year, 0, 1).getTime(), to: new Date(+year + 1, 0, 1).getTime(), label: String(year) }
    : { from: -Infinity, to: Infinity, label: 'all years' });

  const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const monthStart = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
  const monthLabel = (t) => new Date(t).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  // ── the Expenses tab ─────────────────────────────────────────

  function render() {
    const data = store.data;
    const cs = cats();
    fillJobSelect($('#expJob'), st.job, 'All jobs');

    const years = X.yearsWithExpenses(data.expenses);
    $('#expYear').innerHTML = years.map((y) =>
      `<option value="${y}"${String(y) === st.year ? ' selected' : ''}>${y}</option>`).join('') +
      `<option value=""${st.year === '' ? ' selected' : ''}>All years</option>`;

    if (st.category && st.category !== '__none' && !store.category(st.category)) st.category = '';
    $('#expCategory').innerHTML = '<option value="">All categories</option>' +
      cs.map((c) => `<option value="${esc(c.id)}"${c.id === st.category ? ' selected' : ''}>${esc(c.name)}</option>`).join('') +
      `<option value="__none"${st.category === '__none' ? ' selected' : ''}>${X.UNCATEGORIZED}</option>`;

    const p = period(st.year);
    // Counts come from everything the other filters allow, so switching
    // between chips never changes the numbers on them.
    const base = X.filterExpenses(data.expenses, cs, { jobId: st.job, from: p.from, to: p.to, category: st.category });
    const counts = X.attentionCounts(base);
    const list = st.status ? base.filter((e) => X.attentionOf(e).includes(st.status)) : base;
    const sum = X.summarizeExpenses(list, cs);

    $('#expAttention').hidden = !base.length;
    $('#expAttention').innerHTML = '<h2 class="card-title">Needs attention</h2><div class="chips">' +
      X.ATTENTION.map((a) => `<button class="chip${st.status === a.key ? ' is-active' : ''}" data-att="${a.key}"
          type="button"${counts[a.key] ? '' : ' disabled'}>
          <span class="n">${counts[a.key]}</span><span class="l">${esc(a.label)}</span></button>`).join('') +
      '</div>';
    const personal = sum.totalCents - sum.businessCents;
    const missing = sum.count - sum.withReceipts;

    $('#expTiles').innerHTML = `
      <div class="tile lead"><div class="k">Deductible — ${esc(p.label)}</div>
        <div class="v money">${money(sum.deductibleCents)}</div>
        <div class="sub">${!sum.count ? 'Nothing logged yet'
          : sum.deductibleCents !== sum.businessCents
            ? `${money(sum.businessCents)} business use, reduced by category limits`
          : personal > 0 ? `${money(personal)} of what you paid was personal`
          : 'All of it was fully for business'}</div></div>
      <div class="tile"><div class="k">Total paid</div><div class="v">${money0(sum.totalCents)}</div></div>
      <div class="tile"><div class="k">Transactions</div><div class="v">${sum.count}</div></div>`;

    // Grouped by id rather than name, so two categories can share a name.
    const bd = $('#expBreakdown');
    if (sum.count && !st.category) {
      const groups = new Map();
      for (const e of list) {
        const c = store.category(e.category_id);
        const k = c ? c.id : '__none';
        const g = groups.get(k) || {
          k, name: c ? c.name : X.UNCATEGORIZED, count: 0, biz: 0,
          pct: X.categoryPct(cs, e.category_id),
        };
        g.count++;
        g.biz += X.deductibleCents(e, cs);
        groups.set(k, g);
      }
      bd.hidden = false;
      bd.innerHTML = '<h2 class="card-title">By category</h2><dl class="statlist">' +
        [...groups.values()].sort((a, b) => b.biz - a.biz).map((g) =>
          `<div><button class="statrow" type="button" data-expcat="${esc(g.k)}">
             <dt>${esc(g.name)}<span class="cnt">${g.count}</span>${g.pct < 100 ? `<span class="cnt">${g.pct}%</span>` : ''}</dt>
             <dd>${money(g.biz)}</dd></button></div>`).join('') +
        '</dl>';
    } else {
      bd.hidden = true;
    }

    const sorted = [...list].sort((a, b) => b.spent_ms - a.spent_ms);
    const shown = sorted.slice(0, st.limit);
    const el = $('#expList');
    if (!shown.length) {
      el.innerHTML = `<p class="empty">${data.expenses.length
        ? 'No expenses match these filters.'
        : 'No expenses yet. Add one, and attach a photo of the receipt while it’s still in your hand.'}</p>`;
    } else {
      const byMonth = new Map();
      for (const e of shown) {
        const k = monthStart(e.spent_ms);
        if (!byMonth.has(k)) byMonth.set(k, []);
        byMonth.get(k).push(e);
      }
      el.innerHTML = [...byMonth].map(([m, rows]) => {
        const tot = rows.reduce((n, e) => n + X.businessCents(e), 0);
        return `<div class="daygroup"><div class="daygroup-head"><span>${esc(monthLabel(m))}</span>` +
          `<span class="tot">${money0(tot)}</span></div>${rows.map(rowHtml).join('')}</div>`;
      }).join('');
    }
    const more = sorted.length - shown.length;
    $('#expMore').hidden = more <= 0;
    if (more > 0) $('#expMore').textContent = `Show ${Math.min(more, 60)} more (${more} older)`;
  }

  function rowHtml(e) {
    const c = store.category(e.category_id);
    const n = (e.attachments || []).length;
    const att = X.attentionOf(e);
    // Everything needing attention leads the line, in one fixed order, before
    // what the expense actually was.
    const warn = [];
    if (att.includes('nonote')) warn.push('<span class="nr">No note</span>');
    if (att.includes('noreceipt')) warn.push('<span class="nr">No receipt</span>');
    if (X.isFlagged(e)) warn.push(`<span class="flag">Flagged${e.flag_note ? ': ' + esc(e.flag_note) : ''}</span>`);
    if (att.includes('big')) warn.push('<span class="flag">Over $2,500</span>');

    const bits = [...warn, esc(c ? c.name : X.UNCATEGORIZED), esc(shortDate(e.spent_ms))];
    if (!st.job) bits.push(esc(store.job(e.job_id)?.name ?? 'Unknown job'));
    if (n) bits.push(`${n} file${n === 1 ? '' : 's'}`);
    return `<button class="entry expense${att.length ? ' is-attention' : ''}" data-exp="${esc(e.id)}" type="button">
      <span class="bar"></span>
      <span class="main"><span class="t1">${esc(X.vendorName(e))}</span><span class="t2">${bits.join(' · ')}</span></span>
      <span class="amt">${money(X.businessCents(e))}${X.isSplit(e) ? `<span class="s">of ${money(e.total_cents)}</span>` : ''}</span>
    </button>`;
  }

  $('#expJob').addEventListener('change', (e) => { st.job = e.target.value; st.limit = 60; render(); });
  $('#expYear').addEventListener('change', (e) => { st.year = e.target.value; st.limit = 60; render(); });
  $('#expCategory').addEventListener('change', (e) => { st.category = e.target.value; st.limit = 60; render(); });
  $('#expAttention').addEventListener('click', (e) => {
    const key = e.target.closest('[data-att]')?.dataset.att;
    if (!key) return;
    st.status = st.status === key ? '' : key;   // tapping the active chip clears it
    st.limit = 60;
    render();
  });
  $('#expBreakdown').addEventListener('click', (e) => {
    const b = e.target.closest('[data-expcat]');
    if (b) { st.category = b.dataset.expcat; st.limit = 60; render(); }
  });
  $('#expList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-exp]');
    if (b) openEditor(store.expenses.get(b.dataset.exp));
  });
  $('#expMore').addEventListener('click', () => { st.limit += 60; render(); });
  $('#addExpenseBtn').addEventListener('click', () => openEditor(null));
  $('#exportExpensesBtn').addEventListener('click', openExport);

  // ── attachment viewer ────────────────────────────────────────

  const viewer = $('#viewer');
  const closeViewer = () => { viewer.hidden = true; $('#viewerImg').removeAttribute('src'); };
  $('#viewerClose').addEventListener('click', closeViewer);
  viewer.addEventListener('click', (e) => {
    if (e.target === viewer || e.target.classList.contains('viewer-body')) closeViewer();
  });
  // Capture phase, so Escape closes the viewer without also closing the sheet
  // underneath it.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !viewer.hidden) { e.stopPropagation(); closeViewer(); }
  }, true);

  function openAttachment(a) {
    if (!isImage(a.type)) { window.open(fileUrl(a.key), '_blank', 'noopener'); return; }
    $('#viewerName').textContent = a.name || 'Receipt';
    $('#viewerOpen').href = fileUrl(a.key);
    $('#viewerImg').src = fileUrl(a.key);
    viewer.hidden = false;
  }

  // ── expense editor ───────────────────────────────────────────

  function frequentVendors() {
    const n = new Map();
    for (const e of store.data.expenses) {
      const v = (e.vendor || '').trim();
      if (v) n.set(v, (n.get(v) || 0) + 1);
    }
    return [...n].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([v]) => v);
  }

  function openEditor(expense) {
    const isNew = !expense;
    const jobId = expense?.job_id || st.job || currentJobId();
    if (!jobId) { toast('Add a job in Setup first', 'error'); return; }

    const e = expense
      ? { ...expense, attachments: [...(expense.attachments || [])] }
      : {
          id: newId(), job_id: jobId,
          category_id: st.category && st.category !== '__none' ? st.category : null,
          spent_ms: fromDateInput(toDateInput(Date.now())), vendor: '',
          total_cents: 0, business_cents: null, note: '', attachments: [],
          flagged: 0, flag_note: '',
        };

    const added = [];      // uploaded during this edit — deleted again if it is abandoned
    const removed = [];    // existing files taken off — deleted only once saved
    let uploading = 0;
    let finished = false;  // saved, deleted or dismissed; late uploads must not attach

    const catOptions = (sel) => '<option value="">Uncategorized</option>' +
      cats().map((c) => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    const split = X.isSplit(e);

    openSheet(isNew ? 'Add an expense' : 'Edit expense', `
      <div class="field"><label for="x-job">Job</label>
        <select class="select" id="x-job">${jobOptions(e.job_id)}</select></div>
      <div class="field-row">
        <div class="field"><label for="x-date">Date</label>
          <input class="input" type="date" id="x-date" value="${toDateInput(e.spent_ms)}"></div>
        <div class="field"><label for="x-total">Amount paid</label>
          <input class="input" type="number" inputmode="decimal" step="0.01" min="0" id="x-total"
                 value="${e.total_cents ? (e.total_cents / 100).toFixed(2) : ''}" placeholder="0.00"></div>
      </div>
      <div class="field"><label for="x-vendor">Vendor</label>
        <input class="input" id="x-vendor" list="x-vendors" value="${esc(e.vendor)}" placeholder="e.g. Adobe"
               maxlength="120" autocomplete="off">
        <datalist id="x-vendors">${frequentVendors().map((v) => `<option value="${esc(v)}">`).join('')}</datalist></div>
      <div class="field"><label for="x-cat">Category</label>
        <div class="inline-pick"><select class="select" id="x-cat">${catOptions(e.category_id)}</select>
          <button class="btn btn-quiet" id="x-newcat" type="button">New</button></div>
        <div class="inline-new" id="x-newcat-row" hidden>
          <input class="input" id="x-newcat-name" placeholder="Category name" maxlength="60">
          <button class="btn btn-quiet" id="x-newcat-add" type="button">Add</button></div>
        <p class="field-hint" id="x-pct"></p></div>
      <label class="check"><input type="checkbox" id="x-split"${split ? ' checked' : ''}>
        Only part of this was for business</label>
      <div class="field" id="x-split-row"${split ? '' : ' hidden'}>
        <label for="x-biz">Business-use amount</label>
        <input class="input" type="number" inputmode="decimal" step="0.01" min="0" id="x-biz"
               value="${split ? (e.business_cents / 100).toFixed(2) : ''}" placeholder="0.00">
        <div class="row-actions" style="margin-top:8px">${[25, 50, 75].map((p) =>
          `<button class="btn btn-quiet" data-bizpct="${p}" type="button">${p}%</button>`).join('')}</div></div>
      <p class="field-hint" id="x-hint"></p>
      <p class="field-hint warnish" id="x-big" hidden>Over $2,500 — this may have to be spread over several
        years rather than deducted at once.</p>
      <div class="field"><label>Receipts and statements</label>
        <div class="attach-grid" id="x-atts"></div>
        <label class="btn btn-quiet attach-add">Add a photo or PDF
          <input type="file" id="x-file" accept="image/*,application/pdf" multiple hidden></label></div>
      <div class="field"><label for="x-note">Note</label>
        <textarea class="input" id="x-note" rows="2" placeholder="Optional">${esc(e.note)}</textarea></div>
      <label class="check"><input type="checkbox" id="x-flag"${e.flagged ? ' checked' : ''}> Flag this for review</label>
      <div class="field" id="x-flag-row"${e.flagged ? '' : ' hidden'}>
        <input class="input" id="x-flagnote" maxlength="200" placeholder="Why? (optional)" value="${esc(e.flag_note || '')}">
        <div class="row-actions" style="margin-top:8px">${X.FLAG_REASONS.map((r) =>
          `<button class="btn btn-quiet" data-flagreason="${esc(r)}" type="button">${esc(r)}</button>`).join('')}</div></div>
      <div class="row-actions"><button class="btn btn-primary btn-block" id="x-save" type="button">${isNew ? 'Add expense' : 'Save changes'}</button></div>
      ${isNew ? '' : '<div class="row-actions" style="margin-top:8px"><button class="btn btn-danger btn-block" id="x-del" type="button">Delete expense</button></div>'}
    `, (root) => {
      const q = (sel) => $(sel, root);
      const save = q('#x-save');

      const renderAtts = () => {
        q('#x-atts').innerHTML = e.attachments.map((a, i) => `
          <div class="attach-tile">
            <button type="button" class="attach-open" data-open="${i}" aria-label="Open ${esc(a.name || 'file')}">
              ${a.thumb ? `<img src="${fileUrl(a.thumb)}" alt="">`
                        : `<span class="attach-kind">${a.type === 'application/pdf' ? 'PDF' : 'IMG'}</span>`}
            </button>
            <button type="button" class="attach-x" data-rm="${i}" aria-label="Remove">&times;</button>
          </div>`).join('') +
          (uploading ? '<div class="attach-tile is-pending">Uploading…</div>' : '');
        save.disabled = uploading > 0;
        save.textContent = uploading ? 'Uploading…' : isNew ? 'Add expense' : 'Save changes';
      };

      const hint = () => {
        const t = cents(q('#x-total').value);
        const on = q('#x-split').checked;
        const b = on ? cents(q('#x-biz').value) : t;
        q('#x-hint').textContent = !t ? ''
          : !on ? `${money(t)} counts as business use.`
          : b > t ? 'The business portion is more than the amount paid.'
          : `${money(b)} business use of ${money(t)} · ${Math.round((b / t) * 100)}%`;

        const pct = X.categoryPct(cats(), q('#x-cat').value || null);
        q('#x-pct').textContent = pct >= 100 ? ''
          : t ? `Only ${pct}% of this category is deductible — ${money(b)} counts as ${money(Math.round((b * pct) / 100))}.`
              : `Only ${pct}% of this category is deductible.`;

        const over = t >= X.REVIEW_ABOVE_CENTS;
        q('#x-big').hidden = !over;
      };

      q('#x-split').addEventListener('change', () => { q('#x-split-row').hidden = !q('#x-split').checked; hint(); });
      q('#x-flag').addEventListener('change', () => {
        q('#x-flag-row').hidden = !q('#x-flag').checked;
        if (q('#x-flag').checked) q('#x-flagnote').focus();
      });
      root.addEventListener('input', hint);
      root.addEventListener('click', (ev) => {
        const reason = ev.target.dataset?.flagreason;
        if (reason) { q('#x-flagnote').value = reason; return; }
        const pct = ev.target.dataset?.bizpct;
        if (pct) {
          q('#x-biz').value = (Math.round((cents(q('#x-total').value) * pct) / 100) / 100).toFixed(2);   // nearest cent
          hint();
          return;
        }
        const rm = ev.target.closest('[data-rm]');
        if (rm) {
          const [a] = e.attachments.splice(+rm.dataset.rm, 1);
          const i = added.indexOf(a);
          if (i >= 0) { added.splice(i, 1); deleteAttachment(a); } else removed.push(a);
          renderAtts();
          return;
        }
        const open = ev.target.closest('[data-open]');
        if (open) openAttachment(e.attachments[+open.dataset.open]);
      });

      q('#x-file').addEventListener('change', async (ev) => {
        const picked = [...ev.target.files];
        ev.target.value = '';
        for (const f of picked) {
          uploading++;
          renderAtts();
          try {
            const a = await uploadAttachment(e.id, f);
            if (finished) deleteAttachment(a);   // the sheet went away mid-upload
            else { e.attachments.push(a); added.push(a); }
          } catch (err) {
            toast(err.message || 'Upload failed', 'error');
          } finally {
            uploading--;
            if (!finished) renderAtts();
          }
        }
      });

      q('#x-cat').addEventListener('change', hint);
      q('#x-newcat').addEventListener('click', () => {
        const row = q('#x-newcat-row');
        row.hidden = !row.hidden;
        if (!row.hidden) q('#x-newcat-name').focus();
      });
      q('#x-newcat-add').addEventListener('click', () => {
        const name = q('#x-newcat-name').value.trim();
        if (!name) return;
        const existing = cats().find((c) => c.name.toLowerCase() === name.toLowerCase());
        const id = existing ? existing.id : newId();
        if (!existing) store.mutate([{ type: 'category', op: 'put', data: { id, name, created_ms: Date.now() } }]);
        q('#x-cat').innerHTML = catOptions(id);
        q('#x-newcat-name').value = '';
        q('#x-newcat-row').hidden = true;
      });

      save.addEventListener('click', () => {
        const total = cents(q('#x-total').value);
        const job = q('#x-job').value;
        if (!job) return toast('Pick a job', 'error');
        if (total <= 0) return toast('Enter the amount paid', 'error');
        let biz = null;
        if (q('#x-split').checked) {
          biz = cents(q('#x-biz').value);
          if (biz > total) return toast('The business portion is more than the amount paid', 'error');
          if (biz === total) biz = null;   // a "split" that isn't one is stored as unsplit
        }
        finished = true;
        store.mutate([{ type: 'expense', op: 'put', data: {
          ...e, job_id: job, spent_ms: fromDateInput(q('#x-date').value), vendor: q('#x-vendor').value.trim(),
          category_id: q('#x-cat').value || null, total_cents: total, business_cents: biz,
          note: q('#x-note').value.trim(), attachments: e.attachments,
          flagged: q('#x-flag').checked ? 1 : 0,
          flag_note: q('#x-flag').checked ? q('#x-flagnote').value.trim() : '',
        } }]);
        for (const a of removed) deleteAttachment(a);
        closeSheet();
        toast(isNew ? 'Expense added' : 'Expense saved');
      });

      q('#x-del')?.addEventListener('click', () => {
        finished = true;
        for (const a of added) deleteAttachment(a);   // never saved, so nothing to undo
        closeSheet();
        // The expense's saved files stay in storage, so Undo brings them back intact.
        deleteWithUndo('Expense deleted', [{ type: 'expense', data: expense }]);
      });

      renderAtts();
      hint();
    }, {
      onDismiss: () => { finished = true; for (const a of added) deleteAttachment(a); },
    });
  }

  // ── categories (managed from Setup) ──────────────────────────

  function renderCategories() {
    const cs = cats();
    const counts = new Map();
    for (const e of store.data.expenses) if (e.category_id) counts.set(e.category_id, (counts.get(e.category_id) || 0) + 1);
    $('#categoryList').innerHTML = cs.length
      ? cs.map((c) => {
          const n = counts.get(c.id) || 0;
          return `<div class="jobitem"><span class="nm">${esc(c.name)}${c.deduct_pct < 100 ? ` · ${c.deduct_pct}% deductible` : ''}</span>
            <span class="meta">${n} expense${n === 1 ? '' : 's'}</span>
            <button class="btn btn-quiet" data-editcat="${esc(c.id)}" type="button">Edit</button></div>`;
        }).join('')
      : '<p class="empty">No categories yet.</p>';
    $('#suggestCategoriesBtn').hidden = cs.length > 0;
  }

  function openCategoryEditor(cat) {
    const isNew = !cat;
    const c = cat || { id: newId(), name: '', created_ms: Date.now() };
    const n = store.data.expenses.filter((e) => e.category_id === c.id).length;
    openSheet(isNew ? 'Add a category' : 'Edit category', `
      <div class="field"><label for="k-name">Name</label>
        <input class="input" id="k-name" value="${esc(c.name)}" maxlength="60" placeholder="e.g. Software & subscriptions"></div>
      <div class="field"><label for="k-pct">Deductible</label>
        <div class="inline-pick"><input class="input" type="number" id="k-pct" min="0" max="100" step="1"
          value="${c.deduct_pct === undefined ? 100 : c.deduct_pct}"><span class="suffix">%</span></div>
        <p class="field-hint">How much of this category the law lets you deduct. Meals are 50%; most things are 100%.</p></div>
      <div class="row-actions" style="margin-top:14px">
        <button class="btn btn-primary btn-block" id="k-save" type="button">${isNew ? 'Add category' : 'Save changes'}</button></div>
      ${isNew ? '' : `<div class="row-actions" style="margin-top:8px">
        <button class="btn btn-danger btn-block" id="k-del" type="button">Delete category</button></div>
        <p class="field-hint">${n ? `Its ${n} expense${n === 1 ? '' : 's'} stay put and show as Uncategorized.` : 'No expenses use it.'}</p>`}
    `, (root) => {
      $('#k-save', root).addEventListener('click', () => {
        const name = $('#k-name', root).value.trim();
        if (!name) return toast('Give the category a name', 'error');
        if (cats().some((x) => x.id !== c.id && x.name.toLowerCase() === name.toLowerCase())) {
          return toast('There is already a category with that name', 'error');
        }
        const pct = Math.min(100, Math.max(0, Math.round(Number($('#k-pct', root).value) || 0)));
        store.mutate([{ type: 'category', op: 'put', data: { ...c, name, deduct_pct: pct } }]);
        closeSheet();
        toast(isNew ? 'Category added' : 'Category saved');
      });
      $('#k-del', root)?.addEventListener('click', () => {
        closeSheet();
        deleteWithUndo(`Deleted "${c.name}"`, [{ type: 'category', data: c }]);
      });
    });
  }

  $('#addCategoryBtn').addEventListener('click', () => openCategoryEditor(null));
  $('#categoryList').addEventListener('click', (e) => {
    const id = e.target.closest('[data-editcat]')?.dataset.editcat;
    if (id) openCategoryEditor(store.categories.get(id));
  });
  $('#suggestCategoriesBtn').addEventListener('click', () => {
    if (cats().length) return;
    const now = Date.now();
    store.mutate(SUGGESTED.map(([name, pct], i) => ({
      type: 'category', op: 'put', data: { id: newId(), name, deduct_pct: pct, created_ms: now + i },
    })));
    toast(`Added ${SUGGESTED.length} categories — rename or delete any of them`);
  });

  // ── tax-time export ──────────────────────────────────────────

  function openExport() {
    const jobs = store.activeJobs;
    if (!jobs.length) { toast('Add a job first', 'error'); return; }
    const years = X.yearsWithExpenses(store.data.expenses);
    const defJob = st.job || jobs[0].id;
    const defYear = st.year || String(years[0]);

    openSheet('Export for taxes', `
      <p class="card-note">A zip with a readable summary, spreadsheets by transaction, category and vendor,
        and every receipt renamed to match its entry.</p>
      <div class="field"><label for="z-job">Job</label>
        <select class="select" id="z-job">${jobs.map((j) =>
          `<option value="${esc(j.id)}"${j.id === defJob ? ' selected' : ''}>${esc(j.name)}</option>`).join('')}
          <option value="__all">All jobs, one folder each</option></select></div>
      <div class="field"><label for="z-year">Tax year</label>
        <select class="select" id="z-year">${years.map((y) =>
          `<option value="${y}"${String(y) === defYear ? ' selected' : ''}>${y}</option>`).join('')}
          <option value="">All years</option></select></div>
      <label class="check"><input type="checkbox" id="z-files" checked> Include receipt files</label>
      <p class="field-hint" id="z-preview"></p>
      <div class="row-actions" style="margin-top:14px">
        <button class="btn btn-primary btn-block" id="z-go" type="button">Download export</button></div>
    `, (root) => {
      const q = (sel) => $(sel, root);
      const selection = () => {
        const jv = q('#z-job').value;
        const p = period(q('#z-year').value);
        const lists = (jv === '__all' ? jobs.map((j) => j.id) : [jv])
          .map((id) => ({ job: store.job(id), list: X.filterExpenses(store.data.expenses, cats(), { jobId: id, from: p.from, to: p.to }) }))
          .filter((x) => x.list.length);
        return { p, lists };
      };
      const preview = () => {
        const all = selection().lists.flatMap((x) => x.list);
        const s = X.summarizeExpenses(all, cats());
        const files = all.reduce((n, e) => n + (e.attachments || []).length, 0);
        q('#z-preview').textContent = all.length
          ? `${s.count} transactions · ${files} file${files === 1 ? '' : 's'} · ${money(s.businessCents)} business use` +
            (s.flagged ? ` · ${s.flagged} flagged, listed first in the summary` : '')
          : 'Nothing logged for that job and year.';
        q('#z-go').disabled = !all.length;
      };
      root.addEventListener('change', preview);
      preview();

      q('#z-go').addEventListener('click', async () => {
        const btn = q('#z-go');
        btn.disabled = true;
        const { p, lists } = selection();
        const withFiles = q('#z-files').checked;
        try {
          const files = [];
          const receipts = [];
          for (const { job, list } of lists) {
            const ex = X.buildExport({ expenses: list, categories: cats(), jobName: job.name, periodLabel: p.label });
            files.push(...ex.files);
            if (withFiles) receipts.push(...ex.receipts);
          }
          const failed = [];
          let done = 0;
          await pool(receipts, 4, async (r) => {
            try {
              const res = await fetch(fileUrl(r.key));
              if (!res.ok) throw new Error(String(res.status));
              files.push({ name: r.path, data: new Uint8Array(await res.arrayBuffer()), date: r.date });
            } catch {
              failed.push(r.path);
            }
            btn.textContent = `Fetching receipts ${++done} of ${receipts.length}…`;
          });
          if (failed.length) {
            files.push({ name: 'MISSING-FILES.txt',
              data: `These receipts could not be downloaded:\r\n${failed.join('\r\n')}\r\n` });
          }
          btn.textContent = 'Building the zip…';
          files.sort((a, b) => a.name.localeCompare(b.name));
          const jobPart = lists.length === 1 ? X.safePart(lists[0].job.name, 40) : 'all-jobs';
          download(`work-tracker-expenses_${jobPart}_${X.safePart(p.label)}.zip`, makeZip(files), 'application/zip');
          closeSheet();
          toast(failed.length ? `Exported, but ${failed.length} file${failed.length === 1 ? '' : 's'} could not be fetched`
                              : 'Export downloaded', failed.length ? 'error' : 'ok');
        } catch (err) {
          toast(`Export failed: ${err.message || err}`, 'error');
          btn.disabled = false;
          btn.textContent = 'Download export';
        }
      });
    });
  }

  return { render, renderCategories };
}
