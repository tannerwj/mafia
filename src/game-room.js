export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.lastActivity = Date.now();
    this.cleanupInterval = null;
    
    // Start cleanup timer
    this.startCleanupTimer();
  }

  async fetch(request) {
    const url = new URL(request.url);
    
    switch (url.pathname) {
      case '/websocket':
        return this.handleWebSocket(request);
      case '/create':
        return this.createRoom();
      case '/join':
        return this.joinRoom(request);
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  async handleWebSocket(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    server.accept();
    
    // Update activity on new connection
    this.updateActivity();
    
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      webSocket: server,
      playerId: null,
      playerName: null
    });

    server.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data);
        await this.handleMessage(sessionId, message);
      } catch (error) {
        console.error('Error handling message:', error);
        server.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format'
        }));
      }
    });

    server.addEventListener('close', () => {
      this.handleDisconnect(sessionId);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async handleMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Update activity timestamp
    this.updateActivity();

    switch (message.type) {
      case 'host_connect':
        await this.handleHostConnect(sessionId, message.hostName);
        break;
      case 'join_game':
        await this.handleJoinGame(sessionId, message.playerName);
        break;
      case 'start_game':
        await this.handleStartGame(sessionId, message.gameSettings);
        break;
      case 'kick_player':
        await this.handleKickPlayer(sessionId, message.playerId);
        break;
      case 'night_action':
        await this.handleNightAction(sessionId, message.action);
        break;
      case 'day_vote':
        await this.handleDayVote(sessionId, message.vote);
        break;
      case 'reveal_role':
        await this.handleRevealRole(sessionId);
        break;
      case 'new_game':
        await this.handleNewGame(sessionId);
        break;
      default:
        session.webSocket.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
  }

  async handleHostConnect(sessionId, hostName) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    
    if (!session) return;
    
    // Set up host session (host is not a player)
    session.playerName = hostName;
    session.isHost = true;
    
    // Set host ID if not already set
    if (!gameState.hostId) {
      gameState.hostId = sessionId; // Use session ID for host, not player ID
    }
    
    await this.saveGameState(gameState);
    await this.broadcastGameState();
  }

  async handleJoinGame(sessionId, playerName) {
    const gameState = await this.getGameState();
    
    if (gameState.phase !== 'lobby') {
      const session = this.sessions.get(sessionId);
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Game already in progress'
      }));
      return;
    }

    const playerId = crypto.randomUUID();
    const session = this.sessions.get(sessionId);
    session.playerId = playerId;
    session.playerName = playerName;

    gameState.players.set(playerId, {
      id: playerId,
      name: playerName,
      role: null,
      alive: true,
      sessionId: sessionId
    });

    await this.saveGameState(gameState);
    
    // Send player joined confirmation to the joining player
    session.webSocket.send(JSON.stringify({
      type: 'player_joined',
      playerId: playerId,
      playerName: playerName
    }));
    
    await this.broadcastGameState();
  }

  async handleStartGame(sessionId, gameSettings) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    
    // Check if this session is the host
    if (!session || (!session.isHost && sessionId !== gameState.hostId)) {
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Only the host can start the game'
      }));
      return;
    }

    if (gameState.players.size < 2) {
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Need at least 2 players to start'
      }));
      return;
    }

    // Store game settings
    gameState.gameSettings = gameSettings || {
      dayDuration: 0,
      mafiaCount: 'auto',
      detectiveCount: 0,
      angelCount: 0,
      suicideBomber: false,
      minion: false
    };

    // Assign roles based on settings
    this.assignRoles(gameState);
    
    gameState.phase = 'night';
    gameState.day = 1;
    gameState.gameLog.push(`Game started with ${gameState.players.size} players`);

    await this.saveGameState(gameState);
    await this.broadcastGameState();
    await this.sendRolesToPlayers(gameState);
    
    // Initialize night action coordination for all role groups
    await this.broadcastNightActionUpdate(gameState);
  }

  async handleKickPlayer(sessionId, targetPlayerId) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    
    // Only host can kick players
    if (!session || (!session.isHost && sessionId !== gameState.hostId)) {
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Only the host can kick players'
      }));
      return;
    }

    // Can't kick during active game
    if (gameState.phase !== 'lobby') {
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Cannot kick players during an active game'
      }));
      return;
    }

    const targetPlayer = gameState.players.get(targetPlayerId);
    if (!targetPlayer) {
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Player not found'
      }));
      return;
    }

    // Remove player from game
    gameState.players.delete(targetPlayerId);
    
    // Close the kicked player's connection
    const targetSession = this.sessions.get(targetPlayer.sessionId);
    if (targetSession) {
      targetSession.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'You have been kicked from the game'
      }));
      targetSession.webSocket.close();
      this.sessions.delete(targetPlayer.sessionId);
    }

    gameState.gameLog.push(`${targetPlayer.name} was kicked from the game`);
    
    await this.saveGameState(gameState);
    await this.broadcastGameState();
  }

  assignRoles(gameState) {
    const playerIds = Array.from(gameState.players.keys());
    const numPlayers = playerIds.length;
    const settings = gameState.gameSettings || {};
    
    // Calculate role counts with sane defaults
    let mafiaCount, detectiveCount, angelCount;
    
    // Mafia count logic
    if (settings.mafiaCount === 'auto') {
      if (numPlayers <= 4) mafiaCount = 1;
      else if (numPlayers <= 7) mafiaCount = 2;
      else mafiaCount = 3;
    } else {
      mafiaCount = parseInt(settings.mafiaCount) || 1;
    }
    
    // Detective count - use the setting directly
    detectiveCount = parseInt(settings.detectiveCount) || 0;
    
    // Angel count (default based on player count)
    angelCount = settings.angelCount !== undefined ?
      parseInt(settings.angelCount) :
      (numPlayers >= 8 ? 1 : 0);
    
    // Special roles
    const hasSuicideBomber = settings.suicideBomber === true;
    const hasMinion = settings.minion === true;
    
    // Validate role counts don't exceed player count
    const totalSpecialRoles = mafiaCount + detectiveCount + angelCount +
      (hasSuicideBomber ? 1 : 0) + (hasMinion ? 1 : 0);
    
    if (totalSpecialRoles >= numPlayers) {
      // Fallback to simple assignment if too many special roles
      mafiaCount = 1;
      detectiveCount = 0;
      angelCount = 0;
    }
    
    // Shuffle players
    for (let i = playerIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerIds[i], playerIds[j]] = [playerIds[j], playerIds[i]];
    }

    let roleIndex = 0;
    
    // Assign Mafia
    for (let i = 0; i < mafiaCount; i++) {
      gameState.players.get(playerIds[roleIndex]).role = 'mafia';
      roleIndex++;
    }
    
    // Assign Detectives
    for (let i = 0; i < detectiveCount; i++) {
      gameState.players.get(playerIds[roleIndex]).role = 'detective';
      roleIndex++;
    }
    
    // Assign Angels
    for (let i = 0; i < angelCount; i++) {
      gameState.players.get(playerIds[roleIndex]).role = 'angel';
      roleIndex++;
    }
    
    // Assign Suicide Bomber
    if (hasSuicideBomber && roleIndex < numPlayers) {
      gameState.players.get(playerIds[roleIndex]).role = 'suicide_bomber';
      roleIndex++;
    }
    
    // Assign Minion
    if (hasMinion && roleIndex < numPlayers) {
      gameState.players.get(playerIds[roleIndex]).role = 'minion';
      roleIndex++;
    }
    
    // Assign remaining players as Villagers
    for (let i = roleIndex; i < numPlayers; i++) {
      gameState.players.get(playerIds[i]).role = 'villager';
    }
    
    // Log role distribution
    const roleCount = {};
    for (const player of gameState.players.values()) {
      roleCount[player.role] = (roleCount[player.role] || 0) + 1;
    }
    
    const roleString = Object.entries(roleCount)
      .map(([role, count]) => `${count} ${role}${count > 1 ? 's' : ''}`)
      .join(', ');
    
    gameState.gameLog.push(`Roles assigned: ${roleString}`);
  }

  async sendRolesToPlayers(gameState) {
    for (const [playerId, player] of gameState.players) {
      const session = this.sessions.get(player.sessionId);
      if (session && session.webSocket) {
        // Get rolemates for coordination
        const rolemates = this.getRolemates(gameState, player.role, playerId);
        
        session.webSocket.send(JSON.stringify({
          type: 'role_assigned',
          role: player.role,
          rolemates: rolemates
        }));
      }
    }
  }

  getRolemates(gameState, role, excludePlayerId) {
    const rolemates = [];
    for (const [playerId, player] of gameState.players) {
      if (player.role === role && playerId !== excludePlayerId && player.alive) {
        rolemates.push({
          id: playerId,
          name: player.name
        });
      }
    }
    return rolemates;
  }

  async handleNightAction(sessionId, action) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    
    if (!session || !session.playerId) {
      console.error('No session or playerId found for night action');
      return;
    }
    
    const player = gameState.players.get(session.playerId);

    if (gameState.phase !== 'night') {
      console.log('Not night phase, ignoring action');
      return;
    }
    
    if (!player) {
      console.error('Player not found for night action:', session.playerId);
      return;
    }
    
    if (!player.alive) {
      console.log('Dead player trying to act:', player.name);
      return;
    }

    console.log(`Night action from ${player.name} (${player.role}):`, action);

    // Initialize role voting maps if they don't exist
    if (!gameState.roleVoting) {
      gameState.roleVoting = {
        mafiaVotes: new Map(),
        detectiveVotes: new Map(),
        angelVotes: new Map()
      };
    }

    if (player.role === 'mafia' && action.type === 'kill') {
      gameState.roleVoting.mafiaVotes.set(session.playerId, action.target);
      console.log('Mafia kill vote recorded:', {
        voter: player.name,
        target: action.target
      });
    } else if (player.role === 'detective' && action.type === 'investigate') {
      gameState.roleVoting.detectiveVotes.set(session.playerId, action.target);
      console.log('Detective investigation vote recorded:', {
        voter: player.name,
        target: action.target
      });
    } else if (player.role === 'angel' && action.type === 'protect') {
      gameState.roleVoting.angelVotes.set(session.playerId, action.target);
      console.log('Angel protection vote recorded:', {
        voter: player.name,
        target: action.target
      });
    }

    await this.saveGameState(gameState);
    await this.broadcastNightActionUpdate(gameState);
    await this.checkNightActionsComplete(gameState);
  }

  async broadcastNightActionUpdate(gameState) {
    console.log('broadcastNightActionUpdate called for day:', gameState.day);
    // Send updated voting status to each role group
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.alive);
    console.log('Alive players:', alivePlayers.map(p => p.name));
    
    for (const [playerId, player] of gameState.players) {
      if (!player.alive) continue;
      
      const session = this.sessions.get(player.sessionId);
      if (!session || !session.webSocket) {
        console.log(`No session or websocket for player ${player.name}`);
        continue;
      }

      const rolemates = this.getRolemates(gameState, player.role, playerId);
      let nightActionState = null;

      if (gameState.roleVoting) {
        if (player.role === 'mafia') {
          // Only show this player's own vote, but show all teammates' votes for coordination
          nightActionState = {
            mafiaVotes: Object.fromEntries(gameState.roleVoting.mafiaVotes)
          };
        } else if (player.role === 'detective') {
          // Only show this player's own vote, but show all teammates' votes for coordination
          nightActionState = {
            detectiveVotes: Object.fromEntries(gameState.roleVoting.detectiveVotes)
          };
        } else if (player.role === 'angel') {
          // Only show this player's own vote, but show all teammates' votes for coordination
          nightActionState = {
            angelVotes: Object.fromEntries(gameState.roleVoting.angelVotes)
          };
        }
      }

      console.log(`Sending night_action_update to ${player.name} (${player.role})`);
      session.webSocket.send(JSON.stringify({
        type: 'night_action_update',
        role: player.role,
        rolemates: rolemates,
        alivePlayers: alivePlayers.map(p => ({ id: p.id, name: p.name })),
        nightActionState: nightActionState
      }));
    }
  }

  async checkNightActionsComplete(gameState) {
    if (!gameState.roleVoting) return;

    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.alive);
    
    // Check if all members of each role group have voted AND agreed
    const aliveMafia = alivePlayers.filter(p => p.role === 'mafia');
    const aliveDetectives = alivePlayers.filter(p => p.role === 'detective');
    const aliveAngels = alivePlayers.filter(p => p.role === 'angel');

    // Check mafia consensus
    let mafiaComplete = true;
    if (aliveMafia.length > 0) {
      const mafiaVoteTargets = Array.from(gameState.roleVoting.mafiaVotes.values());
      const mafiaVoters = Array.from(gameState.roleVoting.mafiaVotes.keys())
        .filter(playerId => {
          const player = gameState.players.get(playerId);
          return player && player.alive && player.role === 'mafia';
        });
      
      // All mafia must vote and agree on the same target
      mafiaComplete = mafiaVoters.length === aliveMafia.length &&
                     mafiaVoteTargets.length > 0 &&
                     mafiaVoteTargets.every(target => target === mafiaVoteTargets[0]);
    }

    // Check detective consensus
    let detectivesComplete = true;
    if (aliveDetectives.length > 0) {
      const detectiveVoteTargets = Array.from(gameState.roleVoting.detectiveVotes.values());
      const detectiveVoters = Array.from(gameState.roleVoting.detectiveVotes.keys())
        .filter(playerId => {
          const player = gameState.players.get(playerId);
          return player && player.alive && player.role === 'detective';
        });
      
      // All detectives must vote and agree on the same target
      detectivesComplete = detectiveVoters.length === aliveDetectives.length &&
                          detectiveVoteTargets.length > 0 &&
                          detectiveVoteTargets.every(target => target === detectiveVoteTargets[0]);
    }

    // Check angel consensus
    let angelsComplete = true;
    if (aliveAngels.length > 0) {
      const angelVoteTargets = Array.from(gameState.roleVoting.angelVotes.values());
      const angelVoters = Array.from(gameState.roleVoting.angelVotes.keys())
        .filter(playerId => {
          const player = gameState.players.get(playerId);
          return player && player.alive && player.role === 'angel';
        });
      
      // All angels must vote and agree on the same target
      angelsComplete = angelVoters.length === aliveAngels.length &&
                      angelVoteTargets.length > 0 &&
                      angelVoteTargets.every(target => target === angelVoteTargets[0]);
    }

    console.log('Night actions consensus check:', {
      aliveMafia: aliveMafia.length,
      mafiaComplete: mafiaComplete,
      aliveDetectives: aliveDetectives.length,
      detectivesComplete: detectivesComplete,
      aliveAngels: aliveAngels.length,
      angelsComplete: angelsComplete
    });

    if (mafiaComplete && detectivesComplete && angelsComplete) {
      console.log('All night roles have reached consensus, resolving night');
      await this.resolveNightActions(gameState);
    }
  }

  async resolveNightActions(gameState) {
    if (!gameState.roleVoting) {
      console.log('No role voting data found');
      return;
    }

    const killVotes = new Map();
    const protections = new Set();
    const investigations = new Map();
    
    console.log('Resolving night actions with role voting:', {
      mafiaVotes: Array.from(gameState.roleVoting.mafiaVotes.entries()),
      detectiveVotes: Array.from(gameState.roleVoting.detectiveVotes.entries()),
      angelVotes: Array.from(gameState.roleVoting.angelVotes.entries())
    });
    
    // Process mafia kill votes
    for (const [playerId, targetId] of gameState.roleVoting.mafiaVotes) {
      const player = gameState.players.get(playerId);
      if (player && player.alive && player.role === 'mafia') {
        killVotes.set(targetId, (killVotes.get(targetId) || 0) + 1);
        console.log(`Mafia ${player.name} voted to kill ${targetId}`);
      }
    }

    // Process angel protection votes
    for (const [playerId, targetId] of gameState.roleVoting.angelVotes) {
      const player = gameState.players.get(playerId);
      if (player && player.alive && player.role === 'angel') {
        protections.add(targetId);
        console.log(`Angel ${player.name} voted to protect ${targetId}`);
      }
    }

    // Process detective investigation votes - find most voted target
    const investigationVotes = new Map();
    for (const [playerId, targetId] of gameState.roleVoting.detectiveVotes) {
      const player = gameState.players.get(playerId);
      if (player && player.alive && player.role === 'detective') {
        investigationVotes.set(targetId, (investigationVotes.get(targetId) || 0) + 1);
        console.log(`Detective ${player.name} voted to investigate ${targetId}`);
      }
    }

    // Find most voted investigation target
    let maxInvestigationVotes = 0;
    let investigationTarget = null;
    for (const [targetId, votes] of investigationVotes) {
      if (votes > maxInvestigationVotes) {
        maxInvestigationVotes = votes;
        investigationTarget = targetId;
      }
    }

    // Perform investigation if there's a target
    if (investigationTarget && gameState.players.has(investigationTarget)) {
      const target = gameState.players.get(investigationTarget);
      const isMafia = target.role === 'mafia';
      
      // Send result to all detectives who participated
      for (const [detectiveId] of gameState.roleVoting.detectiveVotes) {
        const detective = gameState.players.get(detectiveId);
        if (detective && detective.alive) {
          const detectiveSession = this.sessions.get(detective.sessionId);
          if (detectiveSession && detectiveSession.webSocket) {
            detectiveSession.webSocket.send(JSON.stringify({
              type: 'investigation_result',
              target: target.name,
              isMafia: isMafia
            }));
          }
        }
      }
      console.log(`Investigation result: ${target.name} is ${isMafia ? 'Mafia' : 'Not Mafia'}`);
    }

    // Find most voted kill target
    let maxKillVotes = 0;
    let killedPlayer = null;
    for (const [targetId, votes] of killVotes) {
      if (votes > maxKillVotes) {
        maxKillVotes = votes;
        killedPlayer = targetId;
      }
    }

    // Execute kill if target is not protected
    if (killedPlayer && gameState.players.has(killedPlayer)) {
      if (protections.has(killedPlayer)) {
        const target = gameState.players.get(killedPlayer);
        gameState.gameLog.push(`The Mafia tried to kill ${target.name} but ${target.name} was saved by an Angel!`);
      } else {
        const victim = gameState.players.get(killedPlayer);
        victim.alive = false;
        gameState.gameLog.push(`${victim.name} was killed during the night (${victim.role})`);
      }
    } else if (maxKillVotes > 0) {
      gameState.gameLog.push('The Mafia failed to agree on a target');
    } else {
      gameState.gameLog.push('No one was killed during the night');
    }

    // Clear role voting and move to day
    gameState.roleVoting = {
      mafiaVotes: new Map(),
      detectiveVotes: new Map(),
      angelVotes: new Map()
    };
    gameState.phase = 'day';
    gameState.dayVotes.clear();

    await this.saveGameState(gameState);
    
    // Check win conditions
    if (await this.checkWinConditions(gameState)) {
      return;
    }

    await this.broadcastGameState();
    
    // Add transition message and auto-transition to voting after 8 seconds
    setTimeout(async () => {
      const currentState = await this.getGameState();
      if (currentState.phase === 'day') {
        // Add transition message
        currentState.gameLog.push('☀️ Day phase begins - Discuss what happened during the night and vote to eliminate someone!');
        currentState.phase = 'voting';
        await this.saveGameState(currentState);
        await this.broadcastGameState();
      }
    }, 8000);
  }

  async handleDayVote(sessionId, vote) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    const player = gameState.players.get(session.playerId);

    if (gameState.phase !== 'voting' || !player || !player.alive) {
      return;
    }

    gameState.dayVotes.set(session.playerId, vote.target);
    await this.saveGameState(gameState);
    
    // Check if all alive players have voted
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.alive);
    const votes = Array.from(gameState.dayVotes.keys());
    
    if (votes.length === alivePlayers.length) {
      await this.resolveDayVoting(gameState);
    }
  }

  async resolveDayVoting(gameState) {
    const voteCount = new Map();
    
    for (const [playerId, target] of gameState.dayVotes) {
      voteCount.set(target, (voteCount.get(target) || 0) + 1);
    }

    // Find player with most votes
    let maxVotes = 0;
    let eliminatedPlayer = null;
    for (const [targetId, votes] of voteCount) {
      if (votes > maxVotes) {
        maxVotes = votes;
        eliminatedPlayer = targetId;
      }
    }

    // Execute elimination
    if (eliminatedPlayer && eliminatedPlayer !== 'no_murder' && gameState.players.has(eliminatedPlayer)) {
      const victim = gameState.players.get(eliminatedPlayer);
      victim.alive = false;
      gameState.gameLog.push(`${victim.name} was eliminated by village vote (${victim.role})`);
    } else {
      gameState.gameLog.push('No one was eliminated this round');
    }

    gameState.dayVotes.clear();
    
    // Clear role voting maps for the new night
    gameState.roleVoting = {
      mafiaVotes: new Map(),
      detectiveVotes: new Map(),
      angelVotes: new Map()
    };
    
    // Check win conditions
    if (await this.checkWinConditions(gameState)) {
      return;
    }

    // Move to next night
    gameState.phase = 'night';
    gameState.day++;
    
    // Add transition message
    gameState.gameLog.push(`🌙 Night ${gameState.day} begins - Special roles, make your moves!`);

    await this.saveGameState(gameState);
    await this.broadcastGameState();
    
    // Initialize night action coordination for the new night
    await this.broadcastNightActionUpdate(gameState);
  }

  async checkWinConditions(gameState) {
    const alivePlayers = Array.from(gameState.players.values()).filter(p => p.alive);
    const aliveMafia = alivePlayers.filter(p => p.role === 'mafia' || p.role === 'minion');
    const aliveVillage = alivePlayers.filter(p =>
      ['villager', 'detective', 'angel', 'suicide_bomber'].includes(p.role)
    );

    let winner = null;
    
    if (aliveMafia.length === 0) {
      winner = 'village';
      gameState.gameLog.push('Village wins! All Mafia have been eliminated.');
    } else if (aliveMafia.length >= aliveVillage.length) {
      winner = 'mafia';
      gameState.gameLog.push('Mafia wins! They equal or outnumber the Village.');
    }

    if (winner) {
      gameState.phase = 'ended';
      gameState.winner = winner;
      await this.saveGameState(gameState);
      await this.broadcastGameState();
      return true;
    }

    return false;
  }

  async handleRevealRole(sessionId) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    const player = gameState.players.get(session.playerId);

    if (player) {
      session.webSocket.send(JSON.stringify({
        type: 'role_reveal',
        role: player.role
      }));
    }
  }

  async handleNewGame(sessionId) {
    const gameState = await this.getGameState();
    const session = this.sessions.get(sessionId);
    
    // Check if this session is the host
    if (!session || (!session.isHost && sessionId !== gameState.hostId)) {
      session.webSocket.send(JSON.stringify({
        type: 'error',
        message: 'Only the host can start a new game'
      }));
      return;
    }

    // Reset game state but keep existing players
    const existingPlayers = new Map();
    for (const [playerId, player] of gameState.players) {
      // Reset player state but keep them in the game
      existingPlayers.set(playerId, {
        ...player,
        role: null,
        alive: true
      });
    }

    // Reset game state
    gameState.phase = 'lobby';
    gameState.day = 0;
    gameState.players = existingPlayers;
    gameState.nightActions = new Map();
    gameState.dayVotes = new Map();
    gameState.roleVoting = {
      mafiaVotes: new Map(),
      detectiveVotes: new Map(),
      angelVotes: new Map()
    };
    gameState.gameLog = ['New game started! Players from previous game have been kept.'];
    gameState.winner = null;

    await this.saveGameState(gameState);
    
    // Send new game notification to all players
    for (const [sessionId, session] of this.sessions) {
      if (session.webSocket) {
        session.webSocket.send(JSON.stringify({
          type: 'new_game_started',
          message: 'Host started a new game! You can leave or stay to play again.'
        }));
      }
    }
    
    await this.broadcastGameState();
  }

  handleDisconnect(sessionId) {
    this.sessions.delete(sessionId);
  }

  async broadcastGameState() {
    const gameState = await this.getGameState();
    const publicGameState = this.getPublicGameState(gameState);
    
    for (const [sessionId, session] of this.sessions) {
      if (session.webSocket) {
        session.webSocket.send(JSON.stringify({
          type: 'game_state_update',
          gameState: publicGameState
        }));
      }
    }
  }

  getPublicGameState(gameState) {
    const publicPlayers = Array.from(gameState.players.values()).map(player => ({
      id: player.id,
      name: player.name,
      alive: player.alive,
      role: player.alive ? null : player.role // Only reveal role if dead
    }));

    return {
      roomId: gameState.roomId,
      phase: gameState.phase,
      day: gameState.day,
      players: publicPlayers,
      gameLog: gameState.gameLog,
      winner: gameState.winner,
      hostId: gameState.hostId
    };
  }

  async getGameState() {
    const stored = await this.state.storage.get('gameState');
    if (stored) {
      // Convert stored data back to Maps
      const gameState = JSON.parse(stored);
      gameState.players = new Map(gameState.players);
      gameState.nightActions = new Map(gameState.nightActions || []);
      gameState.dayVotes = new Map(gameState.dayVotes || []);
      
      // Handle role voting system
      if (gameState.roleVoting) {
        gameState.roleVoting.mafiaVotes = new Map(gameState.roleVoting.mafiaVotes || []);
        gameState.roleVoting.detectiveVotes = new Map(gameState.roleVoting.detectiveVotes || []);
        gameState.roleVoting.angelVotes = new Map(gameState.roleVoting.angelVotes || []);
      } else {
        gameState.roleVoting = {
          mafiaVotes: new Map(),
          detectiveVotes: new Map(),
          angelVotes: new Map()
        };
      }
      
      return gameState;
    }

    // Initialize new game state
    const gameState = {
      roomId: crypto.randomUUID(),
      phase: 'lobby',
      day: 0,
      players: new Map(),
      nightActions: new Map(),
      dayVotes: new Map(),
      roleVoting: {
        mafiaVotes: new Map(),
        detectiveVotes: new Map(),
        angelVotes: new Map()
      },
      gameLog: [],
      hostId: null,
      winner: null,
      gameSettings: {
        dayDuration: 0,
        mafiaCount: 'auto',
        detectiveCount: 0,
        angelCount: 0,
        suicideBomber: false,
        minion: false
      }
    };

    await this.saveGameState(gameState);
    return gameState;
  }

  async saveGameState(gameState) {
    // Convert Maps to arrays for storage
    const storableState = {
      ...gameState,
      players: Array.from(gameState.players.entries()),
      nightActions: Array.from(gameState.nightActions.entries()),
      dayVotes: Array.from(gameState.dayVotes.entries()),
      roleVoting: {
        mafiaVotes: Array.from(gameState.roleVoting.mafiaVotes.entries()),
        detectiveVotes: Array.from(gameState.roleVoting.detectiveVotes.entries()),
        angelVotes: Array.from(gameState.roleVoting.angelVotes.entries())
      }
    };
    
    await this.state.storage.put('gameState', JSON.stringify(storableState));
  }

  async createRoom() {
    const gameState = await this.getGameState();
    return new Response(JSON.stringify({
      roomId: gameState.roomId
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  async joinRoom(request) {
    const gameState = await this.getGameState();
    return new Response(JSON.stringify({
      success: true,
      roomId: gameState.roomId,
      phase: gameState.phase
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  startCleanupTimer() {
    // Clean up room after 2 hours of inactivity
    const CLEANUP_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours in milliseconds
    
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastActivity = now - this.lastActivity;
      
      if (timeSinceLastActivity > CLEANUP_TIMEOUT) {
        console.log('Room cleanup: Removing inactive room');
        this.cleanup();
      }
    }, 30 * 60 * 1000); // Check every 30 minutes
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  cleanup() {
    // Close all WebSocket connections
    for (const [sessionId, session] of this.sessions) {
      if (session.webSocket) {
        session.webSocket.close();
      }
    }
    this.sessions.clear();
    
    // Clear cleanup timer
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    
    // Clear storage
    this.state.storage.deleteAll();
  }
}