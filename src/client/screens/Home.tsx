import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { InstructionsContent } from "../components/Instructions";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
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
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <p className="text-center text-[0.7rem] text-smoke">
          Playing at the table already?{" "}
          <Dialog.Trigger asChild>
            <button
              type="button"
              data-testid="landing-how-it-works-link"
              className="inline-flex min-h-11 items-center rounded-sm px-1 underline decoration-dotted underline-offset-4 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-hi focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
            >
              Read the full case briefing
            </button>
          </Dialog.Trigger>
          .
        </p>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/90" />
          <Dialog.Content
            data-testid="landing-instructions-modal"
            className="file-frame animate-rise fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-ink-2 p-6 shadow-card"
          >
            <div className="mb-4 flex items-center justify-between">
              <Dialog.Title asChild>
                <h2 className="file-heading text-xl text-blood-hi">Case briefing</h2>
              </Dialog.Title>
              <Dialog.Close asChild>
                <button
                  type="button"
                  data-testid="landing-instructions-close"
                  aria-label="Close instructions"
                  className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-hi focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
                >
                  ✕
                </button>
              </Dialog.Close>
            </div>
            <Dialog.Description asChild>
              <span className="sr-only">
                Objective, day and night loop, voting rules, and every role&apos;s ability.
              </span>
            </Dialog.Description>
            <div className="overflow-y-auto">
              <InstructionsContent />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

function LandingExplainer() {
  return (
    <section
      data-testid="landing-explainer"
      className="home-explainer flex flex-col gap-10 pb-16 text-paper"
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
              <span className="file-heading shrink-0 text-xl text-blood-hi">{i + 1}</span>
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
    <div className="home-page flex w-full flex-col items-center">
      <main
        data-testid="home-screen"
        className="page-p relative z-10 flex min-h-dvh w-full flex-col items-center justify-center gap-8 text-paper"
      >
        <div className="home-hero">
          <section className="home-brand" aria-labelledby="home-title">
            <p className="text-[0.68rem] uppercase tracking-[0.32em] text-smoke">
              Case File No. 187 · private table game
            </p>
            <h1 id="home-title" className="home-title">
              MAF<span className="home-title-mark">I</span>A
            </h1>
            <span className="stamp stamp-red mt-4 text-[0.6rem]">Confidential</span>
            <p className="home-lede">
              A silent digital game master for a loud table. Your group talks in
              the room; the app handles secret roles, tense nights, and fair votes.
            </p>
            <div className="home-meta" aria-label="Game features">
              <span>No accounts</span>
              <span>One host</span>
              <span>Every player on a phone</span>
            </div>
          </section>

          <section className="home-action-card p-5 sm:p-6" aria-label="Start or join a game">
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-[0.65rem] uppercase tracking-[0.2em] text-brass-hi">
                  Start at the table
                </p>
                <h2 className="mt-1 text-xl font-semibold text-bone">Create or join a room</h2>
                <p className="mt-1 text-sm leading-relaxed text-paper/75">
                  The host opens a room and shares the link. Everyone else enters the five-letter code.
                </p>
              </div>

              <Button
                onClick={createRoom}
                disabled={creating}
                data-testid="create-room"
                variant="brass"
                size="lg"
                className="w-full"
              >
                {creating ? "Opening file…" : "Open a new case"}
              </Button>

              <div className="home-action-divider" aria-hidden="true">or</div>

              <form onSubmit={joinRoom} className="flex flex-col gap-3">
                <label htmlFor="join-code" className="text-xs uppercase tracking-[0.16em] text-smoke">
                  Join with room code
                </label>
                <div className="flex gap-2">
                  <input
                    id="join-code"
                    data-testid="join-code-input"
                    value={joinCode}
                    onChange={(e) => setJoinCode(e.target.value)}
                    maxLength={5}
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="ABCDE"
                    aria-describedby="join-code-hint"
                    className="h-12 min-w-0 flex-1 rounded-md border px-3 text-center text-xl uppercase tracking-[0.3em] text-brass-hi placeholder:text-smoke/60 focus:outline-none"
                  />
                  <Button
                    type="submit"
                    data-testid="join-room"
                    variant="outline"
                    disabled={checking}
                    className="shrink-0 px-4"
                  >
                    {checking ? "Checking…" : "Join"}
                  </Button>
                </div>
                <p id="join-code-hint" className="text-xs text-smoke">
                  Ask the host for the code or scan their QR.
                </p>
              </form>

              {error && (
                <p data-testid="home-error" role="alert" className="text-sm text-blood-hi">
                  {error}
                </p>
              )}
            </div>
          </section>
        </div>

      </main>
      <LandingExplainer />
    </div>
  );
}
