const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat(undefined, {maximumFractionDigits: 2});
const show = value => value === null ? '—' : format.format(value);
const collator = new Intl.Collator(undefined, {numeric:true, sensitivity:'base'});
const pageSize = 15;
let data, filtered, source, page = 0, sortColumn = null, direction = 1, values = [];
function element(tag, text, parent) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (parent) parent.append(node);
  return node;
}
function options(id, items) {
  const fragment = document.createDocumentFragment();
  for (const [label, value] of items) fragment.append(new Option(label, value));
  $(id).replaceChildren(fragment);
}
function resetFilter() {
  const column = Number($('group').value);
  values = [...new Set(data.records.map(row => row[column]))].sort(collator.compare);
  options('filter', [['All groups', ''], ...values.map((value, index) => [value || '(Blank)', index])]);
}
function load(dataset, name, sample = false) {
  data = dataset;
  source = name;
  $('status').textContent = sample ? 'Sample dataset · Fictional Summit campaign performance' : 'Imported · ' + name + ' · Processed in this tab';
  const columns = data.headers.map((header, i) => [header, i]);
  const numericColumns = columns.filter(([, i]) =>
    data.records.some(row => row[i].trim()) &&
    data.records.every(row => !row[i].trim() || numeric(row[i]) !== null));
  options('group', columns);
  options('metric', numericColumns.length ? numericColumns : [['No numeric columns', '']]);
  $('group').value = String(sample ? 1 : (columns.find(([, i]) => !numericColumns.some(([, j]) => i === j))?.[1] ?? 0));
  if (sample) $('metric').value = '4';
  $('operation').value = numericColumns.length ? 'sum' : 'count';
  for (const option of $('operation').options) option.disabled = !numericColumns.length && option.value !== 'count';
  $('search').value = '';
  page = 0; sortColumn = null; direction = 1;
  resetFilter(); render();
  window.dispatchEvent(new CustomEvent('datasetloaded', {detail: name}));
}
function render() {
  const group = Number($('group').value), metric = Number($('metric').value);
  const operation = $('operation').value;
  $('metric').disabled = operation === 'count';
  const filter = $('filter').value;
  const query = $('search').value.trim().toLowerCase();
  filtered = data.records.filter(row =>
    (filter === '' || row[group] === values[Number(filter)]) &&
    (!query || row.some(value => value.toLowerCase().includes(query))));
  if (sortColumn !== null) {
    filtered.sort((a, b) => {
      const left = numeric(a[sortColumn]), right = numeric(b[sortColumn]);
      return direction * (left !== null && right !== null ? left - right : collator.compare(a[sortColumn], b[sortColumn]));
    });
  }
  const buckets = new Map();
  for (const row of filtered) {
    if (!buckets.has(row[group])) buckets.set(row[group], []);
    buckets.get(row[group]).push(row);
  }
  const ranking = Array.from(buckets, ([name, rows]) => [name, summarize(rows, metric, operation)])
    .sort((a,b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity) || collator.compare(a[0], b[0]));
  const label = operation === 'count' ? 'Row count' : (operation === 'avg' ? 'Average ' : 'Total ') + data.headers[metric];
  $('valueLabel').textContent = label;
  $('rows').textContent = show(filtered.length);
  $('groups').textContent = show(buckets.size);
  $('total').textContent = show(summarize(filtered, metric, operation));
  $('chartTitle').textContent = label + ' by ' + data.headers[group];
  const visible = ranking.slice(0, 10);
  const numbers = visible.map(([, value]) => value ?? 0);
  const min = Math.min(0, ...numbers), max = Math.max(0, ...numbers);
  const span = max - min || 1;
  $('chart').replaceChildren();
  if (!visible.length) element('p', 'No rows match the current filters.', $('chart'));
  for (const [name, value] of visible) {
    const bar = element('div', '', $('chart')); bar.className = 'bar';
    element('span', name || '(Blank)', bar);
    const track = element('div', '', bar); track.className = 'track';
    const fill = element('div', '', track); fill.className = value < 0 ? 'fill negative' : 'fill';
    fill.style.left = (Math.min(0, value ?? 0) - min) / span * 100 + '%';
    fill.style.width = Math.abs(value ?? 0) / span * 100 + '%';
    element('span', show(value), bar);
  }
  $('chartNote').textContent = ranking.length > 10 ? 'Showing the 10 highest groups out of ' + show(ranking.length) + '.' : '';
  renderTable();
}
function renderTable() {
  const table = $('table'); table.replaceChildren();
  const header = table.createTHead().insertRow();
  data.headers.forEach((name, i) => {
    const th = element('th', '', header);
    th.scope = 'col';
    if (sortColumn === i) th.setAttribute('aria-sort', direction === 1 ? 'ascending' : 'descending');
    element('button', name + (sortColumn === i ? (direction === 1 ? ' ↑' : ' ↓') : ''), th).onclick = () => {
      direction = sortColumn === i ? -direction : 1;
      sortColumn = i; page = 0; render();
      table.tHead.rows[0].cells[i].firstChild.focus();
    };
  });
  const body = table.createTBody();
  const start = page * pageSize;
  for (const row of filtered.slice(start, start + pageSize)) {
    const tr = body.insertRow();
    row.forEach(value => element('td', value, tr));
  }
  $('page').textContent = filtered.length ? (start + 1) + '–' + Math.min(start + pageSize, filtered.length) + ' of ' + show(filtered.length) : '0 rows';
  $('prev').disabled = page === 0;
  $('next').disabled = start + pageSize >= filtered.length;
  $('export').disabled = !filtered.length;
}
function sampleData() {
  const channels = ['Paid Search','Organic Search','Social Media','Referrals','Email','Events'];
  const records = Array.from({length: 72}, (_, i) => {
    const channel = i % 6, month = Math.floor(i / 6);
    const leads = 9 + (5 - channel) * 4 + ((i * 17) % 19) + month;
    return ['2026-' + String(month + 1).padStart(2, '0'), channels[channel],
      ['Boise','Nampa','Caldwell'][(channel + month) % 3], String(leads),
      String(leads * (120 + ((i * 13) % 40))), String(200 + channel * 28 + ((i * 31) % 250))];
  });
  load({headers:['Month','Channel','Market','Leads','Revenue','Spend'], records}, 'sample-campaigns.csv', true);
}
$('upload').onclick = () => $('file').click();
$('file').onchange = async () => {
  const file = $('file').files[0];
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw Error('Choose a CSV of 10 MB or smaller.');
    load(parseCSV(await file.text()), file.name);
  } catch (error) { $('status').textContent = 'Import failed. ' + error.message; }
  finally { $('file').value = ''; }
};
$('demo').onclick = sampleData;
$('group').onchange = () => { resetFilter(); page = 0; render(); };
for (const id of ['operation','metric','filter','search']) $(id).oninput = () => { page = 0; render(); };
$('prev').onclick = () => { page--; renderTable(); };
$('next').onclick = () => { page++; renderTable(); };
$('export').onclick = () => {
  const url = URL.createObjectURL(new Blob(['\uFEFF', encodeCSV([data.headers, ...filtered])], {type:'text/csv;charset=utf-8'}));
  const link = element('a', '', document.body);
  link.href = url; link.download = source.replace(/\.csv$/i,'') + '-filtered.csv';
  link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
sampleData();
