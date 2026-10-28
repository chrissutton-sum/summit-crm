// Minimal, dependency-free iCalendar (.ics) feed fetcher/parser.
//
// Scope (deliberately not a full RFC 5545 implementation — covers what
// real-world Google/Outlook/Apple calendar exports actually use):
//  - VEVENT blocks, folded-line unfolding
//  - DTSTART/DTEND as UTC ("Z"), IANA TZID, or floating (no tz) times, and
//    all-day (VALUE=DATE) events
//  - RRULE recurrence: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT,
//    UNTIL, and BYDAY for WEEKLY
//  - EXDATE exclusions and RECURRENCE-ID overrides (incl. cancelled
//    instances via STATUS:CANCELLED)
//
// All event times are normalized to one business timezone's wall-clock
// (BIZ_TZ below) as plain 'YYYY-MM-DDTHH:MM' strings, matching how the rest
// of this app already stores/display activity times — no further tz math
// happens on the frontend.

const BIZ_TZ = 'America/Denver';
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function pad2(n) { return String(n).padStart(2, '0'); }
function pad4(n) { return String(n).padStart(4, '0'); }

function unfold(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const out = [];
  for (const l of lines) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && out.length) {
      out[out.length - 1] += l.slice(1);
    } else {
      out.push(l);
    }
  }
  return out;
}

function splitLine(line) {
  const ci = line.indexOf(':');
  if (ci < 0) return null;
  const head = line.slice(0, ci);
  const value = line.slice(ci + 1);
  const parts = head.split(';');
  const name = (parts[0] || '').toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

function parseDateValue(value, params) {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    return { allDay: true, y: +value.slice(0, 4), mo: +value.slice(4, 6), d: +value.slice(6, 8), h: 0, mi: 0, s: 0, z: false, tzid: null };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  return { allDay: false, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], z: !!m[7], tzid: params.TZID || null };
}

function civilKey(p) { return `${p.y}-${p.mo}-${p.d}-${p.h}-${p.mi}`; }
function compareCivil(a, b) {
  return (a.y - b.y) || (a.mo - b.mo) || (a.d - b.d) || (a.h - b.h) || (a.mi - b.mi) || (a.s - b.s);
}
// Approximate instant (treats civil fields as UTC) — good enough for
// ordering/window-bounding occurrences; final display uses tz-aware convert.
function civilToApproxMs(p) { return Date.UTC(p.y, p.mo - 1, p.d, p.h || 0, p.mi || 0, p.s || 0); }

function tzParts(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = dtf.formatToParts(new Date(utcMs));
  const o = {};
  for (const pt of parts) if (pt.type !== 'literal') o[pt.type] = pt.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: o.hour === '24' ? 0 : +o.hour, mi: +o.minute, s: +o.second };
}
function formatInTZ(utcMs, tz) {
  const p = tzParts(utcMs, tz);
  return `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}
// Civil wall-clock time in `tz` -> UTC instant (ms). Two-pass convergence;
// correct except in the ambiguous hour of a fall-back DST transition.
function civilToUTC(p, tz) {
  let guess = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  for (let i = 0; i < 2; i++) {
    const seenAsCivil = tzParts(guess, tz);
    const seenAsIfUTC = Date.UTC(seenAsCivil.y, seenAsCivil.mo - 1, seenAsCivil.d, seenAsCivil.h, seenAsCivil.mi, seenAsCivil.s);
    const wanted = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess += (wanted - seenAsIfUTC);
  }
  return guess;
}

// Convert a parsed date to this business's local wall-clock string.
function toBizLocal(parsed) {
  if (!parsed) return null;
  if (parsed.allDay) return { allDay: true, dt: `${pad4(parsed.y)}-${pad2(parsed.mo)}-${pad2(parsed.d)}` };
  if (parsed.z) {
    const utcMs = Date.UTC(parsed.y, parsed.mo - 1, parsed.d, parsed.h, parsed.mi, parsed.s);
    return { allDay: false, dt: formatInTZ(utcMs, BIZ_TZ) };
  }
  if (parsed.tzid) {
    try {
      const utcMs = civilToUTC(parsed, parsed.tzid);
      return { allDay: false, dt: formatInTZ(utcMs, BIZ_TZ) };
    } catch (e) { /* unrecognized tz name (e.g. Windows-style) — fall through to floating */ }
  }
  return { allDay: false, dt: `${pad4(parsed.y)}-${pad2(parsed.mo)}-${pad2(parsed.d)}T${pad2(parsed.h)}:${pad2(parsed.mi)}` };
}

function parseRRULE(value) {
  const rule = { freq: null, interval: 1, count: null, until: null, byday: [] };
  for (const part of value.split(';')) {
    const [k, v] = part.split('=');
    if (!k || v === undefined) continue;
    const key = k.toUpperCase();
    if (key === 'FREQ') rule.freq = v.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = Math.max(1, parseInt(v, 10) || 1);
    else if (key === 'COUNT') rule.count = parseInt(v, 10) || null;
    else if (key === 'UNTIL') rule.until = parseDateValue(v, {});
    else if (key === 'BYDAY') rule.byday = v.split(',').map(s => s.trim().slice(-2).toUpperCase()).filter(c => DOW[c] !== undefined);
  }
  return rule;
}

function addDaysCivil(p, days) {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  d.setUTCDate(d.getUTCDate() + days);
  return { ...p, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}
function addIntervalCivil(p, freq, interval) {
  const d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (freq === 'DAILY') d.setUTCDate(d.getUTCDate() + interval);
  else if (freq === 'WEEKLY') d.setUTCDate(d.getUTCDate() + 7 * interval);
  else if (freq === 'MONTHLY') d.setUTCMonth(d.getUTCMonth() + interval);
  else if (freq === 'YEARLY') d.setUTCFullYear(d.getUTCFullYear() + interval);
  else return null;
  return { ...p, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const MAX_OCCURRENCES = 366;
const MAX_LOOP = 4000;

// Returns an array of parsed-civil occurrences (same shape as parseDateValue)
// for `rruleStr` starting at `start`, bounded to [windowStartMs, windowEndMs].
function expandRRULE(start, rruleStr, windowStartMs, windowEndMs) {
  const rule = parseRRULE(rruleStr);
  if (!rule.freq) return [start];
  const out = [];
  const hardStopMs = windowEndMs + 400 * 86400000; // safety cutoff well past the window

  if (rule.freq === 'WEEKLY' && rule.byday.length) {
    // Sunday that starts DTSTART's week.
    let weekStart = addDaysCivil(start, -(new Date(Date.UTC(start.y, start.mo - 1, start.d))).getUTCDay());
    let n = 0, guard = 0;
    outer: while (guard++ < MAX_LOOP) {
      for (const code of rule.byday) {
        const occ = { ...addDaysCivil(weekStart, DOW[code]), h: start.h, mi: start.mi, s: start.s, allDay: start.allDay, tzid: start.tzid, z: start.z };
        if (compareCivil(occ, start) < 0) continue;
        if (rule.until && compareCivil(occ, rule.until) > 0) break outer;
        n++;
        if (rule.count && n > rule.count) break outer;
        if (civilToApproxMs(occ) > hardStopMs) break outer;
        out.push(occ);
        if (out.length >= MAX_OCCURRENCES) break outer;
      }
      weekStart = addDaysCivil(weekStart, 7 * rule.interval);
    }
  } else {
    let cur = start, n = 0, guard = 0;
    while (guard++ < MAX_LOOP) {
      if (rule.until && compareCivil(cur, rule.until) > 0) break;
      n++;
      if (rule.count && n > rule.count) break;
      if (civilToApproxMs(cur) > hardStopMs) break;
      out.push(cur);
      if (out.length >= MAX_OCCURRENCES) break;
      const next = addIntervalCivil(cur, rule.freq, rule.interval);
      if (!next) break;
      cur = next;
    }
  }
  return out.filter(o => {
    const ms = civilToApproxMs(o);
    return ms >= windowStartMs - 86400000 && ms <= windowEndMs + 86400000;
  });
}

function parseICS(text, windowStartMs, windowEndMs) {
  const lines = unfold(text);
  const masters = []; // {uid, summary, location, start, end, rrule, exdates:[civilKey]}
  const overrides = {}; // uid -> [{recurrenceKey, summary, location, start, end, cancelled}]
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
    if (line === 'END:VEVENT') {
      if (cur) {
        if (cur.recurrenceId) {
          (overrides[cur.uid] = overrides[cur.uid] || []).push(cur);
        } else {
          masters.push(cur);
        }
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const f = splitLine(line);
    if (!f) continue;
    switch (f.name) {
      case 'UID': cur.uid = f.value; break;
      case 'SUMMARY': cur.summary = f.value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';'); break;
      case 'LOCATION': cur.location = f.value.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';'); break;
      case 'STATUS': cur.status = f.value.toUpperCase(); break;
      case 'DTSTART': cur.start = parseDateValue(f.value, f.params); break;
      case 'DTEND': cur.end = parseDateValue(f.value, f.params); break;
      case 'RRULE': cur.rrule = f.value; break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDateValue(f.value, f.params); break;
      case 'EXDATE':
        for (const v of f.value.split(',')) {
          const pd = parseDateValue(v, f.params);
          if (pd) cur.exdates.push(civilKey(pd));
        }
        break;
      default: break;
    }
  }

  const events = [];
  for (const m of masters) {
    if (!m.start || m.status === 'CANCELLED') continue;
    const durMs = m.end ? (civilToApproxMs(m.end) - civilToApproxMs(m.start)) : (m.start.allDay ? 86400000 : 3600000);
    const occs = m.rrule ? expandRRULE(m.start, m.rrule, windowStartMs, windowEndMs) : [m.start];
    for (const occ of occs) {
      if (m.exdates.includes(civilKey(occ))) continue;
      const override = (overrides[m.uid] || []).find(o => o.recurrenceId && civilKey(o.recurrenceId) === civilKey(occ));
      if (override && override.status === 'CANCELLED') continue;
      const startParsed = override && override.start ? override.start : occ;
      const endParsed = override && override.end ? override.end
        : { ...startParsed, ...msToDelta(civilToApproxMs(startParsed) + durMs) };
      const sb = toBizLocal(startParsed), eb = toBizLocal(endParsed);
      if (!sb) continue;
      const msVal = civilToApproxMs(occ);
      if (msVal < windowStartMs - 86400000 || msVal > windowEndMs + 86400000) continue;
      events.push({
        uid: m.uid,
        title: (override && override.summary) || m.summary || '(untitled)',
        location: (override && override.location) || m.location || '',
        allDay: sb.allDay,
        start: sb.dt,
        end: eb ? eb.dt : sb.dt,
      });
    }
  }
  events.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  return events;
}
function msToDelta(ms) {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}

async function fetchAndParseICS(url, windowStartMs, windowEndMs, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await doFetch(url, { signal: controller.signal, headers: { 'User-Agent': 'SummitCRM-CalendarSync/1.0' } });
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`Calendar server returned ${res.status}`);
  const len = res.headers.get('content-length');
  if (len && +len > 8 * 1024 * 1024) throw new Error('Calendar feed is too large');
  const text = await res.text();
  if (text.length > 8 * 1024 * 1024) throw new Error('Calendar feed is too large');
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('That URL did not return a calendar (.ics) feed');
  return parseICS(text, windowStartMs, windowEndMs);
}

// Exposed for other calendar sources (e.g. the Google Calendar API, which
// already hands back ISO datetimes with an explicit UTC offset) that just
// need "what wall-clock time is this UTC instant in the business's zone".
function utcMsToBizLocal(ms) { return formatInTZ(ms, BIZ_TZ); }

module.exports = { parseICS, fetchAndParseICS, BIZ_TZ, utcMsToBizLocal };
