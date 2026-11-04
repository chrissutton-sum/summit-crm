function parseCSV(input) {
  const records = [];
  let row = [], field = '', quoted = false, closed = false;
  input = input.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        if (char === '\r' && input[i + 1] === '\n') i++;
        if (row.length > 1 || row[0] !== '') records.push(row);
        row = [];
      }
    } else if (closed) {
      throw Error('Unexpected character after a quoted field.');
    } else if (char === '"') {
      if (field) throw Error('Unexpected quote in an unquoted field.');
      quoted = true;
    } else field += char;
  }
  if (quoted) throw Error('A quoted field is missing its closing quote.');
  if (row.length || field || closed) records.push([...row, field]);
  const headers = records.shift()?.map(cell => cell.trim());
  if (!headers?.length || headers.some(cell => !cell) || new Set(headers).size !== headers.length) {
    throw Error('Use a header row with unique, nonempty column names.');
  }
  if (records.some(row => row.length !== headers.length)) throw Error('Every row must have the same number of fields as the header.');
  return {headers, records};
}
function numeric(value) {
  if (value == null || !value.trim()) return null;
  const clean = value.trim().replace(/^\$/, '').replace(/,(?=\d{3}(?:,|\.|$))/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(clean)) return null;
  const number = Number(clean);
  return Number.isFinite(number) ? number : null;
}
function summarize(rows, column, operation) {
  if (operation === 'count') return rows.length;
  let sum = 0, count = 0;
  for (const row of rows) {
    const value = numeric(row[column]);
    if (value !== null) { sum += value; count++; }
  }
  return operation === 'avg' ? (count ? sum / count : null) : sum;
}
function encodeCSV(rows) {
  return rows.map(row => row.map(value => {
    const dangerous = /^[\s]*[=+@-]|^[\t\r\n]/.test(value);
    const safe = dangerous && (numeric(value) === null || /^[\t\r\n]/.test(value)) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n');
}
