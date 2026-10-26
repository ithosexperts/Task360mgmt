// ====== Value labels plugin ======
const SMALL_SLICE_PCT = 0.06;

// Keep chart labels, axes, and legends readable at 90% browser zoom.
if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  Chart.defaults.font.size = 14;
  Chart.defaults.color = '#30233A';
}

const ValueLabelsPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const css = getComputedStyle(document.documentElement);
    const textCol = css.getPropertyValue('--text').trim() || '#30233A';
    const fmt = chart.config._durationFmt || (x => x);
    
    ctx.save(); 
    ctx.fillStyle = textCol; 
    ctx.textAlign = 'center'; 
    ctx.textBaseline = 'middle';
    ctx.font = (Chart.defaults.font?.size || 12) + "px Inter, sans-serif";

    if (chart.config.type === 'bar') {
      chart.data.datasets.forEach((ds, di) => {
        const meta = chart.getDatasetMeta(di);
        meta.data.forEach((el, i) => {
          const raw = ds.data[i]; 
          if (raw == null || isNaN(raw)) return;
          const labelTxt = String(fmt(raw));
          const { x, y, base } = el.getProps(['x', 'y', 'base'], true);
          const h = Math.abs(base - y);
          const inside = h >= 16;
          const labelY = inside ? (y + (base > y ? 8 : -8)) : (Math.min(y, base) - 10);
          ctx.fillStyle = inside ? '#FFFFFF' : textCol;
          ctx.strokeStyle = inside ? 'rgba(36,22,48,.78)' : 'rgba(255,255,255,.95)'; ctx.lineWidth = inside ? 2.5 : 2; 
          ctx.strokeText(labelTxt, x, labelY); ctx.fillText(labelTxt, x, labelY);
        });
      });
    }

    if (chart.config.type === 'doughnut') {
      const ds = chart.data.datasets[0]; 
      if (!ds) return;
      const meta = chart.getDatasetMeta(0);
      const total = ds.data.reduce((a, b) => a + (+b || 0), 0) || 1;
      
      meta.data.forEach((arc, i) => {
        const raw = +ds.data[i] || 0; 
        if (!raw) return;
        const pct = raw / total;
        const m = arc.getProps(['startAngle', 'endAngle', 'x', 'y', 'innerRadius', 'outerRadius'], true);
        const mid = (m.startAngle + m.endAngle) / 2, cx = m.x, cy = m.y;
        const labelTxt = String(fmt(raw));
        
        if (pct >= SMALL_SLICE_PCT) {
          const r = m.innerRadius + (m.outerRadius - m.innerRadius) * .5;
          const lx = cx + Math.cos(mid) * r, ly = cy + Math.sin(mid) * r;
          ctx.fillStyle = '#FFFFFF';
          ctx.strokeStyle = 'rgba(36,22,48,.78)'; ctx.lineWidth = 2.5; 
          ctx.strokeText(labelTxt, lx, ly); ctx.fillText(labelTxt, lx, ly);
        } else {
          const r1 = m.outerRadius * .92, r2 = m.outerRadius + 18;
          const x1 = cx + Math.cos(mid) * r1, y1 = cy + Math.sin(mid) * r1;
          const x2 = cx + Math.cos(mid) * r2, y2 = cy + Math.sin(mid) * r2;
          ctx.fillStyle = textCol;
          ctx.strokeStyle = textCol; ctx.lineWidth = 1.5; ctx.beginPath(); 
          ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
          const tick = 10 * (Math.cos(mid) >= 0 ? 1 : -1); 
          ctx.lineTo(x2 + tick, y2); ctx.stroke();
          const tx = x2 + tick + (Math.cos(mid) >= 0 ? 16 : -16), ty = y2; 
          ctx.textAlign = (Math.cos(mid) >= 0) ? 'left' : 'right';
          ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.lineWidth = 3; 
          ctx.strokeText(labelTxt, tx, ty); ctx.fillStyle = textCol; ctx.fillText(labelTxt, tx, ty);
        }
      });
    }
    ctx.restore();
  }
};
Chart.register(ValueLabelsPlugin);

// ===== Global State =====
let ALL_DATA = [];
let FAULTY_DATA = [];
let PARTITIONS = { admin: [], myTeam: [], me: [] };
let FILTER_COLUMNS = {};
let HEADERS = [];
let ROLEINFO = {};
let CURRENT_MODE = 'admin';
let fmsBarChartInstance = null;
let statusDoughnutChartInstance = null;

const DRILL = { status: null, fms: null, stage: null };
const TOP_FILTERS = {};
let SCOREBOARD_STATUS_FILTER = null;
window.task360GetSharedFilters = () => Object.fromEntries(
  Object.entries(TOP_FILTERS).filter(([, values]) => values && values.size).map(([key, values]) => [key, Array.from(values)])
);
function notifySharedFiltersChanged() {
  window.dispatchEvent(new CustomEvent('task360:shared-filters-changed', {
    detail: { filters: window.task360GetSharedFilters(), scoreboardStatus: SCOREBOARD_STATUS_FILTER }
  }));
}
let OPEN_TOP_FOR = null;
let CURRENT_TOP_WORKSET = new Set();
let currentPage = 1;
const ROWS_PER_PAGE = 50;

function applyThemeForMode(mode) {
  const root = document.documentElement;
  root.setAttribute('data-theme', mode === 'admin' ? 'dark' : (mode === 'myTeam' ? 'grey' : 'light'));
  const styles = getComputedStyle(root);
  Chart.defaults.color = styles.getPropertyValue('--text').trim() || '#30233A';
  Chart.defaults.borderColor = styles.getPropertyValue('--border').trim() || '#DDD5E8';
  Chart.defaults.font.family = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial';
}

function setMode(mode) {
  CURRENT_MODE = mode; 
  applyThemeForMode(mode === 'faulty' ? 'admin' : mode);
  
  const bA = document.getElementById('tab-admin');
  const bT = document.getElementById('tab-myteam');
  const bM = document.getElementById('tab-me');
  const bF = document.getElementById('tab-faulty');
  
  [bA, bT, bM, bF].forEach(b => b?.classList.remove('active'));
  
  if (mode === 'admin') bA?.classList.add('active'); 
  if (mode === 'myTeam') bT?.classList.add('active'); 
  if (mode === 'me') bM?.classList.add('active');
  if (mode === 'faulty') bF?.classList.add('active');

  const mainDash = document.getElementById('main-dashboard-content');
  const multiSel = document.getElementById('multi-select-container');
  const faultyDash = document.getElementById('faulty-dashboard-content');

  if (mode === 'faulty') {
      if(mainDash) mainDash.style.display = 'none';
      if(multiSel) multiSel.style.display = 'none';
      if(faultyDash) faultyDash.style.display = 'block';
      renderFaultyTable();
      return;
  } else {
      if(mainDash) mainDash.style.display = 'block';
      if(multiSel) multiSel.style.display = 'block';
      if(faultyDash) faultyDash.style.display = 'none';
  }

  if (mode === 'admin') ALL_DATA = ROLEINFO.isAdmin ? PARTITIONS.admin : []; 
  else if (mode === 'myTeam') ALL_DATA = PARTITIONS.myTeam; 
  else ALL_DATA = PARTITIONS.me; 

  resetTopFilters(); clearDrill(); closeAnyTopPopover(); currentPage = 1;
  renderTopFilters(HEADERS, ALL_DATA);
  renderAll();
  // Keep the KPI 1 charts on this unified screen synchronized with the shared Admin / My Team / Me view.
  window.dispatchEvent(new CustomEvent('task360:view-changed', { detail: { mode } }));
}

function renderFaultyTable() {
    const tbody = document.getElementById('faulty-table-body');
    if(!tbody) return;
    tbody.innerHTML = '';
    if (!FAULTY_DATA.length) {
        tbody.innerHTML = '<tr><td colspan="3" class="p-4 text-center text-success font-semibold">Perfect! No faulty data was detected during this load.</td></tr>';
        return;
    }
    FAULTY_DATA.forEach(err => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="text-warning text-xs font-semibold uppercase">${err.range}</td>
            <td class="text-danger text-sm font-semibold">${err.reason}</td>
            <td class="muted text-xs" style="font-family: monospace;">${err.raw}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function refreshData() {
  // Identity comes from the HttpOnly session established by One Portal SSO.
  // Do not accept an email or EmployeeCode from the browser URL.
  window.history.replaceState({}, '', window.location.pathname);

  const btn = document.getElementById('refresh-button'); 
  if(btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
  
  const tBody = document.getElementById('table-body');
  if(tBody) { tBody.setAttribute('aria-busy', 'true'); tBody.innerHTML = '<div class="record-list-message">Loading records…</div>'; }
  
  const pageCtrl = document.getElementById('pagination-controls');
  if(pageCtrl) pageCtrl.style.display = 'none';
  
  const statsDiv = document.getElementById('loading-stats');
  if(statsDiv) statsDiv.style.display = 'none';

  try {
    const response = await fetch('/api/payload', { credentials: 'same-origin' });
    if (!response.ok) {
      // Preserve the server's actual JSON error instead of hiding it behind a generic 503.
      const rawBody = await response.text();
      let detail = rawBody;
      try {
        const errorPayload = JSON.parse(rawBody);
        detail = errorPayload.error || errorPayload.detail || errorPayload.message || rawBody;
      } catch (_) {
        // Keep plain-text response bodies as the diagnostic detail.
      }
      const compactDetail = String(detail || '').replace(/\s+/g, ' ').trim().slice(0, 700);
      if (response.status === 401) throw new Error('Your One Portal session is not active. Please reopen Task 360 from One Portal.');
      if (response.status === 403) throw new Error(compactDetail || 'You do not have access to Task 360.');
      throw new Error(`HTTP ${response.status}${compactDetail ? `: ${compactDetail}` : ''}`);
    }
    const payload = await response.json();
    
    if (payload.stats && statsDiv && payload.roleInfo && payload.roleInfo.isAdmin) {
        statsDiv.style.display = 'block'; 
        const loadedCt = document.getElementById('loaded-count');
        const totalCt = document.getElementById('total-count');
        if(loadedCt) loadedCt.innerText = payload.stats.loadedRecords.toLocaleString();
        if(totalCt) totalCt.innerText = payload.stats.totalSystemRecords.toLocaleString();
        statsDiv.style.boxShadow = "0 0 10px var(--primary)";
        setTimeout(() => { statsDiv.style.boxShadow = "none"; }, 1500);
    } else if (statsDiv) {
        statsDiv.style.display = 'none'; 
    }
    
    currentPage = 1;
    handlePayload(payload);
    if (typeof window.refreshKpi1Analytics === 'function') window.refreshKpi1Analytics(false);
  } catch (error) { handleError(error); }
}

function handlePayload(payload) {
  const btn = document.getElementById('refresh-button'); 
  if(btn) { btn.disabled = false; btn.textContent = 'Refresh Data'; }
  
  ROLEINFO = payload.roleInfo || {}; 
  PARTITIONS = payload.partitions || { admin: [], myTeam: [], me: [] };
  FILTER_COLUMNS = payload.filterIndexes || {}; 
  HEADERS = payload.headers || [];
  FAULTY_DATA = payload.faultyData || []; 

  const emailDisp = document.getElementById('user-email-display');
  if(emailDisp) {
    const who = ROLEINFO.employeeName || 'Employee';
    const code = ROLEINFO.employeeCode || payload.employeeCode || '';
    emailDisp.textContent = `${who}${code ? ` · ${code}` : ''} (${deriveDefaultPartitionName()})`;
  }

  const bA = document.getElementById('tab-admin');
  const bT = document.getElementById('tab-myteam');
  const bM = document.getElementById('tab-me');
  const bF = document.getElementById('tab-faulty');
  
  if(bA) bA.style.display = ROLEINFO.isAdmin ? 'inline-flex' : 'none';
  if(bA) bA.disabled = !ROLEINFO.isAdmin;
  if(bT) { bT.style.display = ROLEINFO.isManager ? 'inline-flex' : 'none'; bT.disabled = !ROLEINFO.isManager; }
  if(bM) { bM.style.display = 'inline-flex'; bM.disabled = false; }

  if (ROLEINFO.isAdmin && FAULTY_DATA.length > 0) {
      if(bF) {
          bF.style.display = 'inline-block';
          bF.textContent = `Faulty Data (${FAULTY_DATA.length}) ⚠️`;
      }
  } else {
      if(bF) bF.style.display = 'none';
  }

  if (ROLEINFO.isAdmin) setMode('admin');
  else if (ROLEINFO.isManager) setMode('myTeam');
  else setMode('me');
}

function deriveDefaultPartitionName() {
  if (ROLEINFO.isAdmin) return 'Admin View';
  if (ROLEINFO.isManager) return 'My Team View';
  if (PARTITIONS.me?.length) return 'My Performance View';
  return 'No Access';
}

function getStatusBucket(row) {
  const rawIdx = FILTER_COLUMNS.RAW_STATUS;
  const visibleIdx = FILTER_COLUMNS.TASK_STATUS;
  const status = String((rawIdx != null ? row[rawIdx] : '') || (visibleIdx != null ? row[visibleIdx] : '') || '').toLowerCase().trim();
  if (['defer', 'missed', 'overdue', 'not done', 'not complet', 'unfinished', 'uncompleted', 'cancel'].some(term => status.includes(term))) return 'deferred';
  if (status.includes('finish') || status.includes('complet') || status.includes('done') || status.includes('closed')) return 'finished';
  return 'awaited';
}

function parseTaskDateValue(value) {
  if (value == null || String(value).trim() === '') return null;
  const text = String(value).trim();
  const native = new Date(text);
  if (!Number.isNaN(native.getTime())) return native;
  const match = text.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})[- ](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return null;
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const month = months[match[2].slice(0,3).toLowerCase()];
  if (month == null) return null;
  const result = new Date(Number(match[3]), month, Number(match[1]), Number(match[4] || 0), Number(match[5] || 0), Number(match[6] || 0));
  return Number.isNaN(result.getTime()) ? null : result;
}

// Generic Task Status is intentionally separate from KPI 1 / KPI 2 status values.
// Finished or Deferred is Complete; an open Awaited task is Planned until its
// planned timestamp passes, after which it is Pending.
function getGenericTaskStatus(row) {
  const rawIdx = FILTER_COLUMNS.RAW_STATUS;
  const statusIdx = FILTER_COLUMNS.TASK_STATUS;
  const status = String((rawIdx != null ? row[rawIdx] : '') || (statusIdx != null ? row[statusIdx] : '') || '').trim().toLowerCase();
  if (['finish', 'complet', 'defer', 'done', 'closed', 'cancel', 'missed', 'overdue', 'not done', 'not complet', 'unfinished', 'uncompleted'].some(term => status.includes(term))) return 'Complete';
  const plannedIdx = FILTER_COLUMNS.PLANNED;
  const planned = plannedIdx == null ? null : parseTaskDateValue(row[plannedIdx]);
  return planned && Date.now() > planned.getTime() ? 'Pending' : 'Planned';
}

function parseTeamNameValues(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (value == null || String(value).trim() === '') return [];
  const raw = String(value).trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
  } catch (_) { /* supports older records without JSON-encoded lookup values */ }
  return raw.split(/\s*[;,|]\s*/).map(v => v.trim()).filter(Boolean);
}

function rowMatchesTopFilter(key, row, selected, idx) {
  if (key === 'TEAM_NAME') return parseTeamNameValues(row[idx]).some(team => selected.has(team));
  return selected.has(String(row[idx] ?? '').trim());
}

function computeFilteredData(options = {}) {
  const ignoreTaskStatusFilter = Boolean(options.ignoreTaskStatusFilter);
  const ignoreScoreboardStatus = Boolean(options.ignoreScoreboardStatus);
  const ignoreDrills = Boolean(options.ignoreDrills);
  let data = ALL_DATA.slice();
  for (const key in TOP_FILTERS) {
    if (ignoreTaskStatusFilter && key === 'TASK_STATUS') continue;
    const selected = TOP_FILTERS[key];
    if (selected && selected.size) {
      const idx = FILTER_COLUMNS[key];
      if (idx != null && idx >= 0) {
        data = data.filter(r => rowMatchesTopFilter(key, r, selected, idx));
      }
    }
  }
  if (!ignoreScoreboardStatus && SCOREBOARD_STATUS_FILTER) {
    data = data.filter(row => getGenericTaskStatus(row) === SCOREBOARD_STATUS_FILTER);
  }
  if (!ignoreDrills && DRILL.status) {
    data = data.filter(r => {
      const b = getStatusBucket(r);
      return (DRILL.status === 'finished' && b === 'finished') || 
             (DRILL.status === 'deferred' && b === 'deferred') || 
             (DRILL.status === 'awaited' && b === 'awaited');
    });
  }
  if (!ignoreDrills && DRILL.fms) { data = data.filter(r => String(r[FILTER_COLUMNS.FMS] || '').trim() === DRILL.fms); }
  if (!ignoreDrills && DRILL.stage) { data = data.filter(r => String(r[FILTER_COLUMNS.STAGE] || '').trim() === DRILL.stage); }
  return data;
}

function renderKPIs(data) {
  if (!Object.keys(FILTER_COLUMNS).length) { setKPI('N/A', 'N/A', 'N/A', 'N/A'); return; }
  let deferredCount = 0, finishedCount = 0;
  data.forEach(r => {
    const bucket = getStatusBucket(r);
    if (bucket === 'deferred') deferredCount++;
    else if (bucket === 'finished') finishedCount++;
  });
  setKPI(deferredCount.toLocaleString(), finishedCount.toLocaleString(), data.length.toLocaleString(), '0.00');
}

function setKPI(a, b, c, d) { 
  const kD = document.getElementById('kpi-delayed'); if(kD) kD.textContent = a; 
  const kO = document.getElementById('kpi-ontime'); if(kO) kO.textContent = b; 
  const kT = document.getElementById('kpi-total'); if(kT) kT.textContent = c; 
  const kA = document.getElementById('kpi-avg-delay'); if(kA) kA.textContent = d; 
}

function resetTopFilters() { for (const k in TOP_FILTERS) delete TOP_FILTERS[k]; SCOREBOARD_STATUS_FILTER = null; }

function renderTopFilters(headers, data) {
  const wrap = document.getElementById('filters-below-views');
  if (!wrap) return; wrap.innerHTML = '';
  if (!Object.keys(FILTER_COLUMNS).length) return;

  const ORDER = [
    { key: 'KPI_MONTH',   label: 'KPI Month'   }, { key: 'WEEK_NO',     label: 'Week No'     },
    { key: 'DAY_NO',      label: 'Day No'      }, { key: 'DOER',        label: 'Doer'        },
    { key: 'DEPARTMENT',  label: 'Department'  }, { key: 'TEAM_NAME',   label: 'Team Name'   },
    { key: 'FMS',         label: 'FMS'         }, { key: 'STAGE',       label: 'Stage'       },
    { key: 'TASK_STATUS', label: 'KPI 2 Status' }
  ];

  const optionsMap = {};
  ORDER.forEach(({ key }) => {
    if (FILTER_COLUMNS[key] == null || FILTER_COLUMNS[key] < 0) return;
    const idx = FILTER_COLUMNS[key];
    const set = new Set();
    data.forEach(r => {
      const v = r[idx];
      if (key === 'TEAM_NAME') parseTeamNameValues(v).forEach(team => set.add(team));
      else if (v != null && String(v).trim() !== '') set.add(String(v).trim());
    });
    optionsMap[key] = Array.from(set).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }));
    if (!TOP_FILTERS[key]) TOP_FILTERS[key] = new Set();
  });

  ORDER.forEach(({ key, label }) => {
    if (FILTER_COLUMNS[key] == null || FILTER_COLUMNS[key] < 0) return;
    const btn = document.createElement('button');
    btn.className = 'filter-chip-btn'; btn.setAttribute('data-top-key', key);
    btn.innerHTML = `<span>${label}</span><span class="filter-chip-count">${TOP_FILTERS[key].size || 0}</span>`;
    btn.addEventListener('click', (ev) => { ev.stopPropagation(); toggleTopPopover(key, btn, optionsMap[key] || []); });
    wrap.appendChild(btn);
  });
}

function toggleTopPopover(key, triggerBtn, options) {
  if (OPEN_TOP_FOR === key) { closeAnyTopPopover(); return; }
  closeAnyTopPopover();
  OPEN_TOP_FOR = key; CURRENT_TOP_WORKSET = new Set(TOP_FILTERS[key] ? Array.from(TOP_FILTERS[key]) : []);

  const pop = document.createElement('div'); pop.className = 'multi-pop'; pop.setAttribute('data-key', key);
  const head = document.createElement('div'); head.className = 'multi-head';
  const row1 = document.createElement('div'); row1.className = 'multi-row';
  const search = document.createElement('input'); search.type = 'text'; search.placeholder = 'Search...';
  row1.appendChild(search); head.appendChild(row1);
  const actions = document.createElement('div'); actions.className = 'multi-actions';
  
  const btnSelectAll = document.createElement('button'); btnSelectAll.className = 'link-btn'; btnSelectAll.textContent = 'All';
  btnSelectAll.onclick = (e) => { e.preventDefault(); filtered().forEach(v => CURRENT_TOP_WORKSET.add(v)); renderList(); };
  const btnClear = document.createElement('button'); btnClear.className = 'link-btn'; btnClear.textContent = 'Clear';
  btnClear.onclick = (e) => { e.preventDefault(); filtered().forEach(v => CURRENT_TOP_WORKSET.delete(v)); renderList(); };

  actions.appendChild(btnSelectAll); actions.appendChild(btnClear); head.appendChild(actions); pop.appendChild(head);
  const list = document.createElement('div'); list.className = 'multi-list'; pop.appendChild(list);
  const foot = document.createElement('div'); foot.className = 'multi-foot';
  
  const btnCancel = document.createElement('button'); btnCancel.className = 'btn btn-clear'; btnCancel.textContent = 'Cancel'; btnCancel.onclick = () => closeAnyTopPopover();
  const btnApply = document.createElement('button'); btnApply.className = 'btn'; btnApply.textContent = 'Apply';
  btnApply.onclick = () => {
    TOP_FILTERS[key] = new Set(CURRENT_TOP_WORKSET);
    const badge = triggerBtn.querySelector('.filter-chip-count');
    if(badge) badge.textContent = TOP_FILTERS[key].size || 0;
    closeAnyTopPopover(); currentPage = 1; clearDrill(); renderAll(); 
  };
  
  foot.appendChild(btnCancel); foot.appendChild(btnApply); pop.appendChild(foot); document.body.appendChild(pop);

  // The popover is position:fixed, so always use viewport coordinates from
  // getBoundingClientRect(). Do NOT add window.scrollY/scrollX; that caused
  // the panel to drift above/below its filter when the page was scrolled.
  function positionTopPopover() {
    if (!pop.isConnected || !triggerBtn.isConnected) return;
    const rect = triggerBtn.getBoundingClientRect();
    const margin = 12;
    const gap = 8;
    // Measure in viewport coordinates and use the native page scale so popovers
    // line up directly under their filters in the dashboard and One Portal iframe.
    const rootZoomValue = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    const rootZoom = Number.isFinite(rootZoomValue) && rootZoomValue > 0 ? rootZoomValue : 1;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popWidth = Math.max(0, Math.min(300, viewportWidth - margin * 2));
    pop.style.width = `${popWidth / rootZoom}px`;

    // Align the left edge with the filter. If there isn't room, align right
    // edges instead, and clamp to the viewport so the panel is never cut off.
    let left = rect.left;
    if (left + popWidth > viewportWidth - margin) left = rect.right - popWidth;
    left = Math.max(margin, Math.min(left, viewportWidth - popWidth - margin));

    const belowTop = rect.bottom + gap;
    const belowSpace = Math.max(0, viewportHeight - belowTop - margin);
    const aboveSpace = Math.max(0, rect.top - gap - margin);
    const measuredHeight = Math.min(pop.scrollHeight || 300, 360);
    let top = belowTop;
    let available = belowSpace;

    // Prefer directly below the selected filter. Flip above only when the
    // viewport cannot fit a usable menu below and there is clearly more room above.
    if (belowSpace < Math.min(measuredHeight, 190) && aboveSpace > belowSpace) {
      available = aboveSpace;
      top = Math.max(margin, rect.top - gap - Math.min(measuredHeight, available));
    }

    available = Math.max(90, Math.min(360, available));
    pop.style.top = `${Math.round(top / rootZoom)}px`;
    pop.style.left = `${Math.round(left / rootZoom)}px`;
    pop.style.maxHeight = `${Math.round(available / rootZoom)}px`;
    const fixedContent = head.getBoundingClientRect().height + foot.getBoundingClientRect().height + 4;
    list.style.maxHeight = `${Math.max(40, Math.min(230, available - fixedContent)) / rootZoom}px`;
  }

  function filtered() { const q = (search.value || '').trim().toLowerCase(); return !q ? options.slice() : options.filter(v => String(v).toLowerCase().includes(q)); }
  function renderList() {
    list.innerHTML = ''; const vals = filtered();
    if (!vals.length) { list.innerHTML = '<div class="muted text-sm">No options</div>'; return; }
    vals.forEach(v => {
      const row = document.createElement('label'); row.className = 'multi-item';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = CURRENT_TOP_WORKSET.size ? CURRENT_TOP_WORKSET.has(v) : false;
      cb.addEventListener('change', () => { if (cb.checked) CURRENT_TOP_WORKSET.add(v); else CURRENT_TOP_WORKSET.delete(v); });
      const span = document.createElement('span'); span.textContent = v;
      row.appendChild(cb); row.appendChild(span); list.appendChild(row);
    });
  }
  renderList();
  search.addEventListener('input', () => { renderList(); positionTopPopover(); });
  triggerBtn.classList.add('active');
  positionTopPopover();

  // Re-anchor the panel if the page, a scroll container, or the window moves.
  const handleScroll = (event) => {
    if (event && event.target && pop.contains(event.target)) return;
    positionTopPopover();
  };
  pop._filterPopoverTrigger = triggerBtn;
  pop._filterPopoverScroll = handleScroll;
  pop._filterPopoverResize = positionTopPopover;
  window.addEventListener('scroll', handleScroll, true);
  window.addEventListener('resize', positionTopPopover);
  search.focus({ preventScroll: true });
}

function closeAnyTopPopover() {
  // Close KPI 1's popover too, so only one filter menu can be open at a time.
  if (typeof window.task360CloseKpi1FilterPopover === 'function') {
    window.task360CloseKpi1FilterPopover();
  }
  const pop = document.querySelector('.multi-pop');
  if (pop) {
    if (pop._filterPopoverScroll) window.removeEventListener('scroll', pop._filterPopoverScroll, true);
    if (pop._filterPopoverResize) window.removeEventListener('resize', pop._filterPopoverResize);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
  }
  OPEN_TOP_FOR = null; CURRENT_TOP_WORKSET = new Set();
  document.querySelectorAll('.filter-chip-btn.active').forEach(b => b.classList.remove('active'));
}

// Shared close hook used by the KPI 1 filter module.
window.task360CloseSharedFilterPopover = closeAnyTopPopover;

// A click anywhere outside all filter buttons/popovers closes every open menu.
if (!window.__task360GlobalFilterDismissBound) {
  document.addEventListener('click', event => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (target.closest('.multi-pop, .kpi1-multi-pop')) return;
    if (target.closest('.filter-chip-btn, .kpi1-filter-chip-btn')) return;
    closeAnyTopPopover();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAnyTopPopover();
  });
  window.__task360GlobalFilterDismissBound = true;
}

function aggregateByKey(data, keyIndex) {
  const agg = {};
  data.forEach(r => {
    const bucket = getStatusBucket(r);
    if (bucket !== 'finished' && bucket !== 'deferred') return;
    const key = String(r[keyIndex] || 'N/A').trim();
    if (!agg[key]) agg[key] = { finished: 0, deferred: 0 };
    agg[key][bucket] += 1;
  });
  return agg;
}

function renderCharts() {
  const data = computeFilteredData();
  const css = getComputedStyle(document.documentElement);
  const colGreen = css.getPropertyValue('--chart-green').trim(); const colRed = css.getPropertyValue('--chart-red').trim();
  const colBlue = css.getPropertyValue('--chart-blue').trim(); const pendingColor = '#7F5D99'; const textCol = css.getPropertyValue('--text').trim();

  if (statusDoughnutChartInstance) statusDoughnutChartInstance.destroy();
  let totalFinished = 0, totalDeferred = 0, totalAwaited = 0;
  data.forEach(r => { const b = getStatusBucket(r); if (b === 'finished') totalFinished++; else if (b === 'deferred') totalDeferred++; else totalAwaited++; });
  
  const dCtx = document.getElementById('statusDoughnutChart');
  if(dCtx) {
      statusDoughnutChartInstance = new Chart(dCtx.getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Finished', 'Deferred', 'Awaited'], datasets: [{ data: [totalFinished, totalDeferred, totalAwaited], backgroundColor: [colGreen, colRed, pendingColor], hoverOffset: 8 }] },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '70%',
          plugins: { legend: { position: 'bottom', labels: { color: textCol }} },
          onClick: (e, els) => { if (!els.length) return; const idx = els[0].index; DRILL.status = idx === 0 ? 'finished' : (idx === 1 ? 'deferred' : 'awaited'); currentPage = 1; renderAll(); }
        }
      });
  }

  const bCtx = document.getElementById('fmsBarChart');
  if (fmsBarChartInstance) fmsBarChartInstance.destroy();

  if(bCtx) {
      if (!DRILL.fms) {
        const idxF = FILTER_COLUMNS.FMS; const agg = aggregateByKey(data, idxF);
        const labels = Object.keys(agg); const finished = labels.map(l => agg[l].finished); const deferred = labels.map(l => agg[l].deferred);
        fmsBarChartInstance = new Chart(bCtx.getContext('2d'), {
          type: 'bar',
          data: { labels, datasets: [ { label: 'Finished', data: finished, backgroundColor: colGreen, borderRadius: 6, stack: 'status' }, { label: 'Deferred', data: deferred, backgroundColor: colRed, borderRadius: 6, stack: 'status' } ]},
          options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { color: css.getPropertyValue('--border') }}, y: { stacked: true, beginAtZero: true, grid: { color: css.getPropertyValue('--border') }, ticks: { precision: 0 }} }, plugins: { legend: { position: 'top', labels: { color: textCol }}}, onClick: (e, els) => { if (!els.length) return; const i = els[0].index; DRILL.fms = labels[i]; DRILL.stage = null; currentPage = 1; renderAll(); } }
        });
        const barTitle = document.getElementById('bar-title');
        if(barTitle) barTitle.textContent = 'FMS – Finished vs Deferred';
      } else {
        const idxF = FILTER_COLUMNS.FMS, idxS = FILTER_COLUMNS.STAGE;
        const scoped = data.filter(r => String(r[idxF] || '').trim() === DRILL.fms);
        const agg = aggregateByKey(scoped, idxS);
        const labels = Object.keys(agg); const finished = labels.map(l => agg[l].finished); const deferred = labels.map(l => agg[l].deferred);
        fmsBarChartInstance = new Chart(bCtx.getContext('2d'), {
          type: 'bar',
          data: { labels, datasets: [ { label: 'Finished', data: finished, backgroundColor: colGreen, borderRadius: 6, stack: 'status' }, { label: 'Deferred', data: deferred, backgroundColor: colRed, borderRadius: 6, stack: 'status' } ]},
          options: { responsive: true, maintainAspectRatio: false, scales: { x: { stacked: true, grid: { color: css.getPropertyValue('--border') }}, y: { stacked: true, beginAtZero: true, grid: { color: css.getPropertyValue('--border') }, ticks: { precision: 0 }} }, plugins: { legend: { position: 'top', labels: { color: textCol }}}, onClick: (e, els) => { if (!els.length) return; const i = els[0].index; DRILL.stage = labels[i]; currentPage = 1; renderAll(); } }
        });
        const barTitle = document.getElementById('bar-title');
        if(barTitle) barTitle.textContent = `Stages – ${DRILL.fms}: Finished vs Deferred`;
      }
      fmsBarChartInstance.config._durationFmt = (x) => x;
  }
}

function normalizeHeaderKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getTableCellValue(row, header, index) {
  if (Array.isArray(row)) return row[index];
  if (!row || typeof row !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(row, header)) return row[header];
  const wanted = normalizeHeaderKey(header);
  const match = Object.keys(row).find(key => normalizeHeaderKey(key) === wanted);
  if (match !== undefined) return row[match];
  return Object.values(row)[index] ?? '';
}

function renderTable(data) {
  const container = document.getElementById('table-body');
  const paginationControls = document.getElementById('pagination-controls');
  if (!container) return;

  container.className = 'record-table-wrap task360-record-wrap';
  container.setAttribute('aria-busy', 'false');
  container.replaceChildren();

  const rows = Array.isArray(data) ? data : [];
  const headers = Array.isArray(HEADERS) ? HEADERS.slice() : [];
  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  currentPage = Math.max(1, Math.min(currentPage, totalPages));
  const startIdx = (currentPage - 1) * ROWS_PER_PAGE;
  const pageData = rows.slice(startIdx, startIdx + ROWS_PER_PAGE);

  if (!pageData.length) {
    const empty = document.createElement('div');
    empty.className = 'record-list-message';
    empty.textContent = rows.length ? 'No records match the current filters.' : 'No records found for this view or date range.';
    container.appendChild(empty);
    if (paginationControls) paginationControls.style.display = 'none';
  } else {
    if (paginationControls) paginationControls.style.display = 'flex';

    const headerIndex = new Map();
    headers.forEach((header, index) => {
      const key = normalizeHeaderKey(header);
      if (!headerIndex.has(key)) headerIndex.set(key, index);
    });
    const findIndex = (...names) => {
      for (const name of names) {
        const idx = headerIndex.get(normalizeHeaderKey(name));
        if (idx != null) return idx;
      }
      return -1;
    };
    const readValue = (row, ...names) => {
      const idx = findIndex(...names);
      return idx >= 0 ? getTableCellValue(row, headers[idx], idx) : '';
    };
    const displayValue = value => value == null || String(value).trim() === '' ? '—' : String(value);

    const taskCols = [
      { label: 'Record', width: 54, aliases: ['Record #', 'Record ID', 'RowID', 'Task ID'] },
      { label: 'FMS Name', width: 95, aliases: ['FMS Name'] },
      { label: 'Stage No', width: 55, aliases: ['Stage No', 'StageNo', 'Stage_No'] },
      { label: 'Stage Name', width: 105, aliases: ['Stage Name'] },
      { label: 'Doer Name', width: 88, aliases: ['Doer Name'] },
      { label: 'Manager Code', width: 66, aliases: ['Manager Code'] },
      { label: 'Manager Name', width: 86, aliases: ['Manager Name'] },
      { label: 'Task Status', width: 77, aliases: ['Task Status'] },
      { label: 'Planned', width: 98, aliases: ['Planned'] },
      { label: 'Lead Time', width: 66, aliases: ['Lead Time'] },
      { label: 'Forms', width: 62, forms: true },
      { label: 'Actual', width: 98, aliases: ['Actual'] },
      { label: 'KPIRecord Key', width: 110, aliases: ['KPI Record Key', 'KPIRecord Key'] },
      { label: 'Year', width: 52, aliases: ['KPI Year', 'Year'] },
      { label: 'Month', width: 52, aliases: ['KPI Month', 'Month'] },
      { label: 'Day', width: 42, aliases: ['Day No', 'Day'] },
      { label: 'Presence Factor', width: 76, aliases: ['Presence Factor'] },
    ];
    const kpi1Cols = [
      { label: 'KPI01 Score', width: 145, aliases: ['KPI01 Score'] },
      { label: 'KPI 1 Factored Score', width: 170, aliases: ['KPI 1 Factored Score'] },
      { label: 'KPI 1 Task Status', width: 150, aliases: ['KPI 1 Task Status'] },
    ];
    const kpi2Cols = [
      { label: 'KPI 2 Task Status', width: 150, aliases: ['Task Status'] },
      { label: "Total Day's Task", width: 135, aliases: ['Total Tasks'] },
      { label: "Finished Day's Task", width: 145, aliases: ['Finished'] },
      { label: 'Task Completion Rate', width: 145, aliases: ['Task Completion Rate'] },
      { label: 'Task Completion Rate KPI Weightage', width: 185, aliases: ['Task Completion Rate KPI Weightage'] },
      { label: 'Weighted Task Completion Rate Score', width: 190, aliases: ['Weighted Task Completion Rate Score'] },
    ];

    const layout = document.createElement('div');
    layout.className = 'task360-merged-layout';
    if (!window.task360KpiPaneCollapsed || typeof window.task360KpiPaneCollapsed.kpi1 !== 'boolean' || typeof window.task360KpiPaneCollapsed.kpi2 !== 'boolean') {
      // Both optional KPI panels start closed so Task Details can use the full width.
      window.task360KpiPaneCollapsed = { kpi1: true, kpi2: true };
    }
    const taskTableWidth = taskCols.reduce((sum, col) => sum + col.width, 0);
    const kpiPaneWidths = { kpi1: 390, kpi2: 530 };
    const setMergedPaneLayout = () => {
      const taskPane = layout.querySelector('[data-pane="task"]');
      const taskViewport = layout.querySelector('.task360-task-viewport');
      const taskTable = layout.querySelector('.task360-task-table');
      const kpiPanes = ['kpi1', 'kpi2'].map(key => ({ key, el: layout.querySelector(`[data-pane="${key}"]`) }));
      const openKpis = kpiPanes.filter(({ key }) => window.task360KpiPaneCollapsed[key] === false);

      kpiPanes.forEach(({ key, el }) => {
        if (!el) return;
        const collapsed = window.task360KpiPaneCollapsed[key] !== false;
        el.classList.toggle('is-collapsed', collapsed);
        el.style.display = collapsed ? 'none' : '';
        if (!collapsed && taskViewport) {
          const paneViewport = el.querySelector('.task360-pane-viewport');
          if (paneViewport) paneViewport.scrollTop = taskViewport.scrollTop;
        }
      });

      const taskColsEls = layout.querySelectorAll('.task360-task-table colgroup col');
      if (!openKpis.length) {
        // No KPI cards open: hide their tracks and let the generic task table fill the card.
        layout.style.gridTemplateColumns = 'minmax(0, 1fr)';
        layout.style.width = '100%';
        layout.style.minWidth = '0';
        if (taskPane) taskPane.style.width = '100%';
        if (taskViewport) taskViewport.style.overflowX = 'hidden';
        if (taskTable) taskTable.style.width = '100%';
        taskColsEls.forEach((col, index) => {
          const percent = taskCols[index] ? (taskCols[index].width / taskTableWidth) * 100 : 0;
          col.style.width = `${percent.toFixed(5)}%`;
        });
      } else {
        // When a KPI card is opened, preserve the familiar table and pane widths.
        const tracks = [`${taskTableWidth}px`, ...openKpis.map(({ key }) => `${kpiPaneWidths[key]}px`)];
        const totalWidth = taskTableWidth + openKpis.reduce((sum, { key }) => sum + kpiPaneWidths[key], 0) + (tracks.length - 1) * 10;
        layout.style.gridTemplateColumns = tracks.join(' ');
        layout.style.width = `max(100%, ${totalWidth}px)`;
        layout.style.minWidth = '100%';
        if (taskPane) taskPane.style.width = `${taskTableWidth}px`;
        if (taskViewport) taskViewport.style.overflowX = 'hidden';
        if (taskTable) taskTable.style.width = `${taskTableWidth}px`;
        taskColsEls.forEach((col, index) => {
          if (taskCols[index]) col.style.width = `${taskCols[index].width}px`;
        });
      }

      // Keep header controls in sync even after pagination or filters rebuild the table.
      document.querySelectorAll('[data-task360-pane-toggle]').forEach(button => {
        const key = button.dataset.task360PaneToggle;
        const expanded = window.task360KpiPaneCollapsed[key] === false;
        const label = key === 'kpi1' ? 'KPI 1 · Delay' : 'KPI 2 · Completion';
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${label}`);
        button.title = `${expanded ? 'Collapse' : 'Expand'} ${label}`;
        button.classList.toggle('is-active', expanded);
      });
      layout.querySelectorAll('.task360-pane').forEach(pane => pane._task360UpdateScrollButtons?.());
    };
    const panes = [
      { key: 'task', title: 'Task Details & Generic KPI Fields', cols: taskCols, className: 'task360-pane task360-task-pane', width: taskTableWidth, tableWidth: taskTableWidth },
      { key: 'kpi1', title: 'KPI 1 · Delay', cols: kpi1Cols, className: 'task360-pane task360-kpi-pane task360-kpi1-pane', width: 390, tableWidth: 465 },
      { key: 'kpi2', title: 'KPI 2 · Completion', cols: kpi2Cols, className: 'task360-pane task360-kpi-pane task360-kpi2-pane', width: 530, tableWidth: 950 },
    ];

    panes.forEach(pane => {
      const paneEl = document.createElement('section');
      paneEl.className = pane.className;
      paneEl.dataset.pane = pane.key;
      // Let the grid tracks control KPI pane widths so they can collapse to compact toggle tabs.
      paneEl.style.width = pane.key === 'task' ? `${pane.width}px` : 'auto';
      const startsCollapsed = pane.key !== 'task' && window.task360KpiPaneCollapsed[pane.key] !== false;
      if (startsCollapsed) {
        paneEl.classList.add('is-collapsed');
        paneEl.style.display = 'none';
      }

      const title = document.createElement('div');
      title.className = 'task360-pane-title';
      title.textContent = pane.title;
      paneEl.appendChild(title);

      const viewport = document.createElement('div');
      viewport.id = `task360-${pane.key}-pane-content`;
      viewport.className = pane.key === 'task' ? 'task360-pane-viewport task360-task-viewport' : 'task360-pane-viewport task360-kpi-viewport';
      viewport.setAttribute('aria-label', `${pane.title} columns`);

      const table = document.createElement('table');
      table.className = `task360-merged-table task360-${pane.key}-table`;
      table.style.width = `${pane.tableWidth}px`;
      table.setAttribute('aria-label', pane.title);

      const colgroup = document.createElement('colgroup');
      pane.cols.forEach(col => {
        const c = document.createElement('col');
        c.style.width = `${col.width}px`;
        colgroup.appendChild(c);
      });
      table.appendChild(colgroup);

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      headerRow.className = 'task360-col-header-row';
      pane.cols.forEach(col => {
        const th = document.createElement('th');
        th.scope = 'col';
        th.textContent = col.label;
        th.title = col.label;
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);

      const tbody = document.createElement('tbody');
      const fragment = document.createDocumentFragment();
      pageData.forEach((row, rowIndex) => {
        const tr = document.createElement('tr');
        tr.dataset.rowIndex = String(rowIndex);
        pane.cols.forEach(col => {
          const td = document.createElement('td');
          if (col.forms) {
            const recordId = readValue(row, 'Record #', 'Record ID', 'RowID', 'Task ID');
            const appId = readValue(row, 'App ID', 'AppID', 'App_ID', 'Application ID');
            const stageNo = readValue(row, 'Stage No', 'StageNo', 'Stage_No', 'Stage Number');
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'stage-form-show-button';
            button.textContent = 'Show';
            if ([recordId, appId, stageNo].every(v => v != null && String(v).trim() !== '')) {
              button.dataset.stageFormLaunch = 'true';
              button.dataset.recordId = String(recordId).trim();
              button.dataset.appId = String(appId).trim();
              button.dataset.stageNo = String(stageNo).trim();
              button.title = `Open stage form in a new tab · Record ${recordId} · ${appId} · ${stageNo}`;
            } else {
              button.disabled = true;
              button.title = 'Cannot open form: Record #, App ID, or Stage No is missing.';
            }
            td.appendChild(button);
          } else {
            const rawValue = readValue(row, ...(col.aliases || [col.label]));
            const isGenericStatus = normalizeHeaderKey(col.label) === 'taskstatus';
            const value = isGenericStatus ? getGenericTaskStatus(row) : rawValue;
            td.textContent = displayValue(value);
            if (isGenericStatus) {
              const status = normalizeHeaderKey(value);
              if (status === 'complete') td.classList.add('cell-status--finished');
              else if (status === 'pending') td.classList.add('cell-status--deferred');
              else td.classList.add('cell-status--pending');
            }
            if (value != null && String(value).length > 18) td.title = String(value);
          }
          tr.appendChild(td);
        });
        fragment.appendChild(tr);
      });
      tbody.appendChild(fragment);
      table.append(thead, tbody);
      viewport.appendChild(table);
      const scrollShell = document.createElement('div');
      scrollShell.className = `task360-pane-scroll-shell task360-pane-scroll-shell--${pane.key}`;
      scrollShell.appendChild(viewport);

      if (pane.key === 'kpi1' || pane.key === 'kpi2') {
        const scrollControls = document.createElement('div');
        scrollControls.className = 'task360-kpi-scroll-controls';
        scrollControls.setAttribute('role', 'group');
        scrollControls.setAttribute('aria-label', `Scroll ${pane.title} columns`);

        const makeScrollButton = (direction, symbol, label) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `task360-kpi-scroll-arrow task360-kpi-scroll-arrow--${direction}`;
          button.textContent = symbol;
          button.setAttribute('aria-label', label);
          button.title = label;
          button.addEventListener('click', () => {
            const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
            const distance = Math.max(180, Math.round(viewport.clientWidth * 0.72));
            const target = direction === 'left'
              ? Math.max(0, viewport.scrollLeft - distance)
              : Math.min(maxScroll, viewport.scrollLeft + distance);
            viewport.scrollTo({ left: target, behavior: 'smooth' });
          });
          return button;
        };

        const leftButton = makeScrollButton('left', '‹', `Scroll ${pane.title} left`);
        const rightButton = makeScrollButton('right', '›', `Scroll ${pane.title} right`);
        scrollControls.append(leftButton, rightButton);
        scrollShell.appendChild(scrollControls);

        const updateScrollButtons = () => {
          const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
          const current = viewport.scrollLeft;
          scrollControls.hidden = maxScroll <= 2;
          leftButton.disabled = current <= 2;
          rightButton.disabled = current >= maxScroll - 2;
          leftButton.setAttribute('aria-disabled', String(leftButton.disabled));
          rightButton.setAttribute('aria-disabled', String(rightButton.disabled));
        };
        viewport.addEventListener('scroll', updateScrollButtons, { passive: true });
        window.requestAnimationFrame(updateScrollButtons);
        paneEl.addEventListener('mouseenter', updateScrollButtons);
        paneEl.addEventListener('focusin', updateScrollButtons);
        paneEl._task360UpdateScrollButtons = updateScrollButtons;
      }

      paneEl.appendChild(scrollShell);
      layout.appendChild(paneEl);
    });
    container.appendChild(layout);
    setMergedPaneLayout();

    // All three panes use their own row viewport but share vertical scroll so records stay aligned.
    const synchronizedViewports = Array.from(layout.querySelectorAll('.task360-pane-viewport'));
    let isSyncingVerticalScroll = false;
    synchronizedViewports.forEach(viewport => {
      viewport.addEventListener('scroll', () => {
        if (isSyncingVerticalScroll) return;
        isSyncingVerticalScroll = true;
        const top = viewport.scrollTop;
        synchronizedViewports.forEach(peer => {
          if (peer !== viewport && Math.abs(peer.scrollTop - top) > 1) peer.scrollTop = top;
        });
        isSyncingVerticalScroll = false;
      }, { passive: true });
    });

    // Keep row heights shared across panes so each task stays aligned while KPI groups scroll horizontally.
    const alignHeights = () => {
      const paneElements = Array.from(layout.querySelectorAll('.task360-pane'));
      if (!paneElements.length) return;
      const headRows = paneElements.map(el => el.querySelector('thead tr')).filter(Boolean);
      headRows.forEach(el => { el.style.height = 'auto'; });
      const headerHeight = Math.max(0, ...headRows.map(el => el.getBoundingClientRect().height));
      const zoomRaw = Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1');
      const zoomScale = zoomRaw > 1 ? zoomRaw / 100 : (zoomRaw || 1);
      if (headerHeight) headRows.forEach(el => { el.style.height = `${Math.ceil(headerHeight / zoomScale)}px`; });

      const rowSets = paneElements.map(el => Array.from(el.querySelectorAll('tbody tr')));
      rowSets.forEach(set => set.forEach(el => { el.style.height = 'auto'; }));
      const maxRows = Math.max(0, ...rowSets.map(set => set.length));
      for (let i = 0; i < maxRows; i++) {
        const heights = rowSets.map(set => set[i]).filter(Boolean).map(el => el.getBoundingClientRect().height);
        if (!heights.length) continue;
        const cssHeight = Math.ceil(Math.max(...heights) / zoomScale);
        rowSets.forEach(set => { if (set[i]) set[i].style.height = `${cssHeight}px`; });
      }
    };
    document.querySelectorAll('[data-task360-pane-toggle]').forEach(button => {
      button.onclick = () => {
        const key = button.dataset.task360PaneToggle;
        if (!['kpi1', 'kpi2'].includes(key)) return;
        window.task360KpiPaneCollapsed[key] = !window.task360KpiPaneCollapsed[key];
        setMergedPaneLayout();
        window.requestAnimationFrame(alignHeights);
      };
    });
    setMergedPaneLayout();
    window.requestAnimationFrame(() => {
      alignHeights();
      layout.querySelectorAll('.task360-pane').forEach(pane => pane._task360UpdateScrollButtons?.());
    });
    if (!window.__task360MergedResizeBound) {
      window.__task360MergedResizeBound = true;
      window.addEventListener('resize', () => {
        const active = document.querySelector('.task360-merged-layout');
        if (active) window.requestAnimationFrame(() => {
          const paneElements = Array.from(active.querySelectorAll('.task360-pane'));
          const headRows = paneElements.map(el => el.querySelector('thead tr')).filter(Boolean);
          headRows.forEach(el => { el.style.height = 'auto'; });
          const zoomRaw = Number.parseFloat(getComputedStyle(document.documentElement).zoom || '1');
          const zoomScale = zoomRaw > 1 ? zoomRaw / 100 : (zoomRaw || 1);
          const headerHeight = Math.max(0, ...headRows.map(el => el.getBoundingClientRect().height));
          if (headerHeight) headRows.forEach(el => { el.style.height = `${Math.ceil(headerHeight / zoomScale)}px`; });
          const sets = paneElements.map(el => Array.from(el.querySelectorAll('tbody tr')));
          sets.forEach(set => set.forEach(el => { el.style.height = 'auto'; }));
          for (let i = 0; i < Math.max(0, ...sets.map(set => set.length)); i++) {
            const hs = sets.map(set => set[i]).filter(Boolean).map(el => el.getBoundingClientRect().height);
            if (hs.length) sets.forEach(set => { if (set[i]) set[i].style.height = `${Math.ceil(Math.max(...hs) / zoomScale)}px`; });
          }
          active.querySelectorAll('.task360-pane').forEach(pane => pane._task360UpdateScrollButtons?.());
        });
      }, { passive: true });
    }
    // One hover highlights the corresponding task across all three panes.
    layout.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('mouseenter', () => layout.querySelectorAll(`tbody tr[data-row-index="${tr.dataset.rowIndex}"]`).forEach(peer => peer.classList.add('task360-row-hover')));
      tr.addEventListener('mouseleave', () => layout.querySelectorAll(`tbody tr[data-row-index="${tr.dataset.rowIndex}"]`).forEach(peer => peer.classList.remove('task360-row-hover')));
    });
  }

  const pInput = document.getElementById('page-input');
  if (pInput) { pInput.value = currentPage; pInput.max = totalPages; }
  const pInfo = document.getElementById('page-info');
  if (pInfo) pInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  const tRecords = document.getElementById('total-records');
  if (tRecords) tRecords.textContent = rows.length.toLocaleString();
  const prevBtn = document.getElementById('prev-page');
  if (prevBtn) prevBtn.disabled = currentPage === 1;
  const nextBtn = document.getElementById('next-page');
  if (nextBtn) nextBtn.disabled = currentPage === totalPages;
}

function updateBreadcrumb() {
  const box = document.getElementById('drill-breadcrumb'); 
  if(!box) return;
  box.innerHTML = '';
  const makeChip = (label, onClear) => { 
      const span = document.createElement('span'); span.className = 'chip'; span.innerHTML = label + ' <svg xmlns="http://www.w3.org/2000/svg" class="w-3 h-3" viewBox="0 0 20 20" fill="currentColor"><path d="M10 8.586l4.95-4.95 1.414 1.414L11.414 10l4.95 4.95-1.414 1.414L10 11.414l-4.95 4.95-1.414-1.414L8.586 10l-4.95-4.95L5.05 3.636 10 8.586z"/></svg>'; 
      span.style.cursor = 'pointer'; span.onclick = onClear; return span; 
  };
  if (DRILL.status) box.appendChild(makeChip('Status: ' + (DRILL.status === 'finished' ? 'Finished' : (DRILL.status === 'deferred' ? 'Deferred' : 'Awaited')), () => { DRILL.status = null; currentPage=1; renderAll(); }));
  if (DRILL.fms) box.appendChild(makeChip('FMS: ' + DRILL.fms, () => { DRILL.stage = null; DRILL.fms = null; currentPage=1; renderAll(); })); 
  if (DRILL.stage) box.appendChild(makeChip('Stage: ' + DRILL.stage, () => { DRILL.stage = null; currentPage=1; renderAll(); })); 
  const dBack = document.getElementById('drill-back');
  if(dBack) dBack.style.display = (DRILL.stage || DRILL.fms) ? 'inline-block' : 'none';
}

function clearDrill() { DRILL.status = null; DRILL.fms = null; DRILL.stage = null; updateBreadcrumb(); }
function renderDashboardOnly() {
  const data = computeFilteredData();
  renderKPIs(data);
  try { renderCharts(); } catch (error) { console.error('Chart rendering failed:', error); }
}
function renderTaskStatusScoreboard(baseRows) {
  const wrap = document.getElementById('task-status-scoreboard');
  if (!wrap) return;
  const rows = Array.isArray(baseRows) ? baseRows : [];
  const counts = { Planned: 0, Pending: 0, Complete: 0 };
  rows.forEach(row => {
    const status = getGenericTaskStatus(row);
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status]++;
  });

  const allCount = document.getElementById('status-count-all');
  if (allCount) allCount.textContent = rows.length.toLocaleString();
  const allButton = wrap.querySelector('[data-task-status-score="All"]');
  if (allButton) {
    const active = !SCOREBOARD_STATUS_FILTER;
    allButton.classList.toggle('active', active);
    allButton.setAttribute('aria-pressed', String(active));
  }

  Object.entries({ Planned: 'planned', Pending: 'pending', Complete: 'complete' }).forEach(([status, suffix]) => {
    const count = document.getElementById(`status-count-${suffix}`);
    if (count) count.textContent = (counts[status] || 0).toLocaleString();
    const button = wrap.querySelector(`[data-task-status-score="${status}"]`);
    if (button) {
      const active = SCOREBOARD_STATUS_FILTER === status;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  });
}

function setTaskStatusScoreFilter(status) {
  if (status === 'All') SCOREBOARD_STATUS_FILTER = null;
  else SCOREBOARD_STATUS_FILTER = SCOREBOARD_STATUS_FILTER === status ? null : status;
  closeAnyTopPopover();
  DRILL.status = null;
  currentPage = 1;
  renderAll();
}

function bindTaskStatusScoreboard() {
  const wrap = document.getElementById('task-status-scoreboard');
  if (!wrap || wrap.dataset.bound === 'true') return;
  wrap.dataset.bound = 'true';
  wrap.querySelectorAll('[data-task-status-score]').forEach(button => {
    button.addEventListener('click', () => setTaskStatusScoreFilter(button.dataset.taskStatusScore));
  });
}

function renderAll() {
  updateBreadcrumb();
  const data = computeFilteredData();
  // Render the records first: a chart error must never leave the table on a spinner.
  renderTable(data);
  renderKPIs(data);
  try { renderCharts(); } catch (error) { console.error('Chart rendering failed:', error); }
  renderTaskStatusScoreboard(computeFilteredData({ ignoreTaskStatusFilter: true, ignoreScoreboardStatus: true, ignoreDrills: true }));
  notifySharedFiltersChanged();
}

function handleError(error) {
  console.error('Server error:', error);
  const btn = document.getElementById('refresh-button'); 
  if(btn) { btn.disabled = false; btn.textContent = 'Refresh Data'; }
  const tb = document.getElementById('table-body');
  // Escape backend-supplied error text before inserting it into the page.
  const message = String(error?.message || 'Unknown error');
  const safeMessage = message.replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[ch]);
  if(tb) { tb.setAttribute('aria-busy', 'false'); tb.innerHTML = `<div class="record-list-message text-danger">Could not load records: ${safeMessage}</div>`; }
  setKPI('ERR', 'ERR', 'ERR', 'ERR');
}

window.onload = function() {
  bindTaskStatusScoreboard();
  const attach = (id, event, fn) => { const el = document.getElementById(id); if(el) el.addEventListener(event, fn); };

  // No date-range controls: load every available row for the selected access view.

  attach('refresh-button', 'click', refreshData);
  attach('tab-admin', 'click', () => setMode('admin'));
  attach('tab-myteam', 'click', () => setMode('myTeam'));
  attach('tab-me', 'click', () => setMode('me'));
  attach('tab-faulty', 'click', () => setMode('faulty'));
  
  attach('reset-filters-btn', 'click', () => {
      resetTopFilters(); clearDrill(); currentPage = 1;
      renderTopFilters(HEADERS, ALL_DATA); renderAll();
      if (typeof window.resetKpi1Filters === 'function') window.resetKpi1Filters();
  });
  
  attach('drill-back', 'click', () => { 
      if (DRILL.stage) DRILL.stage = null; else if (DRILL.fms) DRILL.fms = null; else DRILL.status = null; 
      currentPage = 1; renderAll(); 
  });

  attach('prev-page', 'click', () => { if (currentPage > 1) { currentPage--; renderTable(computeFilteredData()); } });
  attach('next-page', 'click', () => { const data = computeFilteredData(); if (currentPage < Math.ceil(data.length / ROWS_PER_PAGE)) { currentPage++; renderTable(data); } });
  
  attach('page-input', 'change', (e) => {
      const data = computeFilteredData();
      const totalPages = Math.ceil(data.length / ROWS_PER_PAGE) || 1;
      let newPage = parseInt(e.target.value, 10);
      if (isNaN(newPage) || newPage < 1) newPage = 1;
      if (newPage > totalPages) newPage = totalPages;
      if (currentPage !== newPage) {
          currentPage = newPage; renderTable(data);
      } else { e.target.value = currentPage; }
  });

  refreshData();
};
