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
	10: "Fast Food",
	12: "Retail",
	18: "Cinema",
	20: "Security",
	21: "Housekeeping",
	29: "Entertainment",
};

interface Props {
	inspectedCell: CellInfoData | null;
	onClose: () => void;
	onSetRentLevel: (x: number, y: number, rentLevel: number) => void;
	onAddElevatorCar: (x: number) => void;
	onRemoveElevatorCar: (x: number) => void;
	onPatchInspectedCell: (updater: (cell: CellInfoData) => CellInfoData) => void;
}

export function CellInspectionDialog({
	inspectedCell,
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
			</div>
		</button>
	);
}
