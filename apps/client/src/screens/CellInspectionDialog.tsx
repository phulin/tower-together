import { GRID_HEIGHT, type SimStateData } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { CellInfoData } from "./gameScreenTypes";

const RENT_LEVEL_LABELS = ["High", "Medium", "Low", "Minimal"];
const CARRIER_MODE_LABELS: Record<number, string> = {
	0: "Express",
	1: "Standard",
	2: "Service",
};
const RENT_ADJUSTABLE_FAMILIES = new Set([3, 4, 5, 6, 7, 9, 10, 12]);
const FAMILY_LABELS: Record<number, string> = {
	3: "Hotel (Single)",
	4: "Hotel (Twin)",
	5: "Hotel (Suite)",
	6: "Restaurant",
	7: "Office",
	9: "Condo",
	10: "Retail",
	12: "Fast Food",
	18: "Cinema",
	20: "Security",
	21: "Housekeeping",
	29: "Entertainment",
};

const HOTEL_FAMILIES = new Set([3, 4, 5]);

function getFacilityStatus(info: {
	objectTypeCode: number;
	unitStatus: number;
	venueAvailability?: number;
}): string | null {
	if (HOTEL_FAMILIES.has(info.objectTypeCode)) {
		if (info.unitStatus < 0x18) return "Occupied";
		if (info.unitStatus < 0x28) return "Vacant";
		return "Checked Out";
	}
	if (info.objectTypeCode === 9) {
		return info.unitStatus > 0x17 ? "For Sale" : "Sold";
	}
	if (info.objectTypeCode === 7) {
		return info.unitStatus > 0x0f ? "For Rent" : "Occupied";
	}
	if (info.objectTypeCode === 10) {
		return info.venueAvailability === 0xff ? "Unrented" : "Open";
	}
	return null;
}

const STRESS_COLORS: Record<SimStateData["stressLevel"], string> = {
	low: "#4ade80",
	medium: "#facc15",
	high: "#f87171",
};

interface Props {
	inspectedCell: CellInfoData | null;
	sims: SimStateData[];
	onClose: () => void;
	onSetRentLevel: (x: number, y: number, rentLevel: number) => void;
	onAddElevatorCar: (x: number) => void;
	onRemoveElevatorCar: (x: number) => void;
	onPatchInspectedCell: (updater: (cell: CellInfoData) => CellInfoData) => void;
}

export function CellInspectionDialog({
	inspectedCell,
	sims,
	onClose,
	onSetRentLevel,
	onAddElevatorCar,
	onRemoveElevatorCar,
	onPatchInspectedCell,
}: Props) {
	if (
		!inspectedCell ||
		(!inspectedCell.objectInfo && !inspectedCell.carrierInfo)
	) {
		return null;
	}

	return (
		<button type="button" style={styles.modalOverlay} onClick={onClose}>
			<div
				role="dialog"
				style={styles.inspectDialog}
				onClick={(event) => event.stopPropagation()}
				onKeyDown={() => {}}
			>
				<div style={styles.inspectHeader}>
					<span style={styles.inspectTitle}>
						{inspectedCell.carrierInfo
							? `${CARRIER_MODE_LABELS[inspectedCell.carrierInfo.carrierMode] ?? "Elevator"} Elevator`
							: (FAMILY_LABELS[
									inspectedCell.objectInfo?.objectTypeCode ?? -1
								] ?? inspectedCell.tileType)}
					</span>
					<button type="button" style={styles.inspectClose} onClick={onClose}>
						&times;
					</button>
				</div>

				{inspectedCell.objectInfo &&
					getFacilityStatus(inspectedCell.objectInfo) && (
						<div style={styles.inspectSection}>
							<div style={styles.inspectRow}>
								<span style={styles.inspectLabel}>Status</span>
								<span style={styles.inspectValue}>
									{getFacilityStatus(inspectedCell.objectInfo)}
								</span>
							</div>
						</div>
					)}

				{inspectedCell.objectInfo &&
					RENT_ADJUSTABLE_FAMILIES.has(
						inspectedCell.objectInfo.objectTypeCode,
					) && (
						<div style={styles.inspectSection}>
							<div style={styles.inspectLabel}>Rent Level</div>
							<div style={styles.rentButtons}>
								{RENT_LEVEL_LABELS.map((label, index) => (
									<button
										type="button"
										key={label}
										style={{
											...styles.rentButton,
											...(inspectedCell.objectInfo?.rentLevel === index
												? styles.rentButtonActive
												: {}),
										}}
										onClick={() => {
											onSetRentLevel(inspectedCell.x, inspectedCell.y, index);
											onPatchInspectedCell((cell) => ({
												...cell,
												objectInfo: cell.objectInfo
													? { ...cell.objectInfo, rentLevel: index }
													: undefined,
											}));
										}}
									>
										{label}
									</button>
								))}
							</div>
						</div>
					)}

				{inspectedCell.carrierInfo && (
					<>
						<div style={styles.inspectSection}>
							<div style={styles.inspectRow}>
								<span style={styles.inspectLabel}>Mode</span>
								<span style={styles.inspectValue}>
									{CARRIER_MODE_LABELS[inspectedCell.carrierInfo.carrierMode] ??
										"Unknown"}
								</span>
							</div>
							<div style={styles.inspectRow}>
								<span style={styles.inspectLabel}>Floors</span>
								<span style={styles.inspectValue}>
									{inspectedCell.carrierInfo.bottomServedFloor - 10} to{" "}
									{inspectedCell.carrierInfo.topServedFloor - 10}
								</span>
							</div>
						</div>
						<div style={styles.inspectSection}>
							<div style={styles.inspectRow}>
								<span style={styles.inspectLabel}>Cars</span>
								<span style={styles.inspectValue}>
									{inspectedCell.carrierInfo.carCount} /{" "}
									{inspectedCell.carrierInfo.maxCars}
								</span>
							</div>
							<div style={styles.carButtons}>
								<button
									type="button"
									style={{
										...styles.carButton,
										...(inspectedCell.carrierInfo.carCount >= 8
											? styles.carButtonDisabled
											: {}),
									}}
									disabled={inspectedCell.carrierInfo.carCount >= 8}
									onClick={() => {
										onAddElevatorCar(inspectedCell.x);
										onPatchInspectedCell((cell) => ({
											...cell,
											carrierInfo: cell.carrierInfo
												? {
														...cell.carrierInfo,
														carCount: cell.carrierInfo.carCount + 1,
													}
												: undefined,
										}));
									}}
								>
									+ Add Car
								</button>
								<button
									type="button"
									style={{
										...styles.carButton,
										...(inspectedCell.carrierInfo.carCount <= 1
											? styles.carButtonDisabled
											: {}),
									}}
									disabled={inspectedCell.carrierInfo.carCount <= 1}
									onClick={() => {
										onRemoveElevatorCar(inspectedCell.x);
										onPatchInspectedCell((cell) => ({
											...cell,
											carrierInfo: cell.carrierInfo
												? {
														...cell.carrierInfo,
														carCount: Math.max(
															1,
															cell.carrierInfo.carCount - 1,
														),
													}
												: undefined,
										}));
									}}
								>
									- Remove Car
								</button>
							</div>
						</div>
					</>
				)}

				{(() => {
					const floor = GRID_HEIGHT - 1 - inspectedCell.y;
					const facilitySims = sims.filter(
						(e) =>
							e.homeColumn === inspectedCell.anchorX && e.floorAnchor === floor,
					);
					if (facilitySims.length === 0) return null;
					const totalTrips = facilitySims.reduce((s, e) => s + e.tripCount, 0);
					const avgStress =
						facilitySims.length > 0
							? facilitySims.reduce((s, e) => {
									const avg =
										e.tripCount > 0
											? e.accumulatedTicks / e.tripCount
											: e.elapsedTicks;
									return s + avg;
								}, 0) / facilitySims.length
							: 0;
					return (
						<div style={styles.inspectSection}>
							<div style={styles.inspectLabel}>
								Sims ({facilitySims.length})
							</div>
							<div style={{ ...styles.inspectRow, color: "#e0e0e0" }}>
								<span>Total trips</span>
								<strong>{totalTrips}</strong>
							</div>
							<div style={{ ...styles.inspectRow, color: "#e0e0e0" }}>
								<span>Avg stress</span>
								<strong>{avgStress.toFixed(1)}</strong>
							</div>
							<div style={{ maxHeight: 120, overflowY: "auto" }}>
								{facilitySims.map((e) => {
									const simStress =
										e.tripCount > 0
											? e.accumulatedTicks / e.tripCount
											: e.elapsedTicks;
									return (
										<div key={e.id} style={styles.inspectRow}>
											<span style={{ color: "#e0e0e0" }}>
												{e.id.slice(0, 6)} · {e.tripCount}t · {e.elapsedTicks}el
											</span>
											<span
												style={{
													color: STRESS_COLORS[e.stressLevel],
												}}
											>
												{simStress.toFixed(1)}
											</span>
										</div>
									);
								})}
							</div>
						</div>
					);
				})()}
			</div>
		</button>
	);
}
