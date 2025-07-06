
***

### **Final Design Document: Mafia**

### 1. Core Concept & Vision

**The Goal:** To create a minimalist, streamlined, and private web app for playing Mafia. The app functions as a **silent digital game master**, handling all rules, roles, and turn-based actions, allowing players to focus on pure deduction based on voting patterns and nightly outcomes.

**Key Principles:**
*   **Minimalism:** A clean, uncluttered interface that prioritizes clarity.
*   **Silent Deduction:** The game is played without any chat or voice communication.
*   **Invite-Only:** The experience is designed exclusively for private groups.
*   **Host-Driven Customization:** The game host has control over the game's pacing and rules.
*   **Accessibility:** Clear instructions and intuitive UI features ensure new players can easily understand and play the game.

---

### 2. Key Features

*   **Comprehensive Instructions Page:**
    *   A dedicated, easily accessible page from the homepage.
    *   Explains the objective of the game for each team (Village vs. Mafia).
    *   Details the Day/Night game loop.
    *   Provides clear descriptions of all possible roles (Villager, Mafia, Angel, Detective, Suicide Bomber, Minion) and their abilities.

*   **Game Lobby System:**
    *   **Create Game:** A host creates a new, private game room.
    *   **Unique Room Code/Link:** A shareable link is the only way for players to join.
    *   **Player List:** See who is in the lobby.
    *   **Host Configuration:** Before starting, the host can set up the game:
        *   **Role Selection:** Choose to include/exclude optional roles.
        *   **Rule Modifiers:** Adjust key game rules like **Voting Visibility** (Hidden vs. Real-Time).
        *   **Game Pacing:** Set a **Discussion Timer** (e.g., 60 seconds) for the daytime phase to keep the game moving.
    *   **Start Game Button:** For the host to begin the game.

*   **Core Gameplay Mechanics:**
    *   **Role Assignment & Visibility:**
        *   The server secretly assigns a single role to each player.
        *   Upon game start, your role is clearly displayed, then automatically hidden.
        *   A discreet button (**"Reveal My Role"**) will be permanently available on the UI for you to check your own role at any time.
    *   **Night Actions (Silent Interface):**
        *   **Mafia:** Silent interface to vote on a target.
        *   **Angel:** Selects one player (including themself) to save.
        *   **Detective:** Selects one player to investigate.
        *   **Minions:** Are shown who the Mafia are.
    *   **Day Phase (Silent):**
        *   **Game Log/Announcements:** The app announces night-time events.
        *   **Discussion Phase:** A timed period (set by the host) for silent contemplation.
        *   **Voting System:** A clear UI for players to vote to **murder** a suspect. **There is always an explicit option to vote for "No Murder this round."**

*   **Game State Display:**
    *   A central view of all players and their status (Alive/Dead).
    *   When a player is eliminated, their role is publicly revealed.
    *   Clear indicator of the current phase and day number.

*   **Win/Loss Conditions:**
    *   **Suicide Bomber Win:** Game ends if the Suicide Bomber is murdered by the Village's day vote.
    *   **Mafia/Minion Win:** When their team's numbers equal or exceed the Village's.
    *   **Village Win:** When all Mafia and Minions are eliminated.

---

### 3. User Flow & Game Loop

1.  **Homepage:** User sees options: "Create Game," "Join Game," or "View Instructions."
2.  **Lobby:** Host configures rules, roles, and timers. Players join via link. Host starts the game.
3.  **Game Start:** Your role is displayed, then hidden. The "Reveal My Role" button appears.
4.  **Night Phase:** Players with actions perform them via a simple, silent interface.
5.  **Day Phase Begins:**
    *   The Game Log announces the night's events.
    *   The **Discussion Phase** begins, with a visible timer set by the host.
6.  **Voting Phase:**
    *   The discussion timer ends. The voting UI appears.
    *   Players vote for a player to murder, or vote for the "No Murder" option.
7.  **Vote Resolution:**
    *   Votes are tallied.
    *   **Clear Outcome:** If one player or the "No Murder" option has the most votes, the result is announced. If a player is chosen, they are murdered. If "No Murder" wins, the game proceeds to night.
    *   **Tied Vote:** If two or more *players* are tied for the most votes (and this count is higher than the "No Murder" votes), a **Runoff Vote** is triggered between only those tied players. If a player is tied with the "No Murder" option, the tie goes to peace and no one is murdered.
8.  **Murder Reveal:** If a player was murdered, the app announces it and reveals their role.
9.  **Win Condition Check:** The app checks if any team has won.
    *   If yes -> **Game End Screen**.
    *   If no -> Loop back to **Night Phase (Step 4)**.
10. **Game End:** A victory/defeat screen appears with options to "Play Again" or "Return to Lobby."

---

### 4. UI/UX & Technical Stack

*   **UI/UX:** Focus on a minimal, card-based layout. The **Instructions Page** should be a clean, scrollable view with distinct sections. The **"Reveal My Role"** button could be an icon (e.g., a masked face, an eye) that reveals the role card on press-and-hold to prevent accidental clicks.
*   **Technical Stack:** Unchanged. **Cloudflare Workers** with **Durable Objects** and **WebSockets** remains the ideal architecture.

---

### 5. Game Logic & Rules Summary

| Feature               | Rule                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| **Terminology**       | **Villagers** (not Townspeople). **Murdered** (not Lynched).                                            |
| **Role Visibility**   | Role shown at start, then hidden. A "Reveal My Role" button is always available for the player.       |
| **Daytime Pacing**    | Host can set a **Discussion Timer** for the silent contemplation period before the vote.                 |
| **Daytime Voting**    | Players can always vote for another player or for the **"No Murder"** option.                          |
| **Angel's Power**     | The Angel can save themself.                                                                          |
| **Voting Visibility** | Host option: **Hidden Until Tally** (default) or **Real-Time**.                                         |
| **Tied Vote**         | A tie between players triggers a runoff. A tie involving the "No Murder" option results in no murder. |