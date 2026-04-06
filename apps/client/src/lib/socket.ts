import type {
	ClientMessage,
	ConnectionStatus,
	ServerMessage,
} from "../types";

type MessageListener = (msg: ServerMessage) => void;
type StatusListener = (status: ConnectionStatus) => void;

let ws: WebSocket | null = null;
let currentTowerId: string | null = null;
let currentStatus: ConnectionStatus = "disconnected";
const messageListeners = new Set<MessageListener>();
const statusListeners = new Set<StatusListener>();

function getWsUrl(towerId: string): string {
	const loc = window.location;
	const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
	return `${protocol}//${loc.host}/api/ws/${towerId}`;
}

function setStatus(status: ConnectionStatus) {
	currentStatus = status;
	for (const l of statusListeners) l(status);
}

export function connect(towerId: string): void {
	if (ws) disconnect();
	currentTowerId = towerId;
	setStatus("connecting");

	ws = new WebSocket(getWsUrl(towerId));

	ws.onopen = () => setStatus("connected");

	ws.onmessage = (event: MessageEvent) => {
		try {
			const msg = JSON.parse(event.data as string) as ServerMessage;
			for (const l of messageListeners) l(msg);
		} catch (e) {
			console.error("Failed to parse server message", e);
		}
	};

	ws.onclose = () => {
		ws = null;
		setStatus("disconnected");
	};

	ws.onerror = (e) => {
		console.error("WebSocket error", e);
	};
}

export function disconnect(): void {
	currentTowerId = null;
	ws?.close();
	ws = null;
}

export function send(msg: ClientMessage): void {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify(msg));
	}
}

export function reconnect(): void {
	if (currentTowerId) connect(currentTowerId);
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
