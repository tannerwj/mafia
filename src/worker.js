import { GameRoom } from './game-room.js';

export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle static file requests
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(await getStaticFile('index.html'), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    if (url.pathname === '/game.html') {
      return new Response(await getStaticFile('game.html'), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    if (url.pathname === '/instructions.html') {
      return new Response(await getStaticFile('instructions.html'), {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    if (url.pathname === '/css/styles.css') {
      return new Response(await getStaticFile('css/styles.css'), {
        headers: { 'Content-Type': 'text/css' }
      });
    }
    
    if (url.pathname === '/js/game.js') {
      return new Response(await getStaticFile('js/game.js'), {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    
    if (url.pathname === '/js/websocket.js') {
      return new Response(await getStaticFile('js/websocket.js'), {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }
    
    if (url.pathname === '/js/ui.js') {
      return new Response(await getStaticFile('js/ui.js'), {
        headers: { 'Content-Type': 'application/javascript' }
      });
    }

    // API endpoints
    if (url.pathname === '/api/create-room') {
      return await handleCreateRoom(env);
    }
    
    if (url.pathname === '/api/join-room') {
      return await handleJoinRoom(request, env);
    }

    // Game room routes - delegate to Durable Object
    if (url.pathname.startsWith('/room/')) {
      const roomId = url.pathname.split('/')[2];
      if (!roomId) {
        return new Response('Room ID required', { status: 400 });
      }
      
      const id = env.GAME_ROOM.idFromName(roomId);
      const gameRoom = env.GAME_ROOM.get(id);
      
      // Forward the request to the Durable Object
      const newUrl = new URL(request.url);
      newUrl.pathname = url.pathname.replace(`/room/${roomId}`, '');
      const newRequest = new Request(newUrl, request);
      
      return await gameRoom.fetch(newRequest);
    }

    return new Response('Not found', { status: 404 });
  }
};

async function handleCreateRoom(env) {
  try {
    // Generate a unique room ID for users to share
    const roomId = crypto.randomUUID();
    // Use idFromName to create a Durable Object ID from the room name
    const id = env.GAME_ROOM.idFromName(roomId);
    const gameRoom = env.GAME_ROOM.get(id);
    
    // Initialize the room
    await gameRoom.fetch(new Request('http://localhost/create'));
    
    return new Response(JSON.stringify({
      success: true,
      roomId: roomId,
      joinUrl: `/game.html?room=${roomId}`
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.log('error', error)
    return new Response(JSON.stringify({
      success: false,
      error: 'Failed to create room'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function handleJoinRoom(request, env) {
  try {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId');
    
    if (!roomId) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Room ID required'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const id = env.GAME_ROOM.idFromName(roomId);
    const gameRoom = env.GAME_ROOM.get(id);
    
    const response = await gameRoom.fetch(new Request('http://localhost/join'));
    const result = await response.json();
    
    if (result.phase === 'lobby') {
      return new Response(JSON.stringify({
        success: true,
        roomId: roomId,
        joinUrl: `/game.html?room=${roomId}`
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: 'Game already in progress'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Room not found'
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function getStaticFile(path) {
  // In a real deployment, you'd serve these from Cloudflare's static assets
  // For development, we'll return basic HTML/CSS/JS content
  
  const files = {
    'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mafia Game</title>
    <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>🎭 Mafia Game</h1>
            <p>A minimalist, silent deduction game</p>
        </header>
        
        <main>
            <div class="menu-options">
                <div class="create-game-section">
                    <button id="create-game-btn" class="primary-btn">Create Game</button>
                </div>
                <div class="join-game-section">
                    <input type="text" id="room-id-input" placeholder="Enter Room ID">
                    <button id="join-game-btn" class="secondary-btn">Join Game</button>
                </div>
                <a href="/instructions.html" class="instructions-link">📖 How to Play</a>
            </div>
            
            <div id="loading" class="hidden">
                <p>Creating room...</p>
            </div>
            
            <div id="error-message" class="error hidden"></div>
        </main>
    </div>
    
    <script>
        document.getElementById('create-game-btn').addEventListener('click', async () => {
            const hostName = 'host';
            const loading = document.getElementById('loading');
            const errorMsg = document.getElementById('error-message');
            
            loading.classList.remove('hidden');
            errorMsg.classList.add('hidden');
            
            try {
                const response = await fetch('/api/create-room', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ hostName: hostName })
                });
                const result = await response.json();
                
                if (result.success) {
                    // Store host status in localStorage
                    const roomId = result.roomId; // Use the roomId directly from the response
                    localStorage.setItem('mafiaHostStatus', JSON.stringify({
                        roomId: roomId,
                        hostName: hostName,
                        isHost: true
                    }));
                    
                    // Navigate to game without URL parameters
                    window.location.href = result.joinUrl;
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                errorMsg.textContent = 'Failed to create game: ' + error.message;
                errorMsg.classList.remove('hidden');
            } finally {
                loading.classList.add('hidden');
            }
        });
        
        document.getElementById('join-game-btn').addEventListener('click', async () => {
            const roomId = document.getElementById('room-id-input').value.trim();
            const errorMsg = document.getElementById('error-message');
            
            if (!roomId) {
                errorMsg.textContent = 'Please enter a room ID';
                errorMsg.classList.remove('hidden');
                return;
            }
            
            errorMsg.classList.add('hidden');
            
            try {
                const response = await fetch(\`/api/join-room?roomId=\${roomId}\`);
                const result = await response.json();
                
                if (result.success) {
                    window.location.href = result.joinUrl;
                } else {
                    throw new Error(result.error);
                }
            } catch (error) {
                errorMsg.textContent = 'Failed to join game: ' + error.message;
                errorMsg.classList.remove('hidden');
            }
        });
        
        document.getElementById('room-id-input').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                document.getElementById('join-game-btn').click();
            }
        });
    </script>
</body>
</html>`,

    'game.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mafia Game - Room</title>
    <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>🎭 Mafia Game</h1>
            <div class="game-info">
                <span id="player-name-display" class="player-name"></span>
                <span id="room-id"></span>
                <span id="phase-indicator"></span>
                <span id="day-counter"></span>
            </div>
        </header>
        
        <main>
            <!-- Lobby Phase -->
            <div id="lobby-phase" class="game-phase">
                <h2>Game Lobby</h2>
                
                <!-- Host Settings Panel -->
                <div id="host-settings" class="host-panel hidden">
                    <h3>🎮 Host Settings</h3>
                    
                    <!-- Shareable Link -->
                    <div class="share-section">
                        <label>Share this link with players:</label>
                        <div class="share-link-container">
                            <input type="text" id="share-link" readonly>
                            <button id="copy-link-btn" class="secondary-btn">📋 Copy</button>
                        </div>
                    </div>
                    
                    <div class="settings-grid">
                        <div class="setting-item">
                            <label for="game-duration">Day Phase Duration:</label>
                            <select id="game-duration">
                                <option value="0" selected>Unlimited</option>
                                <option value="60">1 minute</option>
                                <option value="120">2 minutes</option>
                                <option value="180">3 minutes</option>
                                <option value="300">5 minutes</option>
                            </select>
                        </div>
                        <div class="setting-item">
                            <button id="share-lobby-btn" class="secondary-btn">📤 Share Lobby</button>
                        </div>
                    </div>
                    
                    <!-- Role Configuration -->
                    <div class="role-config-section">
                        <h4>🎭 Role Configuration</h4>
                        <div class="role-settings-grid">
                            <div class="setting-item">
                                <label for="mafia-count">Mafia Count:</label>
                                <select id="mafia-count">
                                    <option value="auto" selected>Auto</option>
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                    <option value="3">3</option>
                                </select>
                            </div>
                            <div class="setting-item">
                                <label for="detective-count">Detective Count:</label>
                                <select id="detective-count">
                                    <option value="0" selected>0</option>
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                </select>
                            </div>
                            <div class="setting-item">
                                <label for="angel-count">Angel Count:</label>
                                <select id="angel-count">
                                    <option value="0" selected>0</option>
                                    <option value="1">1</option>
                                    <option value="2">2</option>
                                </select>
                            </div>
                            <div class="setting-item">
                                <label for="suicide-bomber">Suicide Bomber:</label>
                                <select id="suicide-bomber">
                                    <option value="false" selected>Disabled</option>
                                    <option value="true">Enabled</option>
                                </select>
                            </div>
                            <div class="setting-item">
                                <label for="minion">Minion:</label>
                                <select id="minion">
                                    <option value="false" selected>Disabled</option>
                                    <option value="true">Enabled</option>
                                </select>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Host Controls -->
                    <div class="host-controls">
                        <button id="start-game-btn" class="primary-btn hidden">Start Game</button>
                    </div>
                </div>
                
                <div class="players-list">
                    <h3>Players:</h3>
                    <ul id="lobby-players"></ul>
                </div>
                
                <div class="lobby-controls">
                    <input type="text" id="player-name-input" placeholder="Enter your name" maxlength="20">
                    <button id="join-lobby-btn" class="primary-btn">Join Game</button>
                </div>
            </div>
            
            <!-- Game Phase -->
            <div id="game-phase" class="game-phase hidden">
                <div class="game-controls">
                    <button id="reveal-role-btn" class="role-btn">👁️ Reveal My Role</button>
                </div>
                
                <div class="players-grid">
                    <h3>Players:</h3>
                    <div id="players-list"></div>
                </div>
                
                <!-- Night Phase -->
                <div id="night-phase" class="phase-content">
                    <h3>🌙 Night Phase</h3>
                    <div id="night-actions"></div>
                </div>
                
                <!-- Day Phase -->
                <div id="day-phase" class="phase-content">
                    <h3>☀️ Day Phase</h3>
                    <div id="day-timer"></div>
                </div>
                
                <!-- Voting Phase -->
                <div id="voting-phase" class="phase-content">
                    <h3>🗳️ Voting Phase</h3>
                    <div id="voting-options"></div>
                </div>
                
                <!-- Game Log -->
                <div class="game-log">
                    <h3>Game Log:</h3>
                    <div id="game-log-content"></div>
                </div>
            </div>
            
            <!-- Game End Phase -->
            <div id="end-phase" class="game-phase hidden">
                <h2 id="game-result"></h2>
                <div class="final-players">
                    <h3>Final Results:</h3>
                    <div id="final-players-list"></div>
                </div>
                <div class="end-controls">
                    <button id="new-game-btn" class="primary-btn">New Game</button>
                    <a href="/" class="secondary-btn">Home</a>
                </div>
            </div>
            
            <div id="error-message" class="error hidden"></div>
            <div id="role-modal" class="modal hidden">
                <div class="modal-content">
                    <h3>Your Role</h3>
                    <div id="role-display"></div>
                    <button id="close-role-modal" class="secondary-btn">Close</button>
                </div>
            </div>
        </main>
    </div>
    
    <script src="/js/websocket.js"></script>
    <script src="/js/ui.js"></script>
    <script src="/js/game.js"></script>
</body>
</html>`,

    'instructions.html': `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mafia Game - Instructions</title>
    <link rel="stylesheet" href="/css/styles.css">
</head>
<body>
    <div class="container">
        <header>
            <h1>🎭 How to Play Mafia</h1>
            <a href="/" class="back-link">← Back to Home</a>
        </header>
        
        <main class="instructions">
            <section>
                <h2>🎯 Objective</h2>
                <div class="team-objectives">
                    <div class="team">
                        <h3>👥 Village Team</h3>
                        <p>Eliminate all Mafia members through voting during the day phase.</p>
                    </div>
                    <div class="team">
                        <h3>🔪 Mafia Team</h3>
                        <p>Eliminate villagers until you equal or outnumber them.</p>
                    </div>
                </div>
            </section>
            
            <section>
                <h2>🔄 Game Flow</h2>
                <div class="game-flow">
                    <div class="phase">
                        <h3>🌙 Night Phase</h3>
                        <p>Mafia members secretly choose a villager to eliminate. Other special roles may also act during this phase.</p>
                    </div>
                    <div class="phase">
                        <h3>☀️ Day Phase</h3>
                        <p>The results of the night are announced. Players have time for silent contemplation and observation.</p>
                    </div>
                    <div class="phase">
                        <h3>🗳️ Voting Phase</h3>
                        <p>All players vote to eliminate someone they suspect is Mafia, or vote for "No Murder" to skip elimination.</p>
                    </div>
                </div>
            </section>
            
            <section>
                <h2>👤 Roles (Phase 1)</h2>
                <div class="roles">
                    <div class="role">
                        <h3>👨‍🌾 Villager</h3>
                        <p><strong>Team:</strong> Village</p>
                        <p><strong>Goal:</strong> Eliminate all Mafia through voting</p>
                        <p><strong>Abilities:</strong> Vote during day phase</p>
                    </div>
                    <div class="role">
                        <h3>🔪 Mafia</h3>
                        <p><strong>Team:</strong> Mafia</p>
                        <p><strong>Goal:</strong> Equal or outnumber the Village</p>
                        <p><strong>Abilities:</strong> Kill one villager each night, vote during day phase</p>
                    </div>
                </div>
            </section>
            
            <section>
                <h2>🏆 Win Conditions</h2>
                <ul>
                    <li><strong>Village Wins:</strong> All Mafia members are eliminated</li>
                    <li><strong>Mafia Wins:</strong> Mafia equals or outnumbers the remaining villagers</li>
                </ul>
            </section>
            
            <section>
                <h2>📋 Game Rules</h2>
                <ul>
                    <li>This is a <strong>silent game</strong> - no chat or voice communication</li>
                    <li>Use the "👁️ Reveal My Role" button to check your role at any time</li>
                    <li>Pay attention to voting patterns and night outcomes for clues</li>
                    <li>You can always vote for "No Murder" if you're unsure</li>
                    <li>When eliminated, your role is revealed to all players</li>
                    <li>Dead players cannot vote or take actions</li>
                </ul>
            </section>
            
            <section>
                <h2>💡 Strategy Tips</h2>
                <ul>
                    <li><strong>For Villagers:</strong> Watch for suspicious voting patterns and try to identify the Mafia</li>
                    <li><strong>For Mafia:</strong> Blend in with the villagers and avoid drawing suspicion</li>
                    <li><strong>General:</strong> The game is about deduction - use all available information wisely</li>
                </ul>
            </section>
        </main>
    </div>
</body>
</html>`,

    'css/styles.css': `/* Reset and base styles */
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    line-height: 1.6;
    color: #333;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
}

.container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 20px;
}

/* Header */
header {
    text-align: center;
    margin-bottom: 2rem;
    color: white;
}

header h1 {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
    text-shadow: 2px 2px 4px rgba(0,0,0,0.3);
}

header p {
    font-size: 1.1rem;
    opacity: 0.9;
}

.game-info {
    display: flex;
    justify-content: center;
    gap: 2rem;
    margin-top: 1rem;
    font-size: 0.9rem;
}

.game-info span {
    background: rgba(255,255,255,0.2);
    padding: 0.5rem 1rem;
    border-radius: 20px;
    backdrop-filter: blur(10px);
}

/* Main content */
main {
    background: white;
    border-radius: 15px;
    padding: 2rem;
    box-shadow: 0 10px 30px rgba(0,0,0,0.2);
    backdrop-filter: blur(10px);
}

/* Buttons */
.primary-btn, .secondary-btn {
    padding: 12px 24px;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    cursor: pointer;
    transition: all 0.3s ease;
    text-decoration: none;
    display: inline-block;
    text-align: center;
}

.primary-btn {
    background: #667eea;
    color: white;
}

.primary-btn:hover {
    background: #5a6fd8;
    transform: translateY(-2px);
}

.secondary-btn {
    background: #f8f9fa;
    color: #333;
    border: 2px solid #dee2e6;
}

.secondary-btn:hover {
    background: #e9ecef;
    transform: translateY(-2px);
}

.role-btn {
    background: #28a745;
    color: white;
    padding: 10px 20px;
    border: none;
    border-radius: 25px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.3s ease;
}

.role-btn:hover {
    background: #218838;
    transform: scale(1.05);
}

/* Menu options */
.menu-options {
    text-align: center;
    max-width: 400px;
    margin: 0 auto;
}

.menu-options > * {
    margin-bottom: 1.5rem;
    width: 100%;
}

.create-game-section, .join-game-section {
    display: flex;
    gap: 10px;
}

.create-game-section input, .join-game-section input {
    flex: 1;
    padding: 12px;
    border: 2px solid #dee2e6;
    border-radius: 8px;
    font-size: 1rem;
}

.create-game-section button, .join-game-section button {
    flex-shrink: 0;
}

.instructions-link {
    color: #667eea;
    text-decoration: none;
    font-weight: 500;
    font-size: 1.1rem;
}

.instructions-link:hover {
    text-decoration: underline;
}

/* Game phases */
.game-phase {
    min-height: 400px;
}

.hidden {
    display: none !important;
}

/* Players */
.players-list, .players-grid {
    margin: 1.5rem 0;
}

.players-list ul {
    list-style: none;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
}

.players-list li, .player-card {
    background: #f8f9fa;
    padding: 1rem;
    border-radius: 8px;
    border: 2px solid #dee2e6;
    text-align: center;
}

.player-card.dead {
    background: #f8d7da;
    border-color: #f5c6cb;
    opacity: 0.7;
}

.player-card.dead::after {
    content: " ☠️";
}

/* Host Panel */
.host-panel {
    background: rgba(102, 126, 234, 0.1);
    border: 2px solid rgba(102, 126, 234, 0.3);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 2rem;
}

.host-panel h3 {
    color: #667eea;
    margin-bottom: 1rem;
    text-align: center;
    font-size: 1.2rem;
}

.settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
}

.setting-item {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
}

.setting-item label {
    font-weight: 600;
    color: #333;
    font-size: 0.9rem;
}

.setting-item select {
    padding: 8px 12px;
    border: 2px solid #dee2e6;
    border-radius: 6px;
    background: white;
    font-size: 0.9rem;
    cursor: pointer;
}

.setting-item select:focus {
    outline: none;
    border-color: #667eea;
}

.share-section {
    margin-bottom: 1.5rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid #dee2e6;
}

.share-section label {
    display: block;
    font-weight: 600;
    color: #333;
    margin-bottom: 0.5rem;
    font-size: 0.9rem;
}

.share-link-container {
    display: flex;
    gap: 0.5rem;
}

.share-link-container input {
    flex: 1;
    padding: 8px 12px;
    border: 2px solid #dee2e6;
    border-radius: 6px;
    background: #f8f9fa;
    font-size: 0.85rem;
    font-family: monospace;
}

.share-link-container button {
    padding: 8px 12px;
    font-size: 0.8rem;
    white-space: nowrap;
}

/* Host Controls */
.host-controls {
    text-align: center;
    padding-top: 1rem;
    border-top: 1px solid #dee2e6;
    margin-top: 1rem;
}

.host-controls .primary-btn {
    min-width: 150px;
    font-weight: 600;
}

/* Lobby */
.lobby-controls {
    text-align: center;
    max-width: 400px;
    margin: 2rem auto;
}

.lobby-controls input {
    width: 100%;
    padding: 12px;
    border: 2px solid #dee2e6;
    border-radius: 8px;
    font-size: 1rem;
    margin-bottom: 1rem;
}

/* Game controls */
.game-controls {
    text-align: center;
    margin-bottom: 2rem;
}

/* Phase content */
.phase-content {
    margin: 2rem 0;
    padding: 1.5rem;
    background: #f8f9fa;
    border-radius: 8px;
    border-left: 4px solid #667eea;
}

/* Night actions */
#night-actions {
    text-align: center;
}

.target-selection {
    margin: 1rem 0;
}

.target-selection h4 {
    margin-bottom: 1rem;
}

.target-buttons {
display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 0.5rem;
}

.target-btn {
    padding: 10px;
    border: 2px solid #dee2e6;
    background: white;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.3s ease;
}

.target-btn:hover {
    background: #e9ecef;
    border-color: #667eea;
}

.target-btn.selected {
    background: #667eea;
    color: white;
    border-color: #667eea;
}

/* Role coordination styles */
.role-coordination {
    background: #f8f9fa;
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 20px;
}

.rolemates-section {
    margin-bottom: 20px;
    padding: 15px;
    background: #e9ecef;
    border-radius: 6px;
}

.rolemates-section h4 {
    margin: 0 0 10px 0;
    color: #495057;
}

.rolemates-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}

.rolemate {
    background: #6c757d;
    color: white;
    padding: 4px 12px;
    border-radius: 15px;
    font-size: 0.9em;
    font-weight: 500;
}

.voting-status {
    margin: 15px 0;
    padding: 10px;
    background: #fff3cd;
    border: 1px solid #ffeaa7;
    border-radius: 4px;
}

.voting-status h5 {
    margin: 0 0 8px 0;
    color: #856404;
}

.vote-tally {
    font-size: 0.9em;
    color: #856404;
    margin: 2px 0;
}

/* Voting */
#voting-options {
    text-align: center;
}

.vote-buttons {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 1rem;
    margin: 1rem 0;
}

.vote-btn {
    padding: 15px;
    border: 2px solid #dee2e6;
    background: white;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.3s ease;
    font-size: 1rem;
}

.vote-btn:hover {
    background: #e9ecef;
    border-color: #667eea;
    transform: translateY(-2px);
}

.vote-btn.selected {
    background: #667eea;
    color: white;
    border-color: #667eea;
}

.no-murder-btn {
    background: #28a745 !important;
    color: white !important;
    border-color: #28a745 !important;
}

.no-murder-btn:hover {
    background: #218838 !important;
    border-color: #218838 !important;
}

/* Game log */
.game-log {
    margin-top: 2rem;
    padding: 1.5rem;
    background: #f8f9fa;
    border-radius: 8px;
    max-height: 300px;
    overflow-y: auto;
}

.game-log h3 {
    margin-bottom: 1rem;
    color: #667eea;
}

.log-entry {
    padding: 0.5rem 0;
    border-bottom: 1px solid #dee2e6;
}

.log-entry:last-child {
    border-bottom: none;
}

/* Modal */
.modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0,0,0,0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
}

.modal-content {
    background: white;
    padding: 2rem;
    border-radius: 15px;
    text-align: center;
    max-width: 400px;
    width: 90%;
    box-shadow: 0 10px 30px rgba(0,0,0,0.3);
}

.modal-content h3 {
    margin-bottom: 1rem;
    color: #667eea;
}

#role-display {
    font-size: 1.5rem;
    padding: 1rem;
    background: #f8f9fa;
    border-radius: 8px;
    margin: 1rem 0;
    border: 2px solid #667eea;
}

/* Instructions */
.instructions {
    max-width: 800px;
    margin: 0 auto;
}

.instructions section {
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid #dee2e6;
}

.instructions section:last-child {
    border-bottom: none;
}

.instructions h2 {
    color: #667eea;
    margin-bottom: 1rem;
}

.team-objectives, .game-flow, .roles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1.5rem;
    margin: 1rem 0;
}

.team, .phase, .role {
    background: #f8f9fa;
    padding: 1.5rem;
    border-radius: 8px;
    border-left: 4px solid #667eea;
}

.team h3, .phase h3, .role h3 {
    margin-bottom: 0.5rem;
    color: #333;
}

.instructions ul {
    margin-left: 1.5rem;
}

.instructions li {
    margin-bottom: 0.5rem;
}

.back-link {
    color: white;
    text-decoration: none;
    opacity: 0.9;
    font-size: 1rem;
}

.back-link:hover {
    opacity: 1;
    text-decoration: underline;
}

/* Error messages */
.error {
    background: #f8d7da;
    color: #721c24;
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid #f5c6cb;
    margin: 1rem 0;
    text-align: center;
}

/* Loading */
#loading {
    text-align: center;
    padding: 2rem;
    color: #667eea;
}

/* Responsive design */
@media (max-width: 768px) {
    .container {
        padding: 10px;
    }
    
    header h1 {
        font-size: 2rem;
    }
    
    .game-info {
        flex-direction: column;
        gap: 0.5rem;
    }
    
    .join-game-section {
        flex-direction: column;
    }
    
    .team-objectives, .game-flow, .roles {
        grid-template-columns: 1fr;
    }
    
    .vote-buttons, .target-buttons {
        grid-template-columns: 1fr;
    }
}

/* Role Configuration */
.role-config-section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid #dee2e6;
}

.role-config-section h4 {
    color: #667eea;
    margin-bottom: 1rem;
    font-size: 1rem;
    text-align: center;
}

.role-settings-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
}`,

    'js/websocket.js': `class WebSocketManager {
    constructor() {
        this.ws = null;
        this.roomId = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 1000;
        this.messageHandlers = new Map();
    }

    connect(roomId) {
        this.roomId = roomId;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = \`\${protocol}//\${window.location.host}/room/\${roomId}/websocket\`;
        
        try {
            this.ws = new WebSocket(wsUrl);
            this.setupEventHandlers();
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.handleConnectionError();
        }
    }

    setupEventHandlers() {
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            this.onConnectionStatusChange(true);
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            } catch (error) {
                console.error('Failed to parse WebSocket message:', error);
            }
        };

        this.ws.onclose = (event) => {
            console.log('WebSocket disconnected:', event.code, event.reason);
            this.onConnectionStatusChange(false);
            
            if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
                this.attemptReconnect();
            }
        };

        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            this.handleConnectionError();
        };
    }

    handleMessage(message) {
        const handler = this.messageHandlers.get(message.type);
        if (handler) {
            handler(message);
        } else {
            console.warn('No handler for message type:', message.type);
        }
    }

    onMessage(type, handler) {
        this.messageHandlers.set(type, handler);
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        } else {
            console.warn('WebSocket not connected, message not sent:', message);
            return false;
        }
    }

    attemptReconnect() {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        
        console.log(\`Attempting to reconnect in \${delay}ms (attempt \${this.reconnectAttempts}/\${this.maxReconnectAttempts})\`);
        
        setTimeout(() => {
            if (this.roomId) {
                this.connect(this.roomId);
            }
        }, delay);
    }

    handleConnectionError() {
        this.onConnectionStatusChange(false);
    }

    onConnectionStatusChange(connected) {
        // Override this method to handle connection status changes
        console.log('Connection status changed:', connected);
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

window.WebSocketManager = WebSocketManager;`,

    'js/ui.js': `class UIManager {
    constructor() {
        this.currentPhase = 'lobby';
        this.playerRole = null;
        this.gameState = null;
    }

    showPhase(phase) {
        // Hide all phases
        document.querySelectorAll('.game-phase').forEach(el => {
            el.classList.add('hidden');
        });

        // Show current phase
        const phaseElement = document.getElementById(\`\${phase}-phase\`);
        if (phaseElement) {
            phaseElement.classList.remove('hidden');
        }

        this.currentPhase = phase;
    }

    updateGameInfo(gameState, playerName = null, isDead = false) {
        const roomIdEl = document.getElementById('room-id');
        const phaseEl = document.getElementById('phase-indicator');
        const dayEl = document.getElementById('day-counter');
        const playerNameEl = document.getElementById('player-name-display');

        if (playerNameEl && playerName) {
            if (isDead) {
                playerNameEl.textContent = \`💀 \${playerName} (DEAD)\`;
                playerNameEl.style.color = '#ff4444';
                playerNameEl.style.fontWeight = 'bold';
            } else {
                playerNameEl.textContent = \`👤 \${playerName}\`;
                playerNameEl.style.color = '';
                playerNameEl.style.fontWeight = '';
            }
        }

        if (roomIdEl) {
            roomIdEl.textContent = \`Room: \${gameState.roomId || 'Unknown'}\`;
        }

        if (phaseEl) {
            const phaseText = {
                'lobby': '⏳ Lobby',
                'night': '🌙 Night',
                'day': '☀️ Day',
                'voting': '🗳️ Voting',
                'ended': '🏁 Game Over'
            };
            phaseEl.textContent = phaseText[gameState.phase] || gameState.phase;
        }

        if (dayEl && gameState.day > 0) {
            dayEl.textContent = \`Day \${gameState.day}\`;
        }
    }

    hideNightActions() {
        const container = document.getElementById('night-actions');
        if (container) {
            container.innerHTML = '';
        }
    }

    updatePlayersList(players, isLobby = false, isHost = false, hostId = null) {
        const containerId = isLobby ? 'lobby-players' : 'players-list';
        const container = document.getElementById(containerId);
        
        if (!container) return;

        if (isLobby) {
            container.innerHTML = '';
            players.forEach(player => {
                const li = document.createElement('li');
                
                if (isHost && player.id !== hostId) {
                    // Host view with kick functionality
                    li.className = 'player-item';
                    li.innerHTML = \`
                        <span>\${player.name}</span>
                        <button class="kick-btn" onclick="window.gameManager.kickPlayer('\${player.id}')">Kick</button>
                    \`;
                } else {
                    // Regular player view or host's own entry
                    li.textContent = player.name;
                    if (player.id === hostId) {
                        li.textContent += ' 👑'; // Crown for host
                    }
                }
                container.appendChild(li);
            });
        } else {
            // Create compact comma-delimited list
            const playerStrings = players.map(player => {
                if (player.alive) {
                    return \`<strong>\${player.name}</strong>\`;
                } else {
                    return \`<strong style="text-decoration: line-through; opacity: 0.6;">\${player.name}</strong> <small>(\${player.role})</small>\`;
                }
            });
            
            container.innerHTML = \`<p>\${playerStrings.join(', ')}</p>\`;
        }
    }

    showHostSettings(isVisible, roomId = null) {
        console.log('showHostSettings called:', { isVisible, roomId }); // Debug
        const hostPanel = document.getElementById('host-settings');
        console.log('Host panel element:', hostPanel); // Debug
        
        if (hostPanel) {
            if (isVisible) {
                console.log('Making host panel visible'); // Debug
                hostPanel.classList.remove('hidden');
                hostPanel.style.display = 'block';
                
                // Set up share link
                if (roomId) {
                    const shareLink = document.getElementById('share-link');
                    if (shareLink) {
                        const baseUrl = window.location.origin;
                        const joinUrl = \`\${baseUrl}/game.html?room=\${roomId}\`;
                        shareLink.value = joinUrl;
                        console.log('Share link set to:', joinUrl); // Debug
                    }
                }
            } else {
                console.log('Hiding host panel'); // Debug
                hostPanel.classList.add('hidden');
                hostPanel.style.display = 'none';
            }
        } else {
            console.error('Host panel element not found!'); // Debug
        }
    }

    showHostStartButton(show, playerCount = 0) {
        const startBtn = document.getElementById('start-game-btn');
        if (startBtn) {
            if (show && playerCount >= 2) { // Minimum 2 players for a game
                startBtn.classList.remove('hidden');
                startBtn.style.display = 'block';
            } else {
                startBtn.classList.add('hidden');
                startBtn.style.display = 'none';
            }
        }
    }

    updateGameLog(gameLog) {
        const container = document.getElementById('game-log-content');
        if (!container) return;

        container.innerHTML = '';
        gameLog.forEach(entry => {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.textContent = entry;
            container.appendChild(div);
        });

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    showNightActions(playerRole, alivePlayers, rolemates = [], nightActionState = null) {
        const container = document.getElementById('night-actions');
        if (!container) return;

        container.innerHTML = '';

        if (playerRole === 'mafia') {
            this.showMafiaInterface(container, alivePlayers, rolemates, nightActionState);
        } else if (playerRole === 'detective') {
            this.showDetectiveInterface(container, alivePlayers, rolemates, nightActionState);
        } else if (playerRole === 'angel') {
            this.showAngelInterface(container, alivePlayers, rolemates, nightActionState);
        } else {
            container.innerHTML = '<p>🌙 Night time. The special roles are making their moves...</p>';
        }
    }

    showMafiaInterface(container, alivePlayers, mafiaMembers, nightActionState) {
        const div = document.createElement('div');
        div.className = 'role-coordination';
        
        // Always show mafia team members (including self)
        let mafiaListHtml = '';
        if (mafiaMembers.length >= 1) {
            mafiaListHtml = \`
                <div class="rolemates-section">
                    <h4>🔪 Your Mafia Team:</h4>
                    <div class="rolemates-list">
                        \${mafiaMembers.map(member => \`<span class="rolemate">\${member.name}</span>\`).join('')}
                    </div>
                </div>
            \`;
        }

        // Show current votes if any
        let votingStatusHtml = '';
        if (nightActionState && nightActionState.mafiaVotes) {
            const votes = nightActionState.mafiaVotes;
            const voteDetails = [];
            
            Object.entries(votes).forEach(([voterId, targetId]) => {
                if (targetId) {
                    // Look for voter in both mafiaMembers and alivePlayers (to include current player)
                    let voter = mafiaMembers.find(m => m.id === voterId);
                    if (!voter) {
                        voter = alivePlayers.find(p => p.id === voterId);
                    }
                    const target = alivePlayers.find(p => p.id === targetId);
                    if (voter && target) {
                        voteDetails.push(voter.name + ' → ' + target.name);
                    }
                }
            });
            
            if (voteDetails.length > 0) {
                votingStatusHtml = '<div class="voting-status"><h5>Current Votes:</h5>' +
                    voteDetails.map(detail => '<div class="vote-tally">' + detail + '</div>').join('') +
                    '</div>';
            }
        }

        div.innerHTML = mafiaListHtml +
            '<div class="target-selection">' +
                '<h4>Choose a target to eliminate:</h4>' +
                votingStatusHtml +
                '<div class="target-buttons" id="kill-targets"></div>' +
                '<button id="confirm-kill" class="primary-btn" disabled>Vote to Kill</button>' +
            '</div>';
        container.appendChild(div);

        const targetsContainer = document.getElementById('kill-targets');
        let selectedTarget = null;

        // Show non-mafia players as targets (excluding current player)
        alivePlayers.forEach(player => {
            const isMafia = mafiaMembers.some(m => m.id === player.id);
            const isCurrentPlayer = player.id === window.gameManager.playerId;
            if (!isMafia && !isCurrentPlayer) {
                const button = document.createElement('button');
                button.className = 'target-btn';
                button.textContent = player.name;
                button.onclick = () => {
                    targetsContainer.querySelectorAll('.target-btn').forEach(btn => {
                        btn.classList.remove('selected');
                    });
                    button.classList.add('selected');
                    selectedTarget = player.id;
                    document.getElementById('confirm-kill').disabled = false;
                };
                targetsContainer.appendChild(button);
            }
        });

        document.getElementById('confirm-kill').onclick = () => {
            if (selectedTarget && window.gameManager) {
                window.gameManager.sendNightAction('kill', selectedTarget);
                container.innerHTML = '<p>✅ Vote submitted. Waiting for other mafia members...</p>';
            }
        };
    }

    showDetectiveInterface(container, alivePlayers, detectives, nightActionState) {
        const div = document.createElement('div');
        div.className = 'role-coordination';
        
        // Show past investigation results
        let investigationResultsHtml = '';
        if (window.gameManager && window.gameManager.investigationResults && window.gameManager.investigationResults.length > 0) {
            investigationResultsHtml = '<div class="investigation-results">' +
                '<h4>🕵️ Past Investigation Results:</h4>' +
                '<ul>' +
                window.gameManager.investigationResults.map(result => '<li>' + result + '</li>').join('') +
                '</ul>' +
                '</div>';
        }
        
        // Show other detectives
        let detectiveListHtml = '';
        if (detectives.length > 1) {
            detectiveListHtml = \`
                <div class="rolemates-section">
                    <h4>🕵️ Your Detective Team:</h4>
                    <div class="rolemates-list">
                        \${detectives.map(member => \`<span class="rolemate">\${member.name}</span>\`).join('')}
                    </div>
                </div>
            \`;
        }

        // Show current investigation votes
        let votingStatusHtml = '';
        if (nightActionState && nightActionState.detectiveVotes) {
            const votes = nightActionState.detectiveVotes;
            const voteDetails = [];
            
            Object.entries(votes).forEach(([voterId, targetId]) => {
                if (targetId) {
                    // Look for voter in both detectives and alivePlayers (to include current player)
                    let voter = detectives.find(d => d.id === voterId);
                    if (!voter) {
                        voter = alivePlayers.find(p => p.id === voterId);
                    }
                    const target = alivePlayers.find(p => p.id === targetId);
                    if (voter && target) {
                        voteDetails.push(voter.name + ' → ' + target.name);
                    }
                }
            });
            
            if (voteDetails.length > 0) {
                votingStatusHtml = '<div class="voting-status"><h5>Current Investigation Votes:</h5>' +
                    voteDetails.map(detail => '<div class="vote-tally">' + detail + '</div>').join('') +
                    '</div>';
            }
        }

        div.innerHTML = investigationResultsHtml + detectiveListHtml +
            '<div class="target-selection">' +
                '<h4>Choose someone to investigate:</h4>' +
                votingStatusHtml +
                '<div class="target-buttons" id="investigate-targets"></div>' +
                '<button id="confirm-investigate" class="primary-btn" disabled>Vote to Investigate</button>' +
            '</div>';
        container.appendChild(div);

        const targetsContainer = document.getElementById('investigate-targets');
        let selectedTarget = null;

        // Show players as targets (excluding detectives)
        alivePlayers.forEach(player => {
            const isDetective = detectives.some(d => d.id === player.id);
            if (!isDetective) {
                const button = document.createElement('button');
                button.className = 'target-btn';
                button.textContent = player.name;
                button.onclick = () => {
                    targetsContainer.querySelectorAll('.target-btn').forEach(btn => {
                        btn.classList.remove('selected');
                    });
                    button.classList.add('selected');
                    selectedTarget = player.id;
                    document.getElementById('confirm-investigate').disabled = false;
                };
                targetsContainer.appendChild(button);
            }
        });

        document.getElementById('confirm-investigate').onclick = () => {
            if (selectedTarget && window.gameManager) {
                window.gameManager.sendNightAction('investigate', selectedTarget);
                container.innerHTML = '<p>✅ Investigation vote submitted. Waiting for other detectives...</p>';
            }
        };
    }

    showAngelInterface(container, alivePlayers, angels, nightActionState) {
        const div = document.createElement('div');
        div.className = 'role-coordination';
        
        // Show other angels
        let angelListHtml = '';
        if (angels.length > 1) {
            angelListHtml = \`
                <div class="rolemates-section">
                    <h4>👼 Your Angel Team:</h4>
                    <div class="rolemates-list">
                        \${angels.map(member => \`<span class="rolemate">\${member.name}</span>\`).join('')}
                    </div>
                </div>
            \`;
        }

        // Show current protection votes
        let votingStatusHtml = '';
        if (nightActionState && nightActionState.angelVotes) {
            const votes = nightActionState.angelVotes;
            const voteDetails = [];
            
            Object.entries(votes).forEach(([voterId, targetId]) => {
                if (targetId) {
                    // Look for voter in both angels and alivePlayers (to include current player)
                    let voter = angels.find(a => a.id === voterId);
                    if (!voter) {
                        voter = alivePlayers.find(p => p.id === voterId);
                    }
                    const target = alivePlayers.find(p => p.id === targetId);
                    if (voter && target) {
                        voteDetails.push(voter.name + ' → ' + target.name);
                    }
                }
            });
            
            if (voteDetails.length > 0) {
                votingStatusHtml = '<div class="voting-status"><h5>Current Protection Votes:</h5>' +
                    voteDetails.map(detail => '<div class="vote-tally">' + detail + '</div>').join('') +
                    '</div>';
            }
        }

        div.innerHTML = angelListHtml +
            '<div class="target-selection">' +
                '<h4>Choose someone to protect:</h4>' +
                votingStatusHtml +
                '<div class="target-buttons" id="protect-targets"></div>' +
                '<button id="confirm-protect" class="primary-btn" disabled>Vote to Protect</button>' +
            '</div>';
        container.appendChild(div);

        const targetsContainer = document.getElementById('protect-targets');
        let selectedTarget = null;

        // Show all alive players as protection targets
        alivePlayers.forEach(player => {
            const button = document.createElement('button');
            button.className = 'target-btn';
            button.textContent = player.name;
            button.onclick = () => {
                targetsContainer.querySelectorAll('.target-btn').forEach(btn => {
                    btn.classList.remove('selected');
                });
                button.classList.add('selected');
                selectedTarget = player.id;
                document.getElementById('confirm-protect').disabled = false;
            };
            targetsContainer.appendChild(button);
        });

        document.getElementById('confirm-protect').onclick = () => {
            if (selectedTarget && window.gameManager) {
                window.gameManager.sendNightAction('protect', selectedTarget);
                container.innerHTML = '<p>✅ Protection vote submitted. Waiting for other angels...</p>';
            }
        };
    }

    showVotingInterface(alivePlayers, isHost = false) {
        const container = document.getElementById('voting-options');
        if (!container) return;

        // If host, show message that they don't vote
        if (isHost) {
            container.innerHTML = '<p>🎮 As the host, you observe the voting but do not participate.</p>';
            return;
        }

        container.innerHTML = \`
            <h4>Vote to eliminate a player:</h4>
            <div class="vote-buttons" id="vote-targets"></div>
            <button id="confirm-vote" class="primary-btn" disabled>Confirm Vote</button>
        \`;

        const targetsContainer = document.getElementById('vote-targets');
        let selectedTarget = null;

        // Add "No Murder" option
        const noMurderBtn = document.createElement('button');
        noMurderBtn.className = 'vote-btn no-murder-btn';
        noMurderBtn.textContent = '🕊️ No Murder';
        noMurderBtn.onclick = () => {
            targetsContainer.querySelectorAll('.vote-btn').forEach(btn => {
                btn.classList.remove('selected');
            });
            noMurderBtn.classList.add('selected');
            selectedTarget = 'no_murder';
            document.getElementById('confirm-vote').disabled = false;
        };
        targetsContainer.appendChild(noMurderBtn);

        // Add player options (excluding current player)
        alivePlayers.forEach(player => {
            const isCurrentPlayer = player.id === window.gameManager.playerId;
            if (!isCurrentPlayer) {
                const button = document.createElement('button');
                button.className = 'vote-btn';
                button.textContent = player.name;
                button.onclick = () => {
                    targetsContainer.querySelectorAll('.vote-btn').forEach(btn => {
                        btn.classList.remove('selected');
                    });
                    button.classList.add('selected');
                    selectedTarget = player.id;
                    document.getElementById('confirm-vote').disabled = false;
                };
                targetsContainer.appendChild(button);
            }
        });

        document.getElementById('confirm-vote').onclick = () => {
            if (selectedTarget && window.gameManager) {
                window.gameManager.sendDayVote(selectedTarget);
                container.innerHTML = '<p>✅ Vote submitted. Waiting for other players...</p>';
            }
        };
    }

    showRoleModal(role, mafiaMembers = []) {
        const modal = document.getElementById('role-modal');
        const roleDisplay = document.getElementById('role-display');
        
        if (!modal || !roleDisplay) return;

        const roleInfo = {
            'villager': '👨‍🌾 Villager - Find and eliminate the Mafia!',
            'mafia': '🔪 Mafia - Eliminate villagers and avoid detection!',
            'detective': '🕵️ Detective - Investigate players to find the Mafia!',
            'angel': '👼 Angel - Protect players from being eliminated!',
            'minion': '🤝 Minion - You know who the Mafia are and want them to win!',
            'suicide_bomber': '💣 Suicide Bomber - You win if the villagers eliminate you by vote!'
        };

        let roleText = roleInfo[role] || "Unknown role:" + role;

        // Special handling for minion - show mafia members
        if (role === 'minion' && mafiaMembers.length > 0) {
            const mafiaNames = mafiaMembers.map(member => member.name).join(', ');
            roleText += "<br><br><strong>🔪 The Mafia members are:</strong><br>" + mafiaNames;
        }

        roleDisplay.innerHTML = roleText;
        modal.classList.remove('hidden');
    }

    hideRoleModal() {
        const modal = document.getElementById('role-modal');
        if (modal) {
            modal.classList.add('hidden');
        }
    }

    showError(message) {
        const errorEl = document.getElementById('error-message');
        if (errorEl) {
            errorEl.textContent = message;
            errorEl.classList.remove('hidden');
            
            // Auto-hide after 5 seconds
            setTimeout(() => {
                errorEl.classList.add('hidden');
            }, 5000);
        }
    }

    hideError() {
        const errorEl = document.getElementById('error-message');
        if (errorEl) {
            errorEl.classList.add('hidden');
        }
    }

    showGameEnd(winner, players, isHost = false) {
        this.showPhase('end');
        
        const resultEl = document.getElementById('game-result');
        if (resultEl) {
            const winnerText = {
                'village': '🎉 Village Wins!',
                'mafia': '🔪 Mafia Wins!'
            };
            resultEl.textContent = winnerText[winner] || \`Game Over - \${winner} wins!\`;
        }

        const finalPlayersEl = document.getElementById('final-players-list');
        if (finalPlayersEl) {
            finalPlayersEl.innerHTML = '';
            players.forEach(player => {
                const div = document.createElement('div');
                div.className = \`player-card \${player.alive ? '' : 'dead'}\`;
                div.innerHTML = \`
                    <strong>\${player.name}</strong>
                    <br><small>(\${player.role})</small>
                \`;
                finalPlayersEl.appendChild(div);
            });
        }

        // Update end controls based on host status
        const endControls = document.querySelector('.end-controls');
        if (endControls) {
            if (isHost) {
                endControls.innerHTML =
                    '<button id="new-game-btn" class="primary-btn">New Game</button>' +
                    '<a href="/" class="secondary-btn">Home</a>';
            } else {
                endControls.innerHTML =
                    '<p>Waiting for host to start a new game...</p>' +
                    '<a href="/" class="secondary-btn">Home</a>';
            }
        }
    }

    showNewGameNotification() {
        // Create modal for new game notification
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = '<div class="modal-content">' +
            '<h3>🎮 New Game Started!</h3>' +
            '<p>The host has started a new game. Would you like to continue playing?</p>' +
            '<div style="display: flex; gap: 1rem; justify-content: center; margin-top: 1rem;">' +
                '<button id="stay-play-btn" class="primary-btn">Stay & Play</button>' +
                '<button id="leave-game-btn" class="secondary-btn">Leave Game</button>' +
            '</div>' +
        '</div>';
        
        document.body.appendChild(modal);
        
        document.getElementById('stay-play-btn').onclick = () => {
            document.body.removeChild(modal);
        };
        
        document.getElementById('leave-game-btn').onclick = () => {
            window.location.href = '/';
        };
    }
}

window.UIManager = UIManager;`,

    'js/game.js': `class GameManager {
    constructor() {
        this.ws = new WebSocketManager();
        this.ui = new UIManager();
        this.roomId = null;
        this.playerId = null;
        this.playerName = null;
        this.playerRole = null;
        this.isHost = false;
        this.investigationResults = []; // Store detective investigation results
        this.gameSettings = {
            dayDuration: 0, // 0 = unlimited
            mafiaCount: 'auto',
            detectiveCount: 0,
            angelCount: 0,
            suicideBomber: false,
            minion: false
        };
        
        this.setupEventHandlers();
        this.setupWebSocketHandlers();
        this.loadPersistedState();
    }

    init() {
        // Get room ID from URL
        const urlParams = new URLSearchParams(window.location.search);
        this.roomId = urlParams.get('room');
        
        if (!this.roomId) {
            this.ui.showError('No room ID provided');
            return;
        }

        // Check if we're the host for this room from localStorage
        const savedHostStatus = localStorage.getItem('mafiaHostStatus');
        if (savedHostStatus) {
            try {
                const hostData = JSON.parse(savedHostStatus);
                if (hostData.roomId === this.roomId && hostData.isHost) {
                    console.log('Restoring host mode from localStorage'); // Debug
                    this.playerName = 'host';
                    this.isHost = true;
                    this.setupHostInterface();
                }
            } catch (e) {
                console.error('Error parsing saved host status:', e);
            }
        }

        // Connect to WebSocket
        this.ws.connect(this.roomId);
        
        // If host, send host identification after connection
        if (this.isHost && this.playerName) {
            setTimeout(() => {
                console.log('Sending host_connect message'); // Debug
                this.ws.send({
                    type: 'host_connect',
                    hostName: 'host'
                });
            }, 500);
        }
    }

    setupHostInterface() {
        console.log('Setting up host interface'); // Debug
        
        // Hide player join controls completely for host
        const lobbyControls = document.querySelector('.lobby-controls');
        if (lobbyControls) {
            console.log('Hiding lobby controls'); // Debug
            lobbyControls.style.display = 'none';
        }
        
        // Show host settings immediately
        console.log('Showing host settings'); // Debug
        this.ui.showHostSettings(true, this.roomId);
        
        // Apply saved settings to UI
        const dayDurationSelect = document.getElementById('game-duration');
        const minPlayersSelect = document.getElementById('min-players');
        const mafiaCountSelect = document.getElementById('mafia-count');
        const detectiveCountSelect = document.getElementById('detective-count');
        const angelCountSelect = document.getElementById('angel-count');
        const suicideBomberSelect = document.getElementById('suicide-bomber');
        const minionSelect = document.getElementById('minion');
        
        if (dayDurationSelect) dayDurationSelect.value = this.gameSettings.dayDuration;
        if (minPlayersSelect) minPlayersSelect.value = this.gameSettings.minPlayers;
        if (mafiaCountSelect) mafiaCountSelect.value = this.gameSettings.mafiaCount;
        if (detectiveCountSelect) detectiveCountSelect.value = this.gameSettings.detectiveCount;
        if (angelCountSelect) angelCountSelect.value = this.gameSettings.angelCount;
        if (suicideBomberSelect) suicideBomberSelect.value = this.gameSettings.suicideBomber.toString();
        if (minionSelect) minionSelect.value = this.gameSettings.minion.toString();
        
        // Force show the host panel
        const hostPanel = document.getElementById('host-settings');
        if (hostPanel) {
            console.log('Force showing host panel'); // Debug
            hostPanel.classList.remove('hidden');
            hostPanel.style.display = 'block';
        }
    }

    setupEventHandlers() {
        // Lobby controls
        const joinBtn = document.getElementById('join-lobby-btn');
        const startBtn = document.getElementById('start-game-btn');
        const nameInput = document.getElementById('player-name-input');

        if (joinBtn) {
            joinBtn.onclick = () => this.joinGame();
        }

        if (startBtn) {
            startBtn.onclick = () => this.startGame();
        }

        if (nameInput) {
            nameInput.onkeypress = (e) => {
                if (e.key === 'Enter') {
                    this.joinGame();
                }
            };
        }

        // Host settings
        const dayDurationSelect = document.getElementById('game-duration');
        const minPlayersSelect = document.getElementById('min-players');
        const copyLinkBtn = document.getElementById('copy-link-btn');
        const shareLobbyBtn = document.getElementById('share-lobby-btn');
        const mafiaCountSelect = document.getElementById('mafia-count');
        const detectiveCountSelect = document.getElementById('detective-count');
        const angelCountSelect = document.getElementById('angel-count');
        const suicideBomberSelect = document.getElementById('suicide-bomber');
        const minionSelect = document.getElementById('minion');

        if (dayDurationSelect) {
            dayDurationSelect.onchange = () => {
                this.gameSettings.dayDuration = parseInt(dayDurationSelect.value);
                this.savePersistedState();
            };
        }

        if (minPlayersSelect) {
            minPlayersSelect.onchange = () => {
                this.gameSettings.minPlayers = parseInt(minPlayersSelect.value);
                this.savePersistedState();
            };
        }

        if (mafiaCountSelect) {
            mafiaCountSelect.onchange = () => {
                this.gameSettings.mafiaCount = mafiaCountSelect.value;
                this.savePersistedState();
            };
        }

        if (detectiveCountSelect) {
            detectiveCountSelect.onchange = () => {
                this.gameSettings.detectiveCount = parseInt(detectiveCountSelect.value);
                this.savePersistedState();
            };
        }

        if (angelCountSelect) {
            angelCountSelect.onchange = () => {
                this.gameSettings.angelCount = parseInt(angelCountSelect.value);
                this.savePersistedState();
            };
        }

        if (suicideBomberSelect) {
            suicideBomberSelect.onchange = () => {
                this.gameSettings.suicideBomber = suicideBomberSelect.value === 'true';
                this.savePersistedState();
            };
        }

        if (minionSelect) {
            minionSelect.onchange = () => {
                this.gameSettings.minion = minionSelect.value === 'true';
                this.savePersistedState();
            };
        }

        if (copyLinkBtn) {
            copyLinkBtn.onclick = () => this.copyShareLink();
        }

        if (shareLobbyBtn) {
            shareLobbyBtn.onclick = () => this.copyShareLink();
        }

        // Role reveal button
        const revealBtn = document.getElementById('reveal-role-btn');
        if (revealBtn) {
            revealBtn.onclick = () => this.revealRole();
        }

        // Modal close button
        const closeModalBtn = document.getElementById('close-role-modal');
        if (closeModalBtn) {
            closeModalBtn.onclick = () => this.ui.hideRoleModal();
        }

        // New game button - will be set up dynamically in showGameEnd
        this.setupNewGameButton();

        // Handle page refresh/reload
        window.addEventListener('beforeunload', () => {
            this.savePersistedState();
        });
    }

    setupWebSocketHandlers() {
        this.ws.onMessage('game_state_update', (message) => {
            this.handleGameStateUpdate(message.gameState);
        });

        this.ws.onMessage('player_joined', (message) => {
            this.playerId = message.playerId;
            this.playerName = message.playerName;
            
            // Hide join controls after successfully joining
            const lobbyControls = document.querySelector('.lobby-controls');
            if (lobbyControls && !this.isHost) {
                lobbyControls.style.display = 'none';
            }
        });

        this.ws.onMessage('role_assigned', (message) => {
            this.playerRole = message.role;
            this.rolemates = message.rolemates || [];
            this.ui.showRoleModal(message.role);
            
            // Auto-hide role modal after 3 seconds
            setTimeout(() => {
                this.ui.hideRoleModal();
            }, 3000);
        });

        this.ws.onMessage('night_action_update', (message) => {
            console.log('Received night_action_update:', message);
            console.log('Current playerRole:', this.playerRole);
            if (this.playerRole && ['mafia', 'detective', 'angel'].includes(this.playerRole)) {
                console.log('Showing night actions for role:', this.playerRole);
                this.ui.showNightActions(
                    message.role,
                    message.alivePlayers,
                    message.rolemates,
                    message.nightActionState
                );
            } else {
                console.log('Not showing night actions - role check failed');
            }
        });

        this.ws.onMessage('role_reveal', (message) => {
            this.ui.showRoleModal(message.role);
        });

        this.ws.onMessage('investigation_result', (message) => {
            const result = 'Investigation Result: ' + message.target + ' is ' + (message.isMafia ? 'Mafia' : 'Not Mafia');
            this.investigationResults.push(result);
            this.ui.showError(result);
        });

        this.ws.onMessage('error', (message) => {
            this.ui.showError(message.message);
        });

        this.ws.onConnectionStatusChange = (connected) => {
            if (!connected) {
                this.ui.showError('Connection lost. Attempting to reconnect...');
            } else {
                this.ui.hideError();
            }
        };
    }

    joinGame() {
        const nameInput = document.getElementById('player-name-input');
        const playerName = nameInput ? nameInput.value.trim() : '';
        if (!playerName) {
            this.ui.showError('Please enter your name');
            return;
        }

        if (playerName.length > 20) {
            this.ui.showError('Name must be 20 characters or less');
            return;
        }

        this.ws.send({
            type: 'join_game',
            playerName: playerName
        });
    }

    startGame() {
        if (!this.isHost) {
            this.ui.showError('Only the host can start the game');
            return;
        }

        this.ws.send({
            type: 'start_game',
            gameSettings: this.gameSettings
        });
    }

    sendNightAction(actionType, target) {
        this.ws.send({
            type: 'night_action',
            action: {
                type: actionType,
                target: target
            }
        });
    }

    sendDayVote(target) {
        this.ws.send({
            type: 'day_vote',
            vote: {
                target: target
            }
        });
    }

    kickPlayer(playerId) {
        if (!this.isHost) {
            this.ui.showError('Only the host can kick players');
            return;
        }

        this.ws.send({
            type: 'kick_player',
            playerId: playerId
        });
    }

    revealRole() {
        this.ws.send({
            type: 'reveal_role'
        });
    }

    copyShareLink() {
        const shareLink = document.getElementById('share-link');
        if (!shareLink) return;

        const url = shareLink.value;
        
        // Try modern clipboard API first
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(url).then(() => {
                // Visual feedback
                const copyBtn = document.getElementById('copy-link-btn') || document.getElementById('share-lobby-btn');
                if (copyBtn) {
                    const originalText = copyBtn.textContent;
                    copyBtn.textContent = '✅ Copied!';
                    copyBtn.style.background = '#28a745';
                    
                    setTimeout(() => {
                        copyBtn.textContent = originalText;
                        copyBtn.style.background = '';
                    }, 2000);
                }
            }).catch(err => {
                console.error('Failed to copy: ', err);
                // Fallback to alert
                alert(\`Share this link with players: \${url}\`);
            });
        } else {
            // Fallback for older browsers or non-secure contexts
            try {
                shareLink.select();
                shareLink.setSelectionRange(0, 99999); // For mobile devices
                document.execCommand('copy');
                
                // Visual feedback
                const copyBtn = document.getElementById('copy-link-btn') || document.getElementById('share-lobby-btn');
                if (copyBtn) {
                    const originalText = copyBtn.textContent;
                    copyBtn.textContent = '✅ Copied!';
                    copyBtn.style.background = '#28a745';
                    
                    setTimeout(() => {
                        copyBtn.textContent = originalText;
                        copyBtn.style.background = '';
                    }, 2000);
                }
            } catch (err) {
                console.error('Fallback copy failed: ', err);
                alert(\`Share this link with players: \${url}\`);
            }
        }
    }

    handleGameStateUpdate(gameState) {
        console.log('Game state update:', gameState);
        
        this.ui.updateGameInfo(gameState, this.playerName);
        
        // Update players list
        if (gameState.phase === 'lobby') {
            this.ui.showPhase('lobby');
            this.ui.updatePlayersList(gameState.players, true, this.isHost, gameState.hostId);
            
            // Show start button for host if enough players
            if (this.isHost) {
                this.ui.showHostStartButton(true, gameState.players.length);
            }
        } else if (gameState.phase === 'ended') {
            this.handleGameEnd(gameState);
        } else {
            this.ui.showPhase('game');
            this.ui.updatePlayersList(gameState.players, false);
            
            // Handle different game phases
            if (gameState.phase === 'night') {
                console.log('Night phase detected for day:', gameState.day, 'playerRole:', this.playerRole);
                this.handleNightPhase(gameState);
            } else if (gameState.phase === 'day') {
                this.handleDayPhase(gameState);
            } else if (gameState.phase === 'voting') {
                this.handleVotingPhase(gameState);
            }
        }
        
        // Update game log
        if (gameState.gameLog) {
            this.ui.updateGameLog(gameState.gameLog);
        }
    }

    handleVotingPhase(gameState) {
        // Voting is now combined with day phase
        this.handleDayPhase(gameState);
    }

    handleDayPhase(gameState) {
        this.ui.showPhase('game');
        this.ui.updatePlayersList(gameState.players);
        
        // Hide/show role reveal button based on host status
        const revealBtn = document.getElementById('reveal-role-btn');
        if (revealBtn) {
            revealBtn.style.display = this.isHost ? 'none' : 'block';
        }
        
        // Hide night content, show both day and voting content
        document.getElementById('night-phase').style.display = 'none';
        document.getElementById('day-phase').style.display = 'block';
        document.getElementById('voting-phase').style.display = 'block';

        // Hide role action interfaces during day phase
        this.ui.hideNightActions();

        // Show investigation results if detective
        if (this.playerRole === 'detective' && this.investigationResults.length > 0) {
            const dayTimer = document.getElementById('day-timer');
            if (dayTimer) {
                dayTimer.innerHTML =
                    '<div class="investigation-results">' +
                        '<h4>🕵️ Your Investigation Results:</h4>' +
                        this.investigationResults.map(result => '<p>' + result + '</p>').join('') +
                    '</div>';
            }
        }

        // Show voting interface immediately (combined day/voting phase)
        if (!this.isHost) {
            const alivePlayers = gameState.players.filter(p => p.alive);
            this.ui.showVotingInterface(alivePlayers, this.isHost);
        } else {
            const votingOptions = document.getElementById('voting-options');
            if (votingOptions) {
                votingOptions.innerHTML = '<p>🗳️ As the host, you observe the voting but do not participate.</p>';
            }
        }
    }

    handleNightPhase(gameState) {
        console.log('handleNightPhase called for day:', gameState.day, 'playerRole:', this.playerRole);
        this.ui.showPhase('game');
        this.ui.updatePlayersList(gameState.players);
        
        // Hide/show role reveal button based on host status
        const revealBtn = document.getElementById('reveal-role-btn');
        if (revealBtn) {
            revealBtn.style.display = this.isHost ? 'none' : 'block';
        }
        
        // Hide day/voting content, show night content
        document.getElementById('day-phase').style.display = 'none';
        document.getElementById('voting-phase').style.display = 'none';
        document.getElementById('night-phase').style.display = 'block';

        if (this.isHost) {
            // Host sees all players and game state but doesn't participate
            const nightActions = document.getElementById('night-actions');
            if (nightActions) {
                nightActions.innerHTML = '<p>🌙 Night Phase - Players are making their moves...</p>';
            }
        } else {
            // Don't show night actions here - wait for night_action_update message
            // which will have the proper coordination state
            const nightActions = document.getElementById('night-actions');
            if (nightActions) {
                console.log('Setting waiting message for night actions');
                nightActions.innerHTML = '<p>🌙 Night Phase - Waiting for role coordination...</p>';
            }
        }
    }

    handleGameEnd(gameState) {
        this.ui.showGameEnd(gameState.winner, gameState.players, this.isHost);
        
        // Set up new game button after UI is updated
        setTimeout(() => {
            this.setupNewGameButton();
        }, 100);
    }

    setupNewGameButton() {
        const newGameBtn = document.getElementById('new-game-btn');
        if (newGameBtn) {
            newGameBtn.onclick = () => {
                this.clearPersistedState();
                window.location.href = '/';
            };
        }
    }

    savePersistedState() {
        const state = {
            gameSettings: this.gameSettings,
            isHost: this.isHost,
            playerName: this.playerName,
            roomId: this.roomId
        };
        
        localStorage.setItem('mafiaGameState', JSON.stringify(state));
        
        // Also save host status separately for easier access
        if (this.isHost && this.roomId && this.playerName) {
            localStorage.setItem('mafiaHostStatus', JSON.stringify({
                roomId: this.roomId,
                hostName: this.playerName,
                isHost: true
            }));
        }
    }

    loadPersistedState() {
        const saved = localStorage.getItem('mafiaGameState');
        if (saved) {
            try {
                const state = JSON.parse(saved);
                if (state.gameSettings) {
                    this.gameSettings = { ...this.gameSettings, ...state.gameSettings };
                }
            } catch (e) {
                console.error('Error loading persisted state:', e);
            }
        }
    }

    clearPersistedState() {
        localStorage.removeItem('mafiaGameState');
        localStorage.removeItem('mafiaHostStatus');
    }
}

// Initialize game when page loads
window.addEventListener('DOMContentLoaded', () => {
    window.gameManager = new GameManager();
    window.gameManager.init();
});`
  };

  return files[path] || 'File not found';
}
    