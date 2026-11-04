(() => {
  const CRM = ''; // Reporting is served by the same CRM origin.
  const REPORT = 'CRM user report';
  let token = '', timer = null, expiryTimer = null, controller = null, generation = 0;
  let refreshedAt = '', lastDataAt = '';
  const headers = ['User', 'Role', 'Assigned leads', 'Open deals', 'Open pipeline value',
    'Won deals', 'Won deal value', 'Lost deals', 'Open tasks', 'Tasks marked done',
    'Overdue tasks', 'Open deliverables', 'Open scheduled activities',
    'Activities marked done', 'Calls marked done', 'User ID'];
  const fields = ['name', 'role', 'leads', 'openDeals', 'pipeline', 'wonDeals', 'wonValue',
    'lostDeals', 'openTasks', 'doneTasks', 'overdueTasks', 'openDeliverables',
    'openActivities', 'doneActivities', 'doneCalls', 'id'];

  function clearConnection() {
    generation++;
    controller?.abort(); controller = null;
    clearInterval(timer); clearTimeout(expiryTimer);
    token = ''; timer = null; expiryTimer = null;
    refreshedAt = ''; lastDataAt = '';
    $('crmAuto').checked = false;
    $('crmLogin').hidden = false;
    $('crmConnected').hidden = true;
    $('crmBadge').textContent = 'Disconnected';
    $('crmConnect').disabled = false;
    $('crmRefresh').disabled = false;
    $('crmPassword').value = '';
  }
  function disconnect(message) {
    clearConnection();
    if (source === REPORT) {
      load({headers, records: []}, 'Disconnected CRM');
      $('status').textContent = 'CRM report cleared. Connect again or import a CSV.';
    }
    $('crmMessage').textContent = message;
  }
  async function request(path, options, signal) {
    let response;
    try {
      response = await fetch(CRM + path, { ...options, signal, credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      if (signal.aborted) throw error;
      throw Error('Could not reach SCG CRM. Check your connection and try again. The CRM may need a moment to wake up.');
    }
    const type = response.headers.get('content-type') || '';
    if (!type.includes('application/json')) throw Error('The CRM reporting update is not available yet. Try again after deployment finishes.');
    const body = await response.json();
    if (!response.ok) {
      const error = Error(body.error || 'Could not load CRM reporting.');
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function showReport(report, preserve) {
    if (report.schemaVersion !== 1 || !Array.isArray(report.users) ||
        report.users.some(user => !user || typeof user !== 'object')) throw Error('The CRM returned an unsupported report.');
    const state = preserve ? {
      group: $('group').value, metric: $('metric').value, operation: $('operation').value,
      filter: $('filter').value === '' ? null : values[Number($('filter').value)],
      search: $('search').value, sortColumn, direction,
    } : null;
    load({headers, records: report.users.map(user => fields.map(key =>
      key === 'name' && user.id ? String(user.name || 'User') + ' (' + user.id + ')' : String(user[key] ?? ''))) }, REPORT);
    if (state) {
      $('group').value = state.group;
      if (report.users.length) {
        $('metric').value = state.metric;
        $('operation').value = state.operation;
      }
      resetFilter();
      const index = values.indexOf(state.filter);
      $('filter').value = state.filter !== null && index >= 0 ? String(index) : '';
      $('search').value = state.search;
      sortColumn = state.sortColumn; direction = state.direction;
    } else if (report.users.length) {
      $('metric').value = '4';
    }
    render();
    refreshedAt = new Date().toLocaleString();
    lastDataAt = report.dataUpdatedAt ? new Date(report.dataUpdatedAt).toLocaleString() : 'No saved data';
    $('status').textContent = 'Live CRM · Current ownership and status · Retrieved ' + refreshedAt;
    $('crmMessage').textContent = 'Report refreshed ' + refreshedAt + '. CRM last saved ' + lastDataAt + '.';
  }
  async function refresh() {
    if (!token || controller) return;
    const version = generation;
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 90000);
    $('crmRefresh').disabled = true;
    $('crmMessage').textContent = 'Loading current CRM report…';
    try {
      const report = await request('/api/reporting/users', {headers:{Authorization:'Bearer ' + token}}, activeController.signal);
      if (generation !== version) return;
      showReport(report, source === REPORT);
      $('crmBadge').textContent = 'Connected';
    } catch (error) {
      if (generation !== version) return;
      if (error.status === 401 || error.status === 403) disconnect(error.message);
      else {
        $('crmBadge').textContent = 'Refresh failed';
        $('crmMessage').textContent = (activeController.signal.aborted ? 'The CRM took too long to respond. Try refreshing again.' : error.message) +
          (refreshedAt ? ' Displayed report was retrieved ' + refreshedAt + '.' : '');
        if (source === REPORT) $('status').textContent = 'CRM snapshot · Refresh failed · Last retrieved ' + refreshedAt;
      }
    } finally {
      clearTimeout(timeout);
      if (controller === activeController) controller = null;
      $('crmRefresh').disabled = false;
    }
  }
  async function connect(path, options) {
    clearConnection();
    const version = generation;
    controller = new AbortController();
    const activeController = controller;
    const timeout = setTimeout(() => activeController.abort(), 90000);
    $('crmConnect').disabled = true;
    $('crmMessage').textContent = 'Signing in to SCG CRM…';
    try {
      const session = await request(path, options, activeController.signal);
      if (generation !== version) return;
      if (typeof session.token !== 'string' || !session.token || !Number.isFinite(session.expiresIn)) throw Error('The CRM returned an invalid session.');
      token = session.token;
      $('crmLogin').hidden = true;
      $('crmConnected').hidden = false;
      $('crmBadge').textContent = 'Connected';
      expiryTimer = setTimeout(() => disconnect('Your reporting session expired. Sign in again to refresh your report.'), session.expiresIn * 1000);
    } catch (error) {
      if (generation === version) $('crmMessage').textContent = activeController.signal.aborted ? 'Sign-in timed out. Try again once the CRM has woken up.' : error.message;
    } finally {
      clearTimeout(timeout);
      if (controller === activeController) controller = null;
      $('crmConnect').disabled = false;
    }
    if (token && generation === version) await refresh();
  }
  $('crmLogin').onsubmit = event => {
    event.preventDefault();
    const username = $('crmUsername').value.trim();
    const password = $('crmPassword').value;
    return connect('/api/reporting/session', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password}),
    });
  };
  const launchUrl = new URL(window.location.href);
  if (launchUrl.searchParams.get('from') === 'crm') {
    launchUrl.searchParams.delete('from');
    history.replaceState(null, '', launchUrl);
    let crmToken;
    try { crmToken = localStorage.getItem('summit_token'); } catch {}
    if (crmToken) {
      connect('/api/reporting/session/crm', {
        method: 'POST', headers: {Authorization: 'Bearer ' + crmToken},
      });
    }
  }
  $('crmRefresh').onclick = refresh;
  $('crmDisconnect').onclick = () => disconnect('Disconnected. Sign in to load a fresh report.');
  $('crmAuto').onchange = () => {
    clearInterval(timer);
    timer = $('crmAuto').checked ? setInterval(() => { if (!document.hidden) refresh(); }, 60000) : null;
  };
  window.addEventListener('datasetloaded', event => {
    if (event.detail !== REPORT && token) {
      clearConnection();
      $('crmMessage').textContent = 'Disconnected while exploring other data. Sign in again for CRM reports.';
    }
  });
})();
