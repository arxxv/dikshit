# Storycards

A Dixit-style party game for 3 to 10 players over your wifi. One person creates a room,
everyone else joins with a 5-character code, and you play in the browser on phones.

Card art is public-domain only: Met Museum open access (CC0) and Wikimedia Commons
public-domain files. Every card keeps its title, artist, licence and source URL in
`data/cards.manifest.json`, served at `/api/credits`.

## Run it

```bash
bun install
bun run cards          # one-off: downloads ~320 public-domain card images (resumable)
bun run build          # builds the client into dist/
bun run start          # serves game + client on :3000
```

The server prints a QR code and every wifi address it is reachable on. Everyone on the
same wifi opens `http://<your-ip>:3000`, or scans the QR.

Dev loop with hot reload:

```bash
bun run dev            # server on :3000, restarts on change
bun run dev:client     # vite on :5173, proxies sockets to :3000
```

Tests:

```bash
bun test tests/                              # 59 tests: scoring, rooms, lifelines, visibility, 400 bot games
PORT=3100 bun run server/index.ts &           # then, against a live server:
URL=http://localhost:3100 bun run tests/e2e.ts
```

## How a round goes

1. The storyteller picks a card from their hand and gives a clue.
2. Everyone else plays the card from their hand that best fits the clue.
3. The cards are shuffled and revealed. Everyone but the storyteller votes for the one
   they think is the storyteller's. You cannot vote for your own.
4. Scoring:
   - Nobody found it, or everybody found it: storyteller 0, everyone else +2.
   - Otherwise: storyteller +3, each correct voter +3.
   - Either way, every decoy owner takes +1 per vote their card drew (capped at 3 by default).
5. Hands refill to 6. The storyteller role moves on.

The game ends on a points target (30 by default) or after a set number of rounds,
whichever the host chose.

## Host controls

- 5-character room code, a join link, and a QR for phones
- Kick a player (they cannot rejoin; the host can clear the list)
- Optional approval queue: joiners wait until the host lets them in
- Hand the host role to someone else; it also transfers automatically if the host drops
- Separate timers for storytelling (90s), playing a card (60s), voting (45s) and the reveal (14s)
- End on points or rounds, hand size, clue length, max players
- Turn each lifeline on or off and set how many charges each player gets
- "On timeout, play and vote at random" so one idle phone cannot stall the table

## Lifelines

| Lifeline | What it does |
|---|---|
| 🔥 Burn | Throw away one card, draw a replacement. |
| ♻️ Fresh Hand | Dump your whole hand, draw a new one. |
| 🔎 Half-Light | While voting, one card that is definitely wrong is greyed out for you only. |
| ⏳ Stall | Adds 30 seconds to the current phase, for everyone. |
| 🎲 Double Down | Vote right for +2 extra, vote wrong and lose 1. |
| 🙈 Pass the Story | Storyteller only: hand the role on and redraw your hand. |

All of them are checked on the server against phase, role and remaining charges.

## Behaviour worth knowing

- **Timers are server-side.** The server sends a deadline; browsers only count down to it,
  so a tab that sleeps or lags cannot gain time.
- **Reconnecting keeps your seat.** Your token lives in localStorage, so a dropped phone
  rejoins to the same seat and the same hand. Away players are auto-played for.
- **Joining mid-game makes you a spectator.** Spectators take a seat when the next game starts.
- **A storyteller who never speaks gets the round skipped**, not auto-played: a round with no
  clue is not playable. Missed cards and votes do get auto-played when that setting is on.
- **Nobody is ever sent anybody else's hand**, and the storyteller's card is not identifiable
  in the voting payload. Both are tested.
- **If fewer than 3 players remain connected the game stops** with the scores as they stand,
  rather than spinning through rounds that cannot be voted on.
- **The discard pile reshuffles** when the draw pile empties, so a game never runs out of cards.

## Hosting it on the internet later

One instance only: all state is in memory, so rooms live in the process. Fly.io or Render
free tier both work; they support websockets and give you a `PORT` env var, which the server
already reads. Two instances would need rooms moved into Redis first.

## Layout

```
server/     index.ts (http + sockets)  room.ts (the game)  scoring.ts  deck.ts
client/src/ App.tsx  screens/{Home,Lobby,Game}.tsx  ui.tsx  styles.css
shared/     types.ts  (shared by both sides)
scripts/    fetch-cards.ts   (deck builder)
tests/      scoring, room, lifelines, redaction, bots, e2e
```
