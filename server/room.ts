import { randomUUID } from "node:crypto";
import { Deck, shuffle } from "./deck.ts";
import { scoreRound } from "./scoring.ts";
import {
  DEFAULT_SETTINGS, LIFELINES, MIN_PLAYERS, SETTING_BOUNDS,
  type Award, type CardRef, type ChatMsg, type ClientState, type LifelineId,
  type Phase, type PublicPlayer, type RoundLogEntry, type Settings, type TableCard,
} from "../shared/types.ts";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

export function makeCode(len = 5): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

const zeroUses = (): Record<LifelineId, number> =>
  Object.fromEntries(LIFELINES.map((l) => [l.id, 0])) as Record<LifelineId, number>;

interface Player {
  token: string;
  id: string;
  name: string;
  avatar: string;
  score: number;
  hand: CardRef[];
  connected: boolean;
  socketId?: string;
  isSpectator: boolean;
  lifelinesUsed: Record<LifelineId, number>;
  submitted?: string;
  voted?: string;
  halfLight?: string;
  doubleDown: boolean;
  roundDelta: number;
  joinedAt: number;
  stats: { correct: number; decoyVotes: number; storytellerPts: number; stints: number; clues: number };
}

export interface JoinResult {
  ok: boolean;
  error?: string;
  token?: string;
  status?: "joined" | "pending" | "spectator";
}

export class Room {
  code: string;
  settings: Settings;
  phase: Phase = "LOBBY";
  round = 0;
  hostToken = "";
  players = new Map<string, Player>();
  order: string[] = [];
  deck: Deck;
  storytellerToken?: string;
  stIndex = -1;
  clue?: string;
  storytellerCardId?: string;
  table: { cardId: string; img: string; ownerToken: string }[] = [];
  banned = new Set<string>();
  bannedNames = new Set<string>();
  pending = new Map<string, { token: string; name: string; avatar: string }>();
  chat: ChatMsg[] = [];
  log: RoundLogEntry[] = [];
  reactions: Record<string, string[]> = {};
  phaseEndsAt?: number;
  awards?: Award[];
  winners?: string[];
  lastActivity = Date.now();
  emit: () => void = () => {};
  private timer?: ReturnType<typeof setTimeout>;
  private allCards: CardRef[];

  constructor(code: string, cards: CardRef[], settings?: Partial<Settings>) {
    this.code = code;
    this.allCards = cards;
    this.settings = { ...DEFAULT_SETTINGS, ...settings, lifelines: { ...DEFAULT_SETTINGS.lifelines, ...(settings?.lifelines ?? {}) } };
    this.deck = new Deck(cards);
  }

  // ---------- helpers ----------

  private touch() { this.lastActivity = Date.now(); }
  get seated(): Player[] { return this.order.map((t) => this.players.get(t)!).filter(Boolean); }
  get spectators(): Player[] { return [...this.players.values()].filter((p) => p.isSpectator); }
  get connectedSeated(): Player[] { return this.seated.filter((p) => p.connected); }
  byId(id: string): Player | undefined { return [...this.players.values()].find((p) => p.id === id); }
  get storyteller(): Player | undefined { return this.storytellerToken ? this.players.get(this.storytellerToken) : undefined; }
  get isEmpty(): boolean { return [...this.players.values()].every((p) => !p.connected); }

  private sys(text: string) {
    this.chat.push({ id: randomUUID(), name: "", avatar: "", text, ts: Date.now(), system: true });
    if (this.chat.length > 150) this.chat = this.chat.slice(-150);
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.phaseEndsAt = undefined;
  }

  private arm(seconds: number, fn: () => void) {
    this.clearTimer();
    this.phaseEndsAt = Date.now() + seconds * 1000;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { fn(); } catch (e) { console.error("[timer]", this.code, e); }
      this.emit();
    }, seconds * 1000);
  }

  private rearm(fn: () => void) {
    if (!this.phaseEndsAt) return;
    const ms = Math.max(500, this.phaseEndsAt - Date.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try { fn(); } catch (e) { console.error("[timer]", this.code, e); }
      this.emit();
    }, ms);
  }

  dispose() { this.clearTimer(); }

  // ---------- membership ----------

  join(name: string, avatar: string, token?: string): JoinResult {
    this.touch();
    name = (name || "Player").trim().slice(0, 16);
    if (!name) name = "Player";

    if (token && this.players.has(token)) {
      const p = this.players.get(token)!;
      p.connected = true;
      p.name = name || p.name;
      p.avatar = avatar || p.avatar;
      return { ok: true, token, status: p.isSpectator ? "spectator" : "joined" };
    }
    if (token && this.banned.has(token)) return { ok: false, error: "You were removed from this room." };
    if (this.bannedNames.has(name.toLowerCase())) return { ok: false, error: "That name was removed from this room." };

    const taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) name = `${name}-${Math.floor(Math.random() * 90 + 10)}`;

    const fresh = token && !this.players.has(token) ? token : randomUUID();
    const first = this.players.size === 0;

    if (this.settings.requireApproval && !first) {
      this.pending.set(fresh, { token: fresh, name, avatar });
      this.sys(`${name} is asking to join.`);
      return { ok: true, token: fresh, status: "pending" };
    }

    const asSpectator = !first && (this.phase !== "LOBBY" || this.order.length >= this.settings.maxPlayers);
    this.seat(fresh, name, avatar, asSpectator, first);
    return { ok: true, token: fresh, status: asSpectator ? "spectator" : "joined" };
  }

  private seat(token: string, name: string, avatar: string, spectator: boolean, host: boolean) {
    const p: Player = {
      token, id: randomUUID().slice(0, 8), name, avatar: avatar || "🦊",
      score: 0, hand: [], connected: true, isSpectator: spectator,
      lifelinesUsed: zeroUses(), doubleDown: false, roundDelta: 0, joinedAt: Date.now(),
      stats: { correct: 0, decoyVotes: 0, storytellerPts: 0, stints: 0, clues: 0 },
    };
    this.players.set(token, p);
    if (!spectator) this.order.push(token);
    if (host || !this.hostToken) this.hostToken = token;
    this.sys(spectator ? `${name} is watching.` : `${name} joined.`);
  }

  approve(hostToken: string, pendingId: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    const req = this.pending.get(pendingId);
    if (!req) return "No such request.";
    this.pending.delete(pendingId);
    const spectator = this.phase !== "LOBBY" || this.order.length >= this.settings.maxPlayers;
    this.seat(req.token, req.name, req.avatar, spectator, false);
    return null;
  }

  deny(hostToken: string, pendingId: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    const req = this.pending.get(pendingId);
    if (!req) return "No such request.";
    this.pending.delete(pendingId);
    this.banned.add(req.token);
    this.sys(`${req.name}'s request was declined.`);
    return null;
  }

  kick(hostToken: string, playerId: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    const p = this.byId(playerId);
    if (!p) return "No such player.";
    if (p.token === this.hostToken) return "The host cannot be kicked.";
    this.removePlayer(p.token, true);
    this.sys(`${p.name} was removed by the host.`);
    return null;
  }

  promoteHost(hostToken: string, playerId: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    const p = this.byId(playerId);
    if (!p || p.isSpectator) return "No such player.";
    this.hostToken = p.token;
    this.sys(`${p.name} is now the host.`);
    return null;
  }

  clearBans(hostToken: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    this.banned.clear();
    this.bannedNames.clear();
    this.sys("Removed-player list cleared.");
    return null;
  }

  private removePlayer(token: string, ban: boolean) {
    const p = this.players.get(token);
    if (!p) return;
    if (ban) { this.banned.add(token); this.bannedNames.add(p.name.toLowerCase()); }
    this.deck.discard(p.hand);
    this.table = this.table.filter((c) => c.ownerToken !== token);
    this.players.delete(token);
    const idx = this.order.indexOf(token);
    if (idx >= 0) {
      this.order.splice(idx, 1);
      if (idx <= this.stIndex) this.stIndex--;
    }
    if (this.hostToken === token) this.transferHost();
    if (this.phase !== "LOBBY" && this.phase !== "GAME_OVER") {
      if (this.storytellerToken === token) this.skipRound("the storyteller left");
      else this.maybeAdvance();
    }
  }

  private transferHost() {
    const next = this.connectedSeated[0] ?? this.seated[0] ?? [...this.players.values()][0];
    this.hostToken = next?.token ?? "";
    if (next) this.sys(`${next.name} is now the host.`);
  }

  disconnect(token: string) {
    const p = this.players.get(token);
    if (!p) return;
    p.connected = false;
    p.socketId = undefined;
    this.sys(`${p.name} dropped out.`);
    if (this.phase === "LOBBY") {
      // nobody is mid-game, free the seat straight away
      this.deck.discard(p.hand);
      p.hand = [];
      const idx = this.order.indexOf(token);
      if (idx >= 0) this.order.splice(idx, 1);
      this.players.delete(token);
      if (this.hostToken === token) this.transferHost();
      return;
    }
    if (this.hostToken === token) this.transferHost();
    this.maybeAdvance();
  }

  leave(token: string) {
    const p = this.players.get(token);
    if (!p) return;
    this.sys(`${p.name} left.`);
    this.removePlayer(token, false);
  }

  chatSay(token: string, text: string) {
    const p = this.players.get(token);
    if (!p) return;
    text = (text ?? "").trim().slice(0, 240);
    if (!text) return;
    this.chat.push({ id: randomUUID(), name: p.name, avatar: p.avatar, text, ts: Date.now() });
    if (this.chat.length > 150) this.chat = this.chat.slice(-150);
    this.touch();
  }

  react(token: string, cardId: string, emoji: string) {
    if (this.phase !== "REVEAL" && this.phase !== "GAME_OVER") return;
    if (!this.players.has(token)) return;
    if (!this.table.some((c) => c.cardId === cardId)) return;
    const list = (this.reactions[cardId] ??= []);
    if (list.length < 14) list.push(emoji.slice(0, 4));
  }

  // ---------- settings ----------

  setSettings(hostToken: string, patch: Partial<Settings>): string | null {
    if (hostToken !== this.hostToken) return "Only the host can change settings.";
    const s = this.settings;
    const clampNum = (key: keyof typeof SETTING_BOUNDS, v: number) => {
      const [lo, hi] = SETTING_BOUNDS[key] as unknown as [number, number];
      return Math.max(lo, Math.min(hi, Math.round(v)));
    };
    const lobbyOnly: (keyof Settings)[] = ["maxPlayers", "handSize", "endMode"];
    for (const [k, v] of Object.entries(patch) as [keyof Settings, any][]) {
      if (v === undefined || v === null) continue;
      if (this.phase !== "LOBBY" && lobbyOnly.includes(k)) continue;
      switch (k) {
        case "maxPlayers": case "storytellerSeconds": case "submitSeconds": case "voteSeconds":
        case "revealSeconds": case "pointsTarget": case "roundsTarget": case "handSize":
        case "clueMaxLength":
          (s as any)[k] = clampNum(k as any, Number(v)); break;
        case "endMode":
          if (v === "points" || v === "rounds") s.endMode = v; break;
        case "voteCapEnabled": case "autoPlayOnTimeout": case "requireApproval":
          (s as any)[k] = Boolean(v); break;
        case "lifelines": {
          const [lo, hi] = SETTING_BOUNDS.lifeline as unknown as [number, number];
          for (const l of LIFELINES) {
            const got = (v as any)[l.id];
            if (got !== undefined) s.lifelines[l.id] = Math.max(lo, Math.min(hi, Math.round(Number(got) || 0)));
          }
          break;
        }
      }
    }
    if (s.maxPlayers < this.order.length) s.maxPlayers = this.order.length;
    this.touch();
    return null;
  }

  // ---------- game flow ----------

  start(hostToken: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can start the game.";
    if (this.phase !== "LOBBY" && this.phase !== "GAME_OVER") return "Game already running.";
    const seats = this.connectedSeated;
    if (seats.length < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players.`;
    const need = seats.length * this.settings.handSize + 20;
    if (this.deck.total < need) return `Deck too small: need about ${need} cards, have ${this.deck.total}.`;

    this.deck = new Deck(this.allCards);
    this.round = 0;
    this.log = [];
    this.awards = undefined;
    this.winners = undefined;
    for (const p of this.players.values()) {
      p.score = 0; p.hand = []; p.roundDelta = 0; p.doubleDown = false;
      p.submitted = undefined; p.voted = undefined; p.halfLight = undefined;
      p.lifelinesUsed = zeroUses();
      p.stats = { correct: 0, decoyVotes: 0, storytellerPts: 0, stints: 0, clues: 0 };
      if (!p.isSpectator) p.hand = this.deck.draw(this.settings.handSize);
    }
    this.stIndex = Math.floor(Math.random() * this.order.length) - 1;
    this.sys("Game on. Good luck.");
    this.beginRound();
    return null;
  }

  private beginRound() {
    this.round++;
    this.clue = undefined;
    this.storytellerCardId = undefined;
    this.table = [];
    this.reactions = {};
    for (const p of this.players.values()) {
      p.submitted = undefined; p.voted = undefined; p.halfLight = undefined;
      p.doubleDown = false; p.roundDelta = 0;
    }
    // next connected storyteller
    const n = this.order.length;
    if (!n) { this.phase = "LOBBY"; return; }
    // too few people left to play: stop with the scores as they stand rather than
    // spinning through rounds that can never be voted on
    if (this.connectedSeated.length < MIN_PLAYERS) { this.endShort(); return; }
    let found: string | undefined;
    for (let i = 1; i <= n; i++) {
      const idx = (this.stIndex + i + n * 2) % n;
      const cand = this.players.get(this.order[idx]);
      if (cand?.connected && !cand.isSpectator) { this.stIndex = idx; found = cand.token; break; }
    }
    if (!found) { this.phase = "LOBBY"; this.clearTimer(); this.sys("Nobody left to tell a story."); return; }
    this.storytellerToken = found;
    const st = this.players.get(found)!;
    st.stats.stints++;
    this.topUpHands();
    this.phase = "STORYTELLING";
    this.arm(this.settings.storytellerSeconds, () => this.onStorytellerTimeout());
  }

  private topUpHands() {
    for (const p of this.seated) {
      const missing = this.settings.handSize - p.hand.length;
      if (missing > 0) p.hand.push(...this.deck.draw(missing));
    }
  }

  private onStorytellerTimeout() {
    // a round with no clue is unplayable, so it is always skipped rather than auto-played
    this.skipRound("the storyteller ran out of time");
  }

  private skipRound(why: string) {
    this.clearTimer();
    this.returnTableCards();
    this.log.push({
      round: this.round, storytellerName: this.storyteller?.name ?? "?",
      clue: this.clue ?? "", storytellerCardImg: "", guessedRight: [], skipped: true, note: why,
    });
    this.sys(`Round ${this.round} skipped: ${why}.`);
    if (this.checkEnd()) return;
    this.beginRound();
  }

  private returnTableCards() {
    for (const c of this.table) {
      const owner = this.players.get(c.ownerToken);
      if (owner) owner.hand.push({ id: c.cardId, img: c.img });
      else this.deck.discard([{ id: c.cardId, img: c.img }]);
    }
    this.table = [];
  }

  submitStory(token: string, cardId: string, clue: string): string | null {
    if (this.phase !== "STORYTELLING") return "Not the storytelling phase.";
    if (token !== this.storytellerToken) return "You are not the storyteller.";
    const p = this.players.get(token)!;
    const card = p.hand.find((c) => c.id === cardId);
    if (!card) return "That card is not in your hand.";
    clue = (clue ?? "").trim().replace(/\s+/g, " ");
    if (!clue) return "Give a clue first.";
    if (clue.length > this.settings.clueMaxLength) return `Clue must be ${this.settings.clueMaxLength} characters or fewer.`;
    this.clue = clue;
    p.stats.clues++;
    p.hand = p.hand.filter((c) => c.id !== cardId);
    p.submitted = cardId;
    this.storytellerCardId = cardId;
    this.table = [{ cardId: card.id, img: card.img, ownerToken: token }];
    this.phase = "SUBMITTING";
    this.touch();
    this.arm(this.settings.submitSeconds, () => this.onSubmitTimeout());
    // if there is nobody left to play a card, move on now rather than burning the clock
    this.maybeAdvance();
    return null;
  }

  submitCard(token: string, cardId: string): string | null {
    if (this.phase !== "SUBMITTING") return "Not the card-picking phase.";
    if (token === this.storytellerToken) return "You already played your card.";
    const p = this.players.get(token);
    if (!p || p.isSpectator) return "Spectators cannot play.";
    if (p.submitted) return "You already played a card.";
    const card = p.hand.find((c) => c.id === cardId);
    if (!card) return "That card is not in your hand.";
    p.hand = p.hand.filter((c) => c.id !== cardId);
    p.submitted = cardId;
    this.table.push({ cardId: card.id, img: card.img, ownerToken: token });
    this.touch();
    this.maybeAdvance();
    return null;
  }

  private onSubmitTimeout() {
    if (this.settings.autoPlayOnTimeout) {
      for (const p of this.seated) {
        if (p.token === this.storytellerToken || p.submitted || !p.connected || !p.hand.length) continue;
        const pick = p.hand[Math.floor(Math.random() * p.hand.length)];
        p.hand = p.hand.filter((c) => c.id !== pick.id);
        p.submitted = pick.id;
        this.table.push({ cardId: pick.id, img: pick.img, ownerToken: p.token });
      }
      this.sys("Time up: missing cards were played at random.");
    } else {
      this.sys("Time up: players without a card sit this round out.");
    }
    this.startVoting();
  }

  private startVoting() {
    this.clearTimer();
    if (this.table.length < 2) { this.skipRound("not enough cards were played"); return; }
    shuffle(this.table);
    this.phase = "VOTING";
    this.arm(this.settings.voteSeconds, () => this.onVoteTimeout());
  }

  vote(token: string, cardId: string): string | null {
    if (this.phase !== "VOTING") return "Not the voting phase.";
    if (token === this.storytellerToken) return "The storyteller does not vote.";
    const p = this.players.get(token);
    if (!p || p.isSpectator) return "Spectators cannot vote.";
    if (!p.submitted) return "You sat this round out.";
    if (p.voted) return "You already voted.";
    const card = this.table.find((c) => c.cardId === cardId);
    if (!card) return "No such card on the table.";
    if (card.ownerToken === token) return "You cannot vote for your own card.";
    p.voted = cardId;
    this.touch();
    this.maybeAdvance();
    return null;
  }

  private onVoteTimeout() {
    if (this.settings.autoPlayOnTimeout) {
      for (const p of this.eligibleVoters()) {
        if (p.voted || !p.connected) continue;
        const legal = this.table.filter((c) => c.ownerToken !== p.token);
        if (!legal.length) continue;
        p.voted = legal[Math.floor(Math.random() * legal.length)].cardId;
      }
      this.sys("Time up: missing votes were cast at random.");
    } else {
      this.sys("Time up: missing votes scored nothing.");
    }
    this.finishVoting();
  }

  private eligibleVoters(): Player[] {
    return this.seated.filter((p) => p.token !== this.storytellerToken && !!p.submitted);
  }

  private maybeAdvance() {
    if (this.phase === "SUBMITTING") {
      const waiting = this.seated.filter((p) => p.token !== this.storytellerToken && p.connected && !p.submitted);
      if (!waiting.length) this.startVoting();
    } else if (this.phase === "VOTING") {
      const waiting = this.eligibleVoters().filter((p) => p.connected && !p.voted);
      if (!waiting.length) this.finishVoting();
    }
  }

  private finishVoting() {
    this.clearTimer();
    const st = this.storyteller;
    if (!st || !this.storytellerCardId) { this.skipRound("the storyteller vanished"); return; }

    const voters = this.eligibleVoters();
    const votes: Record<string, string> = {};
    for (const v of voters) if (v.voted) votes[v.token] = v.voted;

    const res = scoreRound({
      storytellerId: st.token,
      storytellerCardId: this.storytellerCardId,
      table: this.table.map((c) => ({ cardId: c.cardId, ownerId: c.ownerToken })),
      votes,
      eligibleVoters: voters.map((v) => v.token),
      voteCapEnabled: this.settings.voteCapEnabled,
      doubleDown: this.seated.filter((p) => p.doubleDown).map((p) => p.token),
    });

    for (const [tok, d] of Object.entries(res.delta)) {
      const p = this.players.get(tok);
      if (!p) continue;
      p.roundDelta = d;
      p.score = Math.max(0, p.score + d);
    }
    st.stats.storytellerPts += res.delta[st.token] ?? 0;
    for (const tok of res.correct) {
      const p = this.players.get(tok);
      if (p) p.stats.correct++;
    }
    for (const c of this.table) {
      if (c.ownerToken === st.token) continue;
      const owner = this.players.get(c.ownerToken);
      if (owner) owner.stats.decoyVotes += res.votesPerCard[c.cardId]?.length ?? 0;
    }

    const stCard = this.table.find((c) => c.cardId === this.storytellerCardId);
    this.log.push({
      round: this.round,
      storytellerName: st.name,
      clue: this.clue ?? "",
      storytellerCardImg: stCard?.img ?? "",
      guessedRight: res.correct.map((t) => this.players.get(t)?.name ?? "?"),
    });

    this.votesPerCardCache = res.votesPerCard;
    this.phase = "REVEAL";
    this.arm(this.settings.revealSeconds, () => this.endRound());
  }

  private votesPerCardCache: Record<string, string[]> = {};

  nextRound(hostToken: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    if (this.phase !== "REVEAL") return "Nothing to advance.";
    this.endRound();
    return null;
  }

  private endRound() {
    this.clearTimer();
    this.deck.discard(this.table.map((c) => ({ id: c.cardId, img: c.img })));
    this.table = [];
    this.topUpHands();
    if (this.checkEnd()) return;
    this.beginRound();
  }

  private endShort() {
    this.clearTimer();
    this.phase = "GAME_OVER";
    const best = Math.max(0, ...this.seated.map((p) => p.score));
    this.winners = this.seated.filter((p) => p.score === best).map((p) => p.name);
    this.awards = this.buildAwards();
    this.sys(`Too few players left. Stopping here with the scores as they stand.`);
  }

  private checkEnd(): boolean {
    const s = this.settings;
    const leaders = this.seated.filter((p) => p.score >= s.pointsTarget);
    const reachedPoints = s.endMode === "points" && leaders.length > 0;
    const reachedRounds = s.endMode === "rounds" && this.round >= s.roundsTarget;
    const dry = this.deck.total < this.seated.length + 2;
    if (!reachedPoints && !reachedRounds && !dry) return false;

    this.clearTimer();
    this.phase = "GAME_OVER";
    const best = Math.max(0, ...this.seated.map((p) => p.score));
    this.winners = this.seated.filter((p) => p.score === best).map((p) => p.name);
    this.awards = this.buildAwards();
    this.sys(dry && !reachedPoints && !reachedRounds ? "Deck ran out. Final scores:" : "That's the game.");
    return true;
  }

  private buildAwards(): Award[] {
    const out: Award[] = [];
    const top = (fn: (p: Player) => number) => {
      const list = this.seated.filter((p) => fn(p) > 0).sort((a, b) => fn(b) - fn(a));
      return list[0];
    };
    const sharp = top((p) => p.stats.correct);
    if (sharp) out.push({ icon: "🎯", label: "Sharpest guesser", who: sharp.name, detail: `${sharp.stats.correct} correct reads` });
    const trick = top((p) => p.stats.decoyVotes);
    if (trick) out.push({ icon: "🎭", label: "Master of disguise", who: trick.name, detail: `${trick.stats.decoyVotes} votes stolen by decoys` });
    const teller = top((p) => p.stats.storytellerPts);
    if (teller) out.push({ icon: "📖", label: "Best storyteller", who: teller.name, detail: `${teller.stats.storytellerPts} points while telling` });
    return out;
  }

  playAgain(hostToken: string): string | null {
    if (hostToken !== this.hostToken) return "Only the host can do that.";
    this.clearTimer();
    this.phase = "LOBBY";
    this.round = 0;
    this.table = [];
    this.log = [];
    this.awards = undefined;
    this.winners = undefined;
    this.storytellerToken = undefined;
    this.stIndex = -1;
    for (const p of this.players.values()) {
      p.score = 0; p.roundDelta = 0; p.hand = []; p.submitted = undefined;
      p.voted = undefined; p.halfLight = undefined; p.doubleDown = false;
      p.lifelinesUsed = zeroUses();
    }
    // spectators get first refusal on the free seats
    for (const p of this.spectators) {
      if (this.order.length >= this.settings.maxPlayers) break;
      p.isSpectator = false;
      this.order.push(p.token);
      this.sys(`${p.name} takes a seat.`);
    }
    this.deck = new Deck(this.allCards);
    return null;
  }

  // ---------- lifelines ----------

  private budget(p: Player, id: LifelineId): number {
    return (this.settings.lifelines[id] ?? 0) - (p.lifelinesUsed[id] ?? 0);
  }

  useLifeline(token: string, id: LifelineId, arg?: string): string | null {
    const p = this.players.get(token);
    if (!p) return "Not in this room.";
    if (p.isSpectator) return "Spectators have no lifelines.";
    if (!LIFELINES.some((l) => l.id === id)) return "Unknown lifeline.";
    if (this.settings.lifelines[id] <= 0) return "That lifeline is switched off for this room.";
    if (this.budget(p, id) <= 0) return "You have used all of those.";

    const beforeSubmit = (this.phase === "STORYTELLING" || this.phase === "SUBMITTING") && !p.submitted;

    switch (id) {
      case "burn": {
        if (!beforeSubmit) return "Only usable before you play a card.";
        const card = p.hand.find((c) => c.id === arg);
        if (!card) return "That card is not in your hand.";
        p.hand = p.hand.filter((c) => c.id !== card.id);
        this.deck.discard([card]);
        p.hand.push(...this.deck.draw(1));
        break;
      }
      case "freshHand": {
        if (!beforeSubmit) return "Only usable before you play a card.";
        const n = p.hand.length;
        this.deck.discard(p.hand);
        p.hand = this.deck.draw(n || this.settings.handSize);
        this.sys(`${p.name} redrew their whole hand.`);
        break;
      }
      case "halfLight": {
        if (this.phase !== "VOTING") return "Only usable while voting.";
        if (p.token === this.storytellerToken) return "The storyteller does not vote.";
        if (p.voted) return "You already voted.";
        if (p.halfLight) return "Already used this round.";
        const decoys = this.table.filter((c) => c.cardId !== this.storytellerCardId && c.ownerToken !== p.token);
        if (!decoys.length) return "No card can be ruled out this round.";
        p.halfLight = decoys[Math.floor(Math.random() * decoys.length)].cardId;
        break;
      }
      case "stall": {
        if (!this.phaseEndsAt || !["STORYTELLING", "SUBMITTING", "VOTING"].includes(this.phase)) return "Nothing to stall right now.";
        this.phaseEndsAt += 30_000;
        const phase = this.phase;
        this.rearm(() => {
          if (phase === "STORYTELLING") this.onStorytellerTimeout();
          else if (phase === "SUBMITTING") this.onSubmitTimeout();
          else this.onVoteTimeout();
        });
        this.sys(`${p.name} stalled for 30 more seconds.`);
        break;
      }
      case "doubleDown": {
        if (this.phase !== "VOTING") return "Only usable while voting.";
        if (p.token === this.storytellerToken) return "The storyteller does not vote.";
        if (p.voted) return "Declare it before you vote.";
        if (!p.submitted) return "You sat this round out.";
        p.doubleDown = true;
        this.sys(`${p.name} doubled down.`);
        break;
      }
      case "passStory": {
        if (this.phase !== "STORYTELLING") return "Only usable while you hold the story.";
        if (p.token !== this.storytellerToken) return "You are not the storyteller.";
        if (this.connectedSeated.length < MIN_PLAYERS) return "Not enough players to pass to.";
        this.deck.discard(p.hand);
        p.hand = this.deck.draw(this.settings.handSize);
        p.lifelinesUsed[id]++;
        this.sys(`${p.name} passed the story on and redrew.`);
        this.clearTimer();
        this.round--;          // beginRound will bump it back
        this.beginRound();
        this.touch();
        return null;
      }
    }
    p.lifelinesUsed[id]++;
    this.touch();
    return null;
  }

  // ---------- redacted per-player view ----------

  private publicPlayer(p: Player): PublicPlayer {
    const left = Object.fromEntries(
      LIFELINES.map((l) => [l.id, Math.max(0, (this.settings.lifelines[l.id] ?? 0) - (p.lifelinesUsed[l.id] ?? 0))])
    ) as Record<LifelineId, number>;
    return {
      id: p.id, name: p.name, avatar: p.avatar, score: p.score,
      connected: p.connected, isHost: p.token === this.hostToken, isSpectator: p.isSpectator,
      handCount: p.hand.length, hasSubmitted: !!p.submitted, hasVoted: !!p.voted,
      isStoryteller: p.token === this.storytellerToken,
      lifelinesLeft: left, roundDelta: p.roundDelta, doubleDown: p.doubleDown,
    };
  }

  view(token: string): ClientState {
    const me = this.players.get(token);
    const revealed = this.phase === "REVEAL" || this.phase === "GAME_OVER";
    const voting = this.phase === "VOTING";

    let table: TableCard[] = [];
    if (revealed) {
      table = this.table.map((c) => ({
        cardId: c.cardId, img: c.img,
        ownerId: this.players.get(c.ownerToken)?.id,
        ownerName: this.players.get(c.ownerToken)?.name ?? "(gone)",
        isStorytellerCard: c.cardId === this.storytellerCardId,
        voters: (this.votesPerCardCache[c.cardId] ?? []).map((t) => {
          const v = this.players.get(t);
          return { id: v?.id ?? t, name: v?.name ?? "?", avatar: v?.avatar ?? "👤" };
        }),
      }));
    } else if (voting) {
      // owners stay hidden; only the viewer's own card is flagged back to them
      table = this.table.map((c) => ({
        cardId: c.cardId, img: c.img,
        ownerId: me && c.ownerToken === me.token ? me.id : undefined,
      }));
    }

    const seated = this.seated.map((p) => this.publicPlayer(p));
    const voters = this.eligibleVoters();

    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      settings: this.settings,
      players: seated,
      spectators: this.spectators.map((p) => this.publicPlayer(p)),
      pending: token === this.hostToken ? [...this.pending.values()].map((r) => ({ id: r.token, name: r.name, avatar: r.avatar })) : [],
      you: {
        id: me?.id ?? "",
        name: me?.name ?? "",
        isHost: token === this.hostToken,
        isSpectator: me?.isSpectator ?? true,
        hand: me && !me.isSpectator ? me.hand : [],
        lifelinesLeft: me
          ? (Object.fromEntries(LIFELINES.map((l) => [l.id, Math.max(0, (this.settings.lifelines[l.id] ?? 0) - (me.lifelinesUsed[l.id] ?? 0))])) as Record<LifelineId, number>)
          : zeroUses(),
        halfLightExcluded: voting ? me?.halfLight : undefined,
        doubleDown: me?.doubleDown ?? false,
        submittedCardId: me?.submitted,
        votedCardId: me?.voted,
        isStoryteller: !!me && me.token === this.storytellerToken,
      },
      storytellerId: this.storyteller?.id,
      clue: this.phase === "STORYTELLING" ? undefined : this.clue,
      table,
      submittedCount: this.table.length,
      expectedSubmissions: this.connectedSeated.filter((p) => p.token !== this.storytellerToken).length + (this.clue ? 1 : 0),
      votedCount: voters.filter((p) => p.voted).length,
      expectedVotes: voters.length,
      phaseEndsAt: this.phaseEndsAt,
      deckLeft: this.deck.left,
      log: this.log,
      chat: this.chat,
      awards: this.awards,
      winners: this.winners,
      bans: this.banned.size,
      reactions: this.reactions,
    };
  }
}
