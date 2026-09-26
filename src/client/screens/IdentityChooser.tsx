// Dual-credential identity chooser (D3 pin): a browser may legitimately hold
// both a hostKey and a seatToken for one room. Shown whenever both exist —
// `hello` presents exactly the chosen credential, never auto-picked by
// storage-read order.
import { Button } from "../components/ui/button";

export default function IdentityChooser({
  playerName,
  onChooseHost,
  onChoosePlayer,
}: {
  playerName: string;
  onChooseHost: () => void;
  onChoosePlayer: () => void;
}) {
  return (
    <main className="page-p relative z-10 mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 bg-ink text-paper">
      <div className="animate-rise flex flex-col items-center gap-2 text-center">
        <p className="text-[0.65rem] uppercase tracking-[0.3em] text-smoke">
          Two files on this device
        </p>
        <h1 className="file-heading text-2xl text-blood-hi">Enter this case as…</h1>
        <p className="text-sm text-smoke">
          // credentials found for both the investigator and a subject.
        </p>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button
          type="button"
          data-testid="choose-host"
          size="lg"
          variant="brass"
          onClick={onChooseHost}
        >
          The Investigator
        </Button>
        <Button
          type="button"
          data-testid="choose-player"
          size="lg"
          variant="outline"
          onClick={onChoosePlayer}
        >
          Subject: {playerName}
        </Button>
      </div>
    </main>
  );
}
