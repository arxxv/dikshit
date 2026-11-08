/**
 * Joins a room with warm bodies so you can try the game on your own.
 *   CODE=ABCDE N=3 bun run scripts/bots.ts
 * Bots play a random legal card and vote at random. Ctrl-C to send them home.
 */
import { io, type Socket } from "socket.io-client";
import type { ClientState } from "../shared/types.ts";

const URL = process.env.URL ?? "http://localhost:3000";
const CODE = (process.env.CODE ?? "").toUpperCase();
const N = Number(process.env.N ?? 3);
const NAMES = ["Beep", "Bloop", "Cog", "Widget", "Gizmo", "Sprocket", "Nut", "Bolt", "Cam"];
const FACES = ["🤖", "🦾", "👾", "🛸", "🪐", "🔮", "🧿", "🎲", "🪄"];

if (!CODE) { console.error("CODE=<room code> is required"); process.exit(1); }

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

for (let i = 0; i < N; i++) {
  const name = NAMES[i % NAMES.length];
  const s: Socket = io(URL, { transports: ["websocket"] });
  let acting = false;

  s.on("connect", () => {
    s.emit("room:join", { code: CODE, name, avatar: FACES[i % FACES.length] }, (r: any) => {
      console.log(r.ok ? `${name} joined ${CODE}` : `${name} could not join: ${r.error}`);
      if (!r.ok) s.close();
    });
  });

  s.on("state", (st: ClientState) => {
    if (acting) return;
    const think = 600 + Math.random() * 2200;

    if (st.phase === "STORYTELLING" && st.you.isStoryteller && st.you.hand.length) {
      acting = true;
      setTimeout(() => {
        s.emit("story:submit", { cardId: pick(st.you.hand).id, clue: pick(["a long way home", "something is watching", "the last warm day", "he never came back", "too many doors", "quiet before it starts"]) }, () => { acting = false; });
      }, think);
    } else if (st.phase === "SUBMITTING" && !st.you.isStoryteller && !st.you.submittedCardId && st.you.hand.length) {
      acting = true;
      setTimeout(() => { s.emit("card:submit", { cardId: pick(st.you.hand).id }, () => { acting = false; }); }, think);
    } else if (st.phase === "VOTING" && !st.you.isStoryteller && !st.you.votedCardId) {
      const legal = st.table.filter((c) => c.ownerId !== st.you.id);
      if (legal.length) {
        acting = true;
        setTimeout(() => { s.emit("vote:cast", { cardId: pick(legal).cardId }, () => { acting = false; }); }, think);
      }
    }
  });

  s.on("kicked", (p: any) => { console.log(`${name} was kicked: ${p.reason}`); s.close(); });
}
