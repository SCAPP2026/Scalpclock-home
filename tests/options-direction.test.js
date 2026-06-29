/**
 * Regression tests: Options direction correctness
 * Run with: node tests/options-direction.test.js
 *
 * Core invariant: for identical stock conditions, a winning PUT and a winning CALL
 * must both show positive optVel, positive gainPct, and matching ETA logic.
 */

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

// ── Replicate core calculation logic ─────────────────────────────────────────

function optVel(vel, contractDelta, isPut) {
  const dir = isPut ? -1 : 1;
  return vel * contractDelta * dir;
}

function gainPct(currentPremium, entryPremium) {
  return (currentPremium - entryPremium) / entryPremium * 100;
}

function etaMinutes(currentPremium, entryPremium, targetPct, premVel) {
  if (premVel <= 0) return null;
  const targetPx = entryPremium * (1 + targetPct / 100);
  const diff = targetPx - currentPremium;
  if (diff <= 0) return 0;
  return diff / premVel;
}

function timeMachineImpliedStock(premChange, dir, contractDelta, underlyingNow) {
  const stockMove = premChange * dir / contractDelta;
  return underlyingNow + stockMove;
}

function exitSignalEffective(vel, rsiVal, isPut) {
  const effVel = isPut ? -vel : vel;
  const effRSI = isPut ? (100 - rsiVal) : rsiVal;
  return { effVel, effRSI };
}

// ── Test scenarios ────────────────────────────────────────────────────────────

console.log('\n=== Options Direction Regression Tests ===\n');

// Scenario: Stock at $580, delta 0.40, falling at -$0.10/min
// CALL: losing (stock falling = bad for calls)
// PUT:  winning (stock falling = good for puts)

console.log('Test 1: Stock falling (-$0.10/min) — PUT should profit, CALL should lose');
{
  const stockVel   = -0.10;
  const delta      = 0.40;

  const callVel = optVel(stockVel, delta, false);
  const putVel  = optVel(stockVel, delta, true);

  assert(callVel < 0, 'CALL optVel is negative when stock falls');
  assert(putVel  > 0, 'PUT optVel is positive when stock falls');
  assert(Math.abs(callVel) === Math.abs(putVel), 'CALL and PUT optVel magnitudes match');
}

console.log('\nTest 2: Stock rising (+$0.12/min) — CALL should profit, PUT should lose');
{
  const stockVel = 0.12;
  const delta    = 0.40;

  const callVel = optVel(stockVel, delta, false);
  const putVel  = optVel(stockVel, delta, true);

  assert(callVel > 0, 'CALL optVel is positive when stock rises');
  assert(putVel  < 0, 'PUT optVel is negative when stock rises');
}

console.log('\nTest 3: ETA only runs when optVel > 0 (trade winning)');
{
  const stockVel  = -0.08;
  const delta     = 0.45;
  const entryPrem = 1.50;
  const currPrem  = 1.62; // winning put
  const target    = 20;   // 20% gain target

  const pv = optVel(stockVel, delta, true); // put, stock falling
  const eta = etaMinutes(currPrem, entryPrem, target, pv);

  assert(pv > 0,    'PUT optVel positive (stock falling)');
  assert(eta > 0,   'ETA is a positive number for a winning PUT');
  assert(eta < 120, 'ETA is < 120 min (not infinity threshold)');
}

console.log('\nTest 4: Gain % is direction-agnostic (always premium-based)');
{
  const entry = 1.25;
  const curr  = 1.60;
  const gain  = gainPct(curr, entry);

  assert(Math.abs(gain - 28.0) < 0.1, 'gainPct = +28% regardless of call/put');
  // Same gain whether call or put — premium went from $1.25 to $1.60
}

console.log('\nTest 5: exitSignal direction transform (RSI inversion for puts)');
{
  const rsi = 78; // stock overbought
  const vel = 0.15; // stock rising

  const callEff = exitSignalEffective(vel, rsi, false);
  const putEff  = exitSignalEffective(vel, rsi, true);

  // For CALL: high RSI = near exhaustion = EXIT signal (effRSI high)
  assert(callEff.effRSI === 78,       'CALL effRSI = actual RSI');
  assert(callEff.effVel === 0.15,     'CALL effVel = actual vel');

  // For PUT: stock is overbought = about to fall = GOOD for puts = NOT an exit signal
  assert(putEff.effRSI === 22,        'PUT effRSI = 100 - RSI (22 = not near exhaustion in put space)');
  assert(putEff.effVel === -0.15,     'PUT effVel = -vel (stock rising is bad for puts)');
  assert(putEff.effRSI < 35,          'PUT effRSI signals HOLD — room to run (stock not oversold)');
}

console.log('\nTest 6: exitSignal for stock falling + PUT (should signal HOLD)');
{
  const rsi = 45;   // neutral RSI
  const vel = -0.10; // stock falling (GOOD for puts)

  const { effVel, effRSI } = exitSignalEffective(vel, rsi, true);

  assert(effVel > 0,   'PUT effVel > 0 when stock falling (premium gaining)');
  assert(effRSI === 55, 'PUT effRSI = 100-45 = 55 (moderate, not near exit threshold)');
  assert(effRSI < 74,  'PUT effRSI below 74 — no MOMENTUM FADING signal');
}

console.log('\nTest 7: Time machine implied stock direction');
{
  const entryPrem  = 1.25;
  const currPrem   = 1.30;
  const delta      = 0.40;
  const underlying = 582.00;

  // CALL: premium went up $0.05 → stock went UP
  const callStockDir = timeMachineImpliedStock(0.05, 1, delta, underlying);
  assert(callStockDir > underlying, 'CALL: premium up → implied stock UP');

  // PUT: premium went up $0.05 → stock went DOWN
  const putStockDir = timeMachineImpliedStock(0.05, -1, delta, underlying);
  assert(putStockDir < underlying, 'PUT: premium up → implied stock DOWN');

  // Magnitude check: $0.05 premium / 0.40 delta = $0.125 stock move
  assert(Math.abs(callStockDir - underlying - 0.125) < 0.001, 'CALL stock move magnitude correct');
  assert(Math.abs(putStockDir  - underlying + 0.125) < 0.001, 'PUT stock move magnitude correct');
}

console.log('\nTest 8: PUT with RSI 20 (oversold stock) — should warn, not hold');
{
  const rsi = 20; // stock deeply oversold = bad for puts (stock about to bounce)
  const vel = -0.05; // stock still falling (barely)

  const { effVel, effRSI } = exitSignalEffective(vel, rsi, true);

  // PUT effRSI = 100 - 20 = 80 → near exhaustion in put-space = exit warning
  assert(effRSI === 80,  'PUT: oversold stock (RSI 20) → effRSI 80 = exhaustion signal');
  assert(effRSI >= 74,   'PUT: effRSI >= 74 triggers MOMENTUM FADING exit warning');
}

console.log('\nTest 9: Symmetry — CALL in rising market ≡ PUT in falling market');
{
  const delta = 0.45;

  // Scenario A: Stock rising +$0.08/min, holding a CALL
  const callOptVel = optVel(0.08, delta, false);
  const callEta    = etaMinutes(1.55, 1.25, 20, callOptVel);

  // Scenario B: Stock falling -$0.08/min, holding a PUT (mirror)
  const putOptVel  = optVel(-0.08, delta, true);
  const putEta     = etaMinutes(1.55, 1.25, 20, putOptVel);

  assert(callOptVel > 0, 'CALL winning: optVel positive');
  assert(putOptVel  > 0, 'PUT winning: optVel positive');
  assert(Math.abs(callOptVel - putOptVel) < 0.0001, 'Symmetric scenarios yield equal optVel magnitude');
  assert(callEta !== null && putEta !== null, 'Both ETAs calculable');
  assert(Math.abs(callEta - putEta) < 0.001, 'ETAs identical for symmetric call/put scenarios');
}

console.log('\nTest 10: Fallback delta (0.40) when contract greeks unavailable');
{
  const vel   = -0.06; // stock falling
  const pv    = optVel(vel, 0.40, true); // put, fallback delta

  assert(pv > 0,  'PUT fallback delta still gives positive optVel when stock falls');
  assert(Math.abs(pv - 0.024) < 0.0001, 'PUT fallback: 0.06 × 0.40 = 0.024 $/min');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
