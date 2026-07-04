# Mafia / Werewolf — Game Design Research Report

*Compiled 2026-07-04 by a research subagent for the rebuild. Feeds Spec 02
(engine/ruleset schema) and Spec 06 (roles v1). Engine-relevant conclusions
are extracted into PLAN.md; this is the full reference.*

---

## 1. Canonical Core Rules

**Origin & premise.** Mafia (a.k.a. Werewolf) was created in 1986 by Dmitry Davidoff. It models a conflict between an **informed minority** (Mafia/Werewolves — know each other) and an **uninformed majority** (Villagers/Town — know only how many Mafia exist). A non-playing **moderator/host** arbitrates. This maps exactly to the host-arbitrates-digitally model.

**The day/night cycle** (two alternating phases):

- **Night** — players "sleep" (in the app: submit hidden actions). The host wakes roles in a fixed order. Mafia silently agree on a kill; power roles (Doctor, Detective, etc.) submit their actions. Traditionally roles are woken one at a time so no one learns others' identities — in a digital app this becomes *simultaneous private submission*, which is cleaner and removes the eyes-closed failure mode entirely.
- **Day** — all survivors discuss, accuse, and vote to eliminate one suspect. Highest vote (or majority — see variations) is eliminated.

**Win conditions:**
- **Town wins** when all Mafia (and any other hostile factions) are eliminated.
- **Mafia wins** when they reach **numerical parity** with the town (Mafia count ≥ non-Mafia count), because at that point they control the vote. Under the strict original rule the game ends *immediately* at parity during the day; a common simplification instead plays until one faction is fully eliminated (easier to explain and run — worth offering as a toggle).
- **Third parties** (Jester, Serial Killer, Survivor, etc.) have independent win conditions that can resolve regardless of the Town/Mafia outcome.

**Recommended player count:** 6–20, sweet spot 10–15.

### Common rule variations (host-configurable toggles)

| Variation | Options | Notes |
|---|---|---|
| **First-night kill** | Kill enabled vs. "no first kill" | Many setups skip N1 kill so Mafia only meet each other; town gets info before losing anyone. |
| **Tie-vote handling** | No-lynch; random among tied; kill all tied; carry a vote-penalty to next day; extend timer (ToS style) | Day-1 no-lynch on tie is popular. Ties favor town early, Mafia late — host should fix the rule up front. |
| **Reveal role on death** | Full reveal / reveal alignment only / no reveal | No-reveal ("closed flip") conceals the Mafia count and raises tension. Janitor role specifically hides a flip. |
| **Open vs. closed setup** | Open (role list public) / semi-open / closed | Whether players know which power roles are in the game. |
| **Mafia kill agreement** | Unanimous vs. majority vs. designated killer (Godfather submits) | Live games often require unanimity; digital games usually let Mafia vote and a factional kill resolves, or a designated Godfather/Mafioso submits the kill. |
| **Day vote threshold** | Simple plurality vs. strict majority | Majority-to-lynch is most common; note that because Mafia also vote in the day, town needs a better-than-1:1 ratio to guarantee a win. |
| **Parity rule** | Immediate Mafia win at parity vs. play-to-elimination | See win conditions above. |

---

## 2. Role Catalog

Alignment key: **T** = Town/Village, **M** = Mafia/Werewolf, **N** = Neutral/Third-party. "Acts" and arbitration complexity noted because these drive the resolution engine.

### Town / Village

| Role | Ability | Acts | Arbitration complexity |
|---|---|---|---|
| **Villager / Vanilla Townie** | None; vote + voice only | Day | None |
| **Detective / Cop / Sheriff** | Investigate one player → alignment (guilty/innocent) | Night | Result is corrupted by Godfather (reads innocent), Framer/Miller (reads guilty), Janitor. Resolve *after* frame/block effects. |
| **Role Cop** | Investigate → exact role (not just alignment) | Night | Same modifiers as Cop. |
| **Seer** (Werewolf) | Investigate → is target a Werewolf? | Night | Werewolf equivalent of Cop. |
| **Doctor / Healer** | Protect one player from a kill that night | Night | Must resolve *before* kills. Can be roleblocked. "Powerful defense" blocks basic attacks but not unstoppable ones. |
| **Bodyguard** | Protect a target; kills the attacker (and may die instead of target) | Night | Resolves at kill step; can trade lives. |
| **Jailkeeper / Jailor** | Protects **and** roleblocks the same target | Night | Combined protect+block — mutual-jail cases are edge cases (see §3). Some versions let Jailor execute by day. |
| **Vigilante** | Kill one player at night (town-side gun) | Night (often not N1) | Adds a second night-kill source; can be blocked/redirected. Often loses ability if it kills town. |
| **Veteran / Paranoid Gun Owner** | Goes on "alert"; kills anyone who visits them that night; gains defense | Night (passive trigger) | Triggered action — resolves against *visitors*, so must know who visited. Kills investigators/doctors who target it. |
| **Tracker** | Learn **who** the target visited | Night | Needs visit graph resolved. Redirects (Bus Driver) change the answer. |
| **Watcher** | Learn **who visited** the target | Night | Same visit-graph dependency. |
| **Mason (group)** | Share a private channel; confirmed non-Mafia to each other | Passive | No night action; a confirmed-town cluster. |
| **Medium** | Speak with / learn from dead players | Night | Interacts with dead-chat system specifically. |
| **Mayor** | Reveals to gain extra vote weight (often 2–3 votes) | Day | Vote-weight math; usually can't be healed after reveal in some rulesets. |
| **Escort / town Roleblocker** | Block a target's night action | Night | High priority — resolves before the blocked action. Mutual-block edge case. |
| **Bus Driver** | Swap two players; actions targeting one hit the other | Night | High complexity — redirects *all* actions on the swapped pair; resolve early. |
| **Hunter** (Werewolf) | On death (day or night), immediately kills a chosen player | Reactive on death | Triggered chain — a Hunter killed at night fires during night resolution; can cause kill chains. |
| **Witch** (Werewolf) | One heal potion + one poison potion, once each all game | Night | Heal resolves at protect step, poison at kill step; consumable one-shots. |
| **Little Girl** (Werewolf) | May "peek" during werewolf phase; risks being caught | Night (passive/risk) | Digitally becomes a probabilistic reveal mechanic rather than literal peeking. |
| **Nurse / Deputy / Universal Backup** | Inherit a power role when its holder dies | Passive/triggered | Role reassignment on death — a state change the engine must handle. |
| **Prince / Bulletproof / Bomb** | Can't be lynched / immune to one night kill / kills their night-killer | Passive | Passive modifiers; Bomb is a triggered retaliatory kill. |

### Mafia / Werewolf side

| Role | Ability | Acts | Arbitration complexity |
|---|---|---|---|
| **Mafioso / Werewolf** | Part of the factional night kill; private Mafia chat | Night | Factional kill is one shared action; decide unanimous vs. majority vs. designated submitter. |
| **Godfather** | Submits/leads the kill; reads **innocent** to Cop; often immune to one kill | Night | Investigation-immunity must override Cop result. |
| **Framer** | Makes a target read **guilty** to investigators until next night | Night | Modifies Cop result — resolve before the investigation. |
| **Lawyer / Consigliere-analog** | Makes a target read innocent, or learns exact role | Night | Consigliere = Mafia Role Cop; Lawyer = inverse Framer. |
| **Janitor** | "Cleans" the Mafia's kill so the victim's role isn't revealed on death | Night | Interacts with reveal-on-death setting; Janitor privately learns the cleaned role. Limited charges. |
| **Roleblocker / Consort** | Block a target's action (Mafia-side) | Night | Same high priority as town roleblocker. |
| **Blackmailer** | Target can't speak the next day | Night → Day | Enforced by chat/mute system. |
| **Strongman** | Mafia kill can't be blocked/redirected | Night (passive on kill) | Overrides protection/block priority for that kill. |
| **Ninja** | Kills without being seen by Watcher/Tracker | Night | Suppresses visit-graph visibility. |
| **Direwolf** | Godfather + Roleblocker combined | Night | Stacked priorities. |

### Neutral / Third-party

| Role | Win condition / ability | Acts | Arbitration complexity |
|---|---|---|---|
| **Serial Killer** | Kill each night; win by being last standing | Night | A third kill source, hostile to *everyone*; usually has basic defense. |
| **Arsonist** | Douse targets, then ignite all doused at once | Night | Two-stage kill; "fire" bypasses normal protection unless Firefighter present. |
| **Jester** | Wins if **lynched by the town** | Day (passive goal) | On lynch, often gets a post-death "haunt" kill of a guilty voter — a reactive kill the engine must fire. |
| **Executioner** | Wins if its **assigned town target is lynched**; becomes Jester if target dies at night | Day (goal) | Needs target assignment at game start and fallback conversion. |
| **Survivor** | Win by simply being alive at game end | Passive | Has defensive "vests" (one-shot self-protects). Wins *alongside* whoever wins. |
| **Cupid / Lovers** | Cupid picks two Lovers N1; if one dies the other dies; lovers win together even across factions | N1 setup, then passive | Linked-death chain and a cross-faction win condition — notable edge case. |
| **Cult Leader / Cultist** | Recruit players into the cult each night; win by converting/outlasting | Night | Recruitment = alignment change; Kill-vs-Recruit ordering matters (kill wins — victim flips original alignment). |
| **Vampire** | Recruit or kill to grow; independent win | Night | Recruitment faction like cult. |
| **Witch / Controller** (ToS neutral) | Control a player — force them to target someone | Night | **Highest-priority redirect**; control-immune roles ignore it. Resolve first. |
| **Amnesiac** | Visit a dead player's role in the graveyard and become that role | Night | Direct interaction with dead-player state. |
| **Guardian Angel** | Protect an assigned target; wins if target survives | Night | Assigned-target protection. |

**Attack/Defense tiers (Town of Salem model — adopt for clean kill resolution):**
- Attack: **Basic → Powerful → Unstoppable**.
- Defense: **None → Basic → Powerful → Invincible**.
- A kill lands only if Attack > Defense. One numeric comparison replaces ad-hoc "does the doctor save them?" logic.

---

## 3. Night Action Resolution Order

Community standard: **Natural Action Resolution (NAR)** from mafiascum (XylBot algorithm). The single most important thing for a digital arbiter to get right.

**The Golden Rule:** *Apply actions that modify other actions before the actions they modify.* Algorithmically: find an action (or passive modifier) whose effect cannot be changed by any other action, resolve it, repeat until done.

**Practical priority ladder** (highest resolves first):

1. **Control / Redirect / Bus Driver** — changes *who* other actions target.
2. **Roleblock** — cancels the target's action entirely.
3. **Protection** (Doctor, Bodyguard, Jailkeeper-protect, vests) — "attempts to kill this player fail tonight."
4. **Kills** (Mafia factional kill, Vigilante, Serial Killer, Veteran-trigger) — treated as happening *simultaneously at end of night*, so a kill doesn't stop the victim's own action from resolving.
5. **Investigations** (Cop, Tracker, Watcher) — resolve **last**, reading the final post-modification state (framed/blocked/redirected).

**Key rules to encode:**
- **Kills don't stop the dead player's action** — everyone "pulls the trigger simultaneously" at end of night. Avoids paradoxes.
- **Roleblock affects only *active* (submitted) actions**, never passives. Rule of thumb: if the player had to submit a choice, it's blockable.
- **Strongman / Ninja / "unstoppable"** override the protection or visibility step for their specific kill.
- **Triggered actions** (Veteran alert, Bomb, Hunter death-shot) fire *between* the targeting step and the triggering action's resolution.
- **Mutual-roleblock rule:** if two roleblockers block each other, *all* actions from the involved players fail (including a Mafia kill they were part of). Decide explicitly.
- **Same-priority tie-break:** resolve **Neutral → Mafia → Town**; for identical role+alignment, a deterministic order (seat/alphabetical) fixed before the game.

**Alternative — Reasonable Action Resolution (RAR):** evaluates each *outcome* by looking only at the actions relevant to it; more forgiving for a human host. **NAR is the recommendation for a code engine** — fully specifiable, no judgment calls. Town of Salem, EpicMafia (~220 roles), and Mafia42 all run deterministic priority engines of this shape.

---

## 4. Role-Count Balance Formulas

- **Original Davidoff rule:** Mafia = **~1/3 of players**, rounded.
- **Andrew Plotkin:** exactly **2 Mafia** regardless of size (small games only).
- **Mathematical result (Migdał 2013, arXiv):** fair Mafia count ∝ **√(total players)** — the 1/3 rule *over-represents* Mafia and the fair fraction shrinks as the game grows.
- **Practical designer consensus:** Mafia ≈ **1/5 to 1/4** of players (~23–25%), up toward 1/3 only when town is power-role heavy.

| Players | 1/3 rule | √n (math-fair) | ~25% (practical) |
|---|---|---|---|
| 9 | 3 | 3 | 2–3 |
| 16 | 5 | 4 | 4 |
| 25 | 8 | 5 | 6 |
| 100 | 33 | 10 | ~25 |

**App default:** `round(√n)` (≈ `round(n×0.25)` at party sizes), host override always. A **balance meter** accounting for power roles is worth building — each strong town role shifts balance townward.

---

## 5. Features of Robust Digital Implementations

From EpicMafia, Town of Salem, Mafia42, Werewolf Online, Plato, forum mafia:

**Dead player experience**
- **Graveyard / dead chat** — separate private channel for the dead; walled off from the living; often published to everyone at game end.
- Dead players can **see all roles/actions** (full god visibility) — keeps eliminated players engaged.
- Role hooks into dead state: Medium, Amnesiac, Retributionist, Psychic.

**Spectators** — live-spectate or replay finished games with full information; read-only, leak-proof channel.

**Timers** — per-phase countdowns; **timers and RNG run server-side** so no client can peek or stall.

**Reconnect / disconnect handling** — heartbeat-based drop detection; **rejoin by session token** restoring role and state; grace period before marking idle; **auto-action/auto-skip defaults** so one dropped phone can't stall the game.

**Host / room controls** — private lobbies with passwords; exact role-list picker; **custom setup builder with saveable/shareable setups** (EpicMafia's gold standard); server-as-narrator prompts; role delivery via per-device link/QR; blackmail/silence *actually enforceable* digitally.

---

## Sources

- [Mafia (party game) — Wikipedia](https://en.wikipedia.org/wiki/Mafia_(party_game))
- [Quick Guide to Mafia — MafiaWiki](https://wiki.mafiascum.net/index.php?title=Quick_Guide_to_Mafia)
- [Natural Action Resolution — MafiaWiki](https://wiki.mafiascum.net/index.php?title=Natural_Action_Resolution)
- [Reasonable Action Resolution — MafiaWiki](https://wiki.mafiascum.net/index.php?title=Reasonable_Action_Resolution)
- [Roleblocker — MafiaWiki](https://wiki.mafiascum.net/index.php?title=Roleblocker)
- [List of roles — MafiaWiki](https://wiki.mafiascum.net/index.php?title=List_of_roles)
- [Character Roles — Werewolf by Stellar Factory](https://playwerewolf.co/pages/character-roles)
- [Detailed overview of roles — Wolfy](https://help.wolfy.net/en/article/detailed-overview-of-roles-x8rylu/)
- [Roles — Town of Salem](https://www.townofsalem.io/roles/); [Attack & Defense — ToS Wiki](https://townofsalem.wiki.gg/wiki/Attributes_(ToS2)); [Alignments — ToS Wiki](https://townofsalem.wiki.gg/wiki/Alignment_(ToS2))
- [A mathematical model of the Mafia game — Migdał, arXiv](https://arxiv.org/pdf/1009.1031)
- [Tie lynch rules — Mafia Maniac Wiki](https://mafiamaniac.fandom.com/wiki/Tie_lynch_rules)
- [Mafia Game Rules — mafia-game.net](https://mafia-game.net/en/rules)
- [Rules and Mechanics — Mafia.gg Wiki](https://mafiagg.fandom.com/wiki/Rules_and_Mechanics)
- [Graveyard — Epic Mafia Wiki](https://epicmafia.fandom.com/wiki/Graveyard); [EpicMafia GitHub](https://github.com/epicmafia-community-org/EpicMafia)
- [Novice Guide — Mafia42 Wiki](https://mafia42.fandom.com/wiki/Novice_Guide)
- [Werewolf on Plato](https://platoapp.com/en/games/werewolf); [Werewolf Online — Google Play](https://play.google.com/store/apps/details?id=com.apphteam.werewolfonline.mafiapartygame)
