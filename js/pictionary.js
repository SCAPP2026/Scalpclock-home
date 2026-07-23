/* ── ScalpClock Trading Pictionary ──────────────────────────────
   Visual glossary: term + definition + a small inline-SVG diagram.
   Icons are generated from a handful of reusable builder functions
   (spark/structure/zone/badge/etc.) rather than hand-authored per
   term, so the whole set stays visually consistent. */

const GREEN = '#16d97e', RED = '#f54242', AMBER = '#f5b942';
const MUTE = 'rgba(238,243,240,.28)', DASH = 'rgba(238,243,240,.40)', TXT = 'rgba(238,243,240,.72)';

function svg(inner, vb = '0 0 120 84') {
  return `<svg viewBox="${vb}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}
function lbl(x, y, text, { size = 9, color = TXT, anchor = 'middle', weight = 700 } = {}) {
  return `<text x="${x}" y="${y}" font-family="Rajdhani,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}">${text}</text>`;
}

/* ── generic sparkline ── */
function spark(data, color = GREEN) {
  const w = 120, h = 70, pad = 12, min = Math.min(...data), max = Math.max(...data);
  const xStep = (w - pad * 2) / (data.length - 1);
  const y = v => h - pad - ((v - min) / ((max - min) || 1)) * (h - pad * 2 - 6) - 6;
  const pts = data.map((v, i) => `${pad + i * xStep},${y(v)}`).join(' ');
  const lx = pad + (data.length - 1) * xStep, ly = y(data[data.length - 1]);
  return svg(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="${lx}" cy="${ly}" r="4" fill="${color}"/>`);
}
const TREND_UP = [20, 30, 26, 38, 33, 46, 40, 54];
const TREND_DOWN = [54, 44, 48, 34, 39, 24, 29, 16];
const CONSOLIDATION = [36, 42, 37, 43, 38, 42, 37, 41, 38];

function iconBreakout() {
  return svg(`
    <line x1="8" y1="36" x2="70" y2="36" stroke="${DASH}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <polyline points="10,50 26,52 42,50 58,53 70,36 84,28 100,14" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="100" cy="14" r="4" fill="${GREEN}"/>`);
}
function iconRetest() {
  return svg(`
    <line x1="8" y1="42" x2="112" y2="42" stroke="${DASH}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <polyline points="10,54 26,52 42,50 56,30 70,42 84,30 98,16" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="70" cy="42" r="5" fill="none" stroke="${GREEN}" stroke-width="2"/>
    <circle cx="98" cy="16" r="4" fill="${GREEN}"/>`);
}
function srIcon(kind) {
  const support = kind === 'support';
  const lineY = support ? 58 : 18;
  const pts = support ? '8,20 30,40 52,58 74,38 96,58 112,36' : '8,54 30,34 52,18 74,36 96,18 112,40';
  const color = support ? GREEN : RED;
  return svg(`
    <line x1="6" y1="${lineY}" x2="114" y2="${lineY}" stroke="${color}" stroke-width="1.5" stroke-dasharray="4 4" opacity=".7"/>
    <polyline points="${pts}" fill="none" stroke="${TXT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="52" cy="${lineY}" r="4" fill="${color}"/>
    <circle cx="96" cy="${lineY}" r="4" fill="${color}"/>`);
}
function structureIcon(dir) {
  const up = dir === 'up';
  const pts = up ? '10,58 30,32 50,44 70,18' : '10,10 30,36 50,24 70,58';
  const color = up ? GREEN : RED;
  const l1 = up ? lbl(30, 26, 'HL') : lbl(30, 46, 'LH');
  const l2 = up ? lbl(70, 12, 'HH') : lbl(70, 68, 'LL');
  return svg(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>${l1}${l2}`);
}
function bosIcon() {
  return svg(`
    <line x1="40" y1="30" x2="112" y2="30" stroke="${DASH}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <polyline points="10,55 40,30 60,48 84,15" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="84" cy="15" r="4" fill="${GREEN}"/>
    ${lbl(97, 24, 'BOS', { color: GREEN, size: 10 })}`);
}
function chochIcon() {
  return svg(`
    <line x1="55" y1="42" x2="112" y2="42" stroke="${DASH}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <polyline points="10,55 35,30 55,42 75,15 95,58" fill="none" stroke="${TXT}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="95" cy="58" r="4" fill="${RED}"/>
    ${lbl(94, 72, 'CHoCH', { color: RED, size: 9.5 })}`);
}
function zoneIcon(kind) {
  const supply = kind === 'supply';
  const color = supply ? RED : GREEN;
  const bandY = supply ? 12 : 48, bandH = 16;
  const pts = supply ? '10,62 34,46 58,26 82,22 106,50' : '10,20 34,36 58,54 82,58 106,30';
  return svg(`
    <rect x="6" y="${bandY}" width="108" height="${bandH}" fill="${color}" opacity=".16"/>
    <rect x="6" y="${bandY}" width="108" height="${bandH}" fill="none" stroke="${color}" stroke-width="1" opacity=".55"/>
    <polyline points="${pts}" fill="none" stroke="${TXT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
}
function sweepIcon() {
  return svg(`
    <line x1="8" y1="55" x2="112" y2="55" stroke="${DASH}" stroke-width="1.5" stroke-dasharray="4 4"/>
    <polyline points="10,30 30,48 50,36 68,54 76,66 84,48 104,14" fill="none" stroke="${TXT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="76" cy="66" r="4" fill="${RED}"/>
    <circle cx="104" cy="14" r="4" fill="${GREEN}"/>`);
}
function candleIcon(kind) {
  if (kind === 'doji') {
    return svg(`<line x1="30" y1="10" x2="30" y2="74" stroke="${TXT}" stroke-width="2"/><rect x="17" y="40" width="26" height="4" fill="${TXT}"/>`, '0 0 60 84');
  }
  const bull = kind === 'bull', color = bull ? GREEN : RED;
  return svg(`<line x1="30" y1="8" x2="30" y2="76" stroke="${color}" stroke-width="2"/><rect x="15" y="28" width="30" height="26" fill="${color}"/>`, '0 0 60 84');
}
function vwapIcon() {
  return svg(`
    <polyline points="10,50 26,30 42,46 58,24 74,40 90,20 106,34" fill="none" stroke="${TXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
    <polyline points="10,42 26,40 42,38 58,36 74,35 90,33 106,32" fill="none" stroke="${AMBER}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${lbl(106, 22, 'VWAP', { color: AMBER, size: 9, anchor: 'end' })}`);
}
function maIcon() {
  return svg(`
    <polyline points="10,54 26,26 42,50 58,20 74,44 90,16 106,38" fill="none" stroke="${TXT}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>
    <polyline points="10,44 26,40 42,38 58,34 74,33 90,30 106,30" fill="none" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    ${lbl(106, 20, 'MA', { color: GREEN, size: 9, anchor: 'end' })}`);
}
function rsiIcon() {
  return svg(`
    <rect x="8" y="34" width="104" height="12" rx="6" fill="${MUTE}"/>
    <rect x="8" y="34" width="24" height="12" rx="6" fill="${GREEN}" opacity=".4"/>
    <rect x="88" y="34" width="24" height="12" rx="6" fill="${RED}" opacity=".4"/>
    <circle cx="86" cy="40" r="6" fill="${RED}"/>
    ${lbl(20, 28, '30', { size: 8 })}${lbl(100, 28, '70', { size: 8 })}`);
}
function volumeIcon() {
  const bars = [14, 10, 16, 12, 44, 18];
  const pad = 10, bw = 12, gap = 6;
  return svg(bars.map((v, i) => `<rect x="${pad + i * (bw + gap)}" y="${60 - v}" width="${bw}" height="${v}" fill="${i === 4 ? GREEN : MUTE}"/>`).join(''));
}
function payoffIcon(kind) {
  const call = kind === 'call';
  const pts = call ? '8,54 60,54 112,14' : '8,14 60,54 112,54';
  return svg(`
    <line x1="8" y1="60" x2="112" y2="60" stroke="${DASH}" stroke-width="1" stroke-dasharray="3 3"/>
    <line x1="60" y1="8" x2="60" y2="72" stroke="${DASH}" stroke-width="1" stroke-dasharray="3 3"/>
    <polyline points="${pts}" fill="none" stroke="${GREEN}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    ${lbl(60, 82, 'K (strike)', { size: 8.5 })}`, '0 0 120 90');
}
function numberLineIcon(kind) {
  const line = `<line x1="8" y1="42" x2="112" y2="42" stroke="${MUTE}" stroke-width="2"/>`;
  const kMark = `<line x1="60" y1="30" x2="60" y2="54" stroke="${TXT}" stroke-width="1.5"/>${lbl(60, 24, 'K', { size: 9 })}`;
  const itmBand = `<rect x="60" y="36" width="52" height="12" fill="${GREEN}" opacity=".16"/>`;
  if (kind === 'strike') return svg(`${line}${kMark}<circle cx="60" cy="42" r="5" fill="${GREEN}"/>`);
  if (kind === 'itm') return svg(`${itmBand}${line}${kMark}<circle cx="92" cy="42" r="5" fill="${GREEN}"/>${lbl(92, 66, 'Price', { size: 8 })}`);
  if (kind === 'otm') return svg(`${itmBand}${line}${kMark}<circle cx="26" cy="42" r="5" fill="${MUTE}"/>${lbl(26, 66, 'Price', { size: 8, color: MUTE })}`);
  return svg(`${line}${kMark}<circle cx="60" cy="42" r="5" fill="${AMBER}"/>${lbl(60, 66, 'Price', { size: 8 })}`);
}

/* ── badge icons (circular frame, 24x24 glyph centered inside) ── */
function badge(inner24, color = GREEN) {
  return svg(`
    <circle cx="42" cy="42" r="34" fill="rgba(22,217,126,.06)" stroke="rgba(22,217,126,.35)" stroke-width="1.5"/>
    <g transform="translate(30,30)" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner24}</g>`, '0 0 84 84');
}
function greekBadge(letter) {
  return svg(`
    <circle cx="42" cy="42" r="34" fill="rgba(22,217,126,.06)" stroke="rgba(22,217,126,.35)" stroke-width="1.5"/>
    ${lbl(42, 53, letter, { size: 32, color: GREEN, weight: 700 })}`, '0 0 84 84');
}
const ICON_PREMIUM = `<circle cx="12" cy="12" r="9"/><text x="12" y="16" font-size="10" text-anchor="middle" fill="${GREEN}" stroke="none" font-weight="700">$</text>`;
const ICON_CALENDAR = `<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><circle cx="16" cy="16" r="2" fill="${GREEN}" stroke="none"/>`;
const ICON_STACK = `<rect x="4" y="14" width="4" height="6"/><rect x="10" y="9" width="4" height="11"/><rect x="16" y="4" width="4" height="16"/>`;
const ICON_SWAP = `<path d="M4 8 H16 M12 4 L16 8 L12 12"/><path d="M20 16 H8 M12 20 L8 16 L12 12"/>`;
const ICON_CONE = `<path d="M3 12 H9 M9 12 L21 3 M9 12 L21 21"/>`;
const ICON_SHIELD = `<path d="M12 2 L20 5 V11 C20 16 16.5 20 12 22 C7.5 20 4 16 4 11 V5 Z"/><path d="M8 12 L11 15 L16 8"/>`;
const ICON_RR = `<line x1="3" y1="21" x2="21" y2="21"/><rect x="5" y="15" width="5" height="6" fill="${RED}" stroke="none"/><rect x="14" y="6" width="5" height="15" fill="${GREEN}" stroke="none"/>`;
const ICON_SIZING = `<line x1="3" y1="21" x2="21" y2="21"/><rect x="4" y="15" width="4" height="6" fill="${GREEN}" stroke="none"/><rect x="10" y="10" width="4" height="11" fill="${MUTE}" stroke="none"/><rect x="16" y="5" width="4" height="16" fill="${MUTE}" stroke="none"/>`;
const ICON_FOMO = `<path d="M12 3 L22 20 H2 Z" stroke="${RED}"/><line x1="12" y1="9" x2="12" y2="14" stroke="${RED}"/><circle cx="12" cy="17" r="1" fill="${RED}" stroke="none"/>`;
const ICON_FLAME = `<path d="M12 2 C12 2 6 8 6 13 A6 6 0 0 0 18 13 C18 9 15 7 15 7 C15 10 13 10 13 8 C13 6 12 4 12 2 Z" fill="${RED}" stroke="none"/>`;

/* ── data ── */
const DICTIONARY = [
  // Price Action & Market Structure
  { term: 'Uptrend', cat: 'price-action', def: 'Price making a series of higher highs and higher lows — the dominant, most tradable direction to look for long entries.', icon: () => spark(TREND_UP, GREEN) },
  { term: 'Downtrend', cat: 'price-action', def: 'Price making a series of lower highs and lower lows — momentum favors short setups until structure changes.', icon: () => spark(TREND_DOWN, RED) },
  { term: 'Support', cat: 'price-action', def: 'A price level where buying pressure has repeatedly stepped in and stopped a decline — a spot to watch for a bounce.', icon: () => srIcon('support') },
  { term: 'Resistance', cat: 'price-action', def: 'A price level where selling pressure has repeatedly capped a rally — a spot to watch for a rejection or a breakout.', icon: () => srIcon('resistance') },
  { term: 'Breakout', cat: 'price-action', def: "Price pushes through a key level with strong momentum, often on rising volume — a signal the range is over.", icon: iconBreakout },
  { term: 'Retest', cat: 'price-action', def: 'After a breakout, price returns to the broken level to confirm it now holds as new support or resistance.', icon: iconRetest },
  { term: 'Consolidation (Range)', cat: 'price-action', def: "Price chops sideways between a defined high and low while the market decides its next direction.", icon: () => spark(CONSOLIDATION, TXT) },
  { term: 'Higher Highs & Higher Lows (HH/HL)', cat: 'price-action', def: 'The structural signature of an uptrend: each swing high and swing low prints above the last one.', icon: () => structureIcon('up') },
  { term: 'Lower Highs & Lower Lows (LH/LL)', cat: 'price-action', def: 'The structural signature of a downtrend: each swing high and swing low prints below the last one.', icon: () => structureIcon('down') },
  { term: 'Break of Structure (BOS)', cat: 'price-action', def: 'Price closes beyond a prior swing high or low, confirming the existing trend is continuing.', icon: bosIcon },
  { term: 'Change of Character (CHoCH)', cat: 'price-action', def: 'The first break of structure against the prevailing trend — an early warning that the trend may be reversing.', icon: chochIcon },
  { term: 'Supply Zone', cat: 'price-action', def: 'A price area where sellers previously overwhelmed buyers — price often reacts down when it returns there.', icon: () => zoneIcon('supply') },
  { term: 'Demand Zone', cat: 'price-action', def: 'A price area where buyers previously overwhelmed sellers — price often reacts up when it returns there.', icon: () => zoneIcon('demand') },
  { term: 'Liquidity Sweep (Stop Hunt)', cat: 'price-action', def: 'Price briefly pierces an obvious high or low to trigger resting stop orders before reversing the other way.', icon: sweepIcon },

  // Candles & Indicators
  { term: 'Bullish Candle', cat: 'candles-indicators', def: 'Close above open. Buyers were in control over that period — the candle body prints green.', icon: () => candleIcon('bull') },
  { term: 'Bearish Candle', cat: 'candles-indicators', def: 'Close below open. Sellers were in control over that period — the candle body prints red.', icon: () => candleIcon('bear') },
  { term: 'Doji', cat: 'candles-indicators', def: 'Open and close land almost at the same price, leaving a thin body — a sign of indecision between buyers and sellers.', icon: () => candleIcon('doji') },
  { term: 'VWAP', cat: 'candles-indicators', def: 'Volume-Weighted Average Price — the average price paid across the session, weighted by volume. A key institutional benchmark.', icon: vwapIcon },
  { term: 'Moving Average (EMA/SMA)', cat: 'candles-indicators', def: 'A smoothed line of average price over N periods, used to define trend direction and dynamic support/resistance.', icon: maIcon },
  { term: 'RSI (Overbought/Oversold)', cat: 'candles-indicators', def: 'A 0-100 momentum gauge. Readings above 70 flag overbought conditions; below 30 flags oversold.', icon: rsiIcon },
  { term: 'Volume Spike', cat: 'candles-indicators', def: 'A sudden surge in shares traded relative to the average — often marks real conviction behind a move.', icon: volumeIcon },

  // Options Basics
  { term: 'Call Option', cat: 'options-basics', def: 'A contract giving the right to buy 100 shares at a set strike price before expiration. Profits as the stock rises.', icon: () => payoffIcon('call') },
  { term: 'Put Option', cat: 'options-basics', def: 'A contract giving the right to sell 100 shares at a set strike price before expiration. Profits as the stock falls.', icon: () => payoffIcon('put') },
  { term: 'Strike Price', cat: 'options-basics', def: 'The fixed price at which an option contract lets you buy (call) or sell (put) the underlying stock.', icon: () => numberLineIcon('strike') },
  { term: 'Premium', cat: 'options-basics', def: 'The price you pay to buy an option contract, quoted per share and multiplied by 100 for the full contract.', icon: () => badge(ICON_PREMIUM) },
  { term: 'In the Money (ITM)', cat: 'options-basics', def: 'An option with intrinsic value — a call whose strike is below the stock price, or a put whose strike is above it.', icon: () => numberLineIcon('itm') },
  { term: 'Out of the Money (OTM)', cat: 'options-basics', def: 'An option with no intrinsic value yet — a call whose strike is above the stock price, or a put whose strike is below it.', icon: () => numberLineIcon('otm') },
  { term: 'At the Money (ATM)', cat: 'options-basics', def: 'An option whose strike price sits right at the current stock price — maximum time value, most sensitive to a move.', icon: () => numberLineIcon('atm') },
  { term: 'Expiration / DTE', cat: 'options-basics', def: "The date an option contract stops trading and settles. 'DTE' counts the calendar days left until then.", icon: () => badge(ICON_CALENDAR) },
  { term: 'Open Interest', cat: 'options-basics', def: "The total number of outstanding contracts at a strike that haven't been closed or exercised — a gauge of liquidity.", icon: () => badge(ICON_STACK) },
  { term: 'Assignment', cat: 'options-basics', def: 'When an option seller is required to deliver (calls) or buy (puts) 100 shares because the buyer exercised the contract.', icon: () => badge(ICON_SWAP) },

  // Options Greeks
  { term: 'Delta', cat: 'options-greeks', def: "How much an option's price moves for a $1 move in the stock. Also a rough estimate of the odds it expires ITM.", icon: () => greekBadge('Δ') },
  { term: 'Gamma', cat: 'options-greeks', def: "How fast Delta itself changes as the stock moves — highest for at-the-money options close to expiration.", icon: () => greekBadge('Γ') },
  { term: 'Theta', cat: 'options-greeks', def: "The rate an option loses value each day purely from time passing, all else equal. Time decay.", icon: () => greekBadge('Θ') },
  { term: 'Vega', cat: 'options-greeks', def: "How much an option's price changes for a 1-point move in implied volatility.", icon: () => greekBadge('V') },
  { term: 'Implied Volatility (IV)', cat: 'options-greeks', def: "The market's forecast of how much the stock could move, baked into the option's price. Higher IV means pricier premium.", icon: () => badge(ICON_CONE, AMBER) },

  // Risk & Psychology
  { term: 'Stop Loss', cat: 'risk-psychology', def: 'A predefined price where you exit a losing trade to cap the damage — decided before you enter, not after.', icon: () => badge(ICON_SHIELD) },
  { term: 'Risk/Reward Ratio', cat: 'risk-psychology', def: "How much you're risking versus how much you stand to gain on a trade — the math behind sizing a good setup.", icon: () => badge(ICON_RR) },
  { term: 'Position Sizing', cat: 'risk-psychology', def: 'How many shares or contracts you trade based on account size and risk per trade — not on conviction alone.', icon: () => badge(ICON_SIZING) },
  { term: 'FOMO', cat: 'risk-psychology', def: "Fear Of Missing Out — chasing a move that's already extended because you're afraid of missing further gains.", icon: () => badge(ICON_FOMO, RED) },
  { term: 'Revenge Trading', cat: 'risk-psychology', def: 'Increasing size or frequency to immediately win back a loss — a psychology trap that compounds damage.', icon: () => badge(ICON_FLAME, RED) },
];

const CATEGORIES = [
  { id: 'all', label: 'All Terms' },
  { id: 'price-action', label: 'Price Action' },
  { id: 'candles-indicators', label: 'Candles & Indicators' },
  { id: 'options-basics', label: 'Options Basics' },
  { id: 'options-greeks', label: 'Options Greeks' },
  { id: 'risk-psychology', label: 'Risk & Psychology' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label]));

let activeCat = 'all';
let activeQuery = '';

function renderPictionary() {
  const grid = document.getElementById('picGrid');
  const q = activeQuery.trim().toLowerCase();
  const items = DICTIONARY.filter(d =>
    (activeCat === 'all' || d.cat === activeCat) &&
    (!q || d.term.toLowerCase().includes(q) || d.def.toLowerCase().includes(q))
  );
  document.getElementById('picCount').textContent = `${items.length} term${items.length !== 1 ? 's' : ''}`;
  if (!items.length) {
    grid.innerHTML = `<div class="pic-empty">No terms match "${q}". Try a different search or category.</div>`;
    return;
  }
  grid.innerHTML = items.map(d => `
    <div class="pic-card">
      <div class="pic-icon">${d.icon()}</div>
      <div class="pic-cat">${CAT_LABEL[d.cat]}</div>
      <div class="pic-term">${d.term}</div>
      <div class="pic-def">${d.def}</div>
    </div>`).join('');
}

function initPictionary() {
  const tabWrap = document.getElementById('picTabs');
  tabWrap.innerHTML = CATEGORIES.map(c =>
    `<button class="pic-tab${c.id === 'all' ? ' active' : ''}" data-cat="${c.id}">${c.label}</button>`).join('');
  tabWrap.addEventListener('click', e => {
    const btn = e.target.closest('.pic-tab');
    if (!btn) return;
    activeCat = btn.dataset.cat;
    tabWrap.querySelectorAll('.pic-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderPictionary();
  });
  document.getElementById('picSearch').addEventListener('input', e => {
    activeQuery = e.target.value;
    renderPictionary();
  });
  renderPictionary();
}
