// Shared client <-> server message protocol.
// Spec 00 placeholder: a trivial ping/pong union that exercises the full
// client -> Worker -> Durable Object -> WebSocket round trip. Spec 01 replaces
// this with the real protocol (join, snapshot, actions, etc.).

export interface PingMessage {
  type: "ping";
  /** Client-generated nonce echoed back in the matching pong. */
  nonce: string;
}

export interface PongMessage {
  type: "pong";
  /** Echoes the nonce from the ping this pong answers. */
  nonce: string;
}

export type ClientMessage = PingMessage;
export type ServerMessage = PongMessage;
export type ProtocolMessage = ClientMessage | ServerMessage;
