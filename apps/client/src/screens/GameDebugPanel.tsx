import { gameScreenStyles as styles } from "./gameScreenStyles";

export interface DebugMetrics {
	totalPopulation: number;
	queuedEntities: number;
	boardedEntities: number;
	activeTrips: number;
	totalCars: number;
	movingCars: number;
	doorWaitCars: number;
	peakCarLoad: number;
	state22Entities: number;
	checkoutQueueEntities: number;
}

interface Props {
	metrics: DebugMetrics;
	speedMultiplier: 1 | 3 | 10;
	onSpeedChange: (multiplier: 1 | 3 | 10) => void;
}

export function GameDebugPanel({
	metrics,
	speedMultiplier,
	onSpeedChange,
}: Props) {
	return (
		<div style={styles.debugPanel}>
			<div style={styles.debugTitle}>Debug</div>
			<div style={styles.debugRow}>
				<span>Speed</span>
				<span style={styles.speedButtons}>
					{([1, 3, 10] as const).map((multiplier) => (
						<button
							key={multiplier}
							type="button"
							style={{
								...styles.speedButton,
								...(speedMultiplier === multiplier
									? styles.speedButtonActive
									: {}),
							}}
							onClick={() => onSpeedChange(multiplier)}
						>
							{multiplier}x
						</button>
					))}
				</span>
			</div>
			<div style={styles.debugRow}>
				<span>Total population</span>
				<strong>{metrics.totalPopulation}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Queued</span>
				<strong>{metrics.queuedEntities}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Boarded</span>
				<strong>{metrics.boardedEntities}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Active trips</span>
				<strong>{metrics.activeTrips}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Cars</span>
				<strong>{metrics.totalCars}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Moving cars</span>
				<strong>{metrics.movingCars}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Door wait cars</span>
				<strong>{metrics.doorWaitCars}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Peak car load</span>
				<strong>{metrics.peakCarLoad}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Trip state `0x22`</span>
				<strong>{metrics.state22Entities}</strong>
			</div>
			<div style={styles.debugRow}>
				<span>Checkout `0x04/0x05`</span>
				<strong>{metrics.checkoutQueueEntities}</strong>
			</div>
		</div>
	);
}
