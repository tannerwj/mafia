# Mafia Game

A minimalist, silent web-based Mafia game built with Cloudflare Workers and Durable Objects.

## Features

- **Silent Gameplay**: No chat or voice communication - pure deduction based on voting patterns
- **Real-time Multiplayer**: WebSocket-based real-time game state synchronization
- **Private Rooms**: Invite-only games with unique room codes
- **Core Roles**: Villagers and Mafia (Phase 1 implementation)
- **Clean UI**: Minimalist, card-based interface optimized for clarity

## Game Flow

1. **Lobby Phase**: Players join with a room code and wait for the host to start
2. **Night Phase**: Mafia secretly chooses a target to eliminate
3. **Day Phase**: Results are announced, brief discussion period
4. **Voting Phase**: All players vote to eliminate someone or choose "No Murder"
5. **Resolution**: Votes are tallied, eliminated player's role is revealed
6. **Win Check**: Game ends when Mafia equals/outnumbers Village or all Mafia are eliminated

## Technical Architecture

- **Backend**: Cloudflare Workers with Durable Objects for game state management
- **Frontend**: Vanilla HTML/CSS/JavaScript for maximum performance
- **Real-time**: WebSocket connections for live game updates
- **State Management**: Durable Objects provide persistent, isolated game rooms

## Project Structure

```
mafia/
├── src/
│   ├── worker.js          # Main Cloudflare Worker entry point
│   └── game-room.js       # Durable Object for game state management
├── static/
│   ├── index.html         # Homepage
│   ├── game.html          # Main game interface
│   ├── instructions.html  # Game rules and instructions
│   ├── css/
│   │   └── styles.css     # Main stylesheet
│   └── js/
│       ├── game.js        # Game client logic
│       ├── websocket.js   # WebSocket connection management
│       └── ui.js          # UI management and updates
├── wrangler.toml          # Cloudflare configuration
├── package.json           # Project dependencies
└── README.md              # This file
```

## Development

### Prerequisites

- Node.js 18+
- Cloudflare account
- Wrangler CLI

### Setup

1. Install dependencies:
```bash
npm install
```

2. Configure Cloudflare:
```bash
npx wrangler login
```

3. Start development server:
```bash
npm run dev
```

4. Deploy to production:
```bash
npm run deploy
```

### Local Development

The development server will start at `http://localhost:8787`. You can:

1. Create a new game room
2. Share the room ID with other players
3. Test the full game flow with multiple browser tabs/windows

## Game Rules

### Roles (Phase 1)

- **👨‍🌾 Villager**: Eliminate Mafia through voting
- **🔪 Mafia**: Eliminate villagers until you equal/outnumber them

### Win Conditions

- **Village Wins**: All Mafia eliminated
- **Mafia Wins**: Mafia equals or outnumbers villagers

### Key Features

- **Role Reveal**: Players can check their role anytime with the "👁️ Reveal My Role" button
- **No Murder Option**: Players can vote for "No Murder" to skip elimination
- **Silent Deduction**: Game relies on voting patterns and night outcomes for clues
- **Dead Role Reveal**: Eliminated players' roles are revealed to all

## Future Enhancements (Phase 2+)

- Additional roles (Angel, Detective, Suicide Bomber, Minion)
- Host configuration options (timers, voting visibility)
- Runoff voting for ties
- Game statistics and replay system
- Mobile app version

## Contributing

This project follows the design document specifications for a minimalist Mafia game. When contributing:

1. Maintain the silent gameplay principle
2. Keep the UI clean and uncluttered
3. Ensure real-time synchronization works properly
4. Test with multiple players before submitting

## License

MIT License - see LICENSE file for details.