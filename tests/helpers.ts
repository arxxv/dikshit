import { Room } from "../server/room.ts";
import type { CardRef, Settings } from "../shared/types.ts";

export const fakeCards = (n = 400): CardRef[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i}`, img: `/cards/c${i}.webp` }));

export function roomWith(names: string[], settings?: Partial<Settings>, cards = fakeCards()) {
  const room = new Room("TEST1", cards, settings);
  const tokens: Record<string, string> = {};
  for (const n of names) {
    const r = room.join(n, "🦊");
    if (!r.token) throw new Error(`join failed for ${n}: ${r.error}`);
    tokens[n] = r.token;
  }
  return { room, tokens, host: tokens[names[0]] };
}

/** plays a full round through to REVEAL, choosing the first legal option every time */
export function playRound(room: Room, tokens: Record<string, string>, clue = "a clue") {
  const stToken = room.storytellerToken!;
  const st = room.players.get(stToken)!;
  const err = room.submitStory(stToken, st.hand[0].id, clue);
  if (err) throw new Error("submitStory: " + err);

  for (const t of Object.values(tokens)) {
    if (t === stToken) continue;
    const p = room.players.get(t);
    if (!p || p.isSpectator || !p.hand.length) continue;
    const e = room.submitCard(t, p.hand[0].id);
    if (e) throw new Error("submitCard: " + e);
  }

  if (room.phase !== "VOTING") return;
  for (const t of Object.values(tokens)) {
    if (t === stToken) continue;
    const p = room.players.get(t);
    if (!p || !p.submitted) continue;
    const legal = room.table.find((c) => c.ownerToken !== t)!;
    const e = room.vote(t, legal.cardId);
    if (e) throw new Error("vote: " + e);
  }
}
