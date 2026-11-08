import express from "express";
import { createServer } from "node:http";
import { Server, type Socket } from "socket.io";
import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import QRCode from "qrcode";
import { Room, makeCode } from "./room.ts";
import type { CardRef, LifelineId, Settings } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const PORT = Number(process.env.PORT ?? 3000);
const MANIFEST = path.join(ROOT, "data", "cards.manifest.json");

// ---------- deck ----------
function loadCards(): CardRef[] {
  if (!existsSync(MANIFEST)) {
    console.error(`No card manifest at ${MANIFEST}\nRun:  bun run cards`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
  const cards: CardRef[] = (raw.cards ?? [])
    .filter((c: any) => c?.id && c?.file && existsSync(path.join(ROOT, "public", c.file)))
    .map((c: any) => ({ id: c.id, img: "/" + c.file.replace(/^\/+/, "") }));
  if (cards.length < 60) {
    console.error(`Only ${cards.length} cards usable. Run:  bun run cards`);
    process.exit(1);
  }
  return cards;
}
const CARDS = loadCards();
const CREDITS = (() => {
  try {
    const raw = JSON.parse(readFileSync(MANIFEST, "utf8"));
    return (raw.cards ?? []).map((c: any) => ({ title: c.title, artist: c.artist, license: c.license, source: c.source }));
  } catch { return []; }
})();

// ---------- rooms ----------
const rooms = new Map<string, Room>();
/** code -> socketId -> player token */
const sockets = new Map<string, Map<string, string>>();

function freshCode(): string {
  for (let i = 0; i < 50; i++) {
    const c = makeCode(5);
    if (!rooms.has(c)) return c;
  }
  return makeCode(7);
}

function registry(code: string) {
  let m = sockets.get(code);
  if (!m) { m = new Map(); sockets.set(code, m); }
  return m;
}

function broadcast(code: string) {
  const room = rooms.get(code);
  if (!room) return;
  for (const [sid, token] of registry(code)) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    if (room.players.has(token)) s.emit("state", room.view(token));
    else if (room.pending.has(token)) s.emit("pending", { code, name: room.pending.get(token)!.name });
  }
}

function bindRoom(room: Room) {
  room.emit = () => broadcast(room.code);
  rooms.set(room.code, room);
  return room;
}

// ---------- http ----------
const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: true }, pingTimeout: 25000 });

app.use("/cards", express.static(path.join(ROOT, "public", "cards"), { maxAge: "7d", immutable: true }));

const DIST = path.join(ROOT, "dist");
if (existsSync(DIST)) app.use(express.static(DIST));

function lanUrls(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(`http://${ni.address}:${PORT}`);
    }
  }
  return out;
}

app.get("/api/info", async (_req, res) => {
  const urls = lanUrls();
  let qr: string | null = null;
  try { if (urls[0]) qr = await QRCode.toDataURL(urls[0], { margin: 1, width: 240 }); } catch {}
  res.json({ cards: CARDS.length, urls, qr, rooms: rooms.size });
});

app.get("/api/qr", async (req, res) => {
  const url = String(req.query.url ?? "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "bad url" });
  try {
    res.json({ qr: await QRCode.toDataURL(url, { margin: 1, width: 260 }) });
  } catch { res.status(500).json({ error: "qr failed" }); }
});

app.get("/api/credits", (_req, res) => res.json({ count: CREDITS.length, items: CREDITS }));

app.get("/api/room/:code", (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ exists: false });
  res.json({
    exists: true, phase: room.phase, players: room.order.length,
    maxPlayers: room.settings.maxPlayers, requireApproval: room.settings.requireApproval,
  });
});

if (existsSync(DIST)) {
  app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));
}

// ---------- sockets ----------
type Ack = (r: any) => void;
const ok = (ack?: Ack, extra: any = {}) => ack?.({ ok: true, ...extra });
const fail = (ack?: Ack, error = "Something went wrong") => ack?.({ ok: false, error });

function attach(socket: Socket, code: string, token: string) {
  socket.data.code = code;
  socket.data.token = token;
  socket.join(code);
  registry(code).set(socket.id, token);
  const room = rooms.get(code);
  const p = room?.players.get(token);
  if (p) p.socketId = socket.id;
}

io.on("connection", (socket) => {
  const myRoom = (): Room | undefined => (socket.data.code ? rooms.get(socket.data.code) : undefined);
  const myToken = (): string => socket.data.token ?? "";

  const act = (fn: (room: Room, token: string) => string | null | undefined, ack?: Ack) => {
    const room = myRoom();
    if (!room) return fail(ack, "You are not in a room.");
    const err = fn(room, myToken());
    broadcast(room.code);
    if (err) return fail(ack, err);
    ok(ack);
  };

  socket.on("room:create", (p: { name?: string; avatar?: string; settings?: Partial<Settings> }, ack?: Ack) => {
    const code = freshCode();
    const room = bindRoom(new Room(code, CARDS, p?.settings));
    const r = room.join(p?.name ?? "Host", p?.avatar ?? "🦊");
    if (!r.ok || !r.token) { rooms.delete(code); return fail(ack, r.error); }
    attach(socket, code, r.token);
    ok(ack, { code, token: r.token, status: r.status });
    broadcast(code);
  });

  socket.on("room:join", (p: { code?: string; name?: string; avatar?: string; token?: string }, ack?: Ack) => {
    const code = String(p?.code ?? "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return fail(ack, "No room with that code.");
    const r = room.join(p?.name ?? "Player", p?.avatar ?? "🦊", p?.token);
    if (!r.ok || !r.token) return fail(ack, r.error);
    attach(socket, code, r.token);
    ok(ack, { code, token: r.token, status: r.status });
    broadcast(code);
  });

  socket.on("room:leave", (_p: any, ack?: Ack) => {
    const room = myRoom();
    if (room) {
      room.leave(myToken());
      registry(room.code).delete(socket.id);
      socket.leave(room.code);
      broadcast(room.code);
    }
    socket.data.code = undefined;
    socket.data.token = undefined;
    ok(ack);
  });

  socket.on("room:settings", (p: { patch?: Partial<Settings> }, ack?: Ack) =>
    act((r, t) => r.setSettings(t, p?.patch ?? {}), ack));

  socket.on("host:kick", (p: { playerId?: string }, ack?: Ack) => {
    const room = myRoom();
    if (!room) return fail(ack, "You are not in a room.");
    const victim = room.byId(String(p?.playerId ?? ""));
    const victimSocket = victim?.socketId;
    const err = room.kick(myToken(), String(p?.playerId ?? ""));
    if (!err && victimSocket) {
      const s = io.sockets.sockets.get(victimSocket);
      registry(room.code).delete(victimSocket);
      s?.emit("kicked", { reason: "The host removed you from the room." });
      s?.leave(room.code);
      if (s) { s.data.code = undefined; s.data.token = undefined; }
    }
    broadcast(room.code);
    return err ? fail(ack, err) : ok(ack);
  });

  socket.on("host:promote", (p: { playerId?: string }, ack?: Ack) => act((r, t) => r.promoteHost(t, String(p?.playerId ?? "")), ack));
  socket.on("host:approve", (p: { id?: string }, ack?: Ack) => act((r, t) => r.approve(t, String(p?.id ?? "")), ack));
  socket.on("host:deny", (p: { id?: string }, ack?: Ack) => act((r, t) => r.deny(t, String(p?.id ?? "")), ack));
  socket.on("host:clearBans", (_p: any, ack?: Ack) => act((r, t) => r.clearBans(t), ack));

  socket.on("game:start", (_p: any, ack?: Ack) => act((r, t) => r.start(t), ack));
  socket.on("game:next", (_p: any, ack?: Ack) => act((r, t) => r.nextRound(t), ack));
  socket.on("game:again", (_p: any, ack?: Ack) => act((r, t) => r.playAgain(t), ack));

  socket.on("story:submit", (p: { cardId?: string; clue?: string }, ack?: Ack) =>
    act((r, t) => r.submitStory(t, String(p?.cardId ?? ""), String(p?.clue ?? "")), ack));
  socket.on("card:submit", (p: { cardId?: string }, ack?: Ack) =>
    act((r, t) => r.submitCard(t, String(p?.cardId ?? "")), ack));
  socket.on("vote:cast", (p: { cardId?: string }, ack?: Ack) =>
    act((r, t) => r.vote(t, String(p?.cardId ?? "")), ack));
  socket.on("lifeline:use", (p: { id?: LifelineId; arg?: string }, ack?: Ack) =>
    act((r, t) => r.useLifeline(t, p?.id as LifelineId, p?.arg), ack));

  socket.on("chat:say", (p: { text?: string }, ack?: Ack) => act((r, t) => { r.chatSay(t, String(p?.text ?? "")); return null; }, ack));
  socket.on("card:react", (p: { cardId?: string; emoji?: string }, ack?: Ack) =>
    act((r, t) => { r.react(t, String(p?.cardId ?? ""), String(p?.emoji ?? "👏")); return null; }, ack));

  socket.on("disconnect", () => {
    const room = myRoom();
    if (!room) return;
    const reg = registry(room.code);
    reg.delete(socket.id);
    // another tab may still hold this seat
    const stillHere = [...reg.values()].includes(myToken());
    if (!stillHere) room.disconnect(myToken());
    broadcast(room.code);
  });
});

// ---------- housekeeping ----------
setInterval(() => {
  const cutoff = Date.now() - 45 * 60 * 1000;
  for (const [code, room] of rooms) {
    const anyone = [...room.players.values()].some((p) => p.connected);
    if (!anyone && room.lastActivity < cutoff) {
      room.dispose();
      rooms.delete(code);
      sockets.delete(code);
      console.log(`[gc] dropped idle room ${code}`);
    }
  }
}, 5 * 60 * 1000);

// ---------- boot ----------
http.listen(PORT, "0.0.0.0", async () => {
  const urls = lanUrls();
  console.log(`\n  dicks-it?  ·  ${CARDS.length} cards loaded`);
  console.log(`  local      ${`http://localhost:${PORT}`}`);
  for (const u of urls) console.log(`  on wifi    ${u}`);
  if (!existsSync(DIST)) console.log(`\n  (no client build yet: run "bun run build", or "bun run dev:client" for hot reload on :5173)`);
  if (urls[0]) {
    try {
      console.log("\n" + (await QRCode.toString(urls[0], { type: "terminal", small: true })));
      console.log(`  scan to join: ${urls[0]}\n`);
    } catch {}
  }
});
