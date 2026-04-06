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
  cells: Record<string, string>       // "x,y" -> tileType (all cells incl. extensions)
  cellToAnchor: Record<string, string> // extension cell key -> anchor cell key
}

export class TowerRoom extends DurableObject<Env> {
  private state: TowerState | null = null
  private tickTimer: ReturnType<typeof setInterval> | null = null
  // Track active sockets ourselves (classic non-hibernation API)
  private sockets: Set<WebSocket> = new Set()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tower (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  async initialize(towerId: string, name: string): Promise<void> {
    this.state = {
      towerId, name,
      simTime: 0, isRunning: false,
      width: 64, height: 80,
      cash: STARTING_CASH,
      cells: {}, cellToAnchor: {},
    }
    await this.saveState()
  }

  private loadState(): TowerState | null {
    const cursor = this.ctx.storage.sql.exec('SELECT value FROM tower WHERE key = ?', 'state')
    const row = cursor.toArray()[0] as { value: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.value) as TowerState
    if (!parsed.cash) parsed.cash = STARTING_CASH
    if (!parsed.cellToAnchor) parsed.cellToAnchor = {}
    return parsed
  }

  private saveState(): void {
    if (!this.state) return
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO tower VALUES (?, ?)',
      'state',
      JSON.stringify(this.state),
    )
  }

  // ─── HTTP fetch handler ──────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade — use classic accept() so the socket stays open
    // immediately without relying on the hibernation API (which has wrangler
    // local-dev timing issues that cause Firefox to drop the connection).
    if (request.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair()

      // Classic (non-hibernation) accept
      server.accept()
      this.sockets.add(server)

      server.addEventListener('message', (evt: MessageEvent) => {
        this.handleMessage(server, evt.data as string | ArrayBuffer)
      })
      server.addEventListener('close', () => {
        this.sockets.delete(server)
        this.handleClose()
      })
      server.addEventListener('error', () => {
        this.sockets.delete(server)
        this.handleClose()
      })

      return new Response(null, { status: 101, webSocket: client })
    }

    const path = url.pathname

    if (request.method === 'POST' && path === '/init') {
      const towerId = url.searchParams.get('towerId')
      const name = url.searchParams.get('name')
      if (!towerId || !name) {
        return Response.json({ error: 'Missing towerId or name' }, { status: 400 })
      }
      await this.initialize(towerId, name)
      return Response.json({ towerId, name })
    }

    if (request.method === 'GET' && path === '/info') {
      const s = this.state ?? this.loadState()
      if (!s) return Response.json({ error: 'Tower not found' }, { status: 404 })
      return Response.json({
        towerId: s.towerId, name: s.name,
        simTime: s.simTime, cash: s.cash,
        width: s.width, height: s.height,
        playerCount: this.sockets.size,
      })
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  }

  // ─── WebSocket message handling ──────────────────────────────────────────────

  private handleMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as ClientMessage
    } catch { return }

    if (!this.state) this.state = this.loadState()
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
        this.broadcast({ type: 'presence_update', playerCount: this.sockets.size })
        if (!this.state.isRunning) {
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
        const w = TILE_WIDTHS[tileType] ?? 1
        const cost = TILE_COSTS[tileType] ?? 0

        if (x < 0 || x + w - 1 >= this.state.width || y < 0 || y >= this.state.height) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Out of bounds' })
          return
        }
        if (cost > this.state.cash) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Insufficient funds' })
          return
        }
        for (let dx = 0; dx < w; dx++) {
          const key = `${x + dx},${y}`
          if (this.state.cells[key] || this.state.cellToAnchor[key]) {
            this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Cell already occupied' })
            return
          }
        }

        this.state.cells[`${x},${y}`] = tileType
        for (let dx = 1; dx < w; dx++) {
          this.state.cells[`${x + dx},${y}`] = tileType
          this.state.cellToAnchor[`${x + dx},${y}`] = `${x},${y}`
        }
        this.state.cash -= cost

        const patch = Array.from({ length: w }, (_, dx) => ({ x: x + dx, y, tileType }))
        this.broadcast({ type: 'state_patch', cells: patch })
        this.sendTo(ws, { type: 'command_result', accepted: true, patch: { cells: patch } })
        if (cost > 0) this.broadcast({ type: 'economy_update', cash: this.state.cash })
        this.saveState()
        break
      }

      case 'remove_tile': {
        const { x, y } = msg
        if (x < 0 || x >= this.state.width || y < 0 || y >= this.state.height) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Out of bounds' })
          return
        }
        const clickedKey = `${x},${y}`
        const anchorKey = this.state.cellToAnchor[clickedKey] ?? clickedKey
        const tileType = this.state.cells[anchorKey]
        if (!tileType) {
          this.sendTo(ws, { type: 'command_result', accepted: false, reason: 'Cell is empty' })
          return
        }

        const [ax, ay] = anchorKey.split(',').map(Number)
        const w = TILE_WIDTHS[tileType] ?? 1
        const patch: Array<{ x: number; y: number; tileType: string }> = []
        for (let dx = 0; dx < w; dx++) {
          const key = `${ax + dx},${ay}`
          delete this.state.cells[key]
          if (dx > 0) delete this.state.cellToAnchor[key]
          patch.push({ x: ax + dx, y: ay, tileType: 'empty' })
        }

        this.broadcast({ type: 'state_patch', cells: patch })
        this.sendTo(ws, { type: 'command_result', accepted: true, patch: { cells: patch } })
        this.saveState()
        break
      }

      case 'ping':
        this.sendTo(ws, { type: 'pong' })
        break
    }
  }

  private handleClose(): void {
    const remaining = this.sockets.size
    if (remaining === 0) {
      if (this.state) this.state.isRunning = false
      this.stopTick()
      this.saveState()
    } else {
      this.broadcast({ type: 'presence_update', playerCount: remaining })
    }
  }

  // ─── Sim tick ────────────────────────────────────────────────────────────────

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
    if (!this.state?.isRunning) return
    this.state.simTime += 1
    this.broadcast({ type: 'time_update', simTime: this.state.simTime })
    if (this.state.simTime % TICKS_PER_DAY === 0) this.collectHotelIncome()
    if (this.state.simTime % 30 === 0) this.saveState()
  }

  private collectHotelIncome(): void {
    if (!this.state) return
    let income = 0
    for (const [key, tileType] of Object.entries(this.state.cells)) {
      if (this.state.cellToAnchor[key]) continue // skip extensions
      const daily = HOTEL_DAILY_INCOME[tileType]
      if (daily) income += daily
    }
    if (income > 0) {
      this.state.cash = Math.min(99_999_999, this.state.cash + income)
      this.broadcast({ type: 'economy_update', cash: this.state.cash })
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    for (const ws of this.sockets) {
      if (ws !== exclude) this.sendTo(ws, msg)
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket already closed */ }
  }

  private cellsToArray(cells: Record<string, string>): Array<{ x: number; y: number; tileType: string }> {
    return Object.entries(cells).map(([key, tileType]) => {
      const [x, y] = key.split(',').map(Number)
      return { x, y, tileType }
    })
  }
}
