import { useState } from "react";
import type { SeatBackupEntry } from "../net/identity";

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
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-stone-950 p-6 text-stone-100">
      <h1 className="font-serif text-3xl text-red-800">Join the game</h1>

      {backups.length > 0 && !showJoinNew && (
        <div className="flex w-full max-w-xs flex-col gap-3">
          {backups.map((entry) => (
            <button
              key={entry.seatToken}
              type="button"
              data-testid="rejoin-backup"
              onClick={() => onPickBackup(entry)}
              className="rounded border border-stone-600 px-4 py-3 text-left text-stone-100"
            >
              Rejoin as {entry.name}
            </button>
          ))}
          <button
            type="button"
            data-testid="join-as-new"
            onClick={() => setShowJoinNew(true)}
            className="rounded border border-dashed border-stone-600 px-4 py-3 text-stone-300"
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
            className="rounded bg-stone-800 px-3 py-2 text-stone-50"
          />
          <button
            type="submit"
            data-testid="join-name-submit"
            className="rounded bg-red-800 px-4 py-2 font-semibold text-stone-50"
          >
            Join
          </button>
          {backups.length > 0 && (
            <button
              type="button"
              onClick={() => setShowJoinNew(false)}
              className="text-sm text-stone-400"
            >
              Back to saved seats
            </button>
          )}
        </form>
      )}
    </main>
  );
}
