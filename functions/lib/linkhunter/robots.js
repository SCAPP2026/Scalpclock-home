// Phase 4 — "Do not scrape websites in violation of their terms or robots
// rules." Minimal robots.txt parser: fetches /robots.txt for the target
// origin and checks the path against the User-agent: * group (and our own
// UA, if a site singles it out) before any discovery fetch is allowed to
// proceed.

export const LINKHUNTER_USER_AGENT = 'ScalpClockLinkHunterBot/1.0 (+https://www.scalpclock.com/about)';

const robotsCache = new Map(); // per-invocation cache; Workers are short-lived so no TTL needed

function parseRobots(text, userAgent) {
  const lines = text.split(/\r?\n/);
  const groups = []; // { agents: string[], rules: {type, path}[] }
  let current = null;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    if (!rest.length) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'disallow' || key === 'allow') {
      if (!current) continue;
      current.rules.push({ type: key, path: value });
    }
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== '*' && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  return (specific || wildcard)?.rules || [];
}

/** Returns true if `pathname` is allowed to be fetched under the target
 * origin's robots.txt for LINKHUNTER_USER_AGENT. Fails open only when
 * robots.txt itself is unreachable (no robots.txt = no restriction, the
 * standard interpretation) -- never fails open on a parse error that
 * produced real rules. */
export async function isAllowedByRobots(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }

  let rules = robotsCache.get(origin);
  if (rules === undefined) {
    try {
      const res = await fetch(`${origin}/robots.txt`, {
        headers: { 'User-Agent': LINKHUNTER_USER_AGENT },
      });
      rules = res.ok ? parseRobots(await res.text(), LINKHUNTER_USER_AGENT) : [];
    } catch {
      rules = []; // no robots.txt reachable -> no restriction
    }
    robotsCache.set(origin, rules);
  }

  const pathname = new URL(url).pathname || '/';
  // Longest matching rule wins (standard robots.txt precedence).
  let best = null;
  for (const rule of rules) {
    if (rule.path === '' || pathname.startsWith(rule.path)) {
      if (!best || rule.path.length > best.path.length) best = rule;
    }
  }
  return !best || best.type === 'allow';
}
