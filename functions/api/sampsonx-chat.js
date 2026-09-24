// Ask Sampson X — ScalpClock's AI trading coach chat. Replaces the retired
// Chart Review feature (functions/api/chart-feedback.js, deleted) and reuses
// its exact infrastructure: same ANTHROPIC_API_KEY, same CHART_FEEDBACK_KV
// binding (already live in production — no new manual Cloudflare setup),
// same conservative monthly-call ceiling. Chart Review had negligible real
// usage, so its whole budget was repurposed here rather than adding a
// second LLM feature on top of a documented <$10/month Anthropic budget.
//
// Unlike Chart Review, this is NOT plan-gated — any authenticated user
// (free/trial/pro/founding) can chat with Sampson X. SAMPSONX_ENABLED below
// is the configurable access flag the feature spec asked for; flip it to
// false to take the feature down instantly without a redeploy of removed
// logic (same pattern as FOUNDING_ACTIVE_OVERRIDE elsewhere in this repo).
const SAMPSONX_ENABLED = true;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
// Public anon key — same one already shipped client-side across the site.
// Used only as the `apikey` header on the /auth/v1/user verification call.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB decoded — same cap Chart Review used
const MAX_MESSAGES = 20; // caps both cost and prompt size per request
const DAILY_LIMIT_PER_USER = 12;
const MONTHLY_LIMIT_TOTAL = 600; // same total ceiling Chart Review safely operated under

const SAMPSONX_BASE_PROMPT = `You are Sampson X, ScalpClock's AI trading coach. Your purpose is EDUCATIONAL: help traders understand options trading, technical analysis, chart reading, risk management, and the ScalpClock methodology (VWAP, EMA alignment, support/resistance, ORB, volume, momentum). You are not a signal-generating bot.

Personality: friendly, clear, encouraging, patient, confident but not arrogant. Concise for simple questions; more detailed when asked to go deeper. Never a generic corporate chatbot — talk like a knowledgeable trading coach who wants the user to actually learn.

Hard rule: if asked something like "should I buy calls or puts" or "what should I trade," never give a direct instruction. Instead walk through the relevant factors (trend, price structure, support/resistance, VWAP, EMA alignment, volume, momentum, breakout/rejection, risk/reward, time to expiration, options Greeks, implied volatility, confirmation) and encourage the user to make their own informed decision. Teach how to evaluate a setup, don't hand them a trade.

If a question is genuinely ambiguous (e.g. "is this a good setup?" with no context), ask a clarifying question (timeframe, what kind of setup they're looking for) instead of guessing.

For more complex questions, you may structure your answer as: Quick Answer (1-2 sentences), Why, What to Watch, ScalpClock Connection (only if a real ScalpClock tool/lesson genuinely applies — never invent a feature that doesn't exist: real ones are the Learn Hub, Daily System, ORB Signal Engine, ScalpCharts, Replay, Exit Assistant), and Practice (a small exercise or question). Do not force this structure onto simple questions — a one-line answer is fine when that's all the question needs.

You do not have standing access to live market data. For each message, ScalpClock's own live feed is checked for any ticker symbols mentioned, and if real data was found it appears below under "Live market data" — you may state those exact numbers as current fact. For anything NOT in that block (options chains, open interest, news, earnings dates, or any ticker not listed there), say plainly that you don't have that data rather than fabricating a number. Never invent a price, RSI, or VWAP value that isn't explicitly given to you. If the user pastes their own numbers/context, you can reason about those too.

Never claim certainty about future price movement, guarantee a profit, or say a setup or breakout is "guaranteed." Distinguish observation (what's visible), possibility (what could happen), risk (what could go wrong), and educational explanation (the underlying concept).

If you don't have enough information to answer accurately, say so directly and ask for the missing chart, timeframe, or context — never fabricate an answer.

End longer/analytical answers with a brief educational-only reminder when it's not already obvious from context; you don't need to repeat it on every single short reply.`;

const LEARNING_MODE_ADDENDUM = `\n\nLearning Mode is ON: before explaining a concept the user asked about, first ask them a short guiding question or invite them to take a quick guess, then explain — don't just hand them the answer immediately.`;

function personalizationBlock(progress) {
  if (!progress) return '';
  const done = Array.isArray(progress.done) ? progress.done.length : 0;
  const xp = typeof progress.xp === 'number' ? progress.xp : 0;
  const streak = typeof progress.streakCount === 'number' ? progress.streakCount : 0;
  const badges = Array.isArray(progress.badges) ? progress.badges : [];
  if (!done && !xp && !streak && badges.length === 0) return '';
  // Deliberately coarse — this repo has no per-topic mastery data today
  // (only completion counts/badges), so avoid claiming the user does/doesn't
  // know a specific concept. That would need a day->category export from
  // learn.html's curriculum data, which is a documented future step, not
  // built here.
  return `\n\nWhat you know about this user (use lightly, to sound aware of their progress, never to claim they do/don't understand a specific concept): they've completed ${done} Learn Hub lesson(s), have ${xp} XP, a ${streak}-day streak, and earned badges: ${badges.length ? badges.join(', ') : 'none yet'}.`;
}

// ── Live market data ─────────────────────────────────────────────────────
// Sampson X has no standing market-data access (by design — see the system
// prompt), but ScalpClock's own live signals feed (functions/api/signals.js,
// the same Alpaca-backed per-symbol lookup signals.html's "Ask SampsonX"
// ticker search already uses) is public and free to call. So instead of the
// model refusing every price question, extract plausible ticker symbols
// from the user's latest message and fetch real numbers for this one
// request only — never cached across turns, never fabricated if the lookup
// comes back empty.
const TICKER_STOPWORDS = new Set([
  // Trading/options jargon that would otherwise look like a ticker
  'VWAP','EMA','RSI','ATR','ORB','ATM','OTM','ITM','ROI','ETF','IV','ROC','PNL','SMA','MACD','ADX','OBV','CCI','DTE','IRA',
  // Common short English words that show up in caps (start of sentence, emphasis, acronym-shaped)
  'I','A','THE','AND','FOR','ARE','YOU','NOT','BUT','CAN','WILL','WHAT','WHY','HOW','ALL','NOW','SO','IS','IT','TO','OF','IN','ON','AT','DO','BE','IF','OR','MY','ME','GO','UP','NO','OK',
  'CEO','CFO','SEC','IPO','API','FAQ','USD','AI','FYI','ASAP','ELI5',
]);
const MAX_TICKER_LOOKUPS = 3;

function extractTickerCandidates(text) {
  const matches = (text.match(/\b[A-Z]{1,5}\b/g) || []);
  const seen = new Set();
  const candidates = [];
  for (const m of matches) {
    if (TICKER_STOPWORDS.has(m) || seen.has(m)) continue;
    seen.add(m);
    candidates.push(m);
    if (candidates.length >= MAX_TICKER_LOOKUPS) break;
  }
  return candidates;
}

async function fetchLiveData(origin, symbols) {
  const results = await Promise.all(symbols.map(async (sym) => {
    try {
      const res = await fetch(`${origin}/api/signals?symbol=${encodeURIComponent(sym)}&range=day`);
      const data = await res.json().catch(() => null);
      if (data && data.result && data.result.ok) return { symbol: sym, marketOpen: data.marketOpen, asOf: data.asOf, ...data.result };
      return null;
    } catch (e) {
      return null;
    }
  }));
  return results.filter(Boolean);
}

function liveDataBlock(rows) {
  if (!rows.length) return '';
  const lines = rows.map(r => {
    const parts = [
      `price $${r.price}`,
      r.changePct != null ? `${r.changePct >= 0 ? '+' : ''}${r.changePct}% today` : null,
      r.rsi != null ? `RSI(14) ${r.rsi}` : null,
      r.vwap != null ? `VWAP $${r.vwap} (${r.vwapDist >= 0 ? '+' : ''}${r.vwapDist}% from price)` : null,
      r.signal ? `ScalpClock signal: ${r.signal}` : null,
    ].filter(Boolean).join(', ');
    return `- ${r.symbol}: ${parts}`;
  }).join('\n');
  const asOf = rows[0].asOf ? new Date(rows[0].asOf).toISOString() : new Date().toISOString();
  return `\n\nLive market data (fetched just now via ScalpClock's own feed, as of ${asOf}, market ${rows[0].marketOpen ? 'OPEN' : 'CLOSED'}):\n${lines}\nOnly use these exact numbers for these symbols — do not extrapolate to other tickers or later times.`;
}

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!SAMPSONX_ENABLED) return json({ error: 'Sampson X is temporarily unavailable.' }, 503);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Sampson X is not configured yet' }, 500);
  if (!env.CHART_FEEDBACK_KV) return json({ error: 'Sampson X is not configured yet' }, 500);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json({ error: 'Sign in to chat with Sampson X' }, 401);

  // Verify the caller's Supabase JWT for real — see chart-feedback.js's
  // (now-removed) equivalent comment: /auth/v1/user only returns a user for
  // a genuinely valid token, unlike the service-role writes elsewhere in
  // this repo which never check the caller's own identity.
  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Sign in to chat with Sampson X' }, 401);
    user = await userRes.json();
  } catch (e) {
    // Not 502/503/504 — Cloudflare's edge replaces the body of those with
    // its own generic error page, silently swallowing this message.
    return json({ error: 'Could not verify your session — try again in a moment' }, 400);
  }

  // No plan check here on purpose — Sampson X is open to every logged-in
  // user regardless of plan (see file header comment).

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { messages, image, mediaType, learningMode } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'No message provided' }, 400);
  }
  if (messages.length > MAX_MESSAGES) {
    return json({ error: 'This conversation has gotten long — start a new chat with Sampson X' }, 400);
  }
  for (const m of messages) {
    if (!m || typeof m.content !== 'string' || !['user', 'assistant'].includes(m.role)) {
      return json({ error: 'Invalid message format' }, 400);
    }
  }

  if (image) {
    if (!['image/png', 'image/jpeg'].includes(mediaType)) {
      return json({ error: 'Upload a PNG or JPEG screenshot' }, 400);
    }
    const approxBytes = Math.floor(image.length * 0.75);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return json({ error: 'That image is too large — try a screenshot under 4MB' }, 400);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  // New key prefixes (chat:...) so this never collides with any leftover
  // Chart Review counters (user:.../total:...) sharing the same KV namespace.
  const dailyKey = `chat:user:${user.id}:${today}`;
  const monthlyKey = `chat:total:${month}`;

  const kv = env.CHART_FEEDBACK_KV;
  const [dailyCountStr, monthlyCountStr] = await Promise.all([
    kv.get(dailyKey),
    kv.get(monthlyKey),
  ]);
  const dailyCount = parseInt(dailyCountStr || '0', 10);
  const monthlyCount = parseInt(monthlyCountStr || '0', 10);

  if (dailyCount >= DAILY_LIMIT_PER_USER) {
    return json({ error: `You've hit today's limit of ${DAILY_LIMIT_PER_USER} messages with Sampson X — try again tomorrow` }, 429);
  }
  if (monthlyCount >= MONTHLY_LIMIT_TOTAL) {
    return json({ error: 'Sampson X has hit its monthly limit — it resets next month' }, 429);
  }

  // Personalization: fetched server-side from the user's OWN verified id,
  // never trusted from the client — same service-role REST pattern already
  // used across this repo's Functions (e.g. stripe/activate.js).
  let learnProgress = null;
  if (env.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const profRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=learn_progress`,
        { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } }
      );
      if (profRes.ok) {
        const rows = await profRes.json().catch(() => []);
        learnProgress = Array.isArray(rows) && rows[0]?.learn_progress ? rows[0].learn_progress : null;
      }
    } catch (e) {
      console.error('learn_progress lookup failed:', e.message);
    }
  }

  // Live market data: only checked against the LATEST user message (not the
  // whole history, to keep this cheap and relevant to what's actually being
  // asked right now).
  let liveRows = [];
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  if (lastUserMsg) {
    const candidates = extractTickerCandidates(lastUserMsg.content);
    if (candidates.length) {
      const origin = new URL(request.url).origin;
      liveRows = await fetchLiveData(origin, candidates);
    }
  }

  const system = SAMPSONX_BASE_PROMPT
    + (learningMode === true ? LEARNING_MODE_ADDENDUM : '')
    + personalizationBlock(learnProgress)
    + liveDataBlock(liveRows);

  // Only the LAST user message may carry an image (matches the chat UI —
  // one attachment per turn, not retroactively injected into history).
  const anthropicMessages = messages.map((m, i) => {
    const isLast = i === messages.length - 1;
    if (isLast && m.role === 'user' && image) {
      return {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
          { type: 'text', text: m.content },
        ],
      };
    }
    return { role: m.role, content: m.content };
  });

  let reply;
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 700,
        system,
        messages: anthropicMessages,
      }),
    });
    if (!aiRes.ok) {
      const detail = await aiRes.text();
      console.error('Anthropic request failed:', detail);
      return json({ error: '⚠ Could not reach Sampson X — check your connection and try again.' }, 400);
    }
    const data = await aiRes.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    reply = textBlock?.text || "I don't have enough information to answer that accurately yet. Give me the chart, timeframe, or additional context and I'll help you break it down.";
  } catch (e) {
    return json({ error: '⚠ Could not reach Sampson X — check your connection and try again.' }, 400);
  }

  // Best-effort counters — a rare race under concurrent requests just lets a
  // couple of extra calls through, immaterial at this volume/cost.
  await Promise.all([
    kv.put(dailyKey, String(dailyCount + 1), { expirationTtl: 60 * 60 * 24 * 2 }),
    kv.put(monthlyKey, String(monthlyCount + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
  ]);

  return json({ reply });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
