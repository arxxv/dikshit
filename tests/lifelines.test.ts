import { afterEach, describe, expect, test } from "bun:test";
import { roomWith } from "./helpers.ts";
import type { Room } from "../server/room.ts";
import type { LifelineId } from "../shared/types.ts";

const open: Room[] = [];
const mk = (...a: Parameters<typeof roomWith>) => { const r = roomWith(...a); open.push(r.room); return r; };
afterEach(() => { while (open.length) open.pop()!.dispose(); });

const all = (n: number): Record<LifelineId, number> =>
  ({ burn: n, freshHand: n, halfLight: n, stall: n, doubleDown: n, passStory: n });

/** advances a started room to VOTING with everyone's card on the table */
function toVoting(room: Room, tokens: Record<string, string>) {
  const stToken = room.storytellerToken!;
  room.submitStory(stToken, room.players.get(stToken)!.hand[0].id, "clue");
  for (const t of Object.values(tokens)) {
    if (t === stToken) continue;
    room.submitCard(t, room.players.get(t)!.hand[0].id);
  }
  return stToken;
}

describe("lifelines", () => {
  test("Burn swaps one card and spends one use", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: all(2) });
    room.start(host);
    const p = room.players.get(host)!;
    const before = p.hand.map((c) => c.id);
    expect(room.useLifeline(host, "burn", before[0])).toBeNull();
    expect(p.hand.length).toBe(before.length);
    expect(p.hand.map((c) => c.id)).not.toContain(before[0]);
    expect(room.view(host).you.lifelinesLeft.burn).toBe(1);
  });

  test("Burn refuses a card you do not hold", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: all(2) });
    room.start(host);
    expect(room.useLifeline(host, "burn", "nonsense")).toContain("not in your hand");
  });

  test("Fresh Hand replaces every card", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: all(1) });
    room.start(host);
    const p = room.players.get(host)!;
    const before = new Set(p.hand.map((c) => c.id));
    expect(room.useLifeline(host, "freshHand")).toBeNull();
    expect(p.hand.length).toBe(before.size);
    expect(p.hand.some((c) => before.has(c.id))).toBe(false);
  });

  test("neither Burn nor Fresh Hand works once you have played your card", () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { lifelines: all(2) });
    room.start(host);
    const stToken = room.storytellerToken!;
    room.submitStory(stToken, room.players.get(stToken)!.hand[0].id, "clue");
    const other = Object.values(tokens).find((t) => t !== stToken)!;
    room.submitCard(other, room.players.get(other)!.hand[0].id);
    expect(room.useLifeline(other, "burn", room.players.get(other)!.hand[0].id)).toContain("before you play");
    expect(room.useLifeline(other, "freshHand")).toContain("before you play");
    // the storyteller has played too
    expect(room.useLifeline(stToken, "freshHand")).toContain("before you play");
  });

  test("a lifeline set to zero is refused outright", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: { ...all(1), burn: 0 } });
    room.start(host);
    expect(room.useLifeline(host, "burn", room.players.get(host)!.hand[0].id)).toContain("switched off");
  });

  test("running out of uses is refused", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: { ...all(0), burn: 1 } });
    room.start(host);
    const p = room.players.get(host)!;
    expect(room.useLifeline(host, "burn", p.hand[0].id)).toBeNull();
    expect(room.useLifeline(host, "burn", p.hand[0].id)).toContain("used all");
  });

  test("Half-Light rules out a card that is neither the story nor your own", () => {
    // two charges, so the second attempt is stopped by the once-a-round rule and not by the budget
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { lifelines: { ...all(1), halfLight: 2 } });
    room.start(host);
    const stToken = toVoting(room, tokens);
    const user = Object.values(tokens).find((t) => t !== stToken)!;
    expect(room.useLifeline(user, "halfLight")).toBeNull();
    const out = room.players.get(user)!.halfLight!;
    expect(out).toBeTruthy();
    expect(out).not.toBe(room.storytellerCardId);
    expect(room.table.find((c) => c.cardId === out)!.ownerToken).not.toBe(user);
    expect(room.useLifeline(user, "halfLight")).toContain("Already used");
  });

  test("Half-Light is refused after you have voted and to the storyteller", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { lifelines: all(2) });
    room.start(host);
    const stToken = toVoting(room, tokens);
    expect(room.useLifeline(stToken, "halfLight")).toContain("storyteller does not vote");
    const user = Object.values(tokens).find((t) => t !== stToken)!;
    room.vote(user, room.table.find((c) => c.ownerToken !== user)!.cardId);
    expect(room.useLifeline(user, "halfLight")).toContain("already voted");
  });

  test("Stall pushes the deadline out and keeps the phase alive past the old one", async () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { lifelines: all(1), voteSeconds: 1, revealSeconds: 60 });
    room.start(host);
    const stToken = toVoting(room, tokens);
    expect(room.phase).toBe("VOTING");
    const was = room.phaseEndsAt!;
    const user = Object.values(tokens).find((t) => t !== stToken)!;
    expect(room.useLifeline(user, "stall")).toBeNull();
    expect(room.phaseEndsAt! - was).toBe(30_000);
    await new Promise((r) => setTimeout(r, 1400));
    expect(room.phase).toBe("VOTING");
  });

  test("Double Down is declared before voting and only before voting", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { lifelines: all(1) });
    room.start(host);
    const stToken = toVoting(room, tokens);
    const user = Object.values(tokens).find((t) => t !== stToken)!;
    expect(room.useLifeline(user, "doubleDown")).toBeNull();
    expect(room.players.get(user)!.doubleDown).toBe(true);
    room.vote(user, room.table.find((c) => c.ownerToken !== user)!.cardId);
    const other = Object.values(tokens).find((t) => t !== stToken && t !== user)!;
    room.vote(other, room.table.find((c) => c.ownerToken !== other)!.cardId);
    expect(room.useLifeline(other, "doubleDown")).toBeTruthy();
  });

  test("Double Down changes the score it was wagered on", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { lifelines: all(1), revealSeconds: 60 });
    room.start(host);
    const stToken = toVoting(room, tokens);
    const bettor = Object.values(tokens).find((t) => t !== stToken)!;
    room.useLifeline(bettor, "doubleDown");
    // everyone finds the story: bettor gets the 2 for the all-found branch plus the 2 wager
    for (const t of Object.values(tokens)) {
      if (t === stToken) continue;
      room.vote(t, room.storytellerCardId!);
    }
    expect(room.phase).toBe("REVEAL");
    expect(room.players.get(bettor)!.roundDelta).toBe(2 + 2);
  });

  test("Pass the Story moves the role on, redraws, and keeps the round number", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: all(1) });
    room.start(host);
    const stToken = room.storytellerToken!;
    const st = room.players.get(stToken)!;
    const before = new Set(st.hand.map((c) => c.id));
    const round = room.round;
    expect(room.useLifeline(stToken, "passStory")).toBeNull();
    expect(room.storytellerToken).not.toBe(stToken);
    expect(room.round).toBe(round);
    expect(room.phase).toBe("STORYTELLING");
    expect(st.hand.some((c) => before.has(c.id))).toBe(false);
    expect(room.view(stToken).you.lifelinesLeft.passStory).toBe(0);
  });

  test("Pass the Story is storyteller-only", () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { lifelines: all(1) });
    room.start(host);
    const other = Object.values(tokens).find((t) => t !== room.storytellerToken)!;
    expect(room.useLifeline(other, "passStory")).toContain("not the storyteller");
  });

  test("spectators have no lifelines", () => {
    const { room, host } = mk(["A", "B", "C"], { lifelines: all(2) });
    room.start(host);
    const watcher = room.join("Nosy", "👀");
    expect(room.useLifeline(watcher.token!, "freshHand")).toContain("Spectators");
  });
});
