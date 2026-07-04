import { useState } from "react";
import { navigate } from "../useRoute";

export default function Home() {
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createRoom() {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error(`Failed to create room (${res.status})`);
      }
      const data = (await res.json()) as { roomCode: string; hostKey: string };
      sessionStorage.setItem(`mafia:${data.roomCode}:hostKey`, data.hostKey);
      localStorage.setItem(
        `mafia:${data.roomCode}:hostKey:backup`,
        data.hostKey,
      );
      navigate(`/room/${data.roomCode}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create room.");
    } finally {
      setCreating(false);
    }
  }

  function joinRoom(event: React.FormEvent) {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code.length === 0) return;
    navigate(`/room/${code}`);
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 bg-stone-950 p-6 text-stone-100">
      <h1 className="font-serif text-4xl text-red-800">Mafia</h1>

      <button
        type="button"
        onClick={createRoom}
        disabled={creating}
        data-testid="create-room"
        className="rounded bg-red-800 px-6 py-3 text-lg font-semibold text-stone-50 disabled:opacity-50"
      >
        {creating ? "Creating…" : "Create room"}
      </button>

      <form onSubmit={joinRoom} className="flex flex-col items-center gap-3">
        <label htmlFor="join-code" className="text-sm text-stone-300">
          Have a room code?
        </label>
        <input
          id="join-code"
          data-testid="join-code-input"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          maxLength={5}
          placeholder="ABCDE"
          className="w-32 rounded bg-stone-800 px-3 py-2 text-center text-xl uppercase tracking-widest text-stone-50"
        />
        <button
          type="submit"
          data-testid="join-room"
          className="rounded border border-stone-600 px-4 py-2 text-stone-100"
        >
          Go to room
        </button>
      </form>

      {error && (
        <p data-testid="home-error" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </main>
  );
}
