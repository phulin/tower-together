import type { ClientMessage, ConnectionStatus, ServerMessage } from "../types";

type MessageListener = (msg: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

const MAX_RECONNECT_DELAY = 30_000;

export class TowerSocket {
	private ws: WebSocket | null = null;
	private currentTowerId: string | null = null;
	private currentStatus: ConnectionStatus = "disconnected";
	private messageListeners = new Set<MessageListener>();
	private statusListeners = new Set<StatusListener>();
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelay = 1000;
	private intentionalDisconnect = false;

	connect(towerId: string): void {
		this.intentionalDisconnect = false;
		this.currentTowerId = towerId;
		this.reconnectDelay = 1000;
		this.connectInternal(towerId);
	}

	disconnect(): void {
		this.intentionalDisconnect = true;
		this.currentTowerId = null;
		this.clearTimers();
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.close();
			this.ws = null;
		}
		this.setStatus("disconnected");
	}

	send(msg: ClientMessage): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	reconnect(): void {
		if (this.currentTowerId) {
			this.intentionalDisconnect = false;
			this.reconnectDelay = 1000;
			this.connectInternal(this.currentTowerId);
		}
	}

	getStatus(): ConnectionStatus {
		return this.currentStatus;
	}

	onMessage(listener: MessageListener): () => void {
		this.messageListeners.add(listener);
		return () => {
			this.messageListeners.delete(listener);
		};
	}

	onStatus(listener: StatusListener): () => void {
		this.statusListeners.add(listener);
		listener(this.currentStatus);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	private getWsUrl(towerId: string): string {
		const loc = window.location;
		const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${loc.host}/api/ws/${towerId}`;
	}

	private setStatus(status: ConnectionStatus) {
		this.currentStatus = status;
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}

	private clearTimers() {
		if (this.pingTimer !== null) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
		if (this.reconnectTimer !== null) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	private scheduleReconnect() {
		if (this.intentionalDisconnect || !this.currentTowerId) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (!this.intentionalDisconnect && this.currentTowerId) {
				this.connectInternal(this.currentTowerId);
			}
		}, this.reconnectDelay);
		this.reconnectDelay = Math.min(
			this.reconnectDelay * 2,
			MAX_RECONNECT_DELAY,
		);
	}

	private connectInternal(towerId: string) {
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.onerror = null;
			this.ws.close();
			this.ws = null;
		}

		this.clearTimers();
		this.setStatus("connecting");
		this.ws = new WebSocket(this.getWsUrl(towerId));

		this.ws.onopen = () => {
			this.reconnectDelay = 1000;
			this.setStatus("connected");
			this.pingTimer = setInterval(() => {
				if (this.ws?.readyState === WebSocket.OPEN) {
					this.ws.send(JSON.stringify({ type: "ping" }));
				}
			}, 20_000);
		};

		this.ws.onmessage = (event: MessageEvent) => {
			try {
				const msg = JSON.parse(event.data as string) as ServerMessage;
				if (msg.type === "pong") return;
				for (const listener of this.messageListeners) {
					listener(msg);
				}
			} catch (error) {
				console.error("Failed to parse server message", error);
			}
		};

		this.ws.onclose = () => {
			this.ws = null;
			this.clearTimers();
			this.setStatus("disconnected");
			this.scheduleReconnect();
		};

		this.ws.onerror = (error) => {
			console.error("WebSocket error", error);
		};
	}
}
