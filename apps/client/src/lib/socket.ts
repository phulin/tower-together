import type { ClientMessage, ConnectionStatus, ServerMessage } from "../types";

type MessageListener = (msg: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

let ws: WebSocket | null = null;
let currentTowerId: string | null = null;
let currentStatus: ConnectionStatus = "disconnected";
const messageListeners = new Set<MessageListener>();
const statusListeners = new Set<StatusListener>();

let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000; // ms, doubles on each failure up to MAX_RECONNECT_DELAY
const MAX_RECONNECT_DELAY = 30_000;
let intentionalDisconnect = false;

function getWsUrl(towerId: string): string {
	const loc = window.location;
	const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${loc.host}/api/ws/${towerId}`;
}

function setStatus(status: ConnectionStatus) {
	currentStatus = status;
	for (const l of statusListeners) l(status);
}

function clearTimers() {
	if (pingTimer !== null) {
		clearInterval(pingTimer);
		pingTimer = null;
	}
	if (reconnectTimer !== null) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
}

function scheduleReconnect() {
	if (intentionalDisconnect || !currentTowerId) return;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		if (!intentionalDisconnect && currentTowerId) {
			connectInternal(currentTowerId);
		}
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

function connectInternal(towerId: string) {
	// Close any existing socket without triggering auto-reconnect
	if (ws) {
		ws.onclose = null;
		ws.onerror = null;
		ws.close();
		ws = null;
	}
	clearTimers();
	setStatus("connecting");

	ws = new WebSocket(getWsUrl(towerId));

	ws.onopen = () => {
		reconnectDelay = 1000; // reset backoff on successful connect
		setStatus("connected");
		// Send a ping every 20 s to keep the proxy from timing out the connection
		pingTimer = setInterval(() => {
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "ping" }));
			}
		}, 20_000);
	};

	ws.onmessage = (event: MessageEvent) => {
		try {
			const msg = JSON.parse(event.data as string) as ServerMessage;
			if (msg.type === "pong") return; // keepalive response, nothing to do
			for (const l of messageListeners) l(msg);
		} catch (e) {
			console.error("Failed to parse server message", e);
		}
	};

	ws.onclose = () => {
		ws = null;
		clearTimers();
		setStatus("disconnected");
		scheduleReconnect();
	};

	ws.onerror = (e) => {
		console.error("WebSocket error", e);
		// onclose will fire after onerror, so reconnect logic lives there
	};
}

export function connect(towerId: string): void {
	intentionalDisconnect = false;
	currentTowerId = towerId;
	reconnectDelay = 1000;
	connectInternal(towerId);
}

export function disconnect(): void {
	intentionalDisconnect = true;
	currentTowerId = null;
	clearTimers();
	if (ws) {
		ws.onclose = null;
		ws.close();
		ws = null;
	}
	setStatus("disconnected");
}

export function send(msg: ClientMessage): void {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

export function reconnect(): void {
	if (currentTowerId) {
		intentionalDisconnect = false;
		reconnectDelay = 1000;
		connectInternal(currentTowerId);
	}
}

export function getStatus(): ConnectionStatus {
	return currentStatus;
}

/** Subscribe to incoming messages. Returns unsubscribe function. */
export function onMessage(listener: MessageListener): () => void {
	messageListeners.add(listener);
	return () => {
		messageListeners.delete(listener);
	};
}

/** Subscribe to status changes. Fires immediately with current status. Returns unsubscribe function. */
export function onStatus(listener: StatusListener): () => void {
	statusListeners.add(listener);
	listener(currentStatus);
	return () => {
		statusListeners.delete(listener);
	};
}
