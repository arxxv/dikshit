import React, { useEffect, useRef, useState } from "react";
import type { ClientState } from "../../shared/types.ts";
import { clearRoom, loadSession, saveSession, send, socket } from "./socket.ts";
import Home from "./screens/Home.tsx";
import Lobby from "./screens/Lobby.tsx";
import Game from "./screens/Game.tsx";

const codeFromUrl = () => {
  const m = location.pathname.match(/^\/j\/([A-Za-z0-9]{4,8})/);
  return m ? m[1].toUpperCase() : undefined;
};

export default function App() {
  const [state, setState] = useState<ClientState | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(socket.connected);
  const lastPhase = useRef<string>("");

  useEffect(() => {
    const onState = (s: ClientState) => { setState(s); setPending(null); saveSession({ code: s.code }); };
    const onPending = (p: { code: string }) => { setPending(p.code); setState(null); };
    const onKicked = (p: { reason: string }) => { setState(null); setPending(null); clearRoom(); setError(p.reason); };
    const rejoin = async () => {
      setLive(true);
      const s = loadSession();
      if (!s.code || !s.token) return;
      const r = await send("room:join", { code: s.code, token: s.token, name: s.name, avatar: s.avatar });
      if (!r.ok) { clearRoom(); setError(null); }
    };

    socket.on("state", onState);
    socket.on("pending", onPending);
    socket.on("kicked", onKicked);
    socket.on("connect", rejoin);
    socket.on("disconnect", () => setLive(false));
    if (socket.connected) rejoin();
    return () => {
      socket.off("state", onState); socket.off("pending", onPending);
      socket.off("kicked", onKicked); socket.off("connect", rejoin);
    };
  }, []);

  // a little buzz when it becomes your turn to act
  useEffect(() => {
    if (!state) return;
    const key = state.phase + state.round;
    if (lastPhase.current && lastPhase.current !== key) {
      const mine = (state.phase === "STORYTELLING" && state.you.isStoryteller)
        || (state.phase === "SUBMITTING" && !state.you.isStoryteller && !state.you.submittedCardId)
        || (state.phase === "VOTING" && !state.you.isStoryteller && !state.you.votedCardId);
      if (mine && "vibrate" in navigator) try { navigator.vibrate?.(60); } catch {}
    }
    lastPhase.current = key;
  }, [state?.phase, state?.round]);

  const leave = async () => { await send("room:leave"); clearRoom(); setState(null); setPending(null); };

  if (pending) {
    return (
      <div className="app">
        <div className="home">
          <h1>Knocking…</h1>
          <p className="tag">Waiting for the host of <b>{pending}</b> to let you in.</p>
          <button onClick={leave}>Never mind</button>
        </div>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="app">
        {!live && <div className="offline">reconnecting…</div>}
        <Home prefill={codeFromUrl()} error={error} />
      </div>
    );
  }

  return (
    <div className="app">
      {!live && <div className="offline">reconnecting…</div>}
      <nav className="topbar">
        <span className="brand">Storycards</span>
        <span className="code">{state.code}</span>
        <button className="link" onClick={leave}>leave</button>
      </nav>
      {state.phase === "LOBBY" ? <Lobby s={state} /> : <Game s={state} />}
    </div>
  );
}
