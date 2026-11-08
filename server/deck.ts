import type { CardRef } from "../shared/types.ts";

export function shuffle<T>(a: T[], rnd: () => number = Math.random): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Draw pile + discard pile. When the draw pile runs dry the discards are reshuffled in. */
export class Deck {
  private pile: CardRef[];
  private discarded: CardRef[] = [];

  constructor(all: CardRef[], private rnd: () => number = Math.random) {
    this.pile = shuffle([...all], rnd);
  }

  get left() { return this.pile.length; }
  get total() { return this.pile.length + this.discarded.length; }

  draw(n: number): CardRef[] {
    const out: CardRef[] = [];
    for (let i = 0; i < n; i++) {
      if (!this.pile.length) {
        if (!this.discarded.length) break;
        this.pile = shuffle(this.discarded, this.rnd);
        this.discarded = [];
      }
      out.push(this.pile.pop()!);
    }
    return out;
  }

  discard(cards: CardRef[]) { this.discarded.push(...cards); }
}
