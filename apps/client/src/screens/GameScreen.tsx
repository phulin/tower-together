import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { PhaserGame } from "../game/PhaserGame";
import * as socket from "../lib/socket";
import type {
	CarrierCarStateData,
	ConnectionStatus,
	EntityStateData,
	SelectedTool,
	ServerMessage,
} from "../types";
import { DAY_TICK_MAX, TILE_COSTS } from "../types";

interface Toast {
	id: number;
	message: string;
	variant: "error" | "info";
}

interface ActivePrompt {
	promptId: string;
	promptKind: "bomb_ransom" | "fire_rescue";
	message: string;
	cost?: number;
}

interface CellInfoData {
	x: number;
	y: number;
	tileType: string;
	objectInfo?: {
		objectTypeCode: number;
		rentLevel: number;
		evalLevel: number;
		unitStatus: number;
		activationTickCount: number;
	};
	carrierInfo?: {
		carrierId: number;
		carrierMode: 0 | 1 | 2;
		topServedFloor: number;
		bottomServedFloor: number;
		carCount: number;
		maxCars: number;
		servedFloors: number[];
	};
}

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

let toastCounter = 0;
const ELEVATOR_QUEUE_STATES = new Set([0x04, 0x05]);

interface Props {
	playerId: string;
	displayName: string;
	towerId: string;
	onLeave: () => void;
}

interface ToolDef {
	id: SelectedTool;
	label: string;
	color: string;
	cost: number;
}

const TOOLS: ToolDef[] = [
	{ id: "empty", label: "Erase", color: "#888", cost: 0 },
	{ id: "floor", label: "Floor", color: "#777", cost: TILE_COSTS.floor },
	{ id: "lobby", label: "Lobby", color: "#c9a77a", cost: TILE_COSTS.lobby },
	{ id: "stairs", label: "Stairs", color: "#e8d5a3", cost: TILE_COSTS.stairs },
	{
		id: "elevator",
		label: "Elevator",
		color: "#a0a0e0",
		cost: TILE_COSTS.elevator,
	},
	{
		id: "escalator",
		label: "Escalator",
		color: "#c0a0d0",
		cost: TILE_COSTS.escalator,
	},
	{
		id: "hotelSingle",
		label: "Single",
		color: "#f28b82",
		cost: TILE_COSTS.hotelSingle,
	},
	{
		id: "hotelTwin",
		label: "Twin",
		color: "#e35d5b",
		cost: TILE_COSTS.hotelTwin,
	},
	{
		id: "hotelSuite",
		label: "Suite",
		color: "#b63c3c",
		cost: TILE_COSTS.hotelSuite,
	},
	{
		id: "restaurant",
		label: "Restaurant",
		color: "#e58a3a",
		cost: TILE_COSTS.restaurant,
	},
	{
		id: "fastFood",
		label: "Fast Food",
		color: "#f2b24d",
		cost: TILE_COSTS.fastFood,
	},
	{ id: "retail", label: "Retail", color: "#a0c040", cost: TILE_COSTS.retail },
	{ id: "office", label: "Office", color: "#a8b7c4", cost: TILE_COSTS.office },
	{ id: "condo", label: "Condo", color: "#e7cf6b", cost: TILE_COSTS.condo },
	{ id: "cinema", label: "Cinema", color: "#c040a0", cost: TILE_COSTS.cinema },
	{
		id: "security",
		label: "Security",
		color: "#c04040",
		cost: TILE_COSTS.security,
	},
	{
		id: "housekeeping",
		label: "Housekeeping",
		color: "#8cb0c0",
		cost: TILE_COSTS.housekeeping,
	},
	{ id: "metro", label: "Metro", color: "#60c0c0", cost: TILE_COSTS.metro },
	{
		id: "fireSuppressor",
		label: "Fire Supp.",
		color: "#e06060",
		cost: TILE_COSTS.fireSuppressor,
	},
];

export function GameScreen({ playerId, displayName, towerId, onLeave }: Props) {
	const [selectedTool, setSelectedTool] = useState<SelectedTool>("floor");
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [simTime, setSimTime] = useState(0);
	const [cash, setCash] = useState(0);
	const [playerCount, setPlayerCount] = useState(0);
	const [towerName, setTowerName] = useState(towerId);
	const [entities, setEntities] = useState<EntityStateData[]>([]);
	const [carriers, setCarriers] = useState<CarrierCarStateData[]>([]);
	const [isRenaming, setIsRenaming] = useState(false);
	const [aliasInput, setAliasInput] = useState("");
	const [aliasError, setAliasError] = useState("");
	const [aliasSaving, setAliasSaving] = useState(false);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const [speedMultiplier, setSpeedMultiplier] = useState<1 | 3 | 10>(1);
	const [activePrompt, setActivePrompt] = useState<ActivePrompt | null>(null);
	const [inspectedCell, setInspectedCell] = useState<CellInfoData | null>(null);

	const addToast = useCallback(
		(message: string, variant: "error" | "info" = "error") => {
			const id = ++toastCounter;
			setToasts((prev) => [...prev, { id, message, variant }]);
			const duration = variant === "info" ? 8000 : 3000;
			setTimeout(() => {
				setToasts((prev) => prev.filter((t) => t.id !== id));
			}, duration);
		},
		[],
	);

	const sceneRef = useRef<GameScene | null>(null);
	const canvasWrapperRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		return socket.onMessage((msg: ServerMessage) => {
			switch (msg.type) {
				case "init_state":
					setSimTime(msg.simTime);
					setCash(msg.cash);
					setTowerName(msg.name || msg.towerId);
					setEntities(msg.entities);
					setCarriers(msg.carriers);
					sceneRef.current?.applyInitState(
						msg.cells,
						msg.entities,
						msg.carriers,
					);
					break;
				case "state_patch":
					sceneRef.current?.applyPatch(msg.cells);
					break;
				case "entity_update":
					setEntities(msg.entities);
					sceneRef.current?.applyEntities(msg.entities);
					break;
				case "carrier_update":
					setCarriers(msg.carriers);
					sceneRef.current?.applyCarriers(msg.carriers);
					break;
				case "command_result":
					if (msg.accepted && msg.patch) {
						sceneRef.current?.applyPatch(msg.patch.cells);
					} else if (!msg.accepted && msg.reason) {
						addToast(msg.reason);
					}
					break;
				case "presence_update":
					setPlayerCount(msg.playerCount);
					break;
				case "time_update":
					setSimTime(msg.simTime);
					break;
				case "economy_update":
					setCash(msg.cash);
					break;
				case "notification":
					if (msg.message) addToast(msg.message, "info");
					break;
				case "prompt":
					setActivePrompt({
						promptId: msg.promptId,
						promptKind: msg.promptKind,
						message: msg.message,
						cost: msg.cost,
					});
					break;
				case "prompt_dismissed":
					setActivePrompt((prev) =>
						prev?.promptId === msg.promptId ? null : prev,
					);
					break;
				case "cell_info":
					setInspectedCell({
						x: msg.x,
						y: msg.y,
						tileType: msg.tileType,
						objectInfo: msg.objectInfo,
						carrierInfo: msg.carrierInfo,
					});
					break;
			}
		});
	}, [addToast]);

	useEffect(() => {
		return socket.onStatus((status: ConnectionStatus) => {
			setConnectionStatus(status);
			if (status === "connected") {
				socket.send({ type: "join_tower", playerId, displayName });
			}
		});
	}, [playerId, displayName]);

	const handleCellClick = useCallback(
		(x: number, y: number, shift: boolean) => {
			if (selectedTool === "empty") {
				socket.send({ type: "remove_tile", x, y });
				return;
			}

			if (shift) {
				// Shift-click: fill the range between lastPlacedAnchor and this cell
				const fills = sceneRef.current?.computeShiftFill(x, y) ?? [];
				for (const pos of fills) {
					socket.send({
						type: "place_tile",
						x: pos.x,
						y: pos.y,
						tileType: selectedTool,
					});
				}
				// Update lastPlaced to rightmost/leftmost tile placed (last in array)
				if (fills.length > 0) {
					const last = fills[fills.length - 1];
					sceneRef.current?.setLastPlaced(last.x, last.y, selectedTool);
				}
			} else {
				socket.send({ type: "place_tile", x, y, tileType: selectedTool });
				sceneRef.current?.setLastPlaced(x, y, selectedTool);
			}
		},
		[selectedTool],
	);

	const handleCellInspect = useCallback((x: number, y: number) => {
		socket.send({ type: "query_cell", x, y });
	}, []);

	async function handleSetAlias() {
		const alias = aliasInput.trim().toLowerCase();
		if (!alias) return;
		setAliasSaving(true);
		setAliasError("");
		try {
			const res = await fetch(`/api/towers/${towerId}/alias`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ alias }),
			});
			if (!res.ok) {
				const err = (await res.json()) as { error: string };
				setAliasError(err.error || "Failed to set alias");
				return;
			}
			setTowerName(alias);
			setIsRenaming(false);
			window.history.replaceState(null, "", `/${alias}`);
		} catch {
			setAliasError("Network error");
		} finally {
			setAliasSaving(false);
		}
	}

	const respondToPrompt = useCallback(
		(accepted: boolean) => {
			if (!activePrompt) return;
			socket.send({
				type: "prompt_response",
				promptId: activePrompt.promptId,
				accepted,
			});
			setActivePrompt(null);
		},
		[activePrompt],
	);

	const day = Math.floor(simTime / DAY_TICK_MAX) + 1;
	// Map day_tick (0–2599) to SimTower clock: 6:00am (tick 0) → 1:00am next day (tick 2599)
	const dayTick = simTime % DAY_TICK_MAX;
	const hour = (6 + Math.floor((dayTick * 19) / DAY_TICK_MAX)) % 24;

	const statusColor =
		connectionStatus === "connected"
			? "#4ade80"
			: connectionStatus === "connecting"
				? "#facc15"
				: "#f87171";
	const queuedEntities = entities.filter(
		(entity) =>
			!entity.boardedOnCarrier &&
			(entity.stateCode === 0x22 ||
				ELEVATOR_QUEUE_STATES.has(entity.stateCode) ||
				entity.routeMode === 2),
	);
	const boardedEntities = entities.filter((entity) => entity.boardedOnCarrier);
	const activeTrips = entities.filter((entity) => entity.routeMode !== 0);
	const movingCars = carriers.filter(
		(car) => car.speedCounter > 0 || car.currentFloor !== car.targetFloor,
	);
	const doorWaitCars = carriers.filter((car) => car.doorWaitCounter > 0);
	const occupancyByCar = new Map<string, number>();
	for (const entity of boardedEntities) {
		if (entity.carrierId === null || entity.assignedCarIndex < 0) continue;
		const key = `${entity.carrierId}:${entity.assignedCarIndex}`;
		occupancyByCar.set(key, (occupancyByCar.get(key) ?? 0) + 1);
	}
	const peakCarLoad = Math.max(0, ...occupancyByCar.values());

	return (
		<div style={styles.container}>
			{/* Toolbar */}
			<div style={styles.toolbar}>
				<div style={styles.toolbarLeft}>
					{isRenaming ? (
						<form
							style={styles.renameForm}
							onSubmit={(e) => {
								e.preventDefault();
								handleSetAlias();
							}}
						>
							<input
								style={styles.renameInput}
								value={aliasInput}
								onChange={(e) => {
									setAliasInput(e.target.value);
									setAliasError("");
								}}
								placeholder="alias..."
								disabled={aliasSaving}
							/>
							<button
								style={styles.renameSave}
								type="submit"
								disabled={aliasSaving}
							>
								{aliasSaving ? "..." : "Save"}
							</button>
							<button
								style={styles.renameCancel}
								type="button"
								onClick={() => setIsRenaming(false)}
							>
								Cancel
							</button>
							{aliasError && (
								<span style={styles.renameError}>{aliasError}</span>
							)}
						</form>
					) : (
						<button
							type="button"
							style={styles.towerLabel}
							title={`${towerName} (click to rename)`}
							onClick={() => {
								setAliasInput(towerName === towerId ? "" : towerName);
								setAliasError("");
								setIsRenaming(true);
							}}
						>
							{towerName}
						</button>
					)}
					<div style={styles.toolGroup}>
						{TOOLS.map((t) => (
							<button
								type="button"
								key={t.id}
								title={t.cost > 0 ? `$${t.cost.toLocaleString()}` : ""}
								style={{
									...styles.toolBtn,
									borderColor: selectedTool === t.id ? t.color : "#444",
									background:
										selectedTool === t.id ? `${t.color}33` : "transparent",
									color: selectedTool === t.id ? t.color : "#999",
								}}
								onClick={() => setSelectedTool(t.id)}
							>
								{t.label}
							</button>
						))}
					</div>
				</div>

				<div style={styles.toolbarRight}>
					<span style={styles.cashDisplay}>
						${(cash ?? 0).toLocaleString()}
					</span>
					<span style={styles.statItem}>
						Day {day} · {String(hour).padStart(2, "0")}h
					</span>
					<span style={styles.statItem}>
						{playerCount} player{playerCount !== 1 ? "s" : ""}
					</span>
					<button type="button" style={styles.leaveBtn} onClick={onLeave}>
						Leave
					</button>
				</div>
			</div>

			{/* Game canvas */}
			<div ref={canvasWrapperRef} style={styles.canvasWrapper}>
				<PhaserGame
					onCellClick={handleCellClick}
					onCellInspect={handleCellInspect}
					selectedTool={selectedTool}
					sceneRef={sceneRef}
				/>
				<div style={styles.debugPanel}>
					<div style={styles.debugTitle}>Debug</div>
					<div style={styles.debugRow}>
						<span>Speed</span>
						<span style={styles.speedButtons}>
							{([1, 3, 10] as const).map((m) => (
								<button
									key={m}
									type="button"
									style={{
										...styles.speedButton,
										...(speedMultiplier === m ? styles.speedButtonActive : {}),
									}}
									onClick={() => {
										setSpeedMultiplier(m);
										socket.send({
											type: "set_speed",
											multiplier: m,
										});
									}}
								>
									{m}x
								</button>
							))}
						</span>
					</div>
					<div style={styles.debugRow}>
						<span>Total population</span>
						<strong>{entities.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Queued</span>
						<strong>{queuedEntities.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Boarded</span>
						<strong>{boardedEntities.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Active trips</span>
						<strong>{activeTrips.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Cars</span>
						<strong>{carriers.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Moving cars</span>
						<strong>{movingCars.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Door wait cars</span>
						<strong>{doorWaitCars.length}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Peak car load</span>
						<strong>{peakCarLoad}</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Trip state `0x22`</span>
						<strong>
							{entities.filter((entity) => entity.stateCode === 0x22).length}
						</strong>
					</div>
					<div style={styles.debugRow}>
						<span>Checkout `0x04/0x05`</span>
						<strong>
							{
								entities.filter((entity) =>
									ELEVATOR_QUEUE_STATES.has(entity.stateCode),
								).length
							}
						</strong>
					</div>
				</div>
			</div>

			{/* Prompt modal */}
			{activePrompt && (
				<div style={styles.modalOverlay}>
					<div style={styles.modal}>
						<div style={styles.modalIcon}>
							{activePrompt.promptKind === "bomb_ransom" ? "💣" : "🔥"}
						</div>
						<div style={styles.modalTitle}>
							{activePrompt.promptKind === "bomb_ransom"
								? "Bomb Threat"
								: "Fire Emergency"}
						</div>
						<div style={styles.modalMessage}>{activePrompt.message}</div>
						<div style={styles.modalButtons}>
							<button
								type="button"
								style={styles.modalAccept}
								onClick={() => respondToPrompt(true)}
							>
								{activePrompt.cost
									? `Pay $${activePrompt.cost.toLocaleString()}`
									: "Accept"}
							</button>
							<button
								type="button"
								style={styles.modalDecline}
								onClick={() => respondToPrompt(false)}
							>
								Decline
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Inspection dialog */}
			{inspectedCell &&
				(inspectedCell.objectInfo || inspectedCell.carrierInfo) && (
					<button
						type="button"
						style={styles.modalOverlay}
						onClick={() => setInspectedCell(null)}
					>
						<div
							role="dialog"
							style={styles.inspectDialog}
							onClick={(e) => e.stopPropagation()}
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
								<button
									type="button"
									style={styles.inspectClose}
									onClick={() => setInspectedCell(null)}
								>
									&times;
								</button>
							</div>

							{/* Rent level controls */}
							{inspectedCell.objectInfo &&
								RENT_ADJUSTABLE_FAMILIES.has(
									inspectedCell.objectInfo.objectTypeCode,
								) && (
									<div style={styles.inspectSection}>
										<div style={styles.inspectLabel}>Rent Level</div>
										<div style={styles.rentButtons}>
											{RENT_LEVEL_LABELS.map((label, i) => (
												<button
													type="button"
													key={label}
													style={{
														...styles.rentButton,
														...(inspectedCell.objectInfo?.rentLevel === i
															? styles.rentButtonActive
															: {}),
													}}
													onClick={() => {
														socket.send({
															type: "set_rent_level",
															x: inspectedCell.x,
															y: inspectedCell.y,
															rentLevel: i,
														});
														setInspectedCell((prev) =>
															prev?.objectInfo
																? {
																		...prev,
																		objectInfo: {
																			...prev.objectInfo,
																			rentLevel: i,
																		},
																	}
																: prev,
														);
													}}
												>
													{label}
												</button>
											))}
										</div>
									</div>
								)}

							{/* Elevator controls */}
							{inspectedCell.carrierInfo && (
								<>
									<div style={styles.inspectSection}>
										<div style={styles.inspectRow}>
											<span style={styles.inspectLabel}>Mode</span>
											<span style={styles.inspectValue}>
												{CARRIER_MODE_LABELS[
													inspectedCell.carrierInfo.carrierMode
												] ?? "Unknown"}
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
													socket.send({
														type: "add_elevator_car",
														x: inspectedCell.x,
													});
													setInspectedCell((prev) =>
														prev?.carrierInfo
															? {
																	...prev,
																	carrierInfo: {
																		...prev.carrierInfo,
																		carCount: prev.carrierInfo.carCount + 1,
																	},
																}
															: prev,
													);
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
													socket.send({
														type: "remove_elevator_car",
														x: inspectedCell.x,
													});
													setInspectedCell((prev) =>
														prev?.carrierInfo
															? {
																	...prev,
																	carrierInfo: {
																		...prev.carrierInfo,
																		carCount: Math.max(
																			1,
																			prev.carrierInfo.carCount - 1,
																		),
																	},
																}
															: prev,
													);
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
				)}

			{/* Toasts */}
			{toasts.length > 0 && (
				<div style={styles.toastContainer}>
					{toasts.map((t) => (
						<div
							key={t.id}
							style={
								t.variant === "info" ? styles.toastInfo : styles.toastError
							}
						>
							{t.message}
						</div>
					))}
				</div>
			)}

			{/* Status bar */}
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
					<button
						type="button"
						style={styles.reconnectBtn}
						onClick={() => socket.reconnect()}
					>
						Reconnect
					</button>
				)}
				<span style={styles.statusRight}>
					Tower: <span style={styles.towerIdSmall}>{towerId}</span>
				</span>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		width: "100%",
		height: "100%",
		background: "#1a1a1a",
		overflow: "hidden",
	},
	toolbar: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		height: 48,
		padding: "0 16px",
		background: "#242424",
		borderBottom: "1px solid #333",
		flexShrink: 0,
	},
	toolbarLeft: { display: "flex", alignItems: "center", gap: 16 },
	toolbarRight: { display: "flex", alignItems: "center", gap: 16 },
	towerLabel: {
		fontSize: 14,
		fontWeight: 600,
		color: "#ccc",
		maxWidth: 140,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		cursor: "pointer",
		background: "transparent",
		border: "none",
		borderBottom: "1px dashed #555",
		padding: 0,
	},
	renameForm: {
		display: "flex",
		alignItems: "center",
		gap: 4,
	},
	renameInput: {
		width: 120,
		padding: "3px 8px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "#1a1a1a",
		color: "#e0e0e0",
		fontSize: 13,
		outline: "none",
	},
	renameSave: {
		padding: "3px 8px",
		borderRadius: 4,
		border: "1px solid #3a7bd5",
		background: "transparent",
		color: "#3a7bd5",
		fontSize: 11,
		cursor: "pointer",
	},
	renameCancel: {
		padding: "3px 8px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "transparent",
		color: "#888",
		fontSize: 11,
		cursor: "pointer",
	},
	renameError: {
		fontSize: 11,
		color: "#f87171",
	},
	toolGroup: { display: "flex", gap: 4 },
	toolBtn: {
		padding: "4px 10px",
		borderRadius: 4,
		border: "1px solid",
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer",
		transition: "all 0.1s",
	},
	cashDisplay: {
		fontSize: 15,
		fontWeight: 700,
		color: "#4ade80",
		fontVariantNumeric: "tabular-nums",
	},
	statItem: { fontSize: 12, color: "#aaa" },
	leaveBtn: {
		padding: "4px 12px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "transparent",
		color: "#aaa",
		fontSize: 12,
		cursor: "pointer",
	},
	canvasWrapper: { flex: 1, overflow: "hidden", position: "relative" },
	debugPanel: {
		position: "absolute",
		top: 12,
		right: 12,
		zIndex: 40,
		minWidth: 196,
		padding: "10px 12px",
		borderRadius: 8,
		background: "rgba(14, 18, 24, 0.9)",
		border: "1px solid rgba(123, 148, 170, 0.35)",
		backdropFilter: "blur(6px)",
		display: "flex",
		flexDirection: "column",
		gap: 4,
		pointerEvents: "auto",
	},
	debugTitle: {
		fontSize: 11,
		fontWeight: 700,
		color: "#d9e7f2",
		textTransform: "uppercase",
		letterSpacing: "0.08em",
		marginBottom: 2,
	},
	debugRow: {
		display: "flex",
		justifyContent: "space-between",
		gap: 12,
		fontSize: 12,
		color: "#aab8c2",
		fontVariantNumeric: "tabular-nums",
	},
	speedButtons: {
		display: "flex",
		gap: 4,
	},
	speedButton: {
		padding: "1px 6px",
		borderRadius: 3,
		border: "1px solid #555",
		background: "transparent",
		color: "#aab8c2",
		fontSize: 11,
		cursor: "pointer",
		lineHeight: "16px",
	},
	speedButtonActive: {
		background: "#3b82f6",
		borderColor: "#3b82f6",
		color: "#fff",
	},
	statusBar: {
		display: "flex",
		alignItems: "center",
		height: 28,
		padding: "0 16px",
		background: "#1e1e1e",
		borderTop: "1px solid #2a2a2a",
		gap: 8,
		flexShrink: 0,
	},
	statusDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
	statusText: { fontSize: 11, color: "#888" },
	reconnectBtn: {
		padding: "2px 8px",
		borderRadius: 3,
		border: "1px solid #555",
		background: "transparent",
		color: "#ccc",
		fontSize: 11,
		cursor: "pointer",
	},
	statusRight: { marginLeft: "auto", fontSize: 11, color: "#666" },
	towerIdSmall: { fontFamily: "monospace", color: "#888" },
	toastContainer: {
		position: "absolute",
		bottom: 40,
		right: 16,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-end",
		gap: 6,
		pointerEvents: "none",
		zIndex: 100,
	},
	toastError: {
		padding: "7px 14px",
		borderRadius: 6,
		background: "#3a1a1a",
		border: "1px solid #c0392b",
		color: "#f87171",
		fontSize: 13,
		whiteSpace: "nowrap",
	},
	toastInfo: {
		padding: "7px 14px",
		borderRadius: 6,
		background: "#1a2a3a",
		border: "1px solid #3a7bd5",
		color: "#93c5fd",
		fontSize: 13,
		whiteSpace: "nowrap",
	},
	modalOverlay: {
		position: "fixed",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: "rgba(0, 0, 0, 0.6)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 200,
	},
	modal: {
		background: "#242424",
		border: "1px solid #444",
		borderRadius: 12,
		padding: "24px 32px",
		minWidth: 340,
		maxWidth: 420,
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: 12,
		boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
	},
	modalIcon: {
		fontSize: 36,
	},
	modalTitle: {
		fontSize: 18,
		fontWeight: 700,
		color: "#e0e0e0",
	},
	modalMessage: {
		fontSize: 14,
		color: "#aaa",
		textAlign: "center",
		lineHeight: "1.5",
	},
	modalButtons: {
		display: "flex",
		gap: 12,
		marginTop: 8,
	},
	modalAccept: {
		padding: "8px 20px",
		borderRadius: 6,
		border: "1px solid #4ade80",
		background: "rgba(74, 222, 128, 0.15)",
		color: "#4ade80",
		fontSize: 14,
		fontWeight: 600,
		cursor: "pointer",
	},
	modalDecline: {
		padding: "8px 20px",
		borderRadius: 6,
		border: "1px solid #555",
		background: "transparent",
		color: "#aaa",
		fontSize: 14,
		fontWeight: 600,
		cursor: "pointer",
	},
	inspectDialog: {
		background: "#242424",
		border: "1px solid #444",
		borderRadius: 12,
		padding: "16px 20px",
		minWidth: 280,
		maxWidth: 380,
		display: "flex",
		flexDirection: "column",
		gap: 12,
		boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
	},
	inspectHeader: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
	},
	inspectTitle: {
		fontSize: 16,
		fontWeight: 700,
		color: "#e0e0e0",
	},
	inspectClose: {
		background: "transparent",
		border: "none",
		color: "#888",
		fontSize: 20,
		cursor: "pointer",
		padding: "0 4px",
		lineHeight: 1,
	},
	inspectSection: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
	},
	inspectRow: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		fontSize: 13,
	},
	inspectLabel: {
		color: "#888",
		fontSize: 12,
		fontWeight: 600,
		textTransform: "uppercase",
		letterSpacing: "0.05em",
	},
	inspectValue: {
		color: "#ccc",
		fontSize: 13,
		fontVariantNumeric: "tabular-nums",
	},
	rentButtons: {
		display: "flex",
		gap: 4,
		marginTop: 4,
	},
	rentButton: {
		flex: 1,
		padding: "6px 8px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "transparent",
		color: "#aaa",
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer",
	},
	rentButtonActive: {
		background: "rgba(74, 222, 128, 0.15)",
		borderColor: "#4ade80",
		color: "#4ade80",
	},
	carButtons: {
		display: "flex",
		gap: 8,
		marginTop: 4,
	},
	carButton: {
		flex: 1,
		padding: "6px 12px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "transparent",
		color: "#ccc",
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer",
	},
	carButtonDisabled: {
		opacity: 0.4,
		cursor: "default",
	},
};
