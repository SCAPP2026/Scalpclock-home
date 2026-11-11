/**
 * 5-Day Level Map + pre-market summary tests.
 * Run with: node tests/levels-premarket.test.mjs
 *
 * Uses the recorded Alpaca IEX 5-minute bars in
 * tests/fixtures/market-intel-bars.json (captured 2026-10-09 09:41 ET) and
 * replays them at different clock times. No network.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../functions/lib/levels-5day.js';
import { summarizePremarket } from '../functions/lib/premarket.js';
import { lastCompletedSession } from '../functions/api/market-levels.js';
import { splitSessions } from '../functions/lib/market-intel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/market-intel-bars.json'), 'utf8'));
let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ FAIL: ${label}`); failed++; }
}
const near = (a, b, tol = 0.011) => a != null && b != null && Math.abs(a - b) <= tol;
const at = iso => Date.parse(iso);
const NOW = at('2026-10-09T13:41:00Z');           // 9:41 ET Friday

console.log('\nSession bookkeeping');
assert(lastCompletedSession(at('2026-10-09T13:41:00Z')) === '2026-10-08', 'mid-session → yesterday is the last completed session');
assert(lastCompletedSession(at('2026-10-09T20:30:00Z')) === '2026-10-09', 'after 4 PM → today counts');
assert(lastCompletedSession(at('2026-10-11T15:00:00Z')) === '2026-10-09', 'Sunday → Friday');

console.log('\nVolume profile');
{
  const bars = [{ l: 10, h: 10.99, v: 100 }, { l: 10.5, h: 10.59, v: 1000 }];
  const p = L.volumeProfile(bars, 0.1);
  assert(near(p.poc, 10.55), `POC sits in the heavy bin (${p.poc})`);
  assert(p.val <= p.poc && p.vah >= p.poc, 'value area brackets the POC');
  assert(near(p.total, 1100, 1e-6), 'all volume is distributed');
}

console.log('\nVisits: held vs broke');
{
  const mk = (l, h, c) => ({ l, h, c, date: 'd' });
  // From above → dips into 100–101 → leaves above = held. Then from above → through → leaves below = broke.
  const s = L.visitStats([mk(102, 103, 102.5), mk(100.5, 102, 101.5), mk(101.5, 102.5, 102), mk(100, 101.5, 100.5), mk(98, 99.5, 99)], 100, 101);
  assert(s.visits === 2, `two separate visits (${s.visits})`);
  assert(s.held === 1 && s.broke === 1, `one held, one broke (${s.held}/${s.broke})`);
}

console.log('\nRoles');
{
  const lvl = { lo: 100, hi: 101, price: 100.5 };
  assert(L.roleAt(lvl, 103, 0.4) === 'support', 'price above → support');
  assert(L.roleAt(lvl, 98, 0.4) === 'resistance', 'price below → resistance');
  assert(L.roleAt(lvl, 100.6, 0.4) === 'testing', 'price inside → testing');
}

console.log('\n5-day map on recorded SPY / QQQ / IWM');
for (const sym of ['SPY', 'QQQ', 'IWM']) {
  const bars = FIX.intraday[sym];
  const r = L.build5DayLevels({ symbol: sym, bars, nowMs: NOW });
  assert(r.ok, `${sym}: builds`);
  assert(r.window.sessions === 5 && r.window.to === '2026-10-08', `${sym}: last 5 completed sessions, ending ${r.window.to}`);
  assert(!r.days.some(d => d.date === '2026-10-09'), `${sym}: the in-progress session is excluded`);
  // Independent recomputation of the window extremes from regular-session bars.
  const ses = splitSessions(bars);
  const reg = r.days.flatMap(d => ses[d.date].reg);
  const hi = Math.max(...reg.map(b => b.h)), lo = Math.min(...reg.map(b => b.l));
  assert(near(r.high5.price, hi) && near(r.low5.price, lo), `${sym}: 5-day high/low match raw bars (${lo}–${hi})`);
  assert(near(r.days[4].close, ses['2026-10-08'].reg.at(-1).c), `${sym}: last close = final RTH bar close`);
  assert(r.levels.length >= 4 && r.levels.length <= 10, `${sym}: ${r.levels.length} levels kept (4–10)`);
  assert(r.levels.every((l, i, a) => i === 0 || a[i - 1].price >= l.price), `${sym}: levels sorted high → low`);
  assert(r.levels.every(l => l.score >= 0 && l.score <= 100 && ['major', 'strong', 'minor'].includes(l.tier)), `${sym}: scores 0–100 with a tier`);
  assert(r.levels.every(l => l.lo >= lo - 0.5 && l.hi <= hi + 0.5), `${sym}: every level lies inside the window's traded range`);
  assert(r.levels.some(l => l.types.includes('high5')) && r.levels.some(l => l.types.includes('low5')), `${sym}: 5-day extremes are on the map`);
  assert(r.nearestSupport == null || r.nearestSupport < r.refPrice, `${sym}: nearest support is below price`);
  assert(r.nearestResistance == null || r.nearestResistance > r.refPrice, `${sym}: nearest resistance is above price`);
  assert(r.playbook.length >= 3, `${sym}: playbook has range + overhead + underneath`);
  assert(r.bars15.length >= 5 * 20, `${sym}: ${r.bars15.length} fifteen-minute bars for the chart`);
}

console.log('\nLive price moves roles without rebuilding');
{
  const map = L.build5DayMap({ symbol: 'SPY', bars: FIX.intraday.SPY, nowMs: NOW });
  const above = L.applyPrice(map, map.high5.price + 5, NOW);
  assert(above.levels.every(l => l.role === 'support'), 'above the 5-day high → every level is support');
  assert(above.nearestResistance == null && /No 5-day resistance/.test(above.playbook[1].title), 'no resistance + read-out says so');
  const below = L.applyPrice(map, map.low5.price - 5, NOW);
  assert(below.levels.every(l => l.role === 'resistance'), 'below the 5-day low → every level is resistance');
  assert(above.refIsLive && !L.applyPrice(map).refIsLive, 'refIsLive flags a live price');
}

console.log('\nPre-market summary');
{
  const upTo = iso => FIX.intraday.SPY.filter(b => b.t <= at(iso));
  const pm = summarizePremarket({ symbol: 'SPY', bars: upTo('2026-10-09T13:20:00Z'), nowMs: at('2026-10-09T13:20:00Z') });
  const ses = splitSessions(FIX.intraday.SPY);
  const pre = ses['2026-10-09'].pre;
  assert(pm.session.state === 'premarket', 'state = premarket at 9:20 ET');
  assert(near(pm.prevClose, ses['2026-10-08'].reg.at(-1).c), `previous close = last RTH bar of 10/08 (${pm.prevClose})`);
  assert(near(pm.premarket.high, Math.max(...pre.map(b => b.h))) && near(pm.premarket.low, Math.min(...pre.map(b => b.l))), 'pre-market high/low match raw bars');
  assert(pm.gap && pm.gap.basis === 'indicated' && pm.gap.dir === 'up', 'indicated gap up before the open');
  assert(pm.regular == null, 'no regular-session block before 9:30');
  const trade = { p: 780, t: at('2026-10-09T13:19:00Z') };
  const withTrade = summarizePremarket({ symbol: 'SPY', bars: upTo('2026-10-09T13:20:00Z'), nowMs: at('2026-10-09T13:20:00Z'), trade });
  assert(withTrade.last === 780 && near(withTrade.gap.pct, (780 / pm.prevClose - 1) * 100), 'a fresh trade drives the indicated gap');

  const open = summarizePremarket({ symbol: 'SPY', bars: upTo('2026-10-09T13:41:00Z'), nowMs: NOW });
  assert(open.gap.basis === 'open' && near(open.open, ses['2026-10-09'].reg[0].o), 'after 9:30 the gap is measured from the real open');
  assert(open.regular.gapFilled === false, 'gap not filled in the first minutes (low stayed above prior close)');
  assert(open.regular.pmlBreakAt != null, 'pre-market low break is detected');
  assert(open.afterHours && open.afterHours.bars > 0, 'previous after-hours is summarised');
  assert(open.read.some(l => /gap/i.test(l)) && open.read.some(l => /Pre-market low/.test(l)), 'read-out mentions the gap and the PML break');

  const early = summarizePremarket({ symbol: 'SPY', bars: upTo('2026-10-09T08:20:00Z'), nowMs: at('2026-10-09T08:20:00Z') });
  assert(early.premarket == null && early.gap == null, '4:20 AM with no IEX prints → nothing invented');
  assert(/No IEX pre-market trades yet/.test(early.read[0]), 'and the read-out says so');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
