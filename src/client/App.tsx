import { useEffect, useRef, useState } from "react";
import type { PingMessage, ServerMessage } from "../shared/protocol";

// Spec 00 smoke UI: open a WebSocket to a hardcoded test room, send a ping,
// and render whether the pong round-tripped. This is throwaway — the real
// lobby / player / host views land in Spec 04+.
const TEST_ROOM = "smoke-test";

type Status = "connecting" | "waiting" | "ok" | "error";

const STATUS_LABEL: Record<Status, string> = {
  connecting: "Connecting to room…",
  waiting: "Sent ping, waiting for pong…",
  ok: "Round trip OK — client ⇄ Worker ⇄ Durable Object ⇄ WebSocket",
  error: "WebSocket error",
};

export default function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${location.host}/api/rooms/${TEST_ROOM}/ws`,
    );
    socketRef.current = ws;
    const nonce = crypto.randomUUID();

    ws.addEventListener("open", () => {
      setStatus("waiting");
      const ping: PingMessage = { type: "ping", nonce };
      ws.send(JSON.stringify(ping));
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      if (msg.type === "pong" && msg.nonce === nonce) {
        setStatus("ok");
      }
    });

    ws.addEventListener("error", () => setStatus("error"));

    return () => ws.close();
  }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-stone-950 p-6 text-stone-100">
      <h1 className="font-serif text-3xl text-red-800">Mafia</h1>
      <p
        data-testid="status"
        data-status={status}
        className="max-w-md text-center text-sm text-stone-300"
      >
        {STATUS_LABEL[status]}
      </p>
    </main>
  );
}
