export type TileType = 'empty' | 'floor' | 'room_basic'

export type SelectedTool = 'empty' | 'floor' | 'room_basic'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export type ServerMessage =
  | {
      type: 'init_state'
      towerId: string
      name: string
      simTime: number
      width: number
      height: number
      cells: Array<{ x: number; y: number; tileType: string }>
    }
  | { type: 'state_patch'; cells: Array<{ x: number; y: number; tileType: string }> }
  | {
      type: 'command_result'
      accepted: boolean
      patch?: { cells: Array<{ x: number; y: number; tileType: string }> }
      reason?: string
    }
  | { type: 'presence_update'; playerCount: number }
  | { type: 'time_update'; simTime: number }

export type ClientMessage =
  | { type: 'join_tower'; playerId: string; displayName: string }
  | { type: 'place_tile'; x: number; y: number; tileType: string }
  | { type: 'remove_tile'; x: number; y: number }
  | { type: 'ping' }

export interface GameCallbacks {
  onCellClick: (x: number, y: number) => void
}
