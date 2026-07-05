import { useState } from "react";
import type { SeatBackupEntry } from "../net/identity";
import { Button } from "../components/ui/button";

export default function SeatPicker({
  backups,
  onPickBackup,
  onJoinAsNew,
}: {
  backups: SeatBackupEntry[];
  onPickBackup: (entry: SeatBackupEntry) => void;
  onJoinAsNew: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [showJoinNew, setShowJoinNew] = useState(backups.length === 0);

  function submitJoinNew(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    onJoinAsNew(trimmed);
  }

  return (
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 bg-ink p-6 text-bone">
      <h1 className="font-display text-4xl text-blood">Join the game</h1>

      {backups.length > 0 && !showJoinNew && (
        <div className="flex w-full max-w-xs flex-col gap-3">
          {backups.map((entry) => (
            <button
              key={entry.seatToken}
              type="button"
              data-testid="rejoin-backup"
              onClick={() => onPickBackup(entry)}
              className="min-h-11 rounded-md border border-smoke bg-ink-2 px-4 py-3 text-left text-bone hover:border-brass"
            >
              Rejoin as {entry.name}
            </button>
          ))}
          <button
            type="button"
            data-testid="join-as-new"
            onClick={() => setShowJoinNew(true)}
            className="min-h-11 rounded-md border border-dashed border-smoke px-4 py-3 text-smoke"
          >
            Join as someone new
          </button>
        </div>
      )}

      {showJoinNew && (
        <form
          onSubmit={submitJoinNew}
          className="flex w-full max-w-xs flex-col gap-3"
        >
          <input
            data-testid="join-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={20}
            placeholder="Your name"
            autoFocus
            className="h-12 rounded-md border border-smoke bg-ink-2 px-3 text-bone placeholder:text-smoke focus:border-brass focus:outline-none"
          />
          <Button type="submit" data-testid="join-name-submit" className="w-full">
            Join
          </Button>
          {backups.length > 0 && (
            <button
              type="button"
              onClick={() => setShowJoinNew(false)}
              className="min-h-11 text-sm text-smoke"
            >
              Back to saved seats
            </button>
          )}
        </form>
      )}
    </main>
  );
}
