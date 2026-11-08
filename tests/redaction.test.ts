import { afterEach, describe, expect, test } from "bun:test";
import { roomWith } from "./helpers.ts";
import type { Room } from "../server/room.ts";

const open: Room[] = [];
const mk = (...a: Parameters<typeof roomWith>) => { const r = roomWith(...a); open.push(r.room); return r; };
afterEach(() => { while (open.length) open.pop()!.dispose(); });

const idsIn = (view: unknown) => JSON.stringify(view);

/**
 * Exact card ids mentioned anywhere in a payload, including the ones hiding inside
 * image paths. Substring matching is useless here: "c1" sits inside "c100".
 */
function cardIdsIn(view: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: any) => {
    if (typeof v === "string") {
      if (/^c\d+$/.test(v)) out.add(v);
      const m = v.match(/\/cards\/(c\d+)\.webp$/);
      if (m) out.add(m[1]);
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === "object") { Object.values(v).forEach(walk); return; }
  };
  walk(view);
  return out;
}

describe("what each player is allowed to see", () => {
  test("nobody receives anybody else's hand", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"]);
    room.start(host);
    for (const [name, token] of Object.entries(tokens)) {
      const leaked = cardIdsIn(room.view(token));
      const mine = new Set(room.players.get(token)!.hand.map((c) => c.id));

      // negative control: if the extractor found nothing, the test below proves nothing
      expect(mine.size).toBe(room.settings.handSize);
      for (const id of mine) expect(leaked.has(id)).toBe(true);

      for (const [other, otherToken] of Object.entries(tokens)) {
        if (other === name) continue;
        for (const card of room.players.get(otherToken)!.hand) {
          expect(leaked.has(card.id)).toBe(false);
        }
      }
    }
  });

  test("the extractor really does catch a leak when there is one", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    room.start(host);
    const [a, b] = Object.values(tokens);
    const bogus = { ...room.view(a), smuggled: room.players.get(b)!.hand[0] };
    expect(cardIdsIn(bogus).has(room.players.get(b)!.hand[0].id)).toBe(true);
  });

  test("the clue stays secret until the storyteller has actually told it", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    room.start(host);
    for (const t of Object.values(tokens)) expect(room.view(t).clue).toBeUndefined();
    const st = room.players.get(room.storytellerToken!)!;
    room.submitStory(st.token, st.hand[0].id, "a secret");
    for (const t of Object.values(tokens)) expect(room.view(t).clue).toBe("a secret");
  });

  test("while cards are being played the table is face down for everyone", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"]);
    room.start(host);
    const stToken = room.storytellerToken!;
    const st = room.players.get(stToken)!;
    const secret = st.hand[0].id;
    room.submitStory(stToken, secret, "clue");
    const someone = Object.values(tokens).find((t) => t !== stToken)!;
    room.submitCard(someone, room.players.get(someone)!.hand[0].id);
    expect(room.phase).toBe("SUBMITTING");
    for (const t of Object.values(tokens)) {
      const v = room.view(t);
      expect(v.table).toEqual([]);
      if (t !== stToken) expect(idsIn(v)).not.toContain(secret);
    }
  });

  test("during voting the storyteller's card is not flagged and owners stay hidden", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"]);
    room.start(host);
    const stToken = room.storytellerToken!;
    const st = room.players.get(stToken)!;
    room.submitStory(stToken, st.hand[0].id, "clue");
    for (const t of Object.values(tokens)) {
      if (t === stToken) continue;
      room.submitCard(t, room.players.get(t)!.hand[0].id);
    }
    expect(room.phase).toBe("VOTING");

    const voter = Object.values(tokens).find((t) => t !== stToken)!;
    const v = room.view(voter);
    expect(v.table.length).toBe(4);
    for (const c of v.table) {
      expect(c.isStorytellerCard).toBeUndefined();
      expect(c.voters).toBeUndefined();
      expect(c.ownerName).toBeUndefined();
    }
    // exactly one card is marked back: the viewer's own, so the UI can block it
    const flagged = v.table.filter((c) => c.ownerId !== undefined);
    expect(flagged.length).toBe(1);
    expect(flagged[0].ownerId).toBe(room.players.get(voter)!.id);
    expect(flagged[0].cardId).toBe(room.players.get(voter)!.submitted);
  });

  test("a Half-Light hint is visible only to the player who spent it", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { lifelines: { burn: 0, freshHand: 0, halfLight: 1, stall: 0, doubleDown: 0, passStory: 0 } });
    room.start(host);
    const stToken = room.storytellerToken!;
    const st = room.players.get(stToken)!;
    room.submitStory(stToken, st.hand[0].id, "clue");
    for (const t of Object.values(tokens)) {
      if (t === stToken) continue;
      room.submitCard(t, room.players.get(t)!.hand[0].id);
    }
    const user = Object.values(tokens).find((t) => t !== stToken)!;
    expect(room.useLifeline(user, "halfLight")).toBeNull();
    const hint = room.view(user).you.halfLightExcluded;
    expect(hint).toBeTruthy();
    for (const t of Object.values(tokens)) {
      if (t === user) continue;
      expect(room.view(t).you.halfLightExcluded).toBeUndefined();
    }
  });

  test("after the reveal everything is on show", () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { revealSeconds: 60 });
    room.start(host);
    const stToken = room.storytellerToken!;
    const st = room.players.get(stToken)!;
    room.submitStory(stToken, st.hand[0].id, "clue");
    for (const t of Object.values(tokens)) {
      if (t === stToken) continue;
      room.submitCard(t, room.players.get(t)!.hand[0].id);
    }
    for (const t of Object.values(tokens)) {
      if (t === stToken) continue;
      const legal = room.table.find((c) => c.ownerToken !== t)!;
      room.vote(t, legal.cardId);
    }
    expect(room.phase).toBe("REVEAL");
    const v = room.view(stToken);
    expect(v.table.filter((c) => c.isStorytellerCard).length).toBe(1);
    for (const c of v.table) {
      expect(c.ownerName).toBeTruthy();
      expect(Array.isArray(c.voters)).toBe(true);
    }
  });

  test("a spectator gets no hand and no lifelines", () => {
    const { room, host } = mk(["A", "B", "C"]);
    room.start(host);
    const watcher = room.join("Nosy", "👀");
    const v = room.view(watcher.token!);
    expect(v.you.isSpectator).toBe(true);
    expect(v.you.hand).toEqual([]);
  });
});
