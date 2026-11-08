import { io } from "socket.io-client";

export const socket = io({ transports: ["websocket", "polling"] });

/** promise wrapper over the socket's ack callbacks */
export function send<T = any>(event: string, payload: any = {}): Promise<{ ok: boolean; error?: string } & T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, error: "Server did not answer." } as any), 8000);
    socket.emit(event, payload, (r: any) => { clearTimeout(t); resolve(r ?? { ok: true }); });
  });
}

const KEY = "dicks-it.session";
export interface Session { code: string; token: string; name: string; avatar: string }

export function loadSession(): Partial<Session> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; }
}
export function saveSession(s: Partial<Session>) {
  localStorage.setItem(KEY, JSON.stringify({ ...loadSession(), ...s }));
}
export function clearRoom() {
  const s = loadSession();
  delete s.code;
  localStorage.setItem(KEY, JSON.stringify(s));
}
