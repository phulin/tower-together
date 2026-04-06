import { DurableObject } from 'cloudflare:workers'
import type { ClientMessage, ServerMessage } from '../types'

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
  cells: Record<string, string>
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
      cells: {},
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
    return JSON.parse(row.value) as TowerState
  }

  async saveState(): Promise<void> {
    if (!this.state) return
    const data: TowerState = {
      towerId: this.state.towerId,
      name: this.state.name,
      simTime: this.state.simTime,
      isRunning: this.state.isRunning,
      width: this.state.width,
      height: this.state.height,
      cells: this.state.cells,
    }
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO tower VALUES (?, ?)',
      'state',
      JSON.stringify(data)
    )
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // WebSocket upgrade — match on Upgrade header (path may vary)
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

    // Ensure state is loaded
    if (!this.state) {
      this.state = this.loadState()
    }

    if (!this.state) {
      // Tower not initialized yet; reject
      this.sendTo(ws, {
        type: 'command_result',
        accepted: false,
        reason: 'Tower not initialized',
      })
      return
    }

    switch (msg.type) {
      case 'join_tower': {
        // Send current state to joining socket
        this.sendTo(ws, {
          type: 'init_state',
          towerId: this.state.towerId,
          name: this.state.name,
          simTime: this.state.simTime,
          width: this.state.width,
          height: this.state.height,
          cells: this.cellsToArray(this.state.cells),
        })

        const playerCount = this.ctx.getWebSockets().length
        // Broadcast presence to all
        this.broadcast({ type: 'presence_update', playerCount })

        // Start ticking if this is the first player
        if (playerCount >= 1 && !this.state.isRunning) {
          this.state.isRunning = true
          this.startTick()
        }
        break
      }

      case 'place_tile': {
        const { x, y, tileType } = msg
        if (
          x < 0 ||
          x >= this.state.width ||
          y < 0 ||
          y >= this.state.height
        ) {
          this.sendTo(ws, {
            type: 'command_result',
            accepted: false,
            reason: 'Out of bounds',
          })
          return
        }
        if (!this.validateTileType(tileType)) {
          this.sendTo(ws, {
            type: 'command_result',
            accepted: false,
            reason: 'Invalid tile type',
          })
          return
        }
        const key = `${x},${y}`
        if (this.state.cells[key]) {
          this.sendTo(ws, {
            type: 'command_result',
            accepted: false,
            reason: 'Cell already occupied',
          })
          return
        }
        this.state.cells[key] = tileType
        const patch = { cells: [{ x, y, tileType }] }
        this.broadcast({ type: 'state_patch', cells: patch.cells })
        this.sendTo(ws, { type: 'command_result', accepted: true, patch })
        break
      }

      case 'remove_tile': {
        const { x, y } = msg
        if (
          x < 0 ||
          x >= this.state.width ||
          y < 0 ||
          y >= this.state.height
        ) {
          this.sendTo(ws, {
            type: 'command_result',
            accepted: false,
            reason: 'Out of bounds',
          })
          return
        }
        const key = `${x},${y}`
        if (!this.state.cells[key]) {
          this.sendTo(ws, {
            type: 'command_result',
            accepted: false,
            reason: 'Cell is empty',
          })
          return
        }
        delete this.state.cells[key]
        const patch = { cells: [{ x, y, tileType: 'empty' }] }
        this.broadcast({ type: 'state_patch', cells: patch.cells })
        this.sendTo(ws, { type: 'command_result', accepted: true, patch })
        break
      }

      case 'ping': {
        this.sendTo(ws, { type: 'pong' })
        break
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    const remaining = this.ctx.getWebSockets().length
    if (remaining === 0) {
      if (this.state) this.state.isRunning = false
      this.stopTick()
      void this.saveState()
    } else {
      this.broadcast({ type: 'presence_update', playerCount: remaining })
    }
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    this.webSocketClose(ws)
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
    if (this.state.simTime % 30 === 0) {
      void this.saveState()
    }
  }

  private broadcast(msg: ServerMessage, exclude?: WebSocket): void {
    const sockets = this.ctx.getWebSockets()
    for (const socket of sockets) {
      if (socket !== exclude) {
        this.sendTo(socket, msg)
      }
    }
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // Socket may already be closed
    }
  }

  private cellsToArray(cells: Record<string, string>): Array<{ x: number; y: number; tileType: string }> {
    return Object.entries(cells).map(([key, tileType]) => {
      const [xStr, yStr] = key.split(',')
      return { x: parseInt(xStr, 10), y: parseInt(yStr, 10), tileType }
    })
  }

  private validateTileType(t: string): boolean {
    return ['empty', 'floor', 'room_basic'].includes(t)
  }
}
