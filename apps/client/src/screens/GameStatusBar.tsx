import type { ConnectionStatus } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface Props {
	connectionStatus: ConnectionStatus;
	towerId: string;
	onReconnect: () => void;
}

export function GameStatusBar({
	connectionStatus,
	towerId,
	onReconnect,
}: Props) {
	const statusColor =
		connectionStatus === "connected"
			? "#4ade80"
			: connectionStatus === "connecting"
				? "#facc15"
				: "#f87171";

	return (
		<div style={styles.statusBar}>
			<span style={{ ...styles.statusDot, background: statusColor }} />
			<span style={styles.statusText}>
				{connectionStatus === "connected"
					? "Connected"
					: connectionStatus === "connecting"
						? "Connecting…"
						: "Disconnected"}
			</span>
			{connectionStatus === "disconnected" && (
				<button type="button" style={styles.reconnectBtn} onClick={onReconnect}>
					Reconnect
				</button>
			)}
			<span style={styles.statusRight}>
				Tower: <span style={styles.towerIdSmall}>{towerId}</span>
			</span>
		</div>
	);
}
