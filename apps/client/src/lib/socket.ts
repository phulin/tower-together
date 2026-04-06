import type { ClientMessage, ServerMessage } from '../types'

export type MessageHandler = (msg: ServerMessage) => void
export type StatusHandler = (status: 'connecting' | 'connected' | 'disconnected') => void

export class TowerSocket {
  private ws: WebSocket | null = null
  private towerId: string
  private onMessage: MessageHandler
  private onStatus: StatusHandler
  private destroyed = false

  constructor(towerId: string, onMessage: MessageHandler, onStatus: StatusHandler) {
    this.towerId = towerId
    this.onMessage = onMessage
    this.onStatus = onStatus
    this.connect()
  }

  private getWsUrl(): string {
    const loc = window.location
    const protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:'
    // In dev (port 5173), Vite proxies /api to localhost:8787, but WS proxy
    // needs the full backend URL. Check for dev port.
    if (loc.port === '5173') {
      return `ws://localhost:8787/api/ws/${this.towerId}`
    }
    return `${protocol}//${loc.host}/api/ws/${this.towerId}`
  }

  private connect(): void {
    if (this.destroyed) return

    this.onStatus('connecting')
    const url = this.getWsUrl()
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      if (this.destroyed) {
        this.ws?.close()
        return
      }
      this.onStatus('connected')
    }

    this.ws.onmessage = (event: MessageEvent) => {
      if (this.destroyed) return
      try {
        const msg = JSON.parse(event.data as string) as ServerMessage
        this.onMessage(msg)
      } catch (e) {
        console.error('Failed to parse server message', e)
      }
    }

    this.ws.onclose = () => {
      if (this.destroyed) return
      this.onStatus('disconnected')
    }

    this.ws.onerror = (e) => {
      console.error('WebSocket error', e)
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  reconnect(): void {
    this.ws?.close()
    this.connect()
  }

  destroy(): void {
    this.destroyed = true
    this.ws?.close()
    this.ws = null
  }
}
