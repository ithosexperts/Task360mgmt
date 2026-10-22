/* Opens a row's configured FMS stage form when its Planned/Pending status is clicked. */
(() => {
  if (window.__task360StageFormHandlerInstalled) return;
  window.__task360StageFormHandlerInstalled = true;

  document.addEventListener('click', async (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-stage-form-launch="true"]') : null;
    if (!button || button.disabled) return;

    const recordId = (button.dataset.recordId || '').trim();
    const appId = (button.dataset.appId || '').trim();
    const stageNo = (button.dataset.stageNo || '').trim();
    if (!recordId || !appId || !stageNo) {
      window.alert('Cannot open the stage form: Record #, App ID, or Stage No is missing.');
      return;
    }

    // Open the tab synchronously within the click gesture so browsers do not block the later navigation.
    let popup = window.open('about:blank', '_blank');
    if (popup) {
      try { popup.opener = null; } catch (_) { /* no-op */ }
    }
    const oldText = button.textContent;
    button.disabled = true;
    button.textContent = 'Opening…';

    try {
      const params = new URLSearchParams({ record_id: recordId, app_id: appId, stage_no: stageNo });
      const response = await fetch(`/api/stage-link?${params.toString()}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      });
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch (_) { payload = { error: raw || 'Empty response from Task 360.' }; }
      if (!response.ok || !payload || !payload.url) {
        throw new Error(payload && (payload.error || payload.detail) || `Stage form lookup failed (HTTP ${response.status}).`);
      }

      const destination = new URL(payload.url, window.location.href).href;
      if (popup && !popup.closed) {
        popup.location.replace(destination);
      } else {
        window.location.assign(destination);
      }
    } catch (error) {
      if (popup && !popup.closed) popup.close();
      window.alert(`Could not open the stage form. ${String(error && error.message || error)}`);
    } finally {
      button.disabled = false;
      button.textContent = oldText;
    }
  });
})();
