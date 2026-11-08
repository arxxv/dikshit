import { describe, expect, test } from "bun:test";
import { Room } from "../server/room.ts";
import { fakeCards } from "./helpers.ts";
import { LIFELINES, type LifelineId, type Phase } from "../shared/types.ts";

/**
 * Bots play whole games through the real state machine. A passing unit suite can
 * easily miss a deadlock or a card going missing, so this drives thousands of
 * actions and checks the invariants after every single one.
 */

const PHASES: Phase[] = ["LOBBY", "STORYTELLING", "SUBMITTING", "VOTING", "REVEAL", "GAME_OVER"];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function invariants(room: Room, where: string) {
  expect(PHASES).toContain(room.phase);

  // every card in play is unique: nothing is cloned by a reshuffle, nothing vanishes
  const live = [
    ...[...room.players.values()].flatMap((p) => p.hand.map((c) => c.id)),
    ...room.table.map((c) => c.cardId),
  ];
  if (new Set(live).size !== live.length) throw new Error(`duplicate card in play at ${where}`);

  for (const p of room.seated) {
    expect(p.score).toBeGreaterThanOrEqual(0);
    expect(p.hand.length).toBeLessThanOrEqual(room.settings.handSize);
    for (const l of LIFELINES) {
      expect(p.lifelinesUsed[l.id]).toBeLessThanOrEqual(room.settings.lifelines[l.id]);
    }
  }
  if (room.phase === "VOTING") {
    expect(room.table.length).toBeGreaterThanOrEqual(2);
    // nobody can be left with only their own card to vote for
    for (const p of room.seated) {
      if (p.token === room.storytellerToken || !p.submitted) continue;
      expect(room.table.some((c) => c.ownerToken !== p.token)).toBe(true);
    }
  }
  if (room.phase === "SUBMITTING" || room.phase === "VOTING") {
    expect(room.clue).toBeTruthy();
    expect(room.storytellerCardId).toBeTruthy();
  }
}

function maybeLifeline(room: Room, token: string, chance: number) {
  if (Math.random() > chance) return;
  const p = room.players.get(token)!;
  const id: LifelineId = pick(LIFELINES).id;
  const arg = id === "burn" && p.hand.length ? pick(p.hand).id : undefined;
  room.useLifeline(token, id, arg); // a refusal is a legitimate outcome
}

function playGame(nPlayers: number, lifelineChance: number, dropouts: number) {
  const names = Array.from({ length: nPlayers }, (_, i) => `bot${i}`);
  const room = new Room("SIM", fakeCards(320), {
    endMode: Math.random() < 0.5 ? "points" : "rounds",
    pointsTarget: 12,
    roundsTarget: 6,
    handSize: pick([4, 5, 6, 7]),
    voteCapEnabled: Math.random() < 0.5,
    revealSeconds: 600,              // the host bot advances the reveal itself
    storytellerSeconds: 600,
    submitSeconds: 600,
    voteSeconds: 600,
    lifelines: Object.fromEntries(LIFELINES.map((l) => [l.id, pick([0, 1, 2])])) as any,
  });
  const tokens = names.map((n) => room.join(n, "🤖").token!);
  const host = tokens[0];

  const err = room.start(host);
  if (err) throw new Error("start refused: " + err);
  invariants(room, "start");

  let ticks = 0;
  let dropsLeft = dropouts;
  while (room.phase !== "GAME_OVER") {
    if (++ticks > 4000) throw new Error(`game never finished: stuck in ${room.phase} round ${room.round}`);

    if (dropsLeft > 0 && Math.random() < 0.004) {
      const victim = room.connectedSeated.find((p) => p.token !== host);
      if (victim) { room.disconnect(victim.token); dropsLeft--; invariants(room, "after a dropout"); continue; }
    }

    switch (room.phase) {
      case "STORYTELLING": {
        const st = room.players.get(room.storytellerToken!)!;
        maybeLifeline(room, st.token, lifelineChance);
        if (room.phase !== "STORYTELLING") break;      // Pass the Story restarted the round
        const now = room.players.get(room.storytellerToken!)!;
        const e = room.submitStory(now.token, pick(now.hand).id, `clue ${room.round}`);
        if (e) throw new Error("submitStory refused: " + e);
        break;
      }
      case "SUBMITTING": {
        const next = room.seated.find((p) => p.token !== room.storytellerToken && p.connected && !p.submitted);
        if (!next) throw new Error("SUBMITTING with nobody left to submit: the phase should have advanced");
        maybeLifeline(room, next.token, lifelineChance);
        if (next.submitted || room.phase !== "SUBMITTING") break;
        const e = room.submitCard(next.token, pick(next.hand).id);
        if (e) throw new Error("submitCard refused: " + e);
        break;
      }
      case "VOTING": {
        const next = room.seated.find((p) => p.token !== room.storytellerToken && p.connected && p.submitted && !p.voted);
        if (!next) throw new Error("VOTING with nobody left to vote: the phase should have advanced");
        maybeLifeline(room, next.token, lifelineChance);
        if (next.voted || room.phase !== "VOTING") break;
        const legal = room.table.filter((c) => c.ownerToken !== next.token && c.cardId !== next.halfLight);
        const choice = legal.length ? legal : room.table.filter((c) => c.ownerToken !== next.token);
        const e = room.vote(next.token, pick(choice).cardId);
        if (e) throw new Error("vote refused: " + e);
        break;
      }
      case "REVEAL": {
        const e = room.nextRound(host);
        if (e) throw new Error("nextRound refused: " + e);
        break;
      }
      case "LOBBY":
        throw new Error("the game fell back to the lobby mid-play");
    }
    invariants(room, room.phase);
  }

  expect(room.winners!.length).toBeGreaterThan(0);
  expect(room.log.length).toBeGreaterThan(0);
  room.dispose();
  return { rounds: room.round, ticks };
}

describe("bots playing whole games", () => {
  test("160 clean games across every table size finish without a deadlock", () => {
    let rounds = 0;
    for (let i = 0; i < 160; i++) {
      const n = 3 + (i % 8);            // 3..10 players
      rounds += playGame(n, 0, 0).rounds;
    }
    expect(rounds).toBeGreaterThan(160);
  });

  test("160 games with lifelines flying finish too", () => {
    for (let i = 0; i < 160; i++) playGame(3 + (i % 8), 0.3, 0);
  });

  test("80 games survive players dropping out mid-hand", () => {
    for (let i = 0; i < 80; i++) {
      const n = 4 + (i % 7);
      playGame(n, 0.15, 1 + (i % 3));
    }
  });

  test("a table that empties below three stops instead of spinning", () => {
    const room = new Room("SIM2", fakeCards(200), { revealSeconds: 600, storytellerSeconds: 600, submitSeconds: 600, voteSeconds: 600, pointsTarget: 999, roundsTarget: 99 });
    const tokens = ["a", "b", "c"].map((n) => room.join(n, "🤖").token!);
    expect(room.start(tokens[0])).toBeNull();

    // drop everyone except the storyteller, so there is nobody left who could still act
    const stToken = room.storytellerToken!;
    for (const t of tokens) if (t !== stToken) room.disconnect(t);
    expect(room.connectedSeated.length).toBe(1);

    const st = room.players.get(stToken)!;
    expect(room.submitStory(stToken, st.hand[0].id, "anyone there?")).toBeNull();

    // the hand cannot be voted on, so the round is skipped and the game stops there
    expect(room.phase).toBe("GAME_OVER");
    expect(room.log.at(-1)!.skipped).toBe(true);
    room.dispose();
  });

  test("the last player standing still finishes the hand already in progress", () => {
    const room = new Room("SIM3", fakeCards(200), { revealSeconds: 600, storytellerSeconds: 600, submitSeconds: 600, voteSeconds: 600, pointsTarget: 999, roundsTarget: 99 });
    const tokens = ["a", "b", "c"].map((n) => room.join(n, "🤖").token!);
    expect(room.start(tokens[0])).toBeNull();

    // this time the storyteller is the one who vanishes, leaving one able player
    const stToken = room.storytellerToken!;
    const others = tokens.filter((t) => t !== stToken);
    room.disconnect(others[0]);
    const st = room.players.get(stToken)!;
    room.submitStory(stToken, st.hand[0].id, "still here");
    room.disconnect(stToken);

    // the one remaining player can still play and vote, then the game stops
    const alive = room.players.get(others[1])!;
    if (room.phase === "SUBMITTING") room.submitCard(alive.token, alive.hand[0].id);
    if (room.phase === "VOTING") {
      const legal = room.table.find((c) => c.ownerToken !== alive.token);
      if (legal) room.vote(alive.token, legal.cardId);
    }
    // the host badge may have moved on when players dropped, so ask the current host
    if (room.phase === "REVEAL") expect(room.nextRound(room.hostToken)).toBeNull();
    expect(room.phase).toBe("GAME_OVER");
    room.dispose();
  });
});
