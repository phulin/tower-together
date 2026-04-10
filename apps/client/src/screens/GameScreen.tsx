import { useCallback, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { PhaserGame } from "../game/PhaserGame";
import type { SelectedTool } from "../types";
import { DAY_TICK_MAX, TILE_COSTS } from "../types";
import { CellInspectionDialog } from "./CellInspectionDialog";
import { type DebugMetrics, GameDebugPanel } from "./GameDebugPanel";
import { GamePromptModal } from "./GamePromptModal";
import { GameStatusBar } from "./GameStatusBar";
import { GameToasts } from "./GameToasts";
import { GameToolbar } from "./GameToolbar";
import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { Toast } from "./gameScreenTypes";
import { useTowerSession } from "./useTowerSession";

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

let toastCounter = 0;

function buildDebugMetrics(
	entities: ReturnType<typeof useTowerSession>["entities"],
	carriers: ReturnType<typeof useTowerSession>["carriers"],
): DebugMetrics {
	const queuedEntities = entities.filter(
		(entity) =>
			!entity.boardedOnCarrier &&
			(entity.stateCode === 0x22 ||
				entity.stateCode === 0x04 ||
				entity.stateCode === 0x05 ||
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

	return {
		totalPopulation: entities.length,
		queuedEntities: queuedEntities.length,
		boardedEntities: boardedEntities.length,
		activeTrips: activeTrips.length,
		totalCars: carriers.length,
		movingCars: movingCars.length,
		doorWaitCars: doorWaitCars.length,
		peakCarLoad: Math.max(0, ...occupancyByCar.values()),
		state22Entities: entities.filter((entity) => entity.stateCode === 0x22)
			.length,
		checkoutQueueEntities: entities.filter(
			(entity) => entity.stateCode === 0x04 || entity.stateCode === 0x05,
		).length,
	};
}

export function GameScreen({ playerId, displayName, towerId, onLeave }: Props) {
	const [selectedTool, setSelectedTool] = useState<SelectedTool>("floor");
	const [isRenaming, setIsRenaming] = useState(false);
	const [aliasInput, setAliasInput] = useState("");
	const [aliasError, setAliasError] = useState("");
	const [aliasSaving, setAliasSaving] = useState(false);
	const [toasts, setToasts] = useState<Toast[]>([]);
	const sceneRef = useRef<GameScene | null>(null);

	const addToast = useCallback(
		(message: string, variant: "error" | "info" = "error") => {
			const id = ++toastCounter;
			setToasts((prev) => [...prev, { id, message, variant }]);
			const duration = variant === "info" ? 8000 : 3000;
			setTimeout(() => {
				setToasts((prev) => prev.filter((toast) => toast.id !== id));
			}, duration);
		},
		[],
	);

	const {
		connectionStatus,
		simTime,
		cash,
		playerCount,
		towerName,
		setTowerName,
		entities,
		carriers,
		speedMultiplier,
		activePrompt,
		inspectedCell,
		setInspectedCell,
		sendTileCommand,
		inspectCell,
		respondToPrompt,
		setSpeedMultiplier,
		setRentLevel,
		addElevatorCar,
		removeElevatorCar,
		reconnect,
	} = useTowerSession({
		playerId,
		displayName,
		sceneRef,
		addToast,
	});

	const handleCellClick = useCallback(
		(x: number, y: number, shift: boolean) => {
			sendTileCommand(x, y, selectedTool, shift);
		},
		[selectedTool, sendTileCommand],
	);

	const handlePatchInspectedCell = useCallback(
		(
			updater: (
				cell: NonNullable<typeof inspectedCell>,
			) => NonNullable<typeof inspectedCell>,
		) => {
			setInspectedCell((prev) => (prev ? updater(prev) : prev));
		},
		[setInspectedCell],
	);

	const handleRenameStart = useCallback(() => {
		setAliasInput(towerName === towerId ? "" : towerName);
		setAliasError("");
		setIsRenaming(true);
	}, [towerId, towerName]);

	const handleRenameCancel = useCallback(() => {
		setIsRenaming(false);
		setAliasError("");
	}, []);

	const handleAliasInputChange = useCallback((value: string) => {
		setAliasInput(value);
		setAliasError("");
	}, []);

	const handleSetAlias = useCallback(async () => {
		const alias = aliasInput.trim().toLowerCase();
		if (!alias) return;
		setAliasSaving(true);
		setAliasError("");
		try {
			const response = await fetch(`/api/towers/${towerId}/alias`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ alias }),
			});
			if (!response.ok) {
				const error = (await response.json()) as { error: string };
				setAliasError(error.error || "Failed to set alias");
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
	}, [aliasInput, setTowerName, towerId]);

	const day = Math.floor(simTime / DAY_TICK_MAX) + 1;
	const dayTick = simTime % DAY_TICK_MAX;
	const hour = (6 + Math.floor((dayTick * 19) / DAY_TICK_MAX)) % 24;
	const metrics = buildDebugMetrics(entities, carriers);

	return (
		<div style={styles.container}>
			<GameToolbar
				tools={TOOLS}
				isRenaming={isRenaming}
				aliasInput={aliasInput}
				aliasError={aliasError}
				aliasSaving={aliasSaving}
				towerId={towerId}
				towerName={towerName}
				selectedTool={selectedTool}
				cash={cash ?? 0}
				day={day}
				hour={hour}
				playerCount={playerCount}
				onAliasInputChange={handleAliasInputChange}
				onRenameStart={handleRenameStart}
				onRenameCancel={handleRenameCancel}
				onRenameSubmit={handleSetAlias}
				onToolSelect={setSelectedTool}
				onLeave={onLeave}
			/>

			<div style={styles.canvasWrapper}>
				<PhaserGame
					onCellClick={handleCellClick}
					onCellInspect={inspectCell}
					selectedTool={selectedTool}
					sceneRef={sceneRef}
				/>
				<GameDebugPanel
					metrics={metrics}
					speedMultiplier={speedMultiplier}
					onSpeedChange={setSpeedMultiplier}
				/>
			</div>

			{activePrompt && (
				<GamePromptModal prompt={activePrompt} onRespond={respondToPrompt} />
			)}

			<CellInspectionDialog
				inspectedCell={inspectedCell}
				onClose={() => setInspectedCell(null)}
				onSetRentLevel={setRentLevel}
				onAddElevatorCar={addElevatorCar}
				onRemoveElevatorCar={removeElevatorCar}
				onPatchInspectedCell={handlePatchInspectedCell}
			/>

			<GameToasts toasts={toasts} />
			<GameStatusBar
				connectionStatus={connectionStatus}
				towerId={towerId}
				onReconnect={reconnect}
			/>
		</div>
	);
}
