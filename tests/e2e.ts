/**
 * Drives a live server over real sockets: create, join, settings, a full round,
 * a kick, a reconnect. Run with the server already listening.
 *   PORT=3100 bun run server/index.ts &
 *   URL=http://localhost:3100 bun run tests/e2e.ts
 */
import { io, type Socket } from "socket.io-client";
import type { ClientState } from "../shared/types.ts";

const URL = process.env.URL ?? "http://localhost:3100";
let failures = 0;

const ok = (cond: any, msg: string) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures++; console.log(`  FAIL ${msg}`); }
};

interface C {
  s: Socket;
  name: string;
  state: ClientState | null;
  kicked?: string;
  token?: string;
}

function connect(name: string): Promise<C> {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ["websocket"], reconnection: false });
    const c: C = { s, name, state: null };
    s.on("state", (st: ClientState) => { c.state = st; });
    s.on("kicked", (p: any) => { c.kicked = p.reason; });
    s.on("connect", () => resolve(c));
    s.on("connect_error", reject);
    setTimeout(() => reject(new Error("connect timeout for " + name)), 5000);
  });
}

const emit = <T = any>(c: C, ev: string, p: any = {}): Promise<any> =>
  new Promise((res) => {
    const t = setTimeout(() => res({ ok: false, error: "no ack" }), 6000);
    c.s.emit(ev, p, (r: any) => { clearTimeout(t); res(r ?? { ok: true }); });
  });

async function waitFor(c: C, pred: (s: ClientState) => boolean, label: string, ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (c.state && pred(c.state)) return c.state;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timed out waiting for ${label} (${c.name}; phase=${c.state?.phase})`);
}

async function main() {
  console.log(`\ne2e against ${URL}`);

  const info = await (await fetch(`${URL}/api/info`)).json();
  ok(info.cards > 100, `server reports a usable deck (${info.cards} cards)`);
  ok(Array.isArray(info.urls) && info.urls.length > 0, `server advertises a wifi address (${info.urls[0]})`);
  ok(typeof info.qr === "string" && info.qr.startsWith("data:image"), "server renders a join QR");

  const names = ["Ann", "Bob", "Cid", "Dee"];
  const cs: C[] = [];
  for (const n of names) cs.push(await connect(n));
  const [ann, bob, cid, dee] = cs;

  const created = await emit(ann, "room:create", { name: "Ann", avatar: "🦊" });
  ok(created.ok && /^[A-Z0-9]{5}$/.test(created.code), `room created with code ${created.code}`);
  const code = created.code;
  ann.token = created.token;

  for (const c of [bob, cid, dee]) {
    const r = await emit(c, "room:join", { code, name: c.name, avatar: "🐙" });
    c.token = r.token;
    ok(r.ok, `${c.name} joined`);
  }
  await waitFor(ann, (s) => s.players.length === 4, "4 players in the lobby");
  ok(ann.state!.you.isHost, "the creator is host");
  ok(!bob.state!.you.isHost, "a joiner is not host");

  const peek = await (await fetch(`${URL}/api/room/${code}`)).json();
  ok(peek.exists && peek.players === 4, "the room lookup endpoint agrees");

  // settings: host can, guest cannot
  ok((await emit(ann, "room:settings", { patch: { storytellerSeconds: 45, voteSeconds: 25, pointsTarget: 10 } })).ok, "host changed the timers");
  await waitFor(bob, (s) => s.settings.storytellerSeconds === 45, "settings reached the guests");
  const refused = await emit(bob, "room:settings", { patch: { pointsTarget: 99 } });
  ok(!refused.ok, `a guest cannot change settings (${refused.error})`);

  // a guest cannot start the game
  ok(!(await emit(cid, "game:start")).ok, "a guest cannot start the game");
  ok((await emit(ann, "game:start")).ok, "host started the game");
  await waitFor(ann, (s) => s.phase === "STORYTELLING", "storytelling");
  ok(ann.state!.you.hand.length === 6, "a hand of 6 was dealt");
  ok(!!ann.state!.phaseEndsAt, "a phase deadline was published");

  // the hand of one player never shows up in another player's payload
  const annIds = new Set(ann.state!.you.hand.map((c) => c.id));
  const bobBlob = JSON.stringify(bob.state);
  const leaked = [...annIds].filter((id) => new RegExp(`"${id}"|/cards/${id}\\.`).test(bobBlob));
  ok(leaked.length === 0, "no hand leaked across the wire");

  // play a full round
  const teller = cs.find((c) => c.state!.you.isStoryteller)!;
  const others = cs.filter((c) => c !== teller);
  ok(!!teller, `${teller.name} is the storyteller`);
  ok(others.every((c) => c.state!.clue === undefined), "the clue is not visible before it is told");

  const told = await emit(teller, "story:submit", { cardId: teller.state!.you.hand[0].id, clue: "a quiet door" });
  ok(told.ok, "the storyteller told the story");
  await waitFor(bob, (s) => s.phase === "SUBMITTING", "submitting");
  ok(others[0].state!.clue === "a quiet door", "the clue reached everyone");
  ok(others[0].state!.table.length === 0, "the table is face down while cards are played");

  for (const c of others) {
    const r = await emit(c, "card:submit", { cardId: c.state!.you.hand[0].id });
    ok(r.ok, `${c.name} played a card`);
  }
  await waitFor(teller, (s) => s.phase === "VOTING", "voting");
  ok(teller.state!.table.length === 4, "four cards are on the table");

  const voter = others[0];
  const ownCard = voter.state!.table.find((c) => c.ownerId === voter.state!.you.id)!;
  ok(!!ownCard, "a voter can see which card is theirs");
  ok(!(await emit(voter, "vote:cast", { cardId: ownCard.cardId })).ok, "voting for your own card is refused");
  ok(!(await emit(teller, "vote:cast", { cardId: teller.state!.table[0].cardId })).ok, "the storyteller cannot vote");

  for (const c of others) {
    const target = c.state!.table.find((t) => t.ownerId !== c.state!.you.id)!;
    ok((await emit(c, "vote:cast", { cardId: target.cardId })).ok, `${c.name} voted`);
  }
  await waitFor(ann, (s) => s.phase === "REVEAL", "reveal");
  const rev = ann.state!;
  ok(rev.table.every((c) => !!c.ownerName), "owners are revealed");
  ok(rev.table.filter((c) => c.isStorytellerCard).length === 1, "the storyteller's card is marked");
  ok(rev.players.some((p) => p.score > 0), "somebody scored");
  ok(rev.log.length === 1 && rev.log[0].clue === "a quiet door", "the round is in the story log");

  // lifeline over the wire
  await emit(ann, "game:next");
  await waitFor(ann, (s) => s.phase === "STORYTELLING" && s.round === 2, "round 2");
  const burner = cs.find((c) => !c.state!.you.isStoryteller)!;
  const beforeBurn = burner.state!.you.hand.map((c) => c.id);
  const burn = await emit(burner, "lifeline:use", { id: "burn", arg: beforeBurn[0] });
  ok(burn.ok, "Burn worked over the wire");
  await waitFor(burner, (s) => !s.you.hand.some((c) => c.id === beforeBurn[0]), "the burnt card is gone");
  ok(burner.state!.you.lifelinesLeft.burn === 1, "the Burn counter went down");

  // chat
  await emit(bob, "chat:say", { text: "hello table" });
  await waitFor(cid, (s) => s.chat.some((m) => m.text === "hello table"), "chat delivered");
  ok(true, "chat reaches the other players");

  // kick
  const deeId = ann.state!.players.find((p) => p.name === "Dee")!.id;
  ok((await emit(ann, "host:kick", { playerId: deeId })).ok, "host kicked Dee");
  await new Promise((r) => setTimeout(r, 300));
  ok(dee.kicked?.includes("removed"), "the kicked player was told");
  await waitFor(ann, (s) => !s.players.some((p) => p.name === "Dee"), "Dee left the table");
  const back = await emit(dee, "room:join", { code, name: "Dee", avatar: "🐙", token: dee.token });
  ok(!back.ok, `a kicked player cannot rejoin (${back.error})`);

  // reconnect keeps the seat and the hand
  const cidHand = cid.state!.you.hand.map((c) => c.id).sort().join(",");
  cid.s.close();
  await new Promise((r) => setTimeout(r, 300));
  const cid2 = await connect("Cid");
  const rj = await emit(cid2, "room:join", { code, name: "Cid", avatar: "🐙", token: cid.token });
  ok(rj.ok, "a dropped player can rejoin with their token");
  const st = await waitFor(cid2, (s) => s.you.hand.length > 0, "rejoined state");
  ok(st.you.hand.map((c) => c.id).sort().join(",") === cidHand, "the same hand came back");

  for (const c of [ann, bob, dee, cid2]) c.s.close();
  console.log(failures === 0 ? `\nall e2e checks passed\n` : `\n${failures} e2e checks FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("e2e crashed:", e.message); process.exit(1); });
