// Instructions / help modal (Spec 08 D4). Static content, no server
// involvement — reachable from the lobby AND the in-game header via a "?"
// icon (InstructionsButton below). Scrollable: objective, day/night loop,
// tie/vote rules in plain language, and every house role's blurb sourced
// from `roleCopy.ts` (extended with `instructionsBlurb`, not a second
// `roleInfo.ts` — the spec explicitly rejects reintroducing that drift).
import * as Dialog from "@radix-ui/react-dialog";
import { HOUSE_ROLE_IDS, roleCopyFor } from "../lib/roleCopy";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="file-heading text-sm tracking-[0.08em] text-brass-hi">{title}</h3>
      <div className="flex flex-col gap-2 text-sm text-paper/80">{children}</div>
    </section>
  );
}

export function InstructionsContent() {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Objective">
        <p>
          The Village wins once every Mafia member and Minion is eliminated.
          The Mafia team wins once it reaches parity — Mafia and Minions
          together are at least as numerous as everyone else left alive. A
          Suicide Bomber wins alone, instantly, if the village votes them out
          by day.
        </p>
      </Section>

      <Section title="Day and night">
        <p>
          Each round is a night followed by a day. At night, players with a
          night action (Mafia, Detective, Angel) act in secret; everyone else
          sleeps. At dawn, the night's events are revealed. By day, the whole
          village discusses and votes on who to eliminate; the result is
          revealed at dusk, and the cycle repeats.
        </p>
      </Section>

      <Section title="Ties and votes">
        <p>
          The day vote uses plurality (most votes) unless the host configures
          majority (more than half of living players). A tie between
          players triggers a single runoff restricted to the tied players;
          a tie in that runoff — or any tie involving "spare the town" —
          results in peace, nobody eliminated. Abstaining never wins a vote,
          but a single cast vote still beats any number of abstentions.
        </p>
      </Section>

      <Section title="Mafia lock-in">
        <p>
          The Mafia team picks a night target together. Each teammate's
          current pick is visible to the others live, marked "tentative"
          until they lock it in. The kill only happens once the team's
          lock-in rule is satisfied for the game's consensus setting — a
          tentative pick alone never ends the night early.
        </p>
      </Section>

      <Section title="Roles">
        <ul className="flex flex-col gap-3">
          {HOUSE_ROLE_IDS.map((roleId) => {
            const copy = roleCopyFor(roleId);
            return (
              <li key={roleId} data-testid="instructions-role" data-role-id={roleId}>
                <p className="font-bold uppercase tracking-[0.06em] text-bone">
                  {copy.displayName}
                </p>
                <p>{copy.instructionsBlurb ?? copy.blurb}</p>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}

export default function InstructionsModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/90" />
        <Dialog.Content
          data-testid="instructions-modal"
          className="file-frame animate-rise fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-ink-2 p-6 shadow-card"
        >
          <div className="mb-4 flex items-center justify-between">
            <Dialog.Title asChild>
              <h2 className="file-heading text-xl text-blood">Case briefing</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="instructions-close"
                aria-label="Close instructions"
                className="flex h-11 w-11 items-center justify-center rounded-sm border border-frame text-paper"
              >
                ✕
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description asChild>
            <span className="sr-only">
              Objective, day and night loop, voting rules, and every role's
              ability.
            </span>
          </Dialog.Description>
          <div className="overflow-y-auto">
            <InstructionsContent />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
