// ====== Value labels plugin ======
const SMALL_SLICE_PCT = 0.06;
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
  const urlParams = new URLSearchParams(window.location.search);
  let userEmail = urlParams.get('useremail') || urlParams.get('email') || 'systems2@hosexperts.com';
  
  const sDate = document.getElementById('start-date')?.value || '';
  const eDate = document.getElementById('end-date')?.value || '';

  window.history.replaceState({}, '', `?useremail=${encodeURIComponent(userEmail.trim())}&start=${sDate}&end=${eDate}`);

  const btn = document.getElementById('refresh-button'); 
  if(btn) { btn.disabled = true; btn.textContent = 'Downloading...'; }
  
  const tBody = document.getElementById('table-body');
  if(tBody) { tBody.setAttribute('aria-busy', 'true'); tBody.innerHTML = '<div class="record-list-message">Loading records…</div>'; }
  
  const pageCtrl = document.getElementById('pagination-controls');
  if(pageCtrl) pageCtrl.style.display = 'none';
  
  const statsDiv = document.getElementById('loading-stats');
  if(statsDiv) statsDiv.style.display = 'none';

  try {
    const fetchUrl = `/api/payload?email=${encodeURIComponent(userEmail.trim().toLowerCase())}&start_date=${sDate}&end_date=${eDate}`;
    
    const response = await fetch(fetchUrl);
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
  if(emailDisp) emailDisp.textContent = `${payload.email || 'Unknown'} (${deriveDefaultPartitionName()})`;

  const bA = document.getElementById('tab-admin');
  const bT = document.getElementById('tab-myteam');
  const bM = document.getElementById('tab-me');
  const bF = document.getElementById('tab-faulty');
  
  if(bA) bA.disabled = !ROLEINFO.isAdmin;
  if(bT) bT.disabled = !(PARTITIONS.myTeam && PARTITIONS.myTeam.length);
  if(bM) bM.disabled = !(PARTITIONS.me && PARTITIONS.me.length);

  if (ROLEINFO.isAdmin && FAULTY_DATA.length > 0) {
      if(bF) {
          bF.style.display = 'inline-block';
          bF.textContent = `Faulty Data (${FAULTY_DATA.length}) ⚠️`;
      }
  } else {
      if(bF) bF.style.display = 'none';
  }

  if (ROLEINFO.isAdmin) setMode('admin'); 
  else if (PARTITIONS.myTeam?.length) setMode('myTeam'); 
  else setMode('me');
}

function deriveDefaultPartitionName() {
  if (ROLEINFO.isAdmin) return 'Admin View';
  if (PARTITIONS.myTeam?.length) return 'My Team View';
  if (PARTITIONS.me?.length) return 'My Performance View';
  return 'No Access';
}

function getStatusBucket(row) {
  const sIdx = FILTER_COLUMNS.TASK_STATUS;
  const status = String(row[sIdx] || '').toLowerCase().trim();
  if (status.includes('finished')) return 'finished';
  if (status.includes('deferred')) return 'deferred';
  return 'awaited';
}

function computeFilteredData() {
  let data = ALL_DATA.slice();
  for (const key in TOP_FILTERS) {
    const selected = TOP_FILTERS[key];
    if (selected && selected.size) {
      const idx = FILTER_COLUMNS[key];
      if (idx != null && idx >= 0) {
        data = data.filter(r => selected.has(String(r[idx] ?? '').trim()));
      }
    }
  }
  if (DRILL.status) {
    data = data.filter(r => {
      const b = getStatusBucket(r);
      return (DRILL.status === 'finished' && b === 'finished') || 
             (DRILL.status === 'deferred' && b === 'deferred') || 
             (DRILL.status === 'awaited' && b === 'awaited');
    });
  }
  if (DRILL.fms) { data = data.filter(r => String(r[FILTER_COLUMNS.FMS] || '').trim() === DRILL.fms); }
  if (DRILL.stage) { data = data.filter(r => String(r[FILTER_COLUMNS.STAGE] || '').trim() === DRILL.stage); }
  return data;
}

function renderKPIs(data) {
  if (!Object.keys(FILTER_COLUMNS).length) { setKPI('N/A', 'N/A', 'N/A', 'N/A'); return; }
  const idxStatus = FILTER_COLUMNS.TASK_STATUS;
  let deferredCount = 0, finishedCount = 0;
  data.forEach(r => {
    const st = String(r[idxStatus] || '').toLowerCase().trim();
    if (st.includes('deferred')) deferredCount++;
    else if (st.includes('finished')) finishedCount++;
  });
  setKPI(deferredCount.toLocaleString(), finishedCount.toLocaleString(), data.length.toLocaleString(), '0.00');
}

function setKPI(a, b, c, d) { 
  const kD = document.getElementById('kpi-delayed'); if(kD) kD.textContent = a; 
  const kO = document.getElementById('kpi-ontime'); if(kO) kO.textContent = b; 
  const kT = document.getElementById('kpi-total'); if(kT) kT.textContent = c; 
  const kA = document.getElementById('kpi-avg-delay'); if(kA) kA.textContent = d; 
}

function resetTopFilters() { for (const k in TOP_FILTERS) delete TOP_FILTERS[k]; }

function renderTopFilters(headers, data) {
  const wrap = document.getElementById('filters-below-views');
  if (!wrap) return; wrap.innerHTML = '';
  if (!Object.keys(FILTER_COLUMNS).length) return;

  const ORDER = [
    { key: 'KPI_MONTH',   label: 'KPI Month'   }, { key: 'WEEK_NO',     label: 'Week No'     },
    { key: 'DAY_NO',      label: 'Day No'      }, { key: 'DOER',        label: 'Doer'        },
    { key: 'FMS',         label: 'FMS'         }, { key: 'STAGE',       label: 'Stage'       },
    { key: 'TASK_STATUS', label: 'Task Status' }
  ];

  const optionsMap = {};
  ORDER.forEach(({ key }) => {
    if (FILTER_COLUMNS[key] == null || FILTER_COLUMNS[key] < 0) return;
    const idx = FILTER_COLUMNS[key];
    const set = new Set();
    data.forEach(r => { const v = r[idx]; if (v != null && String(v).trim() !== '') set.add(String(v).trim()); });
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
    closeAnyTopPopover(); currentPage = 1; renderDashboardOnly(); renderTable(computeFilteredData()); 
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
    // Task 360 applies html { zoom: 67% } on desktop. DOMRects are viewport
    // pixels, while fixed CSS coordinates live inside that zoomed coordinate
    // space, so convert back to CSS pixels to keep the popover flush with its trigger.
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
  const pop = document.querySelector('.multi-pop');
  if (pop) {
    if (pop._filterPopoverScroll) window.removeEventListener('scroll', pop._filterPopoverScroll, true);
    if (pop._filterPopoverResize) window.removeEventListener('resize', pop._filterPopoverResize);
    if (pop.parentNode) pop.parentNode.removeChild(pop);
  }
  OPEN_TOP_FOR = null; CURRENT_TOP_WORKSET = new Set();
  document.querySelectorAll('.filter-chip-btn.active').forEach(b => b.classList.remove('active'));
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
  const colBlue = css.getPropertyValue('--chart-blue').trim(); const textCol = css.getPropertyValue('--text').trim();

  if (statusDoughnutChartInstance) statusDoughnutChartInstance.destroy();
  let totalFinished = 0, totalDeferred = 0, totalAwaited = 0;
  data.forEach(r => { const b = getStatusBucket(r); if (b === 'finished') totalFinished++; else if (b === 'deferred') totalDeferred++; else totalAwaited++; });
  
  const dCtx = document.getElementById('statusDoughnutChart');
  if(dCtx) {
      statusDoughnutChartInstance = new Chart(dCtx.getContext('2d'), {
        type: 'doughnut',
        data: { labels: ['Finished', 'Deferred', 'Awaited'], datasets: [{ data: [totalFinished, totalDeferred, totalAwaited], backgroundColor: [colGreen, colRed, colBlue], hoverOffset: 8 }] },
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

  container.className = 'record-table-wrap';
  container.setAttribute('aria-busy', 'false');
  container.replaceChildren();

  const rows = Array.isArray(data) ? data : [];
  let headers = Array.isArray(HEADERS) ? HEADERS.slice() : [];
  if (!headers.length && rows.length && rows[0] && !Array.isArray(rows[0]) && typeof rows[0] === 'object') {
    headers = Object.keys(rows[0]);
  }

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
    const table = document.createElement('table');
    table.className = 'data-record-table';
    table.setAttribute('aria-label', 'Full database records');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach(header => {
      const th = document.createElement('th');
      th.className = 'wrap-th';
      th.scope = 'col';
      th.textContent = String(header ?? '');
      headRow.appendChild(th);
    });
    // A dedicated Forms action column is separate from the Task Status column.
    const formsHeader = document.createElement('th');
    formsHeader.className = 'wrap-th forms-action-column';
    formsHeader.scope = 'col';
    formsHeader.textContent = 'Forms';
    headRow.appendChild(formsHeader);
    thead.appendChild(headRow);

    const tbody = document.createElement('tbody');
    const fragment = document.createDocumentFragment();
    const headerIndex = new Map();
    headers.forEach((header, index) => {
      const key = normalizeHeaderKey(header);
      if (!headerIndex.has(key)) headerIndex.set(key, index);
    });
    const findHeader = (...names) => {
      for (const name of names) {
        const index = headerIndex.get(normalizeHeaderKey(name));
        if (index != null) return index;
      }
      return -1;
    };
    const recordCol = findHeader('Record #', 'Record ID', 'RowID', 'Task ID');
    const appCol = findHeader('App ID', 'AppID', 'App_ID', 'Application ID');
    const stageCol = findHeader('Stage No', 'StageNo', 'Stage_No', 'Stage Number');
    pageData.forEach(row => {
      const tr = document.createElement('tr');
      headers.forEach((header, index) => {
        const td = document.createElement('td');
        const value = getTableCellValue(row, header, index);
        td.textContent = value == null || String(value).trim() === '' ? '—' : String(value);
        if (normalizeHeaderKey(header) === 'taskstatus') {
          const status = String(value ?? '').trim();
          const statusKey = normalizeHeaderKey(status);
          if (statusKey.includes('finish') || statusKey.includes('complete') || statusKey.includes('doneontime')) td.classList.add('cell-status--finished');
          else if (statusKey.includes('defer') || statusKey.includes('delay') || statusKey.includes('overdue')) td.classList.add('cell-status--deferred');
          else td.classList.add('cell-status--pending');

          const canLaunch = statusKey.startsWith('planned') || statusKey.startsWith('pending') || statusKey.startsWith('awaited');
          const recordId = recordCol >= 0 ? getTableCellValue(row, headers[recordCol], recordCol) : '';
          const appId = appCol >= 0 ? getTableCellValue(row, headers[appCol], appCol) : '';
          const stageNo = stageCol >= 0 ? getTableCellValue(row, headers[stageCol], stageCol) : '';
          if (canLaunch && [recordId, appId, stageNo].every(item => item != null && String(item).trim() !== '')) {
            const launch = document.createElement('button');
            launch.type = 'button';
            launch.className = 'stage-form-status-link';
            launch.dataset.stageFormLaunch = 'true';
            launch.dataset.recordId = String(recordId).trim();
            launch.dataset.appId = String(appId).trim();
            launch.dataset.stageNo = String(stageNo).trim();
            launch.textContent = status;
            launch.title = `Open stage form · Record ${recordId} · ${appId} · ${stageNo}`;
            td.replaceChildren(launch);
          } else if (canLaunch) {
            td.title = 'Stage form cannot open because Record #, App ID, or Stage No is missing.';
          }
        }
        tr.appendChild(td);
      });

      // Add a Forms > Show button for every row with the form lookup keys.
      // The shared stage_form.js click handler opens the resolved URL in a new tab.
      const formsTd = document.createElement('td');
      formsTd.className = 'forms-action-column';
      const formRecordId = recordCol >= 0 ? getTableCellValue(row, headers[recordCol], recordCol) : '';
      const formAppId = appCol >= 0 ? getTableCellValue(row, headers[appCol], appCol) : '';
      const formStageNo = stageCol >= 0 ? getTableCellValue(row, headers[stageCol], stageCol) : '';
      const formKeysAvailable = [formRecordId, formAppId, formStageNo]
        .every(item => item != null && String(item).trim() !== '');

      const formsButton = document.createElement('button');
      formsButton.type = 'button';
      formsButton.className = 'stage-form-show-button';
      formsButton.textContent = 'Show';
      if (formKeysAvailable) {
        formsButton.dataset.stageFormLaunch = 'true';
        formsButton.dataset.recordId = String(formRecordId).trim();
        formsButton.dataset.appId = String(formAppId).trim();
        formsButton.dataset.stageNo = String(formStageNo).trim();
        formsButton.title = `Open form in a new tab · Record ${formRecordId} · ${formAppId} · ${formStageNo}`;
        formsButton.setAttribute('aria-label', `Show form for record ${formRecordId}`);
      } else {
        formsButton.disabled = true;
        formsButton.title = 'Cannot open form: Record #, App ID, or Stage No is missing.';
        formsButton.setAttribute('aria-label', 'Form unavailable because row details are missing');
      }
      formsTd.appendChild(formsButton);
      tr.appendChild(formsTd);
      fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
    table.append(thead, tbody);
    container.appendChild(table);
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
function renderAll() {
  updateBreadcrumb();
  const data = computeFilteredData();
  // Render the records first: a chart error must never leave the table on a spinner.
  renderTable(data);
  renderKPIs(data);
  try { renderCharts(); } catch (error) { console.error('Chart rendering failed:', error); }
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
  const attach = (id, event, fn) => { const el = document.getElementById(id); if(el) el.addEventListener(event, fn); };

  const urlParams = new URLSearchParams(window.location.search);
  let sDate = urlParams.get('start') || '';
  let eDate = urlParams.get('end') || '';

  if (!sDate || !eDate) {
      const today = new Date();
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(today.getDate() - 90);
      sDate = ninetyDaysAgo.toISOString().split('T')[0];
      eDate = today.toISOString().split('T')[0];
  }

  const sdInput = document.getElementById('start-date');
  const edInput = document.getElementById('end-date');
  if(sdInput) sdInput.value = sDate;
  if(edInput) edInput.value = eDate;

  // --- NAYA: AUTO REFRESH ON DATE CHANGE ---
  attach('start-date', 'change', refreshData);
  attach('end-date', 'change', refreshData);

  attach('refresh-button', 'click', refreshData);
  attach('tab-admin', 'click', () => setMode('admin'));
  attach('tab-myteam', 'click', () => setMode('myTeam'));
  attach('tab-me', 'click', () => setMode('me'));
  attach('tab-faulty', 'click', () => setMode('faulty'));
  
  attach('reset-filters-btn', 'click', () => {
      resetTopFilters(); clearDrill(); currentPage = 1;
      renderTopFilters(HEADERS, ALL_DATA); renderAll();
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
