// Market Intelligence Center — catalyst calendar + macro snapshot.
//
// Sources:
//   FOMC meeting dates  — Federal Reserve Board's published calendar
//                         (federalreserve.gov/monetarypolicy/fomccalendars.htm),
//                         copied into FOMC_MEETINGS below. Update yearly.
//   Economic releases   — FRED (Federal Reserve Bank of St. Louis) API:
//                         release dates + the published values. Needs the
//                         free FRED_API_KEY env var; without it this module
//                         returns the FOMC schedule only and says so.
//
// What this module will NOT do:
//   • Consensus estimates — no free licensed source. Always `null`, rendered
//     as "unavailable". Never estimated or back-filled.
//   • Exact release times from the provider — FRED publishes dates, not
//     times. The times shown are each agency's standard release time and are
//     labelled as such.
//   • Fed speeches — no free structured feed; the UI links to the Fed's own
//     calendar instead.

import { etParts, round, isTradingDay, closeMinutes, addDays } from './market-intel.js';

const HOUR = 3600 * 1000;

// "*" on the Fed's calendar = meeting with a Summary of Economic Projections.
// Decision is announced on the second day.
const FOMC_MEETINGS = [
  { start: '2026-01-27', end: '2026-01-28', sep: false },
  { start: '2026-03-17', end: '2026-03-18', sep: true },
  { start: '2026-04-28', end: '2026-04-29', sep: false },
  { start: '2026-06-16', end: '2026-06-17', sep: true },
  { start: '2026-07-28', end: '2026-07-29', sep: false },
  { start: '2026-09-15', end: '2026-09-16', sep: true },
  { start: '2026-10-27', end: '2026-10-28', sep: false },
  { start: '2026-12-08', end: '2026-12-09', sep: true },
  { start: '2027-01-26', end: '2027-01-27', sep: false },
  { start: '2027-03-16', end: '2027-03-17', sep: true },
  { start: '2027-04-27', end: '2027-04-28', sep: false },
  { start: '2027-06-08', end: '2027-06-09', sep: true },
  { start: '2027-07-27', end: '2027-07-28', sep: false },
  { start: '2027-09-14', end: '2027-09-15', sep: true },
  { start: '2027-10-26', end: '2027-10-27', sep: false },
  { start: '2027-12-07', end: '2027-12-08', sep: true },
];
export const FOMC_SCHEDULE_THROUGH = '2027-12-08';
const FED_CAL_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

const WHY = {
  fed: {
    SPY: 'Rate decisions reprice the whole market. The first move after the statement is often reversed during the press conference.',
    QQQ: 'Growth and technology stocks are valued on profits far in the future, so they tend to react most to changes in the interest-rate outlook.',
    IWM: 'Small companies borrow more at floating rates, so they are especially sensitive to where rates are heading.',
  },
  inflation: {
    SPY: 'Hotter inflation can mean higher rates for longer (often negative for stocks); cooler inflation can mean the opposite. What matters is the surprise versus expectations.',
    QQQ: 'Rate-sensitive growth stocks usually swing the most on an inflation surprise.',
    IWM: 'Small caps react to what inflation means for borrowing costs and for the economy at the same time.',
  },
  jobs: {
    SPY: 'A strong jobs number is good for the economy but can push rate expectations up — "good news" can be bad for stocks, and the reverse.',
    QQQ: 'Reacts mainly through interest-rate expectations and Treasury yields.',
    IWM: 'Small caps are tied closely to the health of the domestic economy, so jobs data matters directly.',
  },
  growth: {
    SPY: 'Growth data shapes the earnings outlook and the rate outlook at once; the reaction depends on which one the market cares about more that day.',
    QQQ: 'Usually reacts through the move in Treasury yields that follows.',
    IWM: 'Small caps earn most of their revenue in the US, so domestic growth data is especially relevant.',
  },
  consumer: {
    SPY: 'Consumer spending is about two-thirds of the US economy, so it feeds straight into the earnings outlook.',
    QQQ: 'Matters most for consumer-facing technology and e-commerce names.',
    IWM: 'Many small caps are domestic consumer and retail businesses.',
  },
};

// Economic releases, grouped by the report they come out in.
// `anchor` is the series used to look up the report's release dates.
const RELEASES = [
  {
    id: 'cpi', name: 'CPI inflation report', category: 'inflation', impact: 'high', anchor: 'CPIAUCSL', agency: 'Bureau of Labor Statistics', time: 8 * 60 + 30,
    readings: [
      { series: 'CPIAUCSL', label: 'CPI, year over year', calc: 'yoy', unit: '%' },
      { series: 'CPIAUCSL', label: 'CPI, month over month', calc: 'mom', unit: '%' },
      { series: 'CPILFESL', label: 'Core CPI, year over year', calc: 'yoy', unit: '%' },
    ],
  },
  {
    id: 'ppi', name: 'PPI producer price report', category: 'inflation', impact: 'high', anchor: 'PPIFIS', agency: 'Bureau of Labor Statistics', time: 8 * 60 + 30,
    readings: [
      { series: 'PPIFIS', label: 'PPI final demand, year over year', calc: 'yoy', unit: '%' },
      { series: 'PPIFIS', label: 'PPI final demand, month over month', calc: 'mom', unit: '%' },
    ],
  },
  {
    id: 'jobs', name: 'Jobs report (nonfarm payrolls)', category: 'jobs', impact: 'high', anchor: 'PAYEMS', agency: 'Bureau of Labor Statistics', time: 8 * 60 + 30,
    readings: [
      { series: 'PAYEMS', label: 'Nonfarm payrolls, monthly change', calc: 'diff', unit: 'K jobs' },
      { series: 'UNRATE', label: 'Unemployment rate', calc: 'level', unit: '%' },
    ],
  },
  {
    id: 'claims', name: 'Weekly jobless claims', category: 'jobs', impact: 'medium', anchor: 'ICSA', agency: 'Department of Labor', time: 8 * 60 + 30,
    readings: [{ series: 'ICSA', label: 'Initial jobless claims', calc: 'level', unit: '', scale: 1 }],
  },
  {
    id: 'gdp', name: 'GDP report', category: 'growth', impact: 'high', anchor: 'A191RL1Q225SBEA', agency: 'Bureau of Economic Analysis', time: 8 * 60 + 30,
    readings: [{ series: 'A191RL1Q225SBEA', label: 'Real GDP, quarterly annualised', calc: 'level', unit: '%' }],
  },
  {
    id: 'pce', name: 'PCE inflation & consumer spending', category: 'inflation', impact: 'high', anchor: 'PCEPI', agency: 'Bureau of Economic Analysis', time: 8 * 60 + 30,
    readings: [
      { series: 'PCEPI', label: 'PCE price index, year over year', calc: 'yoy', unit: '%' },
      { series: 'PCE', label: 'Consumer spending, month over month', calc: 'mom', unit: '%' },
    ],
  },
  {
    id: 'retail', name: 'Retail sales', category: 'consumer', impact: 'medium', anchor: 'RSAFS', agency: 'Census Bureau', time: 8 * 60 + 30,
    readings: [{ series: 'RSAFS', label: 'Retail sales, month over month', calc: 'mom', unit: '%' }],
  },
];
const EXTRA_SERIES = ['DGS10', 'DGS2', 'DFEDTARU', 'DFEDTARL'];

/** ET wall-clock (date + minutes after midnight) → epoch ms. */
export function etToMs(dateStr, minutes) {
  const [y, m, d] = dateStr.split('-').map(Number);
  for (const off of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, 0, minutes) + off * HOUR;
    const et = etParts(ms);
    if (et.date === dateStr && et.minutes === minutes) return ms;
  }
  return Date.UTC(y, m - 1, d, 0, minutes) + 5 * HOUR;
}
function fmtTime(minutes) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'} ET`;
}

async function fred(path, params, key) {
  const qs = new URLSearchParams({ ...params, api_key: key, file_type: 'json' });
  const res = await fetch(`https://api.stlouisfed.org/fred/${path}?${qs}`);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`FRED ${path}: non-JSON response (HTTP ${res.status})`); }
  if (!res.ok || body.error_code) throw new Error(`FRED ${path}: ${body.error_message || `HTTP ${res.status}`}`);
  return body;
}

// Latest observations, newest first, with missing values (".") dropped.
async function fetchSeries(id, key) {
  const d = await fred('series/observations', { series_id: id, sort_order: 'desc', limit: '30' }, key);
  return (d.observations || []).filter(o => o.value !== '.' && o.value !== '').map(o => ({ date: o.date, value: +o.value }));
}
async function fetchReleaseDates(anchorSeries, key, todayET) {
  const rel = await fred('series/release', { series_id: anchorSeries }, key);
  const release = (rel.releases || [])[0];
  if (!release) throw new Error(`No release found for ${anchorSeries}`);
  const d = await fred('release/dates', {
    release_id: String(release.id), include_release_dates_with_no_data: 'true',
    realtime_start: addDays(todayET, -45), sort_order: 'asc', limit: '60',
  }, key);
  return { releaseId: release.id, releaseName: release.name, link: release.link || null, dates: (d.release_dates || []).map(x => x.date) };
}

function periodLabel(dateStr, series) {
  const [y, m] = dateStr.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (series === 'A191RL1Q225SBEA') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  if (series === 'ICSA') return `week ending ${dateStr}`;
  return `${MONTHS[m - 1]} ${y}`;
}
// Derive (latest, prior) for a reading from the raw observation list.
function computeReading(r, obs) {
  const at = (i) => {
    if (!obs || obs.length <= i) return null;
    const o = obs[i];
    if (r.calc === 'level') return { value: o.value, period: periodLabel(o.date, r.series) };
    const stepsBack = r.calc === 'yoy' ? 12 : 1;
    const base = obs[i + stepsBack];
    if (!base) return null;
    const v = r.calc === 'diff' ? o.value - base.value : (o.value / base.value - 1) * 100;
    return { value: v, period: periodLabel(o.date, r.series) };
  };
  const dp = r.calc === 'diff' ? 0 : r.series === 'ICSA' ? 0 : r.calc === 'level' ? 1 : (r.calc === 'mom' ? 2 : 1);
  const latest = at(0), prior = at(1);
  return {
    label: r.label, unit: r.unit, series: r.series,
    latest: latest ? { value: round(latest.value, dp), period: latest.period } : null,
    prior: prior ? { value: round(prior.value, dp), period: prior.period } : null,
  };
}

function fomcEvents(nowMs, obs) {
  const upper = obs.DFEDTARU, lower = obs.DFEDTARL;
  const range = (i) => (upper && lower && upper[i] && lower[i]) ? `${lower[i].value.toFixed(2)}%–${upper[i].value.toFixed(2)}%` : null;
  return FOMC_MEETINGS.map(mt => {
    const ts = etToMs(mt.end, 14 * 60);
    const released = ts <= nowMs;
    // Observations are newest-first. The target range published for decision
    // day itself is still the old one (a change takes effect the next day),
    // so: previous = newest value on/before decision day, actual = oldest
    // value after it. Meetings outside the fetched window show no figures.
    let actual = null, previous = null;
    if (upper && lower && upper.length && lower.length) {
      const fmt = (date) => {
        const u = upper.find(o => o.date === date), l = lower.find(o => o.date === date);
        return u && l ? `${l.value.toFixed(2)}%–${u.value.toFixed(2)}%` : null;
      };
      if (!released) previous = range(0);
      else {
        const before = upper.find(o => o.date <= mt.end);
        const after = [...upper].reverse().find(o => o.date > mt.end);
        if (before && after) { previous = fmt(before.date); actual = fmt(after.date); }
      }
    }
    return {
      id: `fomc-${mt.end}`, name: `FOMC rate decision${mt.sep ? ' + economic projections' : ''}`,
      category: 'fed', impact: 'high', date: mt.end, ts,
      timeLabel: '2:00 PM ET', timeNote: 'Statement at 2:00 PM ET; press conference at 2:30 PM ET. Two-day meeting — the decision comes on day two.',
      status: released ? 'released' : 'upcoming',
      readings: [{ label: 'Fed funds target range', unit: '', actual, previous, consensus: null }],
      source: 'Federal Reserve Board', sourceUrl: FED_CAL_URL,
      implications: WHY.fed,
    };
  });
}

/**
 * Build the calendar. Never throws: each source reports its own status.
 * @returns {{events:Array, macro:object|null, status:object}}
 */
export async function buildCalendar({ fredKey, nowMs }) {
  const todayET = etParts(nowMs).date;
  const status = {
    fomc: { ok: true, source: 'Federal Reserve Board', through: FOMC_SCHEDULE_THROUGH },
    fred: { ok: false, configured: !!fredKey, errors: [] },
    consensus: 'unavailable — no licensed free source for analyst estimates',
    fedSpeeches: { available: false, link: 'https://www.federalreserve.gov/newsevents/calendar.htm' },
  };
  const obs = {};
  let econ = [];

  if (fredKey) {
    const seriesIds = [...new Set([...RELEASES.flatMap(r => r.readings.map(x => x.series)), ...EXTRA_SERIES])];
    const [seriesRes, dateRes] = await Promise.all([
      Promise.allSettled(seriesIds.map(id => fetchSeries(id, fredKey))),
      Promise.allSettled(RELEASES.map(r => fetchReleaseDates(r.anchor, fredKey, todayET))),
    ]);
    seriesRes.forEach((r, i) => {
      if (r.status === 'fulfilled') obs[seriesIds[i]] = r.value;
      else status.fred.errors.push(String(r.reason?.message || r.reason));
    });
    RELEASES.forEach((rel, i) => {
      const dr = dateRes[i];
      if (dr.status !== 'fulfilled') { status.fred.errors.push(String(dr.reason?.message || dr.reason)); return; }
      const dates = dr.value.dates.filter(d => d >= addDays(todayET, -10) && d <= addDays(todayET, 45));
      const past = dr.value.dates.filter(d => etToMs(d, rel.time) <= nowMs);
      const lastReleased = past[past.length - 1] || null;
      for (const date of dates) {
        const ts = etToMs(date, rel.time);
        const released = ts <= nowMs;
        // Values are only attached to the MOST RECENT release (we know the
        // latest published observation belongs to it). Older releases in the
        // window show no figures rather than risk attaching the wrong month.
        const isLatest = released && date === lastReleased;
        const readings = rel.readings.map(r => {
          const c = computeReading(r, obs[r.series]);
          if (!released) return { label: c.label, unit: c.unit, actual: null, previous: c.latest ? c.latest.value : null, previousPeriod: c.latest?.period ?? null, consensus: null };
          if (isLatest) return { label: c.label, unit: c.unit, actual: c.latest ? c.latest.value : null, actualPeriod: c.latest?.period ?? null, previous: c.prior ? c.prior.value : null, previousPeriod: c.prior?.period ?? null, consensus: null };
          return { label: c.label, unit: c.unit, actual: null, previous: null, consensus: null, note: 'Superseded by a newer release.' };
        });
        econ.push({
          id: `${rel.id}-${date}`, name: rel.name, category: rel.category, impact: rel.impact, date, ts,
          timeLabel: fmtTime(rel.time), timeNote: `Standard ${rel.agency} release time. The date comes from FRED's release calendar.`,
          status: released ? 'released' : 'upcoming',
          readings,
          source: `${rel.agency} via FRED`, sourceUrl: dr.value.link || `https://fred.stlouisfed.org/releases/${dr.value.releaseId}`,
          implications: WHY[rel.category],
        });
      }
    });
    status.fred.ok = econ.length > 0;
    // The same series error repeats per reading — collapse duplicates.
    status.fred.errors = [...new Set(status.fred.errors)].slice(0, 6);
  }

  const fomc = fomcEvents(nowMs, obs).filter(e => e.date >= addDays(todayET, -10) && e.date <= addDays(todayET, 120));
  const events = [...fomc, ...econ].sort((a, b) => a.ts - b.ts);
  const nextFomc = fomcEvents(nowMs, obs).find(e => e.ts > nowMs) || null;

  return { events, macro: fredKey ? buildMacro(obs, nextFomc) : { available: false, reason: 'FRED_API_KEY is not configured.', nextFomc: nextFomc ? { date: nextFomc.date, timeLabel: nextFomc.timeLabel } : null }, status };
}

function buildMacro(obs, nextFomc) {
  const items = [];
  const add = (label, r, series) => {
    const c = computeReading(r, obs[series]);
    if (c.latest) items.push({ label, value: c.latest.value, unit: c.unit, period: c.latest.period, prior: c.prior ? c.prior.value : null, priorPeriod: c.prior?.period ?? null, series });
  };
  add('CPI inflation (YoY)', { series: 'CPIAUCSL', calc: 'yoy', unit: '%' }, 'CPIAUCSL');
  add('Core CPI (YoY)', { series: 'CPILFESL', calc: 'yoy', unit: '%' }, 'CPILFESL');
  add('PCE inflation (YoY)', { series: 'PCEPI', calc: 'yoy', unit: '%' }, 'PCEPI');
  add('Unemployment rate', { series: 'UNRATE', calc: 'level', unit: '%' }, 'UNRATE');
  add('Payrolls (monthly change)', { series: 'PAYEMS', calc: 'diff', unit: 'K jobs' }, 'PAYEMS');
  add('Real GDP (annualised)', { series: 'A191RL1Q225SBEA', calc: 'level', unit: '%' }, 'A191RL1Q225SBEA');

  const y10 = obs.DGS10, y2 = obs.DGS2, up = obs.DFEDTARU, lo = obs.DFEDTARL;
  const yields = (y10 && y10.length) ? {
    asOf: y10[0].date,
    tenYear: y10[0].value, tenYearChange1d: y10[1] ? round(y10[0].value - y10[1].value, 2) : null,
    tenYearChange5d: y10[5] ? round(y10[0].value - y10[5].value, 2) : null,
    twoYear: y2 && y2.length ? y2[0].value : null,
    twoYearChange1d: y2 && y2[1] ? round(y2[0].value - y2[1].value, 2) : null,
    spread2s10s: y2 && y2.length ? round(y10[0].value - y2[0].value, 2) : null,
    note: 'Treasury constant-maturity yields, published daily by the Fed with a one-business-day lag. Not intraday.',
  } : null;
  return {
    available: items.length > 0 || !!yields,
    items, yields,
    fedFunds: up && lo && up.length && lo.length ? { range: `${lo[0].value.toFixed(2)}%–${up[0].value.toFixed(2)}%`, asOf: up[0].date } : null,
    nextFomc: nextFomc ? { date: nextFomc.date, timeLabel: nextFomc.timeLabel } : null,
    fedExpectations: 'Market-implied rate-cut/hike odds are not shown: they come from fed funds futures data this site is not licensed for.',
    source: 'FRED, Federal Reserve Bank of St. Louis', sourceUrl: 'https://fred.stlouisfed.org',
  };
}

/**
 * Measure how SPY/QQQ/IWM actually moved around a released event, using
 * the 5-minute bars already loaded. Returns null per symbol when the bars
 * needed are not there — it is never estimated.
 *   initial : last price before the release → 30 minutes after
 *   later   : 30 minutes after → that session's regular close
 */
export function measureReaction(ts, barsBySymbol, nowMs) {
  const out = {};
  const date = etParts(ts).date;
  if (!isTradingDay(date)) return null;
  const closeMs = etToMs(date, closeMinutes(date));
  let any = false;
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    const sorted = bars || [];
    // close of the last bar that ended at or before `t`, no older than `maxAgeMin`
    const priceAt = (t, maxAgeMin) => {
      let found = null;
      for (const b of sorted) { if (b.t + 5 * 60000 <= t) found = b; else if (b.t > t) break; }
      return found && (t - (found.t + 5 * 60000)) <= maxAgeMin * 60000 ? found.c : null;
    };
    const before = priceAt(ts, 90);
    const t30 = ts + 30 * 60000;
    const after = nowMs >= t30 ? priceAt(t30, 20) : null;
    const close = nowMs >= closeMs && closeMs > t30 ? priceAt(closeMs, 20) : null;
    const initial = before != null && after != null ? round((after / before - 1) * 100, 2) : null;
    const later = after != null && close != null ? round((close / after - 1) * 100, 2) : null;
    if (initial != null || later != null) any = true;
    out[sym] = { initialPct: initial, laterPct: later };
  }
  return any ? {
    bySymbol: out,
    note: 'Initial = last trade before the release to 30 minutes after. Later = 30 minutes after to the regular close. IEX trades only; blank means there were no bars to measure.',
  } : null;
}
