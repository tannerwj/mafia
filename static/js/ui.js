class UIManager {
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
        const phaseElement = document.getElementById(`${phase}-phase`);
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
                playerNameEl.textContent = `💀 ${playerName} (DEAD)`;
                playerNameEl.style.color = '#ff4444';
                playerNameEl.style.fontWeight = 'bold';
            } else {
                playerNameEl.textContent = `👤 ${playerName}`;
                playerNameEl.style.color = '';
                playerNameEl.style.fontWeight = '';
            }
        }

        if (roomIdEl) {
            roomIdEl.textContent = `Room: ${gameState.roomId || 'Unknown'}`;
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
            dayEl.textContent = `Day ${gameState.day}`;
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
                    li.innerHTML = `
                        <span>${player.name}</span>
                        <button class="kick-btn" onclick="window.gameManager.kickPlayer('${player.id}')">Kick</button>
                    `;
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
                    return `<strong>${player.name}</strong>`;
                } else {
                    return `<strong style="text-decoration: line-through; opacity: 0.6;">${player.name}</strong> <small>(${player.role})</small>`;
                }
            });
            
            container.innerHTML = `<p>${playerStrings.join(', ')}</p>`;
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
                        const joinUrl = `${baseUrl}/game.html?room=${roomId}`;
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

    hideNightActions() {
        const container = document.getElementById('night-actions');
        if (container) {
            container.innerHTML = '';
        }
    }

    showMafiaInterface(container, alivePlayers, mafiaMembers, nightActionState) {
        const div = document.createElement('div');
        div.className = 'role-coordination';
        
        // Always show mafia team members (including self)
        let mafiaListHtml = '';
        if (mafiaMembers.length >= 1) {
            mafiaListHtml = `
                <div class="rolemates-section">
                    <h4>🔪 Your Mafia Team:</h4>
                    <div class="rolemates-list">
                        ${mafiaMembers.map(member => `<span class="rolemate">${member.name}</span>`).join('')}
                    </div>
                </div>
            `;
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
                        voteDetails.push(`${voter.name} → ${target.name}`);
                    }
                }
            });
            
            if (voteDetails.length > 0) {
                votingStatusHtml = `
                    <div class="voting-status">
                        <h5>Current Votes:</h5>
                        ${voteDetails.map(detail => `<div class="vote-tally">${detail}</div>`).join('')}
                    </div>
                `;
            }
        }

        div.innerHTML = `
            ${mafiaListHtml}
            <div class="target-selection">
                <h4>Choose a target to eliminate:</h4>
                ${votingStatusHtml}
                <div class="target-buttons" id="kill-targets"></div>
                <button id="confirm-kill" class="primary-btn" disabled>Vote to Kill</button>
            </div>
        `;
        container.appendChild(div);

        const targetsContainer = document.getElementById('kill-targets');
        let selectedTarget = null;

        // Show non-mafia players as targets (excluding current player)
        alivePlayers.forEach(player => {
            const isMafia = mafiaMembers.some(m => m.id === player.id);
            const isCurrentPlayer = window.gameManager && player.id === window.gameManager.playerId;
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
        
        // Show other detectives
        let detectiveListHtml = '';
        if (detectives.length > 1) {
            detectiveListHtml = `
                <div class="rolemates-section">
                    <h4>🕵️ Your Detective Team:</h4>
                    <div class="rolemates-list">
                        ${detectives.map(member => `<span class="rolemate">${member.name}</span>`).join('')}
                    </div>
                </div>
            `;
        }

        // Show past investigation results if available
        let investigationResultsHtml = '';
        if (window.gameManager && window.gameManager.investigationResults && window.gameManager.investigationResults.length > 0) {
            investigationResultsHtml = `
                <div class="investigation-results">
                    <h4>🕵️ Your Investigation Results:</h4>
                    ${window.gameManager.investigationResults.map(result => `<p>${result}</p>`).join('')}
                </div>
            `;
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
                        voteDetails.push(`${voter.name} → ${target.name}`);
                    }
                }
            });
            
            if (voteDetails.length > 0) {
                votingStatusHtml = `
                    <div class="voting-status">
                        <h5>Current Investigation Votes:</h5>
                        ${voteDetails.map(detail => `<div class="vote-tally">${detail}</div>`).join('')}
                    </div>
                `;
            }
        }

        div.innerHTML = `
            ${detectiveListHtml}
            ${investigationResultsHtml}
            <div class="target-selection">
                <h4>Choose someone to investigate:</h4>
                ${votingStatusHtml}
                <div class="target-buttons" id="investigate-targets"></div>
                <button id="confirm-investigate" class="primary-btn" disabled>Vote to Investigate</button>
            </div>
        `;
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
            angelListHtml = `
                <div class="rolemates-section">
                    <h4>👼 Your Angel Team:</h4>
                    <div class="rolemates-list">
                        ${angels.map(member => `<span class="rolemate">${member.name}</span>`).join('')}
                    </div>
                </div>
            `;
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
                        voteDetails.push(`${voter.name} → ${target.name}`);
                    }
                }
            });
            
            if (voteDetails.length > 0) {
                votingStatusHtml = `
                    <div class="voting-status">
                        <h5>Current Protection Votes:</h5>
                        ${voteDetails.map(detail => `<div class="vote-tally">${detail}</div>`).join('')}
                    </div>
                `;
            }
        }

        div.innerHTML = `
            ${angelListHtml}
            <div class="target-selection">
                <h4>Choose someone to protect:</h4>
                ${votingStatusHtml}
                <div class="target-buttons" id="protect-targets"></div>
                <button id="confirm-protect" class="primary-btn" disabled>Vote to Protect</button>
            </div>
        `;
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

    showVotingInterface(alivePlayers, isHost = false, isDead = false) {
        const container = document.getElementById('voting-options');
        if (!container) return;

        // If host, show message that they don't vote
        if (isHost) {
            container.innerHTML = '<p>🎮 As the host, you observe the voting but do not participate.</p>';
            return;
        }

        // If dead, show message that they can't vote - no voting interface
        if (isDead) {
            container.innerHTML = `
                <div class="dead-player-message">
                    <h4>💀 You are dead</h4>
                    <p>You cannot participate in voting. Watch the remaining players decide who to eliminate.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = `
            <h4>Vote to eliminate a player:</h4>
            <div class="vote-buttons" id="vote-targets"></div>
            <button id="confirm-vote" class="primary-btn" disabled>Confirm Vote</button>
        `;

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
            const isCurrentPlayer = window.gameManager && player.id === window.gameManager.playerId;
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

        let roleText = roleInfo[role] || `Unknown role: ${role}`;
        
        // Special handling for minion - show mafia members
        if (role === 'minion' && mafiaMembers.length > 0) {
            const mafiaNames = mafiaMembers.map(member => member.name).join(', ');
            roleText += `<br><br><strong>🔪 The Mafia members are:</strong><br>${mafiaNames}`;
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
                'mafia': '🔪 Mafia Wins!',
                'suicide_bomber': '💣 Suicide Bomber Wins!'
            };
            resultEl.textContent = winnerText[winner] || `Game Over - ${winner} wins!`;
        }

        const finalPlayersEl = document.getElementById('final-players-list');
        if (finalPlayersEl) {
            finalPlayersEl.innerHTML = '';
            players.forEach(player => {
                const div = document.createElement('div');
                div.className = `player-card ${player.alive ? '' : 'dead'}`;
                div.innerHTML = `
                    <strong>${player.name}</strong>
                    <br><small>(${player.role})</small>
                `;
                finalPlayersEl.appendChild(div);
            });
        }

        // Update end controls based on host status
        const endControls = document.querySelector('.end-controls');
        if (endControls) {
            if (isHost) {
                endControls.innerHTML = `
                    <button id="new-game-btn" class="primary-btn">New Game</button>
                    <a href="/" class="secondary-btn">Home</a>
                `;
                
                // Attach event handler to the new button
                const newGameBtn = document.getElementById('new-game-btn');
                if (newGameBtn && window.gameManager) {
                    newGameBtn.onclick = () => {
                        window.gameManager.startNewGame();
                    };
                }
            } else {
                endControls.innerHTML = `
                    <p>Waiting for host to start a new game...</p>
                    <a href="/" class="secondary-btn">Home</a>
                `;
            }
        }
    }

    showNewGameNotification(message, isHost) {
        // Create modal overlay
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 1000;
        `;

        const modal = document.createElement('div');
        modal.className = 'new-game-modal';
        modal.style.cssText = `
            background: white;
            padding: 2rem;
            border-radius: 8px;
            text-align: center;
            max-width: 400px;
            margin: 1rem;
        `;

        modal.innerHTML = `
            <h3>🎮 New Game Started!</h3>
            <p>${message}</p>
            <div style="margin-top: 1.5rem;">
                <button id="stay-btn" class="primary-btn" style="margin-right: 1rem;">Stay & Play</button>
                <button id="leave-btn" class="secondary-btn">Leave Game</button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Handle button clicks
        document.getElementById('stay-btn').onclick = () => {
            document.body.removeChild(overlay);
        };

        document.getElementById('leave-btn').onclick = () => {
            window.gameManager.clearPersistedState();
            window.location.href = '/';
        };

        // Auto-close after 10 seconds if no action taken
        setTimeout(() => {
            if (document.body.contains(overlay)) {
                document.body.removeChild(overlay);
            }
        }, 10000);
    }
}

window.UIManager = UIManager;