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

// Tile width in grid cells
export const TILE_WIDTHS: Record<string, number> = {
  floor:         1,
  lobby:         4,
  hotel_single:  1,
  hotel_twin:    2,
  hotel_suite:   3,
}

// One-time build cost in dollars
export const TILE_COSTS: Record<string, number> = {
  floor:         5_000,
  lobby:         0,
  hotel_single:  50_000,
  hotel_twin:    80_000,
  hotel_suite:   120_000,
}

// Income per in-game day (TICKS_PER_DAY ticks)
export const HOTEL_DAILY_INCOME: Record<string, number> = {
  hotel_single:  10_000,
  hotel_twin:    15_000,
  hotel_suite:   25_000,
}

export const VALID_TILE_TYPES = new Set(Object.keys(TILE_WIDTHS))
export const TICKS_PER_DAY = 24
export const STARTING_CASH = 2_000_000

// WebSocket messages from client
export type ClientMessage =
  | { type: 'join_tower'; playerId: string; displayName: string }
  | { type: 'place_tile'; x: number; y: number; tileType: string }
  | { type: 'remove_tile'; x: number; y: number }
  | { type: 'ping' }

// WebSocket messages to client
export type ServerMessage =
  | {
      type: 'init_state'
      towerId: string
      name: string
      simTime: number
      cash: number
      width: number
      height: number
      cells: Array<{ x: number; y: number; tileType: string }>
    }
  | { type: 'state_patch'; cells: Array<{ x: number; y: number; tileType: string }> }
  | { type: 'command_result'; accepted: boolean; patch?: { cells: Array<{ x: number; y: number; tileType: string }> }; reason?: string }
  | { type: 'presence_update'; playerCount: number }
  | { type: 'time_update'; simTime: number }
  | { type: 'economy_update'; cash: number }
  | { type: 'pong' }
