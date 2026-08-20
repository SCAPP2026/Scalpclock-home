/**
 * Integration test: LinkHunter Discovery -> Prospect -> Opportunity flow
 * (Phase 28/29). Run with: node tests/linkhunter-pipeline.test.js
 *
 * Mocks global.fetch to stand in for robots.txt, the candidate page,
 * Anthropic, and Supabase's REST API -- no live network or credentials
 * needed -- and drives the real runProspectAnalysis() pipeline end to end,
 * asserting on exactly what it would have written to the database. This is
 * the one path that touches almost every LinkHunter service in one call
 * (fetch -> robots check -> AI quality scoring -> deterministic score
 * formulas -> AI opportunity generation -> AI-output validation ->
 * opportunity scoring), so it's the highest-value integration test.
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

const SUPABASE_URL = 'https://fnuqxiflqqejjttxymbz.supabase.co';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

async function main() {
  const { runProspectAnalysis } = await import('../functions/lib/linkhunter/pipeline.js');
  const originalFetch = global.fetch;

  const prospectRow = {
    id: 42, url: 'https://example.com/orb-guide', domain: 'example.com',
    title: null, description: null, category: 'ORB', status: 'NEW',
    contact_email: null, contact_name: null, notes: null,
  };
  const updatedProspectRow = { ...prospectRow, relevance_score: 72.5, quality_score: 65, spam_score: 5, status: 'REVIEW' };

  const insertedOpportunities = [];
  const updateCalls = [];

  global.fetch = async (url, init = {}) => {
    const u = String(url);

    if (u.endsWith('/robots.txt')) return jsonResponse({}, 404); // no robots.txt -> allowed

    if (u === prospectRow.url) {
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'content-type' ? 'text/html' : null) },
        body: null,
        text: async () => '<html><title>ORB Guide</title><body>Opening range breakout explained, no interactive tool provided.</body></html>',
      };
    }

    if (u === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(init.body);
      if (body.system.includes('opportunity engine')) {
        return jsonResponse({
          content: [{ type: 'text', text: JSON.stringify({
            opportunities: [
              {
                opportunity_type: 'TOOL_CITATION',
                target_url: prospectRow.url,
                reason: 'Article explains ORB but has no interactive tool.',
                recommended_asset: 'ORB Signal Engine',
                relevance_score: 85,
                audience_overlap: 70,
                editorial_acceptance_likelihood: 60,
                asset_usefulness: 90,
              },
              { opportunity_type: 'NOT_A_REAL_TYPE', reason: 'should be rejected by validation' },
            ],
          }) }],
        });
      }
      return jsonResponse({
        content: [{ type: 'text', text: JSON.stringify({
          topic_relevance: 80, content_relevance: 70, audience_overlap: 60, asset_relevance: 65,
          site_quality: 70, content_quality: 65, organic_visibility: 60, editorial_legitimacy: 70,
          relevant_audience: 65, outbound_link_behavior: 60, spam_score: 5, notes: 'Looks legitimate.',
        }) }],
      });
    }

    if (u.startsWith(`${SUPABASE_URL}/rest/v1/prospects`) && (!init.method || init.method === 'GET')) {
      return jsonResponse([prospectRow]);
    }
    if (u.startsWith(`${SUPABASE_URL}/rest/v1/prospects`) && init.method === 'PATCH') {
      updateCalls.push(JSON.parse(init.body));
      return jsonResponse([updatedProspectRow]);
    }
    if (u.startsWith(`${SUPABASE_URL}/rest/v1/content_assets`)) {
      return jsonResponse([{ title: 'ORB Signal Engine', asset_type: 'TOOL', description: 'ORB tool', url: '/orbsignalengine' }]);
    }
    if (u.startsWith(`${SUPABASE_URL}/rest/v1/opportunities`) && init.method === 'POST') {
      insertedOpportunities.push(JSON.parse(init.body));
      return jsonResponse([{ id: insertedOpportunities.length }]);
    }

    throw new Error(`Unexpected fetch in pipeline test: ${u}`);
  };

  console.log('\n=== LinkHunter Pipeline Integration Test (Discovery -> Prospect -> Opportunity) ===\n');

  const result = await runProspectAnalysis(42, { env: { ANTHROPIC_API_KEY: 'test-key' }, serviceKey: 'test-service-key' });

  assert(result.analyzed === true, 'pipeline completes and reports analyzed=true');
  assert(result.opportunitiesCreated === 1, `exactly 1 valid opportunity created, the invalid one was rejected (got ${result.opportunitiesCreated})`);
  assert(insertedOpportunities.length === 1, 'exactly one INSERT was sent to opportunities, not two');

  const inserted = insertedOpportunities[0];
  assert(inserted.opportunity_type === 'TOOL_CITATION', 'valid opportunity_type made it through');
  assert(inserted.recommended_asset === 'ORB Signal Engine', 'recommended_asset carried through from the AI response');
  assert(typeof inserted.opportunity_score === 'number' && inserted.opportunity_score > 0 && inserted.opportunity_score <= 100, `opportunity_score is a real computed 0-100 number (got ${inserted.opportunity_score})`);

  const scoreUpdate = updateCalls.find((c) => 'relevance_score' in c);
  assert(!!scoreUpdate, 'prospect PATCH included the computed relevance_score');
  assert(scoreUpdate.relevance_score > 0 && scoreUpdate.relevance_score <= 100, 'computed relevance_score is in valid range');
  assert(scoreUpdate.status === 'REVIEW', 'a NEW prospect auto-advances to REVIEW after analysis, but not further (still needs human qualification)');

  global.fetch = originalFetch;
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Integration test crashed:', e);
  process.exit(1);
});
