/* KPI 1 analytics module for the unified Task 360 Management System.
 * It uses the existing /api/data payload and the shared Admin/My Team/Me selector,
 * while keeping a separate set of KPI 1 filters and four KPI 1 charts.
 */
(() => {
  'use strict';

  const state = {
    headers: [], partitions: { admin: [], myTeam: [], me: [] }, roleInfo: {},
    indexes: {}, mode: 'admin', allRows: [], filteredRows: [],
    topFilters: {}, currentWorkset: new Set(), openFilterKey: null,
    drill: { status: null, fms: null, stage: null },
    leadDrill: { fms: null, stage: null },
    charts: { fms: null, status: null, leadBar: null, leadPie: null },
    email: ''
  };

  const FILTER_ORDER = [
    { key: 'KPI_MONTH', label: 'KPI Month' }, { key: 'WEEK_NO', label: 'Week No' },
    { key: 'DAY_NO', label: 'Day No' }, { key: 'DOER', label: 'Doer' },
    { key: 'FMS', label: 'FMS' }, { key: 'STAGE', label: 'Stage' },
    { key: 'TASK_STATUS', label: 'Task Status' }
  ];

  const byId = (id) => document.getElementById(id);
  const normalKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const safeText = (value) => value == null || String(value).trim() === '' ? '—' : String(value);

  function buildIndexes(headers) {
    const map = {};
    headers.forEach((header, i) => {
      const key = normalKey(String(header || '').replace(/\./g, ''));
      const aliases = {
        'record': 'RECORD', 'recordid': 'RECORD', 'fmsname': 'FMS', 'stagename': 'STAGE',
        'leadtime': 'LEAD_TIME', 'planned': 'PLANNED', 'doername': 'DOER',
        'actual': 'ACTUAL', 'delayhours': 'DELAY_HRS', 'taskstatus': 'TASK_STATUS',
        'kpimonth': 'KPI_MONTH', 'weekno': 'WEEK_NO', 'dayno': 'DAY_NO',
        'kpi01score': 'KPI01_SCORE', 'kpi01factoredscore': 'KPI01_FACTORED_SCORE',
        'presencefactor': 'PRESENCE_FACTOR', 'managername': 'MANAGER_NAME', 'managercode': 'MANAGER_CODE'
      };
      if (aliases[key]) map[aliases[key]] = i;
    });
    return map;
  }

  function toHours(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Number(s) || 0;
    let m = s.match(/^(\d+):([0-5]\d)(?::([0-5]\d))?$/);
    if (m) return +m[1] + (+m[2]) / 60 + (+m[3] || 0) / 3600;
    m = s.match(/^(\d+)\s*d(?:\s+(\d+):([0-5]\d))?$/i);
    if (m) return +m[1] * 24 + (+m[2] || 0) + (+m[3] || 0) / 60;
    m = s.match(/^(\d+)\s*d(?:\s+(\d+)\s*h)?(?:\s+(\d+)\s*m)?$/i);
    if (m) return +m[1] * 24 + (+m[2] || 0) + (+m[3] || 0) / 60;
    return 0;
  }

  function hoursToHHMM(hours) {
    const mins = Math.round((+hours || 0) * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(Math.abs(mins % 60)).padStart(2, '0')}`;
  }

  function cell(row, key) {
    const index = state.indexes[key];
    return index == null || !Array.isArray(row) ? '' : row[index];
  }

  function statusBucket(row) {
    const status = String(cell(row, 'TASK_STATUS') || '').toLowerCase().trim();
    const delay = toHours(cell(row, 'DELAY_HRS'));
    if (status.includes('done-on-time')) return 'ontime';
    if (status.includes('done-delay') || delay > 0) return 'delayed';
    return 'pending';
  }

  function activeGlobalMode() {
    if (byId('tab-myteam')?.classList.contains('active')) return 'myTeam';
    if (byId('tab-me')?.classList.contains('active')) return 'me';
    return 'admin';
  }

  function resetDrill() {
    state.drill = { status: null, fms: null, stage: null };
    state.leadDrill = { fms: null, stage: null };
  }

  function updateMode(mode, rerender = true) {
    state.mode = mode || activeGlobalMode();
    if (state.mode === 'admin') state.allRows = state.roleInfo.isAdmin ? (state.partitions.admin || []) : [];
    else if (state.mode === 'myTeam') state.allRows = state.partitions.myTeam || [];
    else state.allRows = state.partitions.me || [];
    if (rerender) {
      Object.keys(state.topFilters).forEach(key => { state.topFilters[key] = new Set(); });
      resetDrill();
      renderFilters();
      renderAll();
    }
  }

  function filteredRows() {
    let rows = state.allRows.slice();
    for (const key of Object.keys(state.topFilters)) {
      const selected = state.topFilters[key];
      const index = state.indexes[key];
      if (selected && selected.size && index != null) rows = rows.filter(row => selected.has(String(row[index] ?? '').trim()));
    }
    if (state.drill.status) rows = rows.filter(row => statusBucket(row) === state.drill.status);
    if (state.drill.fms) rows = rows.filter(row => String(cell(row, 'FMS') || '').trim() === state.drill.fms);
    if (state.drill.stage) rows = rows.filter(row => String(cell(row, 'STAGE') || '').trim() === state.drill.stage);
    if (state.leadDrill.fms) rows = rows.filter(row => String(cell(row, 'FMS') || '').trim() === state.leadDrill.fms);
    if (state.leadDrill.stage) rows = rows.filter(row => String(cell(row, 'STAGE') || '').trim() === state.leadDrill.stage);
    return rows;
  }

  function metric(id, value) { const el = byId(id); if (el) el.textContent = value; }

  function renderMetrics(rows) {
    let delayed = 0, onTime = 0, delayHours = 0;
    rows.forEach(row => {
      const bucket = statusBucket(row);
      if (bucket === 'ontime') onTime++;
      else if (bucket === 'delayed') { delayed++; delayHours += toHours(cell(row, 'DELAY_HRS')); }
    });
    metric('kpi1-delayed', delayed.toLocaleString());
    metric('kpi1-ontime', onTime.toLocaleString());
    metric('kpi1-total', rows.length.toLocaleString());
    metric('kpi1-avg-delay', delayed ? (delayHours / delayed).toFixed(2) : '0.00');
  }

  function destroyChart(key) {
    if (state.charts[key]) { state.charts[key].destroy(); state.charts[key] = null; }
  }

  function chartColors() {
    const css = getComputedStyle(document.documentElement);
    return {
      green: css.getPropertyValue('--chart-green').trim() || '#45A9A9',
      red: css.getPropertyValue('--chart-red').trim() || '#4E1F6E',
      blue: css.getPropertyValue('--chart-blue').trim() || '#3E3E75',
      text: css.getPropertyValue('--text').trim() || '#30233A'
    };
  }

  function renderStatusAndFms(rows) {
    const colors = chartColors();
    const statusCanvas = byId('kpi1StatusDoughnutChart');
    destroyChart('status');
    if (statusCanvas) {
      const totals = { ontime: 0, delayed: 0, pending: 0 };
      rows.forEach(row => totals[statusBucket(row)]++);
      state.charts.status = new Chart(statusCanvas.getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Done On-Time', 'Done Delayed', 'Pending / In Progress'], datasets: [{ data: [totals.ontime, totals.delayed, totals.pending], backgroundColor: [colors.green, colors.red, colors.blue], hoverOffset: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { color: colors.text } } }, onClick: (_event, elements) => {
          if (!elements.length) return;
          const next = ['ontime', 'delayed', 'pending'][elements[0].index];
          state.drill.status = state.drill.status === next ? null : next;
          renderAll();
        } }
      });
    }

    const fmsCanvas = byId('kpi1FmsBarChart');
    destroyChart('fms');
    if (fmsCanvas) {
      const activeRows = state.drill.fms ? rows.filter(row => String(cell(row, 'FMS') || '').trim() === state.drill.fms) : rows;
      const keyIndex = state.drill.fms ? 'STAGE' : 'FMS';
      const agg = {};
      activeRows.forEach(row => {
        const bucket = statusBucket(row);
        if (bucket !== 'ontime' && bucket !== 'delayed') return;
        const label = String(cell(row, keyIndex) || 'N/A').trim();
        if (!agg[label]) agg[label] = { ontime: 0, delayed: 0 };
        agg[label][bucket]++;
      });
      const labels = Object.keys(agg);
      state.charts.fms = new Chart(fmsCanvas.getContext('2d'), {
        type: 'bar', data: { labels, datasets: [
          { label: 'Done On-Time', data: labels.map(label => agg[label].ontime), backgroundColor: colors.green, borderRadius: 6, stack: 'kpi1' },
          { label: 'Done Delayed', data: labels.map(label => agg[label].delayed), backgroundColor: colors.red, borderRadius: 6, stack: 'kpi1' }
        ] },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } }, plugins: { legend: { position: 'top', labels: { color: colors.text } } }, onClick: (_event, elements) => {
          if (!elements.length) return;
          const element = elements[0];
          state.drill.status = element.datasetIndex === 0 ? 'ontime' : 'delayed';
          if (!state.drill.fms) { state.drill.fms = labels[element.index]; state.drill.stage = null; }
          else state.drill.stage = labels[element.index];
          renderAll();
        } }
      });
    }
  }

  function renderLeadDelay(rows) {
    const colors = chartColors();
    const pieCanvas = byId('kpi1LeadDelayPieChart');
    destroyChart('leadPie');
    if (pieCanvas) {
      let totalLead = 0, totalDelay = 0;
      rows.forEach(row => { totalLead += toHours(cell(row, 'LEAD_TIME')); totalDelay += toHours(cell(row, 'DELAY_HRS')); });
      state.charts.leadPie = new Chart(pieCanvas.getContext('2d'), {
        type: 'doughnut', data: { labels: ['Lead Time', 'Delay Time'], datasets: [{ data: [Math.round(totalLead), Math.round(totalDelay)], backgroundColor: [colors.blue, colors.red], hoverOffset: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color: colors.text } }, tooltip: { callbacks: { label: context => `${context.label}: ${hoursToHHMM(context.parsed)}` } } } }
      });
      state.charts.leadPie.config._durationFmt = hoursToHHMM;
    }

    const barCanvas = byId('kpi1LeadDelayBarChart');
    destroyChart('leadBar');
    if (barCanvas) {
      const activeRows = state.leadDrill.fms ? rows.filter(row => String(cell(row, 'FMS') || '').trim() === state.leadDrill.fms) : rows;
      const keyIndex = state.leadDrill.fms ? 'STAGE' : 'FMS';
      const agg = {};
      activeRows.forEach(row => {
        const label = String(cell(row, keyIndex) || 'N/A').trim();
        if (!agg[label]) agg[label] = { lead: 0, delay: 0 };
        agg[label].lead += toHours(cell(row, 'LEAD_TIME'));
        agg[label].delay += toHours(cell(row, 'DELAY_HRS'));
      });
      const labels = Object.keys(agg);
      state.charts.leadBar = new Chart(barCanvas.getContext('2d'), {
        type: 'bar', data: { labels, datasets: [
          { label: 'Lead Time', data: labels.map(label => +agg[label].lead.toFixed(0)), backgroundColor: colors.blue, borderRadius: 6, stack: 'lead-delay' },
          { label: 'Delay Time', data: labels.map(label => +agg[label].delay.toFixed(0)), backgroundColor: colors.red, borderRadius: 6, stack: 'lead-delay' }
        ] },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { callback: hoursToHHMM } } }, plugins: { legend: { position: 'top', labels: { color: colors.text } }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${hoursToHHMM(context.parsed.y)}` } } }, onClick: (_event, elements) => {
          if (!elements.length) return;
          if (!state.leadDrill.fms) { state.leadDrill.fms = labels[elements[0].index]; state.leadDrill.stage = null; }
          else state.leadDrill.stage = labels[elements[0].index];
          renderAll();
        } }
      });
      state.charts.leadBar.config._durationFmt = hoursToHHMM;
    }
  }

  function renderBreadcrumbs() {
    const main = byId('kpi1-drill-breadcrumb');
    const lead = byId('kpi1-drill-breadcrumb-ld');
    if (main) {
      main.replaceChildren();
      const entries = [['Status', state.drill.status, () => { state.drill.status = null; renderAll(); }], ['FMS', state.drill.fms, () => { state.drill.fms = null; state.drill.stage = null; renderAll(); }], ['Stage', state.drill.stage, () => { state.drill.stage = null; renderAll(); }]];
      entries.filter(entry => entry[1]).forEach(([label, value, clear]) => {
        const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'chip'; chip.textContent = `${label}: ${value} ×`; chip.addEventListener('click', clear); main.appendChild(chip);
      });
    }
    if (lead) {
      lead.replaceChildren();
      [['FMS', state.leadDrill.fms, () => { state.leadDrill.fms = null; state.leadDrill.stage = null; renderAll(); }], ['Stage', state.leadDrill.stage, () => { state.leadDrill.stage = null; renderAll(); }]]
        .filter(entry => entry[1]).forEach(([label, value, clear]) => {
          const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'chip'; chip.textContent = `${label}: ${value} ×`; chip.addEventListener('click', clear); lead.appendChild(chip);
        });
    }
    const back = byId('kpi1-drill-back');
    const ldBack = byId('kpi1-ld-drill-back');
    if (back) back.style.display = (state.drill.fms || state.drill.status || state.drill.stage) ? 'inline-flex' : 'none';
    if (ldBack) ldBack.style.display = (state.leadDrill.fms || state.leadDrill.stage) ? 'inline-flex' : 'none';
  }

  function renderAll() {
    state.filteredRows = filteredRows();
    renderMetrics(state.filteredRows);
    renderStatusAndFms(state.filteredRows);
    renderLeadDelay(state.filteredRows);
    renderBreadcrumbs();
  }

  function renderFilters() {
    const wrap = byId('kpi1-filters-below-views');
    if (!wrap) return;
    wrap.replaceChildren();
    if (!state.indexes || !Object.keys(state.indexes).length) return;
    const sourceRows = state.allRows || [];
    FILTER_ORDER.forEach(({ key, label }) => {
      const column = state.indexes[key];
      if (column == null) return;
      const values = Array.from(new Set(sourceRows.map(row => String(row[column] ?? '').trim()).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      if (!state.topFilters[key]) state.topFilters[key] = new Set();
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'kpi1-filter-chip-btn';
      btn.innerHTML = `<span>${label}</span><span class="filter-chip-count">${state.topFilters[key].size || 0}</span>`;
      btn.addEventListener('click', event => { event.stopPropagation(); toggleFilter(key, label, btn, values); });
      wrap.appendChild(btn);
    });
  }

  function toggleFilter(key, label, trigger, options) {
    closeFilter();
    state.openFilterKey = key;
    state.currentWorkset = new Set(state.topFilters[key] || []);
    const pop = document.createElement('div'); pop.className = 'kpi1-multi-pop'; pop.dataset.key = key;
    const head = document.createElement('div'); head.className = 'multi-head';
    const search = document.createElement('input'); search.type = 'search'; search.placeholder = `Search ${label.toLowerCase()}...`;
    head.appendChild(search);
    const tools = document.createElement('div'); tools.className = 'kpi1-filter-pop-tools';
    const all = document.createElement('button'); all.type = 'button'; all.textContent = 'All'; all.className = 'link-btn';
    const clear = document.createElement('button'); clear.type = 'button'; clear.textContent = 'Clear'; clear.className = 'link-btn';
    tools.append(all, clear); head.appendChild(tools); pop.appendChild(head);
    const list = document.createElement('div'); list.className = 'multi-list'; pop.appendChild(list);
    const foot = document.createElement('div'); foot.className = 'multi-foot';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-clear'; cancel.textContent = 'Cancel'; cancel.addEventListener('click', closeFilter);
    const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'btn'; apply.textContent = 'Apply';
    apply.addEventListener('click', () => {
      state.topFilters[key] = new Set(state.currentWorkset);
      const badge = trigger.querySelector('.filter-chip-count'); if (badge) badge.textContent = state.topFilters[key].size || 0;
      closeFilter(); renderAll();
    });
    foot.append(cancel, apply); pop.appendChild(foot); document.body.appendChild(pop);

    function visibleOptions() {
      const q = String(search.value || '').trim().toLowerCase();
      return q ? options.filter(value => value.toLowerCase().includes(q)) : options;
    }
    function renderList() {
      list.replaceChildren();
      visibleOptions().forEach(value => {
        const labelEl = document.createElement('label'); labelEl.className = 'multi-item';
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = state.currentWorkset.has(value);
        cb.addEventListener('change', () => cb.checked ? state.currentWorkset.add(value) : state.currentWorkset.delete(value));
        const span = document.createElement('span'); span.textContent = value;
        labelEl.append(cb, span); list.appendChild(labelEl);
      });
      if (!list.childElementCount) { const none = document.createElement('div'); none.className = 'muted text-sm p-2'; none.textContent = 'No options'; list.appendChild(none); }
    }
    all.addEventListener('click', () => { visibleOptions().forEach(value => state.currentWorkset.add(value)); renderList(); });
    clear.addEventListener('click', () => { visibleOptions().forEach(value => state.currentWorkset.delete(value)); renderList(); });
    search.addEventListener('input', renderList);
    renderList();
    trigger.classList.add('active');

    function position() {
      if (!pop.isConnected || !trigger.isConnected) return;
      const rect = trigger.getBoundingClientRect();
      const zoomRaw = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
      const zoom = Number.isFinite(zoomRaw) && zoomRaw > 0 ? zoomRaw : 1;
      const margin = 10; const width = Math.min(320, window.innerWidth - margin * 2);
      pop.style.width = `${width / zoom}px`;
      let left = rect.left;
      if (left + width > window.innerWidth - margin) left = Math.max(margin, rect.right - width);
      const viewportLeft = Math.max(margin, left);
      pop.style.left = `${viewportLeft / zoom}px`;
      pop.style.top = `${(rect.bottom + 7) / zoom}px`;
      const availableHeight = (window.innerHeight - rect.bottom - 18) / zoom;
      pop.style.maxHeight = `${Math.max(180, availableHeight)}px`;
      list.style.maxHeight = `${Math.max(100, Math.min(230, availableHeight - 115))}px`;
    }
    position();
    pop._reposition = position;
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
  }

  function closeFilter() {
    const pop = document.querySelector('.kpi1-multi-pop');
    if (pop) {
      if (pop._reposition) { window.removeEventListener('resize', pop._reposition); window.removeEventListener('scroll', pop._reposition, true); }
      pop.remove();
    }
    document.querySelectorAll('.kpi1-filter-chip-btn.active').forEach(btn => btn.classList.remove('active'));
    state.openFilterKey = null; state.currentWorkset = new Set();
  }

  async function loadKpi1Analytics(force = false) {
    const banner = byId('kpi1-load-status');
    if (banner) { banner.hidden = false; banner.textContent = 'Loading KPI 1 analytics…'; }
    const params = new URLSearchParams(window.location.search);
    state.email = (params.get('useremail') || params.get('email') || 'systems2@hosexperts.com').trim();
    try {
      const response = await fetch(`/api/data?email=${encodeURIComponent(state.email)}${force ? '&force=true' : ''}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const raw = await response.text();
      let payload; try { payload = JSON.parse(raw); } catch { payload = { error: raw }; }
      if (!response.ok || payload.error) throw new Error(payload.error || `KPI 1 request failed (${response.status})`);
      state.headers = payload.headers || [];
      state.indexes = buildIndexes(state.headers);
      state.partitions = payload.partitions || { admin: [], myTeam: [], me: [] };
      state.roleInfo = payload.roleInfo || {};
      updateMode(activeGlobalMode(), false);
      Object.keys(state.indexes).forEach(key => { if (!state.topFilters[key]) state.topFilters[key] = new Set(); });
      renderFilters(); renderAll();
      if (banner) { banner.hidden = false; banner.textContent = `KPI 1 analytics loaded · ${state.allRows.length.toLocaleString()} records in ${state.mode === 'myTeam' ? 'My Team' : state.mode === 'me' ? 'Me' : 'Admin'} view`; }
      window.dispatchEvent(new CustomEvent('task360:kpi1-ready'));
    } catch (error) {
      console.error('KPI 1 analytics failed to load:', error);
      if (banner) { banner.hidden = false; banner.textContent = `KPI 1 analytics could not load: ${error.message || error}`; }
    }
  }

  window.refreshKpi1Analytics = loadKpi1Analytics;
  window.addEventListener('task360:view-changed', event => updateMode(event.detail?.mode || activeGlobalMode()));
  window.addEventListener('load', () => loadKpi1Analytics(false), { once: true });
  byId('refresh-button')?.addEventListener('click', () => loadKpi1Analytics(true));
  window.resetKpi1Filters = () => {
    Object.keys(state.topFilters).forEach(key => { state.topFilters[key] = new Set(); });
    resetDrill(); renderFilters(); renderAll();
  };
  byId('kpi1-reset-filters-btn')?.addEventListener('click', window.resetKpi1Filters);
  byId('kpi1-drill-back')?.addEventListener('click', () => { resetDrill(); renderAll(); });
  byId('kpi1-ld-drill-back')?.addEventListener('click', () => { state.leadDrill = { fms: null, stage: null }; renderAll(); });
  document.addEventListener('click', event => {
    const pop = document.querySelector('.kpi1-multi-pop');
    if (pop && !pop.contains(event.target) && !event.target.closest('.kpi1-filter-chip-btn')) closeFilter();
  });
})();
