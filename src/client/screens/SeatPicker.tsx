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
  const [nameError, setNameError] = useState<string | null>(null);

  function submitJoinNew(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setNameError("Enter a name before joining.");
      return;
    }
    setNameError(null);
    onJoinAsNew(trimmed);
  }

  return (
    <main className="safe-top safe-bottom safe-x relative z-10 mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 bg-ink p-6 text-paper">
      <div className="animate-rise flex flex-col items-center gap-2 text-center">
        <p className="text-[0.65rem] uppercase tracking-[0.3em] text-smoke">
          Report for questioning
        </p>
        <h1 className="file-heading text-3xl text-blood">Sign the register</h1>
      </div>

      {backups.length > 0 && !showJoinNew && (
        <div className="flex w-full max-w-xs flex-col gap-3">
          {backups.map((entry) => (
            <button
              key={entry.seatToken}
              type="button"
              data-testid="rejoin-backup"
              onClick={() => onPickBackup(entry)}
              className="min-h-11 rounded-sm border border-frame bg-ink-2 px-4 py-3 text-left text-paper transition-colors hover:border-brass"
            >
              Rejoin as {entry.name}
            </button>
          ))}
          <button
            type="button"
            data-testid="join-as-new"
            onClick={() => setShowJoinNew(true)}
            className="file-frame min-h-11 rounded-sm px-4 py-3 text-smoke transition-colors hover:border-brass"
          >
            Enter a new subject
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
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(null);
            }}
            maxLength={20}
            placeholder="Subject name"
            autoFocus
            className="h-12 rounded-md border border-frame bg-ink-2 px-3 text-paper placeholder:text-smoke/60 focus:border-brass focus:outline-none"
          />
          <Button type="submit" variant="brass" data-testid="join-name-submit" className="w-full">
            Join
          </Button>
          {nameError && (
            <p data-testid="join-name-error" className="text-center text-sm text-blood">
              {nameError}
            </p>
          )}
          {backups.length > 0 && (
            <button
              type="button"
              onClick={() => setShowJoinNew(false)}
              className="min-h-11 text-sm text-smoke"
            >
              Back to filed subjects
            </button>
          )}
        </form>
      )}
    </main>
  );
}
