import { useState } from "react";
import { InstructionsContent } from "../components/Instructions";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { HOUSE_ROLE_IDS, roleCopyFor } from "../lib/roleCopy";
import { navigate } from "../useRoute";

// D1 (Spec 16): the below-the-fold landing explainer. Comprehension-first,
// noir-flavored — a reader who's never heard of Mafia/Werewolf needs to get
// it from this section alone. Static content; no server involvement.
const HOW_IT_RUNS = [
  "Someone opens a case and shares the link (or the QR on their screen).",
  "Everyone joins on their own phone — roles are dealt out in secret.",
  "Nights are silent: the killers, the detective, and the angel act on their phones. Everyone else just files a decoy action, so nothing is given away by who's tapping.",
  "Days are loud: the table accuses, defends, and votes out loud. Last faction standing wins.",
] as const;

function HowToPlayFooterLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <p className="text-center text-[0.7rem] text-smoke">
        Playing at the table already?{" "}
        <button
          type="button"
          data-testid="landing-how-it-works-link"
          onClick={() => setOpen(true)}
          className="underline decoration-dotted underline-offset-4 hover:text-paper"
        >
          Read the full case briefing
        </button>
        .
      </p>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="landing-instructions-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="file-frame animate-rise flex max-h-[85dvh] w-full max-w-md flex-col overflow-y-auto rounded-md bg-ink-2 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="file-heading text-xl text-blood">Case briefing</h2>
              <button
                type="button"
                data-testid="landing-instructions-close"
                aria-label="Close instructions"
                onClick={() => setOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-paper"
              >
                ✕
              </button>
            </div>
            <InstructionsContent />
          </div>
        </div>
      )}
    </>
  );
}

function LandingExplainer() {
  return (
    <section
      data-testid="landing-explainer"
      className="flex w-full max-w-2xl flex-col gap-10 px-2 pb-16 pt-4 text-paper"
    >
      <div data-testid="landing-pitch" className="flex flex-col gap-3 text-center">
        <h2 className="file-heading text-lg tracking-[0.08em] text-brass-hi">
          The pitch
        </h2>
        <p className="text-sm text-paper/80">
          Mafia is a social-deduction party game for one room, played in
          person — a killer or two are hiding among an innocent majority, and
          the innocents have to find them before it's too late. This app
          replaces the cards and the sleeping narrator: it deals the roles,
          runs the night in secret, and counts the votes. The table still
          does all the yelling.
        </p>
        <p className="text-xs uppercase tracking-[0.15em] text-smoke">
          No accounts. No app install. No cards.
        </p>
      </div>

      <div data-testid="landing-how-it-runs" className="flex flex-col gap-4">
        <h2 className="file-heading text-center text-lg tracking-[0.08em] text-brass-hi">
          How a game runs
        </h2>
        <ol className="flex flex-col gap-3">
          {HOW_IT_RUNS.map((step, i) => (
            <li key={i} className="flex gap-3 rounded-sm border border-frame bg-ink-2 p-3">
              <span className="file-heading shrink-0 text-xl text-blood">{i + 1}</span>
              <span className="text-sm text-paper/80">{step}</span>
            </li>
          ))}
        </ol>
      </div>

      <div data-testid="landing-cast" className="flex flex-col gap-4">
        <h2 className="file-heading text-center text-lg tracking-[0.08em] text-brass-hi">
          The cast
        </h2>
        <ul className="flex flex-col gap-2">
          {HOUSE_ROLE_IDS.map((roleId) => {
            const copy = roleCopyFor(roleId);
            return (
              <li
                key={roleId}
                data-testid="landing-cast-role"
                data-role-id={roleId}
                className="flex flex-col gap-0.5 rounded-sm border border-frame bg-ink-2 px-3 py-2"
              >
                <span className="text-xs font-bold uppercase tracking-[0.1em] text-bone">
                  {copy.displayName}
                </span>
                <span className="text-xs text-paper/70">{copy.blurb}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <Card data-testid="landing-house-facts" className="bg-ink-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-center">House facts</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-center text-xs text-paper/80 sm:grid-cols-4">
          <div>
            <p className="text-lg text-brass-hi">5–20</p>
            <p className="text-smoke">players (3+ with a narrator)</p>
          </div>
          <div>
            <p className="text-lg text-brass-hi">~15–45</p>
            <p className="text-smoke">minutes a case</p>
          </div>
          <div>
            <p className="text-lg text-brass-hi">1</p>
            <p className="text-smoke">host phone runs the table</p>
          </div>
          <div>
            <p className="text-lg text-brass-hi">AI</p>
            <p className="text-smoke">optional storyteller narrator</p>
          </div>
        </CardContent>
      </Card>

      <HowToPlayFooterLink />
    </section>
  );
}

export default function Home() {
  const [joinCode, setJoinCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [checking, setChecking] = useState(false);
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

  async function joinRoom(event: React.FormEvent) {
    event.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (code.length === 0) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
      if (res.status === 404) {
        setError("No case file with that code — check it and try again.");
        return;
      }
      if (!res.ok) {
        throw new Error(`Could not look up that case file (${res.status}).`);
      }
      const meta = (await res.json()) as { exists: boolean };
      if (!meta.exists) {
        setError("No case file with that code — check it and try again.");
        return;
      }
      navigate(`/room/${code}`);
    } catch {
      setError("Could not reach the office — check your connection and try again.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex w-full flex-col items-center bg-ink">
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
          disabled={checking}
          className="w-full"
        >
          {checking ? "Checking the file…" : "Pull the file"}
        </Button>
      </form>

      {error && (
        <p data-testid="home-error" className="text-sm text-blood">
          {error}
        </p>
      )}
      </main>
      <LandingExplainer />
    </div>
  );
}
