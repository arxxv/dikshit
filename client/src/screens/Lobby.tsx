import React, { useEffect, useState } from "react";
import { LIFELINES, MIN_PLAYERS, SETTING_BOUNDS, type ClientState, type Settings } from "../../../shared/types.ts";
import { send } from "../socket.ts";
import { Avatar } from "../ui.tsx";

function Num({ label, value, min, max, step = 5, suffix, onChange, disabled }: {
  label: string; value: number; min: number; max: number; step?: number;
  suffix?: string; onChange: (v: number) => void; disabled?: boolean;
}) {
  return (
    <div className={"setting" + (disabled ? " ro" : "")}>
      <span className="lab">{label}</span>
      <div className="stepper">
        <button disabled={disabled || value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
        <b>{value}{suffix}</b>
        <button disabled={disabled || value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
      </div>
    </div>
  );
}

export default function Lobby({ s }: { s: ClientState }) {
  const host = s.you.isHost;
  const [qr, setQr] = useState<string | null>(null);
  const [joinUrl, setJoinUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"players" | "rules">("players");

  useEffect(() => {
    const url = `${location.origin}/j/${s.code}`;
    setJoinUrl(url);
    fetch(`/api/qr?url=${encodeURIComponent(url)}`).then((r) => r.json()).then((d) => setQr(d.qr)).catch(() => {});
  }, [s.code]);

  const set = (patch: Partial<Settings>) => send("room:settings", { patch });
  const cfg = s.settings;
  const seats = s.players.length;
  const canStart = s.players.filter((p) => p.connected).length >= MIN_PLAYERS;

  const start = async () => {
    const r = await send("game:start");
    if (!r.ok) { setErr(r.error ?? "Could not start."); setTimeout(() => setErr(null), 4000); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(joinUrl); setErr("Link copied."); setTimeout(() => setErr(null), 1800); }
    catch { setErr(joinUrl); }
  };

  return (
    <div className="lobby">
      <div className="codecard">
        <div>
          <span className="lab">Room code</span>
          <div className="code">{s.code}</div>
          <button className="link" onClick={copy}>copy join link</button>
        </div>
        {qr && <img className="qr" src={qr} alt="join QR" />}
      </div>

      {err && <div className="banner">{err}</div>}

      <div className="tabs">
        <button className={tab === "players" ? "on" : ""} onClick={() => setTab("players")}>Players {seats}/{cfg.maxPlayers}</button>
        <button className={tab === "rules" ? "on" : ""} onClick={() => setTab("rules")}>Settings</button>
      </div>

      {tab === "players" && (
        <>
          {host && s.pending.length > 0 && (
            <div className="pending">
              <h4>Asking to join</h4>
              {s.pending.map((p) => (
                <div key={p.id} className="prow">
                  <span>{p.avatar} {p.name}</span>
                  <div>
                    <button className="primary" onClick={() => send("host:approve", { id: p.id })}>Let in</button>
                    <button onClick={() => send("host:deny", { id: p.id })}>No</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <ul className="plist">
            {s.players.map((p) => (
              <li key={p.id} className={p.connected ? "" : "away"}>
                <Avatar p={p} />
                <span className="nm">{p.name}{p.id === s.you.id ? " (you)" : ""}</span>
                {p.isHost && <em>host</em>}
                {!p.connected && <em className="warn">away</em>}
                {host && !p.isHost && (
                  <span className="acts">
                    <button onClick={() => send("host:promote", { playerId: p.id })} title="Make host">👑</button>
                    <button className="danger" onClick={() => send("host:kick", { playerId: p.id })} title="Remove">✕</button>
                  </span>
                )}
              </li>
            ))}
            {s.spectators.map((p) => (
              <li key={p.id} className="spec">
                <Avatar p={p} />
                <span className="nm">{p.name}</span>
                <em>watching</em>
                {host && <span className="acts"><button className="danger" onClick={() => send("host:kick", { playerId: p.id })}>✕</button></span>}
              </li>
            ))}
          </ul>
          {s.spectators.length > 0 && <p className="note">Spectators take a seat when a seat frees up and the next game starts.</p>}
          {s.bans > 0 && host && (
            <p className="note">{s.bans} removed {s.bans === 1 ? "player" : "players"} cannot rejoin. <button className="link" onClick={() => send("host:clearBans")}>let them back</button></p>
          )}
        </>
      )}

      {tab === "rules" && (
        <div className="settings">
          {!host && <p className="note">Only the host can change these.</p>}

          <h4>Timers</h4>
          <Num label="Storyteller" value={cfg.storytellerSeconds} min={SETTING_BOUNDS.storytellerSeconds[0]} max={SETTING_BOUNDS.storytellerSeconds[1]} step={10} suffix="s" disabled={!host} onChange={(v) => set({ storytellerSeconds: v })} />
          <Num label="Picking a card" value={cfg.submitSeconds} min={SETTING_BOUNDS.submitSeconds[0]} max={SETTING_BOUNDS.submitSeconds[1]} step={10} suffix="s" disabled={!host} onChange={(v) => set({ submitSeconds: v })} />
          <Num label="Voting" value={cfg.voteSeconds} min={SETTING_BOUNDS.voteSeconds[0]} max={SETTING_BOUNDS.voteSeconds[1]} step={5} suffix="s" disabled={!host} onChange={(v) => set({ voteSeconds: v })} />
          <Num label="Reveal" value={cfg.revealSeconds} min={SETTING_BOUNDS.revealSeconds[0]} max={SETTING_BOUNDS.revealSeconds[1]} step={2} suffix="s" disabled={!host} onChange={(v) => set({ revealSeconds: v })} />

          <h4>Game end</h4>
          <div className="setting">
            <span className="lab">Finish on</span>
            <div className="seg">
              <button className={cfg.endMode === "points" ? "on" : ""} disabled={!host} onClick={() => set({ endMode: "points" })}>Points</button>
              <button className={cfg.endMode === "rounds" ? "on" : ""} disabled={!host} onClick={() => set({ endMode: "rounds" })}>Rounds</button>
            </div>
          </div>
          {cfg.endMode === "points"
            ? <Num label="First to" value={cfg.pointsTarget} min={SETTING_BOUNDS.pointsTarget[0]} max={SETTING_BOUNDS.pointsTarget[1]} step={5} suffix=" pts" disabled={!host} onChange={(v) => set({ pointsTarget: v })} />
            : <Num label="Play" value={cfg.roundsTarget} min={SETTING_BOUNDS.roundsTarget[0]} max={SETTING_BOUNDS.roundsTarget[1]} step={1} suffix=" rounds" disabled={!host} onChange={(v) => set({ roundsTarget: v })} />}

          <h4>Table</h4>
          <Num label="Max players" value={cfg.maxPlayers} min={Math.max(SETTING_BOUNDS.maxPlayers[0], seats)} max={SETTING_BOUNDS.maxPlayers[1]} step={1} disabled={!host} onChange={(v) => set({ maxPlayers: v })} />
          <Num label="Hand size" value={cfg.handSize} min={SETTING_BOUNDS.handSize[0]} max={SETTING_BOUNDS.handSize[1]} step={1} suffix=" cards" disabled={!host} onChange={(v) => set({ handSize: v })} />
          <Num label="Clue length" value={cfg.clueMaxLength} min={SETTING_BOUNDS.clueMaxLength[0]} max={SETTING_BOUNDS.clueMaxLength[1]} step={10} suffix=" chars" disabled={!host} onChange={(v) => set({ clueMaxLength: v })} />

          <label className="check"><input type="checkbox" checked={cfg.requireApproval} disabled={!host} onChange={(e) => set({ requireApproval: e.target.checked })} /> Ask me before letting people in</label>
          <label className="check"><input type="checkbox" checked={cfg.autoPlayOnTimeout} disabled={!host} onChange={(e) => set({ autoPlayOnTimeout: e.target.checked })} /> On timeout, play and vote at random</label>
          <label className="check"><input type="checkbox" checked={cfg.voteCapEnabled} disabled={!host} onChange={(e) => set({ voteCapEnabled: e.target.checked })} /> Cap decoy points at 3 per round</label>

          <h4>Lifelines (uses per player)</h4>
          {LIFELINES.map((l) => (
            <div className="setting ll-set" key={l.id}>
              <span className="lab">{l.icon} {l.name}<i>{l.blurb}</i></span>
              <div className="stepper">
                <button disabled={!host || cfg.lifelines[l.id] <= 0} onClick={() => set({ lifelines: { ...cfg.lifelines, [l.id]: cfg.lifelines[l.id] - 1 } })}>−</button>
                <b>{cfg.lifelines[l.id] === 0 ? "off" : cfg.lifelines[l.id]}</b>
                <button disabled={!host || cfg.lifelines[l.id] >= 5} onClick={() => set({ lifelines: { ...cfg.lifelines, [l.id]: cfg.lifelines[l.id] + 1 } })}>+</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="lobby-foot">
        {host ? (
          <button className="primary big" disabled={!canStart} onClick={start}>
            {canStart ? "Start the game" : `Need ${MIN_PLAYERS}+ players`}
          </button>
        ) : (
          <p className="note">Waiting for the host to start.</p>
        )}
      </div>
    </div>
  );
}
