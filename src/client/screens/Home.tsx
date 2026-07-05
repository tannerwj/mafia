import { useState } from "react";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
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
    <main className="safe-top safe-bottom safe-x relative z-10 mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-9 bg-ink p-6 text-paper">
      <div className="animate-rise flex flex-col items-center gap-3">
        <p className="text-[0.7rem] uppercase tracking-[0.4em] text-smoke">
          Case File No. 187
        </p>
        <h1 className="file-heading text-7xl leading-none text-blood">MAFIA</h1>
        <span className="stamp stamp-red text-[0.6rem]">Confidential</span>
        <p className="mt-1 text-xs uppercase tracking-[0.2em] text-smoke">
          a silent game for a loud table
        </p>
      </div>

      <Button
        onClick={createRoom}
        disabled={creating}
        data-testid="create-room"
        variant="brass"
        size="lg"
        className="w-full max-w-xs"
      >
        {creating ? "Opening file…" : "Open a new case"}
      </Button>

      <div className="flex w-full max-w-xs items-center gap-3 text-smoke">
        <Separator className="flex-1" />
        <span className="text-[0.65rem] uppercase tracking-[0.3em]">or</span>
        <Separator className="flex-1" />
      </div>

      <form
        onSubmit={joinRoom}
        className="flex w-full max-w-xs flex-col items-center gap-3"
      >
        <label
          htmlFor="join-code"
          className="text-xs uppercase tracking-[0.2em] text-smoke"
        >
          File reference number
        </label>
        <input
          id="join-code"
          data-testid="join-code-input"
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          maxLength={5}
          placeholder="ABCDE"
          className="h-12 w-full rounded-md border border-frame bg-ink-2 px-3 text-center text-xl uppercase tracking-[0.3em] text-brass-hi placeholder:text-smoke/60 focus:border-brass focus:outline-none"
        />
        <Button
          type="submit"
          data-testid="join-room"
          variant="outline"
          className="w-full"
        >
          Pull the file
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
