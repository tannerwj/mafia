import { GameRoom } from './game-room.js';

// Export the GameRoom class for Durable Objects
export { GameRoom };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle static file requests by serving actual files from the static directory
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return env.ASSETS.fetch(new Request(url.origin + '/index.html'));
    }
    
    if (url.pathname === '/game.html') {
      return env.ASSETS.fetch(new Request(url.origin + '/game.html'));
    }
    
    if (url.pathname === '/instructions.html') {
      return env.ASSETS.fetch(new Request(url.origin + '/instructions.html'));
    }
    
    if (url.pathname.startsWith('/css/') || url.pathname.startsWith('/js/')) {
      return env.ASSETS.fetch(request);
    }
    
    // Handle API requests
    if (url.pathname === '/api/create-room') {
      return handleCreateRoom(request, env);
    }
    
    if (url.pathname === '/api/join-room') {
      return handleJoinRoom(request, env);
    }
    
    // Handle WebSocket upgrade for game rooms
    if (url.pathname.startsWith('/room/') && url.pathname.endsWith('/websocket')) {
      const roomId = url.pathname.split('/')[2];
      return handleWebSocket(request, env, roomId);
    }
    
    return new Response('Not Found', { status: 404 });
  }
};

async function handleCreateRoom(request, env) {
  try {
    const { hostName } = await request.json();
    
    if (!hostName || hostName.trim().length === 0) {
      return Response.json({ success: false, error: 'Host name is required' });
    }
    
    // Generate a unique room ID
    const roomId = generateRoomId();
    
    // Get the Durable Object for this room
    const roomObject = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomId));
    
    // Initialize the room
    const response = await roomObject.fetch(new Request('http://internal/init', {
      method: 'POST',
      body: JSON.stringify({ hostName: hostName.trim() })
    }));
    
    const result = await response.json();
    
    if (result.success) {
      const joinUrl = `/game.html?room=${roomId}`;
      return Response.json({ 
        success: true, 
        roomId, 
        joinUrl 
      });
    } else {
      return Response.json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Error creating room:', error);
    return Response.json({ success: false, error: 'Failed to create room' });
  }
}

async function handleJoinRoom(request, env) {
  try {
    const url = new URL(request.url);
    const roomId = url.searchParams.get('roomId');
    
    if (!roomId) {
      return Response.json({ success: false, error: 'Room ID is required' });
    }
    
    // Check if room exists by trying to get its state
    const roomObject = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomId));
    const response = await roomObject.fetch(new Request('http://internal/check'));
    const result = await response.json();
    
    if (result.exists) {
      const joinUrl = `/game.html?room=${roomId}`;
      return Response.json({ success: true, joinUrl });
    } else {
      return Response.json({ success: false, error: 'Room not found' });
    }
  } catch (error) {
    console.error('Error joining room:', error);
    return Response.json({ success: false, error: 'Failed to join room' });
  }
}

async function handleWebSocket(request, env, roomId) {
  const upgradeHeader = request.headers.get('Upgrade');
  if (upgradeHeader !== 'websocket') {
    return new Response('Expected Upgrade: websocket', { status: 426 });
  }
  
  // Get the Durable Object for this room
  const roomObject = env.GAME_ROOMS.get(env.GAME_ROOMS.idFromName(roomId));
  
  // Create a new request with the correct path for the GameRoom
  const newRequest = new Request('http://internal/websocket', {
    method: request.method,
    headers: request.headers,
    body: request.body
  });
  
  // Forward the WebSocket request to the room
  return roomObject.fetch(newRequest);
}

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}