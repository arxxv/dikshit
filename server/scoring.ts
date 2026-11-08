/**
 * Dixit-style round scoring, kept pure so the tests can hit every branch.
 * Storyteller found by nobody or by everybody: storyteller 0, everyone else 2.
 * Otherwise: storyteller 3, each correct voter 3.
 * Either way each decoy owner takes 1 per vote drawn (capped at 3 when enabled).
 * Double Down pays +2 on a correct vote and costs 1 on a wrong one.
 */
export interface ScoringInput {
  storytellerId: string;
  storytellerCardId: string;
  table: { cardId: string; ownerId: string }[];
  votes: Record<string, string>;
  eligibleVoters: string[];
  voteCapEnabled: boolean;
  doubleDown: string[];
}

export interface ScoringResult {
  delta: Record<string, number>;
  correct: string[];
  votesPerCard: Record<string, string[]>;
}

export function scoreRound(i: ScoringInput): ScoringResult {
  const delta: Record<string, number> = { [i.storytellerId]: 0 };
  for (const v of i.eligibleVoters) delta[v] = 0;

  const correct = i.eligibleVoters.filter((v) => i.votes[v] === i.storytellerCardId);

  const votesPerCard: Record<string, string[]> = {};
  for (const c of i.table) votesPerCard[c.cardId] = [];
  for (const v of i.eligibleVoters) {
    const choice = i.votes[v];
    if (choice && votesPerCard[choice]) votesPerCard[choice].push(v);
  }

  const allOrNothing = correct.length === 0 || correct.length === i.eligibleVoters.length;
  if (allOrNothing) {
    for (const v of i.eligibleVoters) delta[v] += 2;
  } else {
    delta[i.storytellerId] += 3;
    for (const v of correct) delta[v] += 3;
  }

  for (const c of i.table) {
    if (c.ownerId === i.storytellerId) continue;
    const n = votesPerCard[c.cardId]?.length ?? 0;
    const pts = i.voteCapEnabled ? Math.min(3, n) : n;
    delta[c.ownerId] = (delta[c.ownerId] ?? 0) + pts;
  }

  for (const p of i.doubleDown) {
    if (p === i.storytellerId) continue;
    delta[p] = (delta[p] ?? 0) + (correct.includes(p) ? 2 : -1);
  }

  return { delta, correct, votesPerCard };
}
