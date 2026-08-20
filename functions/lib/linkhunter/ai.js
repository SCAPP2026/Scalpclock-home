// Shared Anthropic call helper for LinkHunter's AI services, following the
// same fetch-based pattern as functions/api/chart-feedback.js (no SDK, this
// repo has no npm dependencies at all).

/** Calls Claude with a system prompt + user message and returns the raw
 * text response. Throws on any non-2xx or malformed response so callers
 * never treat a failed call as an empty-but-successful one. */
export async function callClaude(env, { system, prompt, maxTokens = 1024 }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  const text = data?.content?.find((b) => b.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('Anthropic response had no text content');
  return text;
}
