import { useState } from "react";
import { Button } from "../components/ui/button";
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
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-10 bg-ink p-6 text-bone">
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-display text-5xl text-blood">Mafia</h1>
        <p className="text-sm text-smoke">a silent game for a loud table</p>
      </div>

      <Button
        onClick={createRoom}
        disabled={creating}
        data-testid="create-room"
        size="lg"
        className="w-full max-w-xs"
      >
        {creating ? "Creating…" : "Create room"}
      </Button>

      <div className="flex w-full max-w-xs items-center gap-3 text-smoke">
        <div className="h-px flex-1 bg-smoke/40" />
        <span className="text-xs uppercase tracking-widest">or</span>
        <div className="h-px flex-1 bg-smoke/40" />
      </div>

      <form
        onSubmit={joinRoom}
        className="flex w-full max-w-xs flex-col items-center gap-3"
      >
        <label htmlFor="join-code" className="text-sm text-smoke">
          Have a room code?
        </label>
        <input
          id="join-code"
          data-testid="join-code-input"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          maxLength={5}
          placeholder="ABCDE"
          className="h-12 w-full rounded-md border border-smoke bg-ink-2 px-3 text-center text-xl uppercase tracking-widest text-bone placeholder:text-smoke focus:border-brass focus:outline-none"
        />
        <Button
          type="submit"
          data-testid="join-room"
          variant="outline"
          className="w-full"
        >
          Go to room
        </Button>
      </form>

      {error && (
        <p data-testid="home-error" className="text-sm text-blood">
          {error}
        </p>
      )}
    </main>
  );
}
