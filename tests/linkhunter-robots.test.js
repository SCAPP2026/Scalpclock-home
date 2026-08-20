/**
 * Regression tests: LinkHunter robots.txt compliance (Phase 4/28/29)
 * Run with: node tests/linkhunter-robots.test.js
 *
 * Phase 4 requires LinkHunter to never scrape a site in violation of its
 * robots rules -- these tests exercise the actual parser against a mocked
 * fetch (no real network calls), covering the cases that matter most:
 * disallowed paths, allowed paths, longest-match precedence, and the
 * fail-open behavior when robots.txt itself is unreachable.
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

function mockFetch(responses) {
  return async (url) => {
    const key = String(url);
    if (!(key in responses)) throw new Error(`Unexpected fetch: ${key}`);
    const entry = responses[key];
    if (entry === null) throw new Error('network error');
    return { ok: entry.ok !== false, status: entry.status || 200, text: async () => entry.body || '' };
  };
}

async function main() {
  const { isAllowedByRobots } = await import('../functions/lib/linkhunter/robots.js');
  const originalFetch = global.fetch;

  console.log('\n=== LinkHunter robots.txt Compliance Regression Tests ===\n');

  global.fetch = mockFetch({
    'https://blocked-everything.example/robots.txt': { body: 'User-agent: *\nDisallow: /' },
  });
  assert((await isAllowedByRobots('https://blocked-everything.example/some/page')) === false, 'Disallow: / blocks every path');

  global.fetch = mockFetch({
    'https://selective.example/robots.txt': { body: 'User-agent: *\nDisallow: /private/\nAllow: /public/' },
  });
  assert((await isAllowedByRobots('https://selective.example/private/secret')) === false, 'specific disallowed path is blocked');
  assert((await isAllowedByRobots('https://selective.example/public/page')) === true, 'allowed path is permitted');
  assert((await isAllowedByRobots('https://selective.example/other/page')) === true, 'path outside any rule defaults to allowed');

  global.fetch = mockFetch({
    'https://precise.example/robots.txt': { body: 'User-agent: *\nDisallow: /blog/\nAllow: /blog/public-post' },
  });
  assert((await isAllowedByRobots('https://precise.example/blog/public-post')) === true, 'longest matching rule (Allow) wins over shorter Disallow');
  assert((await isAllowedByRobots('https://precise.example/blog/private-post')) === false, 'shorter Disallow still applies outside the more specific Allow');

  global.fetch = mockFetch({
    'https://unreachable.example/robots.txt': null,
  });
  assert((await isAllowedByRobots('https://unreachable.example/page')) === true, 'unreachable robots.txt fails open (no robots.txt = no restriction, per spec)');

  global.fetch = mockFetch({
    'https://no-file.example/robots.txt': { ok: false, status: 404 },
  });
  assert((await isAllowedByRobots('https://no-file.example/page')) === true, '404 robots.txt fails open');

  global.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
