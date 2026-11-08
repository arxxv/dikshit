import React, { useEffect, useMemo, useState } from "react";
import type { ClientState } from "../../../shared/types.ts";
import { send } from "../socket.ts";
import { Banner, Card, Chat, Lifelines, PlayerChips, Reveal, Scoreboard, Timer, Zoom } from "../ui.tsx";

const phaseTotal = (s: ClientState) =>
  s.phase === "STORYTELLING" ? s.settings.storytellerSeconds
  : s.phase === "SUBMITTING" ? s.settings.submitSeconds
  : s.phase === "VOTING" ? s.settings.voteSeconds
  : s.settings.revealSeconds;

const phaseLabel = (s: ClientState) => {
  const st = s.players.find((p) => p.isStoryteller);
  switch (s.phase) {
    case "STORYTELLING": return s.you.isStoryteller ? "Your story. Pick a card and give a clue." : `${st?.name ?? "Someone"} is thinking of a clue`;
    case "SUBMITTING": return s.you.isStoryteller ? "Everyone is picking a card to match your clue" : "Pick the card that best fits the clue";
    case "VOTING": return s.you.isStoryteller ? "Everyone is voting" : "Which one is the storyteller's card?";
    case "REVEAL": return "Reveal";
    default: return "";
  }
};

export default function Game({ s }: { s: ClientState }) {
  const [picked, setPicked] = useState<string | undefined>();
  const [clue, setClue] = useState("");
  const [zoom, setZoom] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => { setPicked(undefined); setClue(""); }, [s.round, s.phase]);

  const flash = (m?: string) => { setErr(m ?? null); if (m) setTimeout(() => setErr(null), 3000); };

  const tellStory = async () => {
    if (!picked || !clue.trim()) return;
    const r = await send("story:submit", { cardId: picked, clue });
    if (!r.ok) flash(r.error);
  };
  const playCard = async () => {
    if (!picked) return;
    const r = await send("card:submit", { cardId: picked });
    if (!r.ok) flash(r.error);
  };
  const castVote = async (cardId: string) => {
    const r = await send("vote:cast", { cardId });
    if (!r.ok) flash(r.error);
  };

  const myHand = s.you.hand;
  const waiting = useMemo(() => {
    if (s.phase === "SUBMITTING") return `${Math.max(0, s.submittedCount - 1)}/${Math.max(0, s.expectedSubmissions - 1)} cards in`;
    if (s.phase === "VOTING") return `${s.votedCount}/${s.expectedVotes} votes in`;
    return "";
  }, [s]);

  if (s.phase === "GAME_OVER") {
    const sorted = [...s.players].sort((a, b) => b.score - a.score);
    return (
      <div className="over">
        <h2>{s.winners && s.winners.length > 1 ? `Tie: ${s.winners.join(" & ")}` : `${s.winners?.[0] ?? "Nobody"} wins`}</h2>
        <ol className="final">
          {sorted.map((p, i) => (
            <li key={p.id}><span className="rank">{i + 1}</span>{p.avatar} {p.name}<b>{p.score}</b></li>
          ))}
        </ol>
        {!!s.awards?.length && (
          <div className="awards">
            {s.awards.map((a) => (
              <div key={a.label} className="award"><span className="ic">{a.icon}</span><div><b>{a.label}</b><i>{a.who} · {a.detail}</i></div></div>
            ))}
          </div>
        )}
        <h3>How it went</h3>
        <ul className="log">
          {s.log.map((l) => (
            <li key={l.round}>
              <span className="rn">{l.round}</span>
              {l.skipped
                ? <i>skipped ({l.note})</i>
                : <><b>"{l.clue}"</b> by {l.storytellerName} · {l.guessedRight.length ? `found by ${l.guessedRight.join(", ")}` : "nobody found it"}
                    {l.storytellerCardImg && <img src={l.storytellerCardImg} alt="" onClick={() => setZoom(l.storytellerCardImg)} />}</>}
            </li>
          ))}
        </ul>
        {s.you.isHost
          ? <button className="primary big" onClick={() => send("game:again")}>Play again</button>
          : <p className="note">Waiting for the host.</p>}
        <Zoom img={zoom} onClose={() => setZoom(null)} />
        <Chat chat={s.chat} open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
      </div>
    );
  }

  return (
    <div className="game">
      <header>
        <div className="hl">
          <span className="rnd">Round {s.round}</span>
          <span className="phase">{phaseLabel(s)}</span>
        </div>
        <Timer endsAt={s.phaseEndsAt} total={phaseTotal(s)} />
      </header>

      <Scoreboard s={s} />
      <PlayerChips s={s} />
      {waiting && <div className="waiting">{waiting}</div>}
      {err && <Banner tone="warn">{err}</Banner>}

      {s.clue && s.phase !== "STORYTELLING" && <div className="clue">“{s.clue}”</div>}

      {s.phase === "REVEAL" && (
        <>
          <Reveal s={s} onZoom={setZoom} />
          {s.you.isHost && <button className="primary" onClick={() => send("game:next")}>Next round now</button>}
        </>
      )}

      {s.phase === "VOTING" && !s.you.isStoryteller && (
        <div className="table">
          {s.table.map((c) => {
            const mine = c.ownerId === s.you.id;
            const ruledOut = s.you.halfLightExcluded === c.cardId;
            const voted = s.you.votedCardId === c.cardId;
            return (
              <Card key={c.cardId} img={c.img}
                selected={voted}
                dim={ruledOut}
                disabled={mine || !!s.you.votedCardId || ruledOut || !!s.you.isSpectator}
                corner={mine ? <span className="mine">yours</span> : ruledOut ? <span className="out">ruled out</span> : null}
                badge={voted ? <span className="st-badge">your vote</span> : null}
                onClick={() => castVote(c.cardId)}
                onZoom={() => setZoom(c.img)} />
            );
          })}
        </div>
      )}

      {s.phase === "VOTING" && s.you.isStoryteller && (
        <div className="table dimmed">
          {s.table.map((c) => <Card key={c.cardId} img={c.img} onZoom={() => setZoom(c.img)} />)}
        </div>
      )}

      {(s.phase === "STORYTELLING" || s.phase === "SUBMITTING") && !s.you.isSpectator && (
        <div className="handzone">
          {s.you.submittedCardId && s.phase === "SUBMITTING" && <Banner tone="good">Card played. Waiting for the rest.</Banner>}
          <div className="hand">
            {myHand.map((c) => (
              <Card key={c.id} img={c.img}
                selected={picked === c.id}
                disabled={!!s.you.submittedCardId || (s.phase === "STORYTELLING" && !s.you.isStoryteller)}
                onClick={() => setPicked(c.id)}
                onZoom={() => setZoom(c.img)} />
            ))}
          </div>

          {s.phase === "STORYTELLING" && s.you.isStoryteller && (
            <div className="clueform">
              <input value={clue} maxLength={s.settings.clueMaxLength} placeholder="A word, a phrase, a sound..."
                     onChange={(e) => setClue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && tellStory()} />
              <button className="primary" disabled={!picked || !clue.trim()} onClick={tellStory}>
                {picked ? "Tell it" : "Pick a card"}
              </button>
            </div>
          )}

          {s.phase === "SUBMITTING" && !s.you.isStoryteller && !s.you.submittedCardId && (
            <button className="primary big" disabled={!picked} onClick={playCard}>{picked ? "Play this card" : "Pick a card"}</button>
          )}
        </div>
      )}

      {s.you.isSpectator && <Banner>You are watching. You will get a seat when the next game starts.</Banner>}

      <Lifelines s={s} selectedCard={picked} />

      <footer>
        <button className="link" onClick={() => setShowLog((v) => !v)}>{showLog ? "hide" : "story so far"}</button>
        <span className="deck">{s.deckLeft} cards left</span>
        <span className="rcode">{s.code}</span>
      </footer>

      {showLog && (
        <ul className="log mini">
          {[...s.log].reverse().map((l) => (
            <li key={l.round}>
              <span className="rn">{l.round}</span>
              {l.skipped ? <i>skipped</i> : <><b>"{l.clue}"</b> {l.storytellerName} · {l.guessedRight.length || 0} found it</>}
            </li>
          ))}
          {!s.log.length && <li><i>nothing yet</i></li>}
        </ul>
      )}

      <Zoom img={zoom} onClose={() => setZoom(null)} />
      <Chat chat={s.chat} open={chatOpen} onToggle={() => setChatOpen((v) => !v)} />
    </div>
  );
}
