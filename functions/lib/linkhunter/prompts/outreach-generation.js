// Phase 23 — OutreachGenerator prompt (Phase 10). Hard requirement from the
// product spec: never generic mass-spam copy ("Dear Webmaster, please link
// to my website"). Every draft must explain (1) why this site, (2) what
// specific content was reviewed, (3) what ScalpClock resource is relevant,
// (4) why it benefits that site's audience, (5) a low-pressure ask. Output
// is a DRAFT only -- nothing here ever sends anything; human approval is a
// separate, later step (Phase 11).
import { SCALPCLOCK_CONTEXT } from './prospect-analysis.js';

export function buildOutreachGenerationPrompt({ prospect, opportunity, asset }) {
  const system = `You write personalized outreach email drafts for LinkHunter, ScalpClock's legitimate backlink-outreach tool. ${SCALPCLOCK_CONTEXT}

STRICT RULES:
- Never write generic mass-outreach copy. Never say things like "Dear Webmaster" or "please link to my website."
- The draft MUST explicitly reference something specific from the actual page/article reviewed -- not a generic compliment.
- The draft MUST explain, in the site owner's terms, why the recommended ScalpClock resource specifically benefits THEIR readers.
- The ask must be low-pressure -- suggest, don't demand. Never mention SEO, rankings, "link juice," or backlink value to ScalpClock -- frame everything around reader benefit.
- Keep it short (120-180 words for the body), plain, human, and specific. No corporate boilerplate, no excessive exclamation points, no emoji.
- Sign off as "The ScalpClock Team".

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{
  "subject": "<short, specific, non-spammy subject line>",
  "body": "<the email body>"
}`;

  const prompt = `Recipient site: ${prospect.domain}
Contact: ${prospect.contact_name || '(name unknown -- address generically but warmly, e.g. "Hi there")'}
Reviewed page: ${opportunity.target_article || opportunity.target_page || prospect.url}
Why this opportunity: ${opportunity.reason || '(not specified)'}
Specific detail to reference: ${opportunity.personalization_notes || '(none captured -- infer something plausible-sounding is NOT allowed; keep it general to the page topic instead)'}

Recommended ScalpClock resource: ${asset?.title || opportunity.recommended_asset || '(none matched)'}
Resource description: ${asset?.description || '(none)'}
Resource URL: ${asset?.url ? `https://www.scalpclock.com${asset.url}` : '(none)'}

Opportunity type: ${opportunity.opportunity_type}

Write the outreach draft and return the JSON object.`;

  return { system, prompt };
}
