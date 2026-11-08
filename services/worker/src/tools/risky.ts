// Shared by Table Mode (workflows/huddle.ts) and Brian's goal tool; lives here so tools do not import workflows.
/**
 * Goals we will not score as a plan, however affordable: gambling, and speculation sold as a way to multiply money. The card
 * says why in one line instead of "on track". Deterministic, so no model can talk itself into backing it.
 */
const GAMBLING_RE = /\bgambl|\bcasino|\bbet(?:s|ting)?\b|\blotter(?:y|ies)\b|\bscratch.?offs?\b|\bsports ?book|\bpoker\b|\bslots?\b|\bparlay/i;
const SPECULATION_RE = /\b(?:double|triple|10x|moon)\b.*\b(?:crypto|bitcoin|coin|money|it)\b|\b(?:crypto|bitcoin|meme ?coin|meme ?stock|day ?trad|options? trad)/i;
export function riskyGoal(text: string): { why: string } | null {
  if (GAMBLING_RE.test(text)) return { why: 'Gambling is not a plan: the odds are set so the house wins over time.' };
  if (SPECULATION_RE.test(text)) return { why: 'Crypto and other speculative bets can lose value fast. Keep it to money you can afford to lose, after the emergency fund.' };
  return null;
}
