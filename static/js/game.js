class GameManager {
    constructor() {
        this.ws = new WebSocketManager();
        this.ui = new UIManager();
        this.roomId = null;
        this.playerId = null;
        this.playerName = null;
        this.playerRole = null;
        this.isHost = false;
        this.isDead = false;
        this.investigationResults = []; // Store detective investigation results
        this.rolemates = []; // Store rolemates for coordination
        this.mafiaMembers = []; // Store mafia members (for minion role)
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

        // New game button
        const newGameBtn = document.getElementById('new-game-btn');
        if (newGameBtn) {
            newGameBtn.onclick = () => {
                if (this.isHost) {
                    // Host starts new game with existing players
                    this.startNewGame();
                }
                // Note: Non-hosts don't have a new game button in the end screen
                // They get a notification modal when host starts a new game
            };
        }

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
            this.mafiaMembers = message.mafiaMembers || [];
            this.ui.showRoleModal(message.role, this.mafiaMembers);
            
            // Auto-hide role modal after 5 seconds (longer for minion to read mafia info)
            setTimeout(() => {
                this.ui.hideRoleModal();
            }, 5000);
        });

        this.ws.onMessage('night_action_update', (message) => {
            console.log('Received night_action_update:', message);
            console.log('Current playerRole:', this.playerRole, 'isDead:', this.isDead);
            
            // Only show night actions if player is alive and has a special role
            if (!this.isDead && this.playerRole && ['mafia', 'detective', 'angel'].includes(this.playerRole)) {
                console.log('Showing night actions for role:', this.playerRole);
                this.ui.showNightActions(
                    message.role,
                    message.alivePlayers,
                    message.rolemates,
                    message.nightActionState
                );
            } else {
                console.log('Not showing night actions - player is dead or role check failed');
            }
        });

        this.ws.onMessage('role_reveal', (message) => {
            this.ui.showRoleModal(message.role, message.mafiaMembers || []);
        });

        this.ws.onMessage('investigation_result', (message) => {
            const result = `Investigation Result: ${message.target} is ${message.isMafia ? 'Mafia' : 'Not Mafia'}`;
            this.investigationResults.push(result);
            this.ui.showError(result);
        });

        this.ws.onMessage('new_game_started', (message) => {
            this.handleNewGameStarted(message);
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

        this.playerName = playerName;
        
        this.ws.send({
            type: 'join_game',
            playerName: playerName
        });

        // Hide join controls
        const joinBtn = document.getElementById('join-lobby-btn');
        const nameInput2 = document.getElementById('player-name-input');
        if (joinBtn) joinBtn.style.display = 'none';
        if (nameInput2) nameInput2.style.display = 'none';
    }

    startGame() {
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

    async copyShareLink() {
        const shareUrl = `${window.location.origin}/game.html?room=${this.roomId}`;
        
        try {
            await navigator.clipboard.writeText(shareUrl);
            
            // Show feedback to user
            const shareLobbyBtn = document.getElementById('share-lobby-btn');
            const copyLinkBtn = document.getElementById('copy-link-btn');
            
            const showFeedback = (btn) => {
                if (btn) {
                    const originalText = btn.textContent;
                    btn.textContent = '✅ Copied!';
                    btn.style.backgroundColor = '#28a745';
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.style.backgroundColor = '';
                    }, 2000);
                }
            };
            
            if (shareLobbyBtn) showFeedback(shareLobbyBtn);
            if (copyLinkBtn) showFeedback(copyLinkBtn);
            
            console.log('Share URL copied to clipboard:', shareUrl);
        } catch (err) {
            console.error('Failed to copy to clipboard:', err);
            
            // Fallback: show the URL in an alert
            alert(`Copy this link to share the lobby:\n${shareUrl}`);
        }
    }

    revealRole() {
        if (this.playerRole) {
            this.ui.showRoleModal(this.playerRole, this.mafiaMembers);
        } else {
            this.ws.send({
                type: 'reveal_role'
            });
        }
    }

    handleGameStateUpdate(gameState) {
        // Check if current player is dead
        const currentPlayer = gameState.players.find(p => p.id === this.playerId);
        const isDead = currentPlayer && !currentPlayer.alive;
        
        this.ui.updateGameInfo(gameState, this.playerName, isDead);
        this.ui.updateGameLog(gameState.gameLog);

        // Store dead status for use in other methods
        this.isDead = isDead;

        switch (gameState.phase) {
            case 'lobby':
                this.handleLobbyPhase(gameState);
                break;
            case 'night':
                this.handleNightPhase(gameState, isDead);
                break;
            case 'day':
                this.handleDayPhase(gameState, isDead);
                break;
            case 'voting':
                this.handleVotingPhase(gameState, isDead);
                break;
            case 'ended':
                this.handleGameEnd(gameState);
                break;
        }
    }

    handleLobbyPhase(gameState) {
        this.ui.showPhase('lobby');
        
        if (this.isHost) {
            // Host interface - show host settings and controls
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
            
            // Show start button if minimum players met
            this.ui.showHostStartButton(true, gameState.players.length, this.gameSettings.minPlayers);
            
            // Hide player join controls for host
            const lobbyControls = document.querySelector('.lobby-controls');
            if (lobbyControls) {
                lobbyControls.style.display = 'none';
            }
        } else {
            // Regular player interface
            this.ui.showHostSettings(false);
            this.ui.showHostStartButton(false);
            
            // Show player join controls
            const lobbyControls = document.querySelector('.lobby-controls');
            if (lobbyControls) {
                lobbyControls.style.display = 'block';
            }
        }

        // Update players list with host functionality
        this.ui.updatePlayersList(gameState.players, true, this.isHost, gameState.hostId);
    }

    handleNightPhase(gameState, isDead = false) {
        console.log('handleNightPhase called for day:', gameState.day, 'playerRole:', this.playerRole, 'isDead:', isDead);
        this.ui.showPhase('game');
        this.ui.updatePlayersList(gameState.players);
        
        // Hide/show role reveal button based on host status and death status
        const revealBtn = document.getElementById('reveal-role-btn');
        if (revealBtn) {
            revealBtn.style.display = (this.isHost || isDead) ? 'none' : 'block';
        }
        
        // Hide day/voting content, show night content
        document.getElementById('day-phase').style.display = 'none';
        document.getElementById('voting-phase').style.display = 'none';
        document.getElementById('night-phase').style.display = 'block';

        const nightActions = document.getElementById('night-actions');
        if (nightActions) {
            if (this.isHost) {
                // Host sees all players and game state but doesn't participate
                nightActions.innerHTML = '<p>🌙 Night Phase - Players are making their moves...</p>';
            } else if (isDead) {
                // Dead players cannot participate in night actions
                nightActions.innerHTML = '<p>💀 You are dead and cannot participate in night actions. Watch and wait for the next day...</p>';
            } else {
                // Don't show night actions here - wait for night_action_update message
                // which will have the proper coordination state
                console.log('Setting waiting message for night actions');
                nightActions.innerHTML = '<p>🌙 Night Phase - Waiting for role coordination...</p>';
            }
        }
    }

    handleDayPhase(gameState, isDead = false) {
        this.ui.showPhase('game');
        this.ui.updatePlayersList(gameState.players);
        
        // Hide/show role reveal button based on host status and death status
        const revealBtn = document.getElementById('reveal-role-btn');
        if (revealBtn) {
            revealBtn.style.display = (this.isHost || isDead) ? 'none' : 'block';
        }
        
        // Hide night content, show both day and voting content
        document.getElementById('night-phase').style.display = 'none';
        document.getElementById('day-phase').style.display = 'block';
        document.getElementById('voting-phase').style.display = 'block';

        // Hide role action interfaces during day phase
        this.ui.hideNightActions();

        // Show investigation results if detective and alive
        if (this.playerRole === 'detective' && this.investigationResults.length > 0 && !isDead) {
            const dayTimer = document.getElementById('day-timer');
            if (dayTimer) {
                dayTimer.innerHTML = `
                    <div class="investigation-results">
                        <h4>🕵️ Your Investigation Results:</h4>
                        ${this.investigationResults.map(result => `<p>${result}</p>`).join('')}
                    </div>
                `;
            }
        }

        // Show mafia members if minion and alive
        console.log('Day phase - Player role:', this.playerRole, 'Mafia members:', this.mafiaMembers, 'Is dead:', isDead);
        if (this.playerRole === 'minion' && this.mafiaMembers.length > 0 && !isDead) {
            const dayTimer = document.getElementById('day-timer');
            if (dayTimer) {
                const mafiaNames = this.mafiaMembers.map(m => m.name).join(', ');
                dayTimer.innerHTML = `
                    <div class="mafia-info">
                        <h4>🔪 The Mafia Team:</h4>
                        <p><strong>${mafiaNames}</strong></p>
                        <p><em>Help them win without revealing yourself!</em></p>
                    </div>
                `;
            }
        }

        // Show voting interface immediately (combined day/voting phase)
        const votingOptions = document.getElementById('voting-options');
        if (votingOptions) {
            // Double-check if current player is dead by looking at game state
            const currentPlayer = gameState.players.find(p => p.id === this.playerId);
            const isPlayerDead = isDead || (currentPlayer && !currentPlayer.alive);
            
            if (isPlayerDead) {
                // Dead players get a clear message with no voting options
                votingOptions.innerHTML = `
                    <div class="dead-player-message">
                        <h4>💀 You are dead</h4>
                        <p>You cannot participate in voting. Watch the remaining players decide who to eliminate.</p>
                    </div>
                `;
            } else if (this.isHost) {
                votingOptions.innerHTML = '<p>🗳️ As the host, you observe the voting but do not participate.</p>';
            } else {
                const alivePlayers = gameState.players.filter(p => p.alive);
                this.ui.showVotingInterface(alivePlayers, this.isHost, isPlayerDead);
            }
        }
    }

    handleVotingPhase(gameState, isDead = false) {
        // Voting is now combined with day phase
        this.handleDayPhase(gameState, isDead);
    }

    handleGameEnd(gameState) {
        this.ui.showGameEnd(gameState.winner, gameState.players, this.isHost);
    }

    startNewGame() {
        this.ws.send({
            type: 'new_game'
        });
    }

    handleNewGameStarted(message) {
        // Reset investigation results and role info
        this.investigationResults = [];
        this.playerRole = null;
        this.rolemates = [];
        this.mafiaMembers = [];
        this.isDead = false;
        
        // Show notification with option to leave
        this.ui.showNewGameNotification(message.message, this.isHost);
    }

    // State persistence methods
    savePersistedState() {
        const state = {
            roomId: this.roomId,
            playerId: this.playerId,
            playerName: this.playerName,
            playerRole: this.playerRole,
            isHost: this.isHost,
            gameSettings: this.gameSettings
        };
        localStorage.setItem('mafiaGameState', JSON.stringify(state));
    }

    loadPersistedState() {
        try {
            const savedState = localStorage.getItem('mafiaGameState');
            if (savedState) {
                const state = JSON.parse(savedState);
                
                // Only restore if we're in the same room
                const urlParams = new URLSearchParams(window.location.search);
                const currentRoomId = urlParams.get('room');
                
                if (state.roomId === currentRoomId) {
                    this.playerId = state.playerId;
                    this.playerName = state.playerName;
                    this.playerRole = state.playerRole;
                    this.isHost = state.isHost;
                    if (state.gameSettings) {
                        this.gameSettings = { ...this.gameSettings, ...state.gameSettings };
                    }
                    
                    // Pre-fill name input if available
                    const nameInput = document.getElementById('player-name-input');
                    if (nameInput && this.playerName) {
                        nameInput.value = this.playerName;
                    }
                }
            }
        } catch (error) {
            console.warn('Failed to load persisted state:', error);
        }
    }

    clearPersistedState() {
        localStorage.removeItem('mafiaGameState');
        localStorage.removeItem('mafiaHostStatus');
    }
}

// Initialize game when page loads
document.addEventListener('DOMContentLoaded', () => {
    window.gameManager = new GameManager();
    window.gameManager.init();
});