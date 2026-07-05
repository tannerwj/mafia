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
    <main className="safe-top safe-bottom safe-x mx-auto flex min-h-dvh w-full max-w-md flex-col items-center justify-center gap-8 bg-ink p-6 text-bone">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-3xl text-blood">Enter this room as…</h1>
        <p className="text-sm text-smoke">
          This browser holds credentials for both the host and a player.
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
          Enter as Host
        </Button>
        <Button
          type="button"
          data-testid="choose-player"
          size="lg"
          variant="outline"
          onClick={onChoosePlayer}
        >
          Enter as {playerName}
        </Button>
      </div>
    </main>
  );
}
