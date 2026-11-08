import React, { useEffect, useRef, useState } from "react";
import type { ChatMsg, ClientState, LifelineId, PublicPlayer, TableCard } from "../../shared/types.ts";
import { LIFELINES } from "../../shared/types.ts";
import { send } from "./socket.ts";

export function Card(props: {
  img: string;
  selected?: boolean;
  dim?: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
  corner?: React.ReactNode;
  onClick?: () => void;
  onZoom?: () => void;
}) {
  return (
    <div
      className={["card", props.selected && "sel", props.dim && "dim", props.disabled && "off"].filter(Boolean).join(" ")}
      onClick={props.disabled ? undefined : props.onClick}
    >
      <img src={props.img} alt="" loading="lazy" draggable={false} />
      {props.badge && <div className="card-badge">{props.badge}</div>}
      {props.corner && <div className="card-corner">{props.corner}</div>}
      {props.onZoom && (
        <button className="zoom" onClick={(e) => { e.stopPropagation(); props.onZoom!(); }} aria-label="Enlarge">⤢</button>
      )}
    </div>
  );
}

export function Zoom({ img, onClose }: { img: string | null; onClose: () => void }) {
  if (!img) return null;
  return (
    <div className="zoomer" onClick={onClose}>
      <img src={img} alt="" />
      <div className="hint">tap to close</div>
    </div>
  );
}

export function Timer({ endsAt, total }: { endsAt?: number; total: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!endsAt) return;
    const h = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(h);
  }, [endsAt]);
  if (!endsAt) return null;
  const left = Math.max(0, endsAt - now);
  const secs = Math.ceil(left / 1000);
  const pct = Math.max(0, Math.min(100, (left / (total * 1000)) * 100));
  return (
    <div className={"timer" + (secs <= 10 ? " urgent" : "")}>
      <div className="bar" style={{ width: pct + "%" }} />
      <span>{secs}s</span>
    </div>
  );
}

export function Avatar({ p, size = 32 }: { p: { avatar: string; name: string; connected?: boolean }; size?: number }) {
  return (
    <span className={"av" + (p.connected === false ? " away" : "")} style={{ fontSize: size * 0.6, width: size, height: size }} title={p.name}>
      {p.avatar}
    </span>
  );
}

export function Scoreboard({ s }: { s: ClientState }) {
  const sorted = [...s.players].sort((a, b) => b.score - a.score);
  const target = s.settings.endMode === "points" ? s.settings.pointsTarget : null;
  return (
    <div className="scoreboard">
      {sorted.map((p) => (
        <div key={p.id} className={"sb" + (p.isStoryteller ? " st" : "") + (p.connected ? "" : " away")}>
          <Avatar p={p} size={26} />
          <span className="nm">{p.name}{p.id === s.you.id ? " (you)" : ""}</span>
          <span className="pts">{p.score}{target ? <i>/{target}</i> : null}</span>
          {p.roundDelta !== 0 && (s.phase === "REVEAL" || s.phase === "GAME_OVER") && (
            <span className={"delta " + (p.roundDelta > 0 ? "up" : "down")}>{p.roundDelta > 0 ? "+" : ""}{p.roundDelta}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function PlayerChips({ s }: { s: ClientState }) {
  const marker = (p: PublicPlayer) => {
    if (p.isStoryteller) return "📖";
    if (s.phase === "SUBMITTING") return p.hasSubmitted ? "✅" : "…";
    if (s.phase === "VOTING") return p.hasVoted ? "✅" : "…";
    return "";
  };
  return (
    <div className="chips">
      {s.players.map((p) => (
        <div key={p.id} className={"chip" + (p.connected ? "" : " away")}>
          <Avatar p={p} size={22} />
          <span>{p.name}</span>
          {p.doubleDown && <b title="Doubled down">🎲</b>}
          <i>{marker(p)}</i>
        </div>
      ))}
      {s.spectators.length > 0 && <div className="chip ghost">👀 {s.spectators.length} watching</div>}
    </div>
  );
}

export function Lifelines({ s, selectedCard }: { s: ClientState; selectedCard?: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const enabled = LIFELINES.filter((l) => s.settings.lifelines[l.id] > 0);
  if (!enabled.length || s.you.isSpectator) return null;

  const usable = (id: LifelineId): string | null => {
    if (s.you.lifelinesLeft[id] <= 0) return "none left";
    const beforePlay = (s.phase === "STORYTELLING" || s.phase === "SUBMITTING") && !s.you.submittedCardId;
    switch (id) {
      case "burn": return beforePlay ? (selectedCard ? null : "pick a card first") : "before you play only";
      case "freshHand": return beforePlay ? null : "before you play only";
      case "halfLight":
        if (s.phase !== "VOTING") return "while voting only";
        if (s.you.isStoryteller) return "not the storyteller";
        if (s.you.votedCardId) return "already voted";
        return s.you.halfLightExcluded ? "used" : null;
      case "stall": return ["STORYTELLING", "SUBMITTING", "VOTING"].includes(s.phase) ? null : "nothing to stall";
      case "doubleDown":
        if (s.phase !== "VOTING") return "while voting only";
        if (s.you.isStoryteller) return "not the storyteller";
        if (s.you.votedCardId) return "before you vote";
        return s.you.doubleDown ? "declared" : null;
      case "passStory": return s.phase === "STORYTELLING" && s.you.isStoryteller ? null : "storyteller only";
    }
  };

  const fire = async (id: LifelineId) => {
    const r = await send("lifeline:use", { id, arg: id === "burn" ? selectedCard : undefined });
    setMsg(r.ok ? null : r.error ?? "No.");
    if (!r.ok) setTimeout(() => setMsg(null), 2600);
  };

  return (
    <div className="lifelines">
      {enabled.map((l) => {
        const why = usable(l.id);
        return (
          <button
            key={l.id}
            className={"ll" + (why ? " off" : "")}
            disabled={!!why}
            onClick={() => fire(l.id)}
            title={`${l.name}: ${l.blurb}${why ? ` (${why})` : ""}`}
          >
            <span className="ic">{l.icon}</span>
            <span className="nm">{l.name}</span>
            <span className="ct">{s.you.lifelinesLeft[l.id]}</span>
          </button>
        );
      })}
      {msg && <div className="ll-msg">{msg}</div>}
    </div>
  );
}

export function Chat({ chat, open, onToggle }: { chat: ChatMsg[]; open: boolean; onToggle: () => void }) {
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const seen = useRef(chat.length);
  const unread = open ? 0 : Math.max(0, chat.length - seen.current);
  useEffect(() => { if (open) { seen.current = chat.length; box.current?.scrollTo({ top: 1e6 }); } }, [chat.length, open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    await send("chat:say", { text: t });
  };

  return (
    <div className={"chat" + (open ? " open" : "")}>
      <button className="chat-tab" onClick={onToggle}>
        💬{unread > 0 && <b>{unread}</b>}
      </button>
      {open && (
        <div className="chat-body">
          <div className="chat-log" ref={box}>
            {chat.map((m) => (
              <div key={m.id} className={"msg" + (m.system ? " sys" : "")}>
                {m.system ? <i>{m.text}</i> : <><span className="who">{m.avatar} {m.name}</span> {m.text}</>}
              </div>
            ))}
          </div>
          <form onSubmit={submit}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Say something" maxLength={240} />
            <button type="submit">↑</button>
          </form>
        </div>
      )}
    </div>
  );
}

const REACTIONS = ["😂", "😍", "🤯", "👏", "🤔", "💀"];

export function Reveal({ s, onZoom }: { s: ClientState; onZoom: (img: string) => void }) {
  const cards: TableCard[] = s.table;
  return (
    <div className="table reveal">
      {cards.map((c) => {
        const mine = c.ownerId === s.you.id;
        return (
          <div key={c.cardId} className="revcard">
            <Card
              img={c.img}
              badge={c.isStorytellerCard ? <span className="st-badge">📖 the story</span> : null}
              corner={mine ? <span className="mine">yours</span> : null}
              onZoom={() => onZoom(c.img)}
            />
            <div className="owner">{c.ownerName}</div>
            <div className="voters">
              {(c.voters ?? []).map((v) => <span key={v.id} title={v.name}>{v.avatar}</span>)}
              {(c.voters ?? []).length === 0 && <i>no votes</i>}
            </div>
            <div className="reacts">
              {(s.reactions[c.cardId] ?? []).map((e, i) => <span key={i}>{e}</span>)}
            </div>
            <div className="react-pick">
              {REACTIONS.map((e) => (
                <button key={e} onClick={() => send("card:react", { cardId: c.cardId, emoji: e })}>{e}</button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Banner({ children, tone }: { children: React.ReactNode; tone?: "warn" | "good" }) {
  return <div className={"banner" + (tone ? " " + tone : "")}>{children}</div>;
}
