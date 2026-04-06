import { DurableObject } from 'cloudflare:workers'
import {
  TILE_WIDTHS,
  TILE_COSTS,
  HOTEL_DAILY_INCOME,
  VALID_TILE_TYPES,
  TICKS_PER_DAY,
  STARTING_CASH,
  type ClientMessage,
  type ServerMessage,
} from '../types'

interface Env {
  TOWER_ROOM: DurableObjectNamespace
}

interface TowerState {
  towerId: string
  name: string
  simTime: number
  isRunning: boolean
  width: number
  height: number
  cash: number
  // "x,y" -> tileType (anchor cell for multi-tile objects)
  cells: Record<string, string>
  // extension cells -> their anchor cell key ("x+1,y" -> "x,y")
  cellToAnchor: Record<string, string>
}

export class TowerRoom extends DurableObject<Env> {
  private state: TowerState | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tower (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  }

  async initialize(towerId: string, name: string): Promise<void> {
    this.state = {
      towerId,
      name,
      simTime: 0,
      isRunning: false,
      width: 64,
      height: 80,
      cash: STARTING_CASH,
      cells: {},
      cellToAnchor: {},
    }
    await this.saveState()
  }

  loadState(): TowerState | null {
    const cursor = this.ctx.storage.sql.exec(
      'SELECT value FROM tower WHERE key = ?',
      'state'
    )
    const rows = cursor.toArray()
    const row = rows[0] as { value: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.value) as TowerState
    // Back-compat: older saves without these fields
    if (!parsed.cash) parsed.cash = STARTING_CASH
    if (!parsed.cellToAnchor) parsed.cellToAnchor = {}
    return parsed
  }

  async saveState(): Promise<void> {
    if (!this.state) return
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO tower VALUES (?, ?)',
      'state',
      JSON.stringify(this.state)
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      this.ctx.acceptWebSocket(server)
      return new Response(null, { status: 101, webSocket: client })
    }

    const path = url.pathname

    if (request.method === 'POST' && path === '/init') {
      const towerId = url.searchParams.get('towerId')
      const name = url.searchParams.get('name')
      if (!towerId || !name) {
        return new Response(JSON.stringify({ error: 'Missing towerId or name' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      await this.initialize(towerId, name)
      return new Response(JSON.stringify({ towerId, name }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    if (request.method === 'GET' && path === '/info') {
      const s = this.state ?? this.loadState()
      if (!s) {
        return new Response(JSON.stringify({ error: 'Tower not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          towerId: s.towerId,
          name: s.name,
          simTime: s.simTime,
          cash: s.cash,
          width: s.width,
          height: s.height,
          playerCount: this.ctx.getWebSockets().length,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as ClientMessage
    } catch {
      return
    }

    if (!this.state) {
      this.state = this.loadState()
    }

    if (!this.state) {
      this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Tower not initialized' })
      return
    }

    switch (msg.type) {
      case 'join_tower': {
        this.sendTo(ws, {
          type: 'init_state',
          towerId: this.state.towerId,
          name: this.state.name,
          simTime: this.state.simTime,
          cash: this.state.cash,
          width: this.state.width,
          height: this.state.height,
          cells: this.cellsToArray(this.state.cells),
        })

        const playerCount = this.ctx.getWebSockets().length
        this.broadcast({ type: 'presence_update', playerCount })

        if (playerCount >= 1 && !this.state.isRunning) {
          this.state.isRunning = true
          this.startTick()
        }
        break
      }

      case 'place_tile': {
        const { x, y, tileType } = msg

        if (!VALID_TILE_TYPES.has(tileType)) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Invalid tile type' })
          return
        }

        const width = TILE_WIDTHS[tileType] ?? 1
        const cost = TILE_COSTS[tileType] ?? 0

        // Bounds check for the full width of the object
        if (x < 0 || x + width - 1 >= this.state.width || y < 0 || y >= this.state.height) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Out of bounds' })
          return
        }

        // Funds check
        if (cost > this.state.cash) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Insufficient funds' })
          return
        }

        // Check all cells in the footprint are empty
        for (let dx = 0; dx < width; dx++) {
          const key = `${x + dx},${y}`
          if (this.state.cells[key] || this.state.cellToAnchor[key]) {
            this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Cell already occupied' })
            return
          }
        }

        // Place the tile: anchor at (x,y), extensions at (x+1..x+width-1, y)
        this.state.cells[`${x},${y}`] = tileType
        for (let dx = 1; dx < width; dx++) {
          this.state.cells[`${x + dx},${y}`] = tileType
          this.state.cellToAnchor[`${x + dx},${y}`] = `${x},${y}`
        }

        // Deduct cost
        this.state.cash -= cost

        const patchCells = Array.from({ length: width }, (_, dx) => ({
          x: x + dx, y, tileType,
        }))

        this.broadcast({ type: 'state_patch', cells: patchCells })
        this.sendTo(ws, { type: 'command_result', accepted: true, patch: { cells: patchCells } })
        if (cost > 0) this.broadcast({ type: 'economy_update', cash: this.state.cash })
        break
      }

      case 'remove_tile': {
        const { x, y } = msg

        if (x < 0 || x >= this.state.width || y < 0 || y >= this.state.height) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Out of bounds' })
          return
        }

        const clickedKey = `${x},${y}`
        // Resolve to anchor
        const anchorKey = this.state.cellToAnchor[clickedKey] ?? clickedKey
        const tileType = this.state.cells[anchorKey]

        if (!tileType) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Cell is empty' })
          return
        }

        // Remove all cells belonging to this object
        const [ax, ay] = anchorKey.split(',').map(Number)
        const width = TILE_WIDTHS[tileType] ?? 1
        const patchCells: Array<{ x: number; y: number; tileType: string }> = []

        for (let dx = 0; dx < width; dx++) {
          const key = `${ax + dx},${ay}`
          delete this.state.cells[key]
          if (dx > 0) delete this.state.cellToAnchor[key]
          patchCells.push({ x: ax + dx, y: ay, tileType: 'empty' })
        }

        this.broadcast({ type: 'state_patch', cells: patchCells })
        this.sendTo(ws, { type: 'command_result', accepted: true, patch: { cells: patchCells } })
        break
      }

      case 'ping': {
        this.sendTo(ws, { type: 'pong' })
        break
      }
    }
  }

  webSocketClose(_ws: WebSocket): void {
    const remaining = this.ctx.getWebSockets().length
    if (remaining === 0) {
      if (this.state) this.state.isRunning = false
      this.stopTick()
      void this.saveState()
    } else {
      this.broadcast({ type: 'presence_update', playerCount: remaining })
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    this.webSocketClose(_ws)
  }

  private startTick(): void {
    if (this.tickTimer !== null) return
    this.tickTimer = setInterval(() => this.tick(), 1000)
  }

  private stopTick(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  private tick(): void {
    if (!this.state || !this.state.isRunning) return

    this.state.simTime += 1
    this.broadcast({ type: 'time_update', simTime: this.state.simTime })

    // Collect hotel income at the end of each in-game day
    if (this.state.simTime % TICKS_PER_DAY === 0) {
      this.collectHotelIncome()
    }

    // Periodic save every 30 ticks
    if (this.state.simTime % 30 === 0) {
      void this.saveState()
    }
  }

  private collectHotelIncome(): void {
    if (!this.state) return
    let income = 0

    // Count anchor cells only (extension cells don't have a cellToAnchor entry from anchor's side)
    for (const [key, tileType] of Object.entries(this.state.cells)) {
      // Skip extension cells
      if (this.state.cellToAnchor[key]) continue
      const daily = HOTEL_DAILY_INCOME[tileType]
      if (daily) income += daily
    }

    if (income > 0) {
      this.state.cash = Math.min(99_999_999, this.state.cash + income)
      this.broadcast({ type: 'economy_update', cash: this.state.cash })
    }
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== exclude) this.sendTo(socket, msg)
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // Socket may be closed
    }
  }

  private cellsToArray(cells: Record<string, string>): Array<{ x: number; y: number; tileType: string }> {
    return Object.entries(cells).map(([key, tileType]) => {
      const [xStr, yStr] = key.split(',')
      return { x: parseInt(xStr, 10), y: parseInt(yStr, 10), tileType }
    })
  }
}
