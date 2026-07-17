const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';
// Public anon key — same one already shipped client-side in scalpchart.html.
// Used only as the `apikey` header on the /auth/v1/user verification call.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZudXF4aWZscXFlamp0dHh5bWJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzMxODksImV4cCI6MjA5ODAwOTE4OX0.XE1-LPW0043gRFEAl9onCahkmpQ8BMAAtGkF9FqJLiY';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB decoded
const DAILY_LIMIT_PER_USER = 5;
const MONTHLY_LIMIT_TOTAL = 600;
const GATED_PLANS = ['free', 'expired', 'anon']; // mirrors scalpchart.html's client-side paywall condition

const SAMPSONX_SYSTEM_PROMPT = `You are SampsonX, ScalpClock's AI trading coach. A user has uploaded a screenshot of a stock or options chart and wants your read on it.

Structure your analysis around ScalpClock's 4 C's framework:
- Candle: describe the body/wick structure of the most recent visible candle(s) — what actually happened.
- Confirm: note the volume context if it's visible in the screenshot; if no volume is shown, say so plainly rather than guessing.
- Context: describe the overall trend, any visible support/resistance, and where this candle sits in that structure.
- Commit: state plainly what a trader should wait to see happen next before acting on this.

Write in plain, direct English a beginner can follow. Don't hedge excessively, but stay honest about what you genuinely can't tell from a static screenshot (e.g. no live volume, no multi-timeframe context). If the image isn't a readable trading chart, say so directly instead of inventing an analysis.

End with one short line: this is educational only, not financial advice.`;

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'Chart feedback is not configured yet' }, 500);
  if (!env.CHART_FEEDBACK_KV) return json({ error: 'Chart feedback is not configured yet' }, 500);

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return json({ error: 'Sign in required' }, 401);

  // Verify the caller's Supabase JWT for real — /auth/v1/user only returns
  // the user (and their app_metadata.plan) if the token is genuinely valid,
  // unlike the admin-service-role writes elsewhere in this repo which never
  // check the caller's own identity.
  let user;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) return json({ error: 'Sign in required' }, 401);
    user = await userRes.json();
  } catch (e) {
    // Not 502/503/504 — Cloudflare's edge replaces the body of those with its
    // own generic error page even for a Function's own Response, silently
    // swallowing this message right back out.
    return json({ error: 'Could not verify your session — try again in a moment' }, 400);
  }

  const plan = user?.app_metadata?.plan;
  if (!plan || GATED_PLANS.includes(plan)) {
    return json({ error: 'Chart Review is a Pro feature' }, 403);
  }

  let image, mediaType;
  try {
    ({ image, mediaType } = await request.json());
  } catch {
    return json({ error: 'Invalid request body' }, 400);
  }

  if (!image || !['image/png', 'image/jpeg'].includes(mediaType)) {
    return json({ error: 'Upload a PNG or JPEG screenshot' }, 400);
  }
  const approxBytes = Math.floor(image.length * 0.75);
  if (approxBytes > MAX_IMAGE_BYTES) {
    return json({ error: 'That image is too large — try a screenshot under 4MB' }, 400);
  }

  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  const dailyKey = `user:${user.id}:${today}`;
  const monthlyKey = `total:${month}`;

  const kv = env.CHART_FEEDBACK_KV;
  const [dailyCountStr, monthlyCountStr] = await Promise.all([
    kv.get(dailyKey),
    kv.get(monthlyKey),
  ]);
  const dailyCount = parseInt(dailyCountStr || '0', 10);
  const monthlyCount = parseInt(monthlyCountStr || '0', 10);

  if (dailyCount >= DAILY_LIMIT_PER_USER) {
    return json({ error: `You've hit today's limit of ${DAILY_LIMIT_PER_USER} chart reviews — try again tomorrow` }, 429);
  }
  if (monthlyCount >= MONTHLY_LIMIT_TOTAL) {
    return json({ error: 'Chart Review has hit its monthly limit — it resets next month' }, 429);
  }

  let feedback;
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
        max_tokens: 1024,
        system: SAMPSONX_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: image } },
            { type: 'text', text: 'Analyze this chart screenshot.' },
          ],
        }],
      }),
    });
    if (!aiRes.ok) {
      const detail = await aiRes.text();
      console.error('Anthropic request failed:', detail);
      return json({ error: "⚠ Could not reach SampsonX — check your connection and try again." }, 400);
    }
    const data = await aiRes.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    feedback = textBlock?.text || "SampsonX couldn't find anything to say about that image — try a clearer screenshot.";
  } catch (e) {
    return json({ error: "⚠ Could not reach SampsonX — check your connection and try again." }, 400);
  }

  // Best-effort counters — a rare race under concurrent requests just lets a
  // couple of extra calls through, which is immaterial at this volume/cost.
  await Promise.all([
    kv.put(dailyKey, String(dailyCount + 1), { expirationTtl: 60 * 60 * 24 * 2 }),
    kv.put(monthlyKey, String(monthlyCount + 1), { expirationTtl: 60 * 60 * 24 * 35 }),
  ]);

  return json({ feedback });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
