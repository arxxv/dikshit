import React, { useEffect, useState } from "react";
import { AVATARS } from "../../../shared/types.ts";
import { loadSession, saveSession, send } from "../socket.ts";

export default function Home({ prefill, error }: { prefill?: string; error?: string | null }) {
  const sess = loadSession();
  const [name, setName] = useState(sess.name ?? "");
  const [avatar, setAvatar] = useState(sess.avatar ?? AVATARS[Math.floor(Math.random() * AVATARS.length)]);
  const [code, setCode] = useState(prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error ?? null);
  const [info, setInfo] = useState<{ cards: number; urls: string[] } | null>(null);

  useEffect(() => { fetch("/api/info").then((r) => r.json()).then(setInfo).catch(() => {}); }, []);
  useEffect(() => { setErr(error ?? null); }, [error]);

  const go = async (kind: "create" | "join") => {
    const nm = name.trim();
    if (!nm) { setErr("Pick a name first."); return; }
    setBusy(true);
    setErr(null);
    saveSession({ name: nm, avatar });
    const r = kind === "create"
      ? await send("room:create", { name: nm, avatar })
      : await send<{ code: string }>("room:join", { code: code.trim().toUpperCase(), name: nm, avatar, token: sess.token });
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? "Could not do that."); return; }
    saveSession({ code: (r as any).code, token: (r as any).token, name: nm, avatar });
  };

  return (
    <div className="home">
      <h1>Storycards</h1>
      <p className="tag">A clue, a picture, and everyone guessing. 3 to 10 players, one wifi.</p>

      {err && <div className="banner warn">{err}</div>}

      <label>Your name</label>
      <input className="big" value={name} maxLength={16} placeholder="e.g. Arnav"
             onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go(code ? "join" : "create")} />

      <label>Pick a face</label>
      <div className="avpick">
        {AVATARS.map((a) => (
          <button key={a} className={a === avatar ? "on" : ""} onClick={() => setAvatar(a)}>{a}</button>
        ))}
      </div>

      <div className="row2">
        <button className="primary big" disabled={busy} onClick={() => go("create")}>Create a room</button>
      </div>

      <div className="joinrow">
        <input className="code" value={code} placeholder="ROOM CODE" maxLength={7}
               onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
               onKeyDown={(e) => e.key === "Enter" && go("join")} />
        <button disabled={busy || code.length < 4} onClick={() => go("join")}>Join</button>
      </div>

      {info && (
        <p className="foot">
          {info.cards} cards in the deck · open <code>{info.urls[0] ?? `http://localhost:3000`}</code> on any phone on this wifi
        </p>
      )}
    </div>
  );
}
