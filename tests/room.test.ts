import { afterEach, describe, expect, test } from "bun:test";
import { playRound, roomWith } from "./helpers.ts";
import type { Room } from "../server/room.ts";

const open: Room[] = [];
const mk = (...a: Parameters<typeof roomWith>) => { const r = roomWith(...a); open.push(r.room); return r; };
afterEach(() => { while (open.length) open.pop()!.dispose(); });

describe("lobby and membership", () => {
  test("the first joiner is host and later joiners are seated in order", () => {
    const { room, tokens } = mk(["Ann", "Bob", "Cid"]);
    expect(room.hostToken).toBe(tokens.Ann);
    expect(room.order.length).toBe(3);
    expect(room.players.get(tokens.Bob)!.isSpectator).toBe(false);
  });

  test("a duplicate name is made unique rather than rejected", () => {
    const { room } = mk(["Ann", "Ann"]);
    const names = [...room.players.values()].map((p) => p.name);
    expect(new Set(names).size).toBe(2);
  });

  test("joining a full table lands you in the spectator stand", () => {
    const { room } = mk(["A", "B", "C"], { maxPlayers: 3 });
    const r = room.join("D", "🐙");
    expect(r.status).toBe("spectator");
    expect(room.order.length).toBe(3);
    expect(room.spectators.length).toBe(1);
  });

  test("joining mid-game makes you a spectator, never a player", () => {
    const { room, host } = mk(["A", "B", "C"]);
    room.start(host);
    const r = room.join("Late", "🐸");
    expect(r.status).toBe("spectator");
    expect(room.spectators[0].hand.length).toBe(0);
  });

  test("a kicked player cannot walk back in with the same token or name", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    const bid = room.players.get(tokens.B)!.id;
    expect(room.kick(host, bid)).toBeNull();
    expect(room.players.has(tokens.B)).toBe(false);
    expect(room.join("B", "🦊", tokens.B).ok).toBe(false);
    expect(room.join("B", "🦊").ok).toBe(false);
    expect(room.clearBans(host)).toBeNull();
    expect(room.join("B", "🦊").ok).toBe(true);
  });

  test("only the host may kick, and the host cannot kick themselves", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    const cid = room.players.get(tokens.C)!.id;
    expect(room.kick(tokens.B, cid)).toBeTruthy();
    expect(room.kick(host, room.players.get(host)!.id)).toBeTruthy();
  });

  test("approval mode parks joiners until the host lets them in", () => {
    const { room, host } = mk(["A"], { requireApproval: true });
    const r = room.join("B", "🐙");
    expect(r.status).toBe("pending");
    expect(room.order.length).toBe(1);
    expect(room.view(host).pending.length).toBe(1);
    expect(room.approve(host, r.token!)).toBeNull();
    expect(room.order.length).toBe(2);
  });

  test("a denied request is blocked from retrying", () => {
    const { room, host } = mk(["A"], { requireApproval: true });
    const r = room.join("B", "🐙");
    expect(room.deny(host, r.token!)).toBeNull();
    expect(room.join("B", "🐙", r.token).ok).toBe(false);
  });

  test("the host badge moves on when the host drops out", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    room.start(host);
    room.disconnect(host);
    expect(room.hostToken).not.toBe(host);
    expect([tokens.B, tokens.C]).toContain(room.hostToken);
  });

  test("pending players are hidden from everyone but the host", () => {
    const { room, host } = mk(["A", "B"]);
    room.setSettings(host, { requireApproval: true });
    room.join("C", "🐸");
    const bToken = [...room.players.keys()].find((t) => t !== host)!;
    expect(room.view(host).pending.length).toBe(1);
    expect(room.view(bToken).pending.length).toBe(0);
  });
});

describe("the round", () => {
  test("starting deals a full hand to every seated player", () => {
    const { room, host } = mk(["A", "B", "C", "D"], { handSize: 6 });
    expect(room.start(host)).toBeNull();
    expect(room.phase).toBe("STORYTELLING");
    for (const p of room.seated) expect(p.hand.length).toBe(6);
  });

  test("a game cannot start below the minimum table size", () => {
    const { room, host } = mk(["A", "B"]);
    expect(room.start(host)).toContain("at least");
  });

  test("a clue is required and length-checked", () => {
    const { room, host } = mk(["A", "B", "C"], { clueMaxLength: 10 });
    room.start(host);
    const st = room.players.get(room.storytellerToken!)!;
    expect(room.submitStory(st.token, st.hand[0].id, "   ")).toContain("clue");
    expect(room.submitStory(st.token, st.hand[0].id, "x".repeat(11))).toContain("characters");
    expect(room.submitStory(st.token, st.hand[0].id, "ok")).toBeNull();
  });

  test("only the storyteller can tell, and only with a card they hold", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    room.start(host);
    const stToken = room.storytellerToken!;
    const other = Object.values(tokens).find((t) => t !== stToken)!;
    expect(room.submitStory(other, room.players.get(other)!.hand[0].id, "nope")).toContain("not the storyteller");
    expect(room.submitStory(stToken, "not-a-card", "nope")).toContain("not in your hand");
  });

  test("the table fills, voting opens, scores land and hands refill", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { handSize: 6, revealSeconds: 60 });
    room.start(host);
    playRound(room, tokens, "a sleeping fox");
    expect(room.phase).toBe("REVEAL");
    expect(room.table.length).toBe(4);
    const total = room.seated.reduce((n, p) => n + p.score, 0);
    expect(total).toBeGreaterThan(0);
    expect(room.log[0].clue).toBe("a sleeping fox");
    room.nextRound(host);
    expect(room.phase).toBe("STORYTELLING");
    for (const p of room.seated) expect(p.hand.length).toBe(6);
  });

  test("you cannot vote for your own card, twice, or before voting opens", () => {
    const { room, tokens, host } = mk(["A", "B", "C"]);
    room.start(host);
    const stToken = room.storytellerToken!;
    const voter = Object.values(tokens).find((t) => t !== stToken)!;
    expect(room.vote(voter, "x")).toContain("Not the voting phase");
    const st = room.players.get(stToken)!;
    room.submitStory(stToken, st.hand[0].id, "clue");
    for (const t of Object.values(tokens)) {
      if (t === stToken) continue;
      room.submitCard(t, room.players.get(t)!.hand[0].id);
    }
    expect(room.phase).toBe("VOTING");
    const own = room.table.find((c) => c.ownerToken === voter)!;
    expect(room.vote(voter, own.cardId)).toContain("your own card");
    expect(room.vote(stToken, room.table[0].cardId)).toContain("storyteller does not vote");
    const legal = room.table.find((c) => c.ownerToken !== voter)!;
    expect(room.vote(voter, legal.cardId)).toBeNull();
    expect(room.vote(voter, legal.cardId)).toContain("already voted");
  });

  test("the storyteller rotates to a different player each round", () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { revealSeconds: 60 });
    room.start(host);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(room.storytellerToken!);
      playRound(room, tokens);
      room.nextRound(host);
    }
    expect(new Set(seen).size).toBe(4);
  });

  test("a storyteller who never speaks gets the round skipped, not auto-played", async () => {
    const { room, host } = mk(["A", "B", "C"], { storytellerSeconds: 1, revealSeconds: 60 });
    room.start(host);
    const first = room.storytellerToken;
    await new Promise((r) => setTimeout(r, 1300));
    expect(room.log[0].skipped).toBe(true);
    expect(room.phase).toBe("STORYTELLING");
    expect(room.storytellerToken).not.toBe(first);
    expect(room.seated.every((p) => p.score === 0)).toBe(true);
  });

  test("autoplay fills in missing cards and votes when the clock runs out", async () => {
    const { room, host } = mk(["A", "B", "C"], { submitSeconds: 1, voteSeconds: 1, revealSeconds: 60, autoPlayOnTimeout: true });
    room.start(host);
    const st = room.players.get(room.storytellerToken!)!;
    room.submitStory(st.token, st.hand[0].id, "tick tock");
    await new Promise((r) => setTimeout(r, 2600));
    expect(room.phase).toBe("REVEAL");
    expect(room.table.length).toBe(3);
  });

  test("with autoplay off, a player who misses the window sits the round out", async () => {
    const { room, tokens, host } = mk(["A", "B", "C", "D"], { submitSeconds: 1, voteSeconds: 1, revealSeconds: 60, autoPlayOnTimeout: false });
    room.start(host);
    const stToken = room.storytellerToken!;
    const st = room.players.get(stToken)!;
    room.submitStory(stToken, st.hand[0].id, "quiet");
    const eager = Object.values(tokens).filter((t) => t !== stToken).slice(0, 2);
    for (const t of eager) room.submitCard(t, room.players.get(t)!.hand[0].id);
    await new Promise((r) => setTimeout(r, 2600));
    expect(room.phase).toBe("REVEAL");
    expect(room.table.length).toBe(3);
    const idler = Object.values(tokens).find((t) => t !== stToken && !eager.includes(t))!;
    expect(room.players.get(idler)!.roundDelta).toBe(0);
  });

  test("a round with nothing to vote on is skipped and the cards go home", async () => {
    const { room, host } = mk(["A", "B", "C"], { submitSeconds: 1, autoPlayOnTimeout: false, revealSeconds: 60 });
    room.start(host);
    const st = room.players.get(room.storytellerToken!)!;
    const handBefore = st.hand.length;
    room.submitStory(st.token, st.hand[0].id, "alone");
    await new Promise((r) => setTimeout(r, 1400));
    expect(room.log[0].skipped).toBe(true);
    expect(room.players.get(st.token)!.hand.length).toBe(handBefore);
  });
});

describe("ending", () => {
  test("a points target ends the game and names a winner", () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { endMode: "points", pointsTarget: 5, revealSeconds: 60 });
    room.start(host);
    for (let i = 0; i < 20 && room.phase !== "GAME_OVER"; i++) {
      playRound(room, tokens);
      if (room.phase === "REVEAL") room.nextRound(host);
    }
    expect(room.phase).toBe("GAME_OVER");
    expect(room.winners!.length).toBeGreaterThan(0);
    expect(Math.max(...room.seated.map((p) => p.score))).toBeGreaterThanOrEqual(5);
  });

  test("a rounds target ends on the right round", () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { endMode: "rounds", roundsTarget: 3, pointsTarget: 999, revealSeconds: 60 });
    room.start(host);
    for (let i = 0; i < 10 && room.phase !== "GAME_OVER"; i++) {
      playRound(room, tokens);
      if (room.phase === "REVEAL") room.nextRound(host);
    }
    expect(room.phase).toBe("GAME_OVER");
    expect(room.round).toBe(3);
  });

  test("a thin deck recycles its discards instead of dealing cards that do not exist", () => {
    const tiny = Array.from({ length: 30 }, (_, i) => ({ id: "k" + i, img: "/x.webp" }));
    const small = mk(["A", "B", "C"], {}, tiny);
    expect(small.room.start(small.host)).toContain("Deck too small");

    const { room, tokens, host } = mk(["A", "B", "C"], { endMode: "rounds", roundsTarget: 25, pointsTarget: 999, revealSeconds: 60, handSize: 4 },
      Array.from({ length: 40 }, (_, i) => ({ id: "k" + i, img: "/x.webp" })));
    expect(room.start(host)).toBeNull();
    for (let i = 0; i < 30 && room.phase !== "GAME_OVER"; i++) {
      playRound(room, tokens);
      // every card in play is still unique even though the pile keeps being rebuilt
      const live = [...room.seated.flatMap((p) => p.hand.map((c) => c.id)), ...room.table.map((c) => c.cardId)];
      expect(new Set(live).size).toBe(live.length);
      if (room.phase === "REVEAL") room.nextRound(host);
    }
    expect(room.phase).toBe("GAME_OVER");
    expect(room.round).toBe(25);
    for (const p of room.seated) expect(p.hand.length).toBe(4);
  });

  test("play again clears the slate and seats the spectators", () => {
    const { room, tokens, host } = mk(["A", "B", "C"], { maxPlayers: 4, endMode: "rounds", roundsTarget: 1, revealSeconds: 60 });
    room.start(host);
    const watcher = room.join("Late", "🐸");
    playRound(room, tokens);
    if (room.phase === "REVEAL") room.nextRound(host);
    expect(room.phase).toBe("GAME_OVER");
    expect(room.playAgain(host)).toBeNull();
    expect(room.phase).toBe("LOBBY");
    expect(room.order.length).toBe(4);
    expect(room.players.get(watcher.token!)!.isSpectator).toBe(false);
    expect(room.seated.every((p) => p.score === 0)).toBe(true);
  });
});
