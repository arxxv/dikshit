import { expect, test, describe } from "bun:test";
import { scoreRound } from "../server/scoring.ts";

const base = {
  storytellerId: "ST",
  storytellerCardId: "s1",
  table: [
    { cardId: "s1", ownerId: "ST" },
    { cardId: "a1", ownerId: "A" },
    { cardId: "b1", ownerId: "B" },
    { cardId: "c1", ownerId: "C" },
  ],
  eligibleVoters: ["A", "B", "C"],
  voteCapEnabled: true,
  doubleDown: [] as string[],
};

describe("round scoring", () => {
  test("nobody finds the storyteller: storyteller 0, everyone else 2", () => {
    const r = scoreRound({ ...base, votes: { A: "b1", B: "c1", C: "a1" } });
    expect(r.correct).toEqual([]);
    expect(r.delta.ST).toBe(0);
    // 2 for the miss, plus 1 for the single vote each decoy drew
    expect(r.delta.A).toBe(3);
    expect(r.delta.B).toBe(3);
    expect(r.delta.C).toBe(3);
  });

  test("everybody finds it: storyteller 0, everyone else 2 and no decoy votes exist", () => {
    const r = scoreRound({ ...base, votes: { A: "s1", B: "s1", C: "s1" } });
    expect(r.correct.sort()).toEqual(["A", "B", "C"]);
    expect(r.delta.ST).toBe(0);
    expect(r.delta.A).toBe(2);
  });

  test("some find it: storyteller 3, finders 3, decoy owner takes the stray vote", () => {
    const r = scoreRound({ ...base, votes: { A: "s1", B: "s1", C: "a1" } });
    expect(r.delta.ST).toBe(3);
    expect(r.delta.A).toBe(3 + 1);
    expect(r.delta.B).toBe(3);
    expect(r.delta.C).toBe(0);
  });

  test("decoy points cap at 3 when enabled and run free when not", () => {
    const wide = {
      ...base,
      eligibleVoters: ["A", "B", "C", "D", "E"],
      table: [...base.table, { cardId: "d1", ownerId: "D" }, { cardId: "e1", ownerId: "E" }],
      votes: { A: "s1", B: "a1", C: "a1", D: "a1", E: "a1" },
    };
    // A voted correctly (+3) and A's decoy drew 4 votes: capped 3, uncapped 4
    expect(scoreRound({ ...wide, voteCapEnabled: true }).delta.A).toBe(3 + 3);
    expect(scoreRound({ ...wide, voteCapEnabled: false }).delta.A).toBe(3 + 4);
  });

  test("the storyteller never earns decoy points for their own card", () => {
    const r = scoreRound({ ...base, votes: { A: "s1", B: "s1", C: "b1" } });
    expect(r.delta.ST).toBe(3);
  });

  test("double down pays 2 on a hit and costs 1 on a miss", () => {
    const hit = scoreRound({ ...base, votes: { A: "s1", B: "a1", C: "a1" }, doubleDown: ["A"] });
    expect(hit.delta.A).toBe(3 + 2 + 2);
    const miss = scoreRound({ ...base, votes: { A: "b1", B: "s1", C: "s1" }, doubleDown: ["A"] });
    expect(miss.delta.A).toBe(0 - 1);
  });

  test("a missing vote counts as wrong, so it blocks the everybody-found branch", () => {
    const r = scoreRound({ ...base, votes: { A: "s1", B: "s1" } });
    expect(r.correct.sort()).toEqual(["A", "B"]);
    expect(r.delta.ST).toBe(3);
    expect(r.delta.C).toBe(0);
  });

  test("votes are tallied per card", () => {
    const r = scoreRound({ ...base, votes: { A: "b1", B: "b1", C: "s1" } });
    expect(r.votesPerCard.b1.sort()).toEqual(["A", "B"]);
    expect(r.votesPerCard.s1).toEqual(["C"]);
  });
});
