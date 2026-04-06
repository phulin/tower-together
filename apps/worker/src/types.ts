export interface TowerSave {
  towerId: string
  name: string
  simTime: number
  width: number
  height: number
  cells: Array<{ x: number; y: number; tileType: string }>
  updatedAt: number
}

export interface TowerRuntimeState {
  towerId: string
  name: string
  simTime: number
  isRunning: boolean
  width: number
  height: number
  cells: Record<string, string>  // "x,y" -> tileType
  sockets: Map<string, WebSocket>
}

// WebSocket messages from client
export type ClientMessage =
  | { type: 'join_tower'; playerId: string; displayName: string }
  | { type: 'place_tile'; x: number; y: number; tileType: string }
  | { type: 'remove_tile'; x: number; y: number }
  | { type: 'ping' }

// WebSocket messages to client
export type ServerMessage =
  | { type: 'init_state'; towerId: string; name: string; simTime: number; width: number; height: number; cells: Array<{x: number; y: number; tileType: string}> }
  | { type: 'state_patch'; cells: Array<{x: number; y: number; tileType: string}> }
  | { type: 'command_result'; accepted: boolean; patch?: { cells: Array<{x: number; y: number; tileType: string}> }; reason?: string }
  | { type: 'presence_update'; playerCount: number }
  | { type: 'time_update'; simTime: number }
  | { type: 'pong' }
