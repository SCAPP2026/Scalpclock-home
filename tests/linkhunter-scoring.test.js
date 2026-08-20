/**
 * Regression tests: LinkHunter scoring formulas (Phase 5/8/28/29)
 * Run with: node tests/linkhunter-scoring.test.js
 *
 * Uses dynamic import() (not a top-level import) so this runs under any
 * Node version without needing a package.json "type": "module" -- same
 * portability goal as this repo's other tests/*.test.js files, just
 * importing the real functions/lib/linkhunter/*.js code directly instead
 * of replicating the logic inline, since that code is real ES modules
 * (unlike the HTML-embedded calc logic the other test file replicates).
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

async function main() {
  const { computeRelevanceScore, computeQualityScore, computeOpportunityScore, computeContactabilityScore, opportunityScoreBand } =
    await import('../functions/lib/linkhunter/scoring.js');
  const { clampScore, isValidUrl, isValidEmail, isOneOf, parseAiJson, validateOpportunity, validateQualityAnalysis, validateOutreachDraft } =
    await import('../functions/lib/linkhunter/validation.js');

  console.log('\n=== LinkHunter Scoring & Validation Regression Tests ===\n');

  console.log('clampScore');
  assert(clampScore(150) === 100, 'clamps above 100 down to 100');
  assert(clampScore(-10) === 0, 'clamps below 0 up to 0');
  assert(clampScore('not a number') === null, 'non-numeric input returns null');
  assert(clampScore(42.37) === 42.4, 'rounds to one decimal place');

  console.log('\ncomputeRelevanceScore — Phase 5 weights (40/25/20/15)');
  const relevance = computeRelevanceScore({ topic_relevance: 100, content_relevance: 0, audience_overlap: 0, asset_relevance: 0 });
  assert(relevance === 40, `topic-only relevance should weight exactly 40% (got ${relevance})`);
  const relevanceFull = computeRelevanceScore({ topic_relevance: 100, content_relevance: 100, audience_overlap: 100, asset_relevance: 100 });
  assert(relevanceFull === 100, 'all sub-scores at 100 should yield 100');

  console.log('\ncomputeQualityScore — Phase 5 (equal-weighted average of 6 factors)');
  const quality = computeQualityScore({ site_quality: 100, content_quality: 100, organic_visibility: 100, editorial_legitimacy: 100, relevant_audience: 100, outbound_link_behavior: 100 });
  assert(quality === 100, 'all factors at 100 should average to 100');
  const qualityHalf = computeQualityScore({ site_quality: 0, content_quality: 0, organic_visibility: 0, editorial_legitimacy: 0, relevant_audience: 0, outbound_link_behavior: 100 });
  assert(Math.abs(qualityHalf - 100 / 6) < 0.2, 'a single 100 among six 0s averages to ~16.7');

  console.log('\ncomputeOpportunityScore — Phase 8 weights (30/20/20/15/10/5)');
  const oppFull = computeOpportunityScore({ relevanceScore: 100, siteQualityScore: 100, audienceOverlap: 100, editorialAcceptanceLikelihood: 100, assetUsefulness: 100, contactabilityScore: 100 });
  assert(oppFull === 100, 'all inputs at 100 should yield opportunity_score 100');
  const oppRelevanceOnly = computeOpportunityScore({ relevanceScore: 100, siteQualityScore: 0, audienceOverlap: 0, editorialAcceptanceLikelihood: 0, assetUsefulness: 0, contactabilityScore: 0 });
  assert(oppRelevanceOnly === 30, `relevance-only should weight exactly 30% (got ${oppRelevanceOnly})`);
  const oppZero = computeOpportunityScore({ relevanceScore: 0, siteQualityScore: 0, audienceOverlap: 0, editorialAcceptanceLikelihood: 0, assetUsefulness: 0, contactabilityScore: 0 });
  assert(oppZero === 0, 'all-zero inputs should yield 0, never a phantom baseline score');

  console.log('\ncomputeContactabilityScore — deterministic, not AI-estimated');
  assert(computeContactabilityScore({ contact_email: 'a@b.com' }) === 100, 'has email -> 100');
  assert(computeContactabilityScore({ contact_name: 'Jane' }) === 50, 'name only, no email -> 50');
  assert(computeContactabilityScore({}) === 0, 'no contact info -> 0');

  console.log('\nopportunityScoreBand — Phase 8 display bands');
  assert(opportunityScoreBand(95) === 'Excellent', '95 -> Excellent');
  assert(opportunityScoreBand(85) === 'High', '85 -> High');
  assert(opportunityScoreBand(75) === 'Good', '75 -> Good');
  assert(opportunityScoreBand(65) === 'Possible', '65 -> Possible');
  assert(opportunityScoreBand(30) === 'Low priority', '30 -> Low priority');

  console.log('\nURL/email/enum validation');
  assert(isValidUrl('https://example.com/page') === true, 'valid https URL accepted');
  assert(isValidUrl('javascript:alert(1)') === false, 'javascript: scheme rejected');
  assert(isValidUrl('not a url') === false, 'garbage string rejected');
  assert(isValidEmail('editor@example.com') === true, 'valid email accepted');
  assert(isValidEmail('not-an-email') === false, 'invalid email rejected');
  assert(isOneOf('TOOL_CITATION', ['RESOURCE_LINK', 'TOOL_CITATION']) === true, 'valid enum member accepted');
  assert(isOneOf('MADE_UP_TYPE', ['RESOURCE_LINK', 'TOOL_CITATION']) === false, 'invented enum value rejected');

  console.log('\nparseAiJson — strips markdown fences models sometimes add');
  const fenced = '```json\n{"a": 1}\n```';
  assert(parseAiJson(fenced).a === 1, 'strips ```json fences before parsing');
  let threw = false;
  try { parseAiJson('not json at all'); } catch { threw = true; }
  assert(threw, 'malformed JSON throws rather than silently returning garbage');

  console.log('\nvalidateOpportunity — Phase 24 AI output validation');
  const goodOpp = validateOpportunity({ opportunity_type: 'RESOURCE_LINK', relevance_score: 200, reason: 'Because reasons' });
  assert(goodOpp.ok === true, 'valid opportunity_type passes');
  assert(goodOpp.value.relevance_score === 100, 'out-of-range AI score gets clamped, not rejected outright');
  const badOpp = validateOpportunity({ opportunity_type: 'MADE_UP', reason: 'x' });
  assert(badOpp.ok === false, 'invented opportunity_type is rejected');

  console.log('\nvalidateQualityAnalysis — every score is required and clamped');
  const badQuality = validateQualityAnalysis({ relevance_score: 'nope', quality_score: 50, spam_score: 10 });
  assert(badQuality.ok === false, 'non-numeric relevance_score fails validation');
  const goodQuality = validateQualityAnalysis({ relevance_score: 80, quality_score: 70, spam_score: 5, notes: 'fine' });
  assert(goodQuality.ok === true, 'all-numeric scores pass validation');

  console.log('\nvalidateOutreachDraft — never a blank/near-blank send');
  const emptyDraft = validateOutreachDraft({ subject: 'Hi', body: 'short' });
  assert(emptyDraft.ok === false, 'too-short body is rejected');
  const realDraft = validateOutreachDraft({ subject: 'Loved your ORB article', body: 'A'.repeat(80) });
  assert(realDraft.ok === true, 'subject + sufficiently long body passes');

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
