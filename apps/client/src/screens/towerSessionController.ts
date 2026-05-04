import type { SimCommand } from "../../../worker/src/sim/commands";
import type { CarrierRecord, SimRecord } from "../../../worker/src/sim/index";
import type { LobbyMode } from "../../../worker/src/sim/world";
import {
	type PendingBySimId,
	TowerLockstepSession,
} from "../lib/lockstepSession";
import { setTowerToolbarCache } from "../lib/storage";
import type {
	CarrierCarStateData,
	ClientMessage,
	ConnectionStatus,
	ServerMessage,
	SimStateData,
} from "../types";
import { TILE_WIDTHS } from "../types";
import type { ActivePrompt, CellInfoData } from "./gameScreenTypes";

const TWO_FLOOR_TILES = new Set(["cinema", "partyHall", "recyclingCenter"]);
const OVERLAY_TILES = new Set([
	"elevator",
	"elevatorExpress",
	"elevatorService",
	"stairs",
	"escalator",
]);

function getRoomFootprint(
	x: number,
	y: number,
	tileType: string,
): Array<{ x: number; y: number }> {
	const tileWidth = TILE_WIDTHS[tileType] ?? 1;
	const cells: Array<{ x: number; y: number }> = [];
	for (let dx = 0; dx < tileWidth; dx++) {
		cells.push({ x: x + dx, y });
		if (TWO_FLOOR_TILES.has(tileType)) cells.push({ x: x + dx, y: y - 1 });
	}
	return cells;
}

export interface TowerSessionScene {
	setSnapshotSource: (source: {
		readSims: () => readonly SimRecord[];
		readCarriers: () => CarrierCarStateData[];
		readLiveCarriers: () => readonly CarrierRecord[];
		readPendingBySimId: () => PendingBySimId;
		materializeSim: (sim: SimRecord) => SimStateData | null;
		readFireFronts: () => {
			fireLeftPos: readonly number[];
			fireRightPos: readonly number[];
		} | null;
	}) => void;
	applyInitState: (
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
			evalActiveFlag?: number;
			unitStatus?: number;
			evalLevel?: number;
			evalScore?: number;
			coverageFlag?: number;
		}>,
		simTime: number,
	) => void;
	applyPatch: (
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
			evalActiveFlag?: number;
			unitStatus?: number;
			evalLevel?: number;
			evalScore?: number;
			coverageFlag?: number;
		}>,
	) => void;
	applySims: (simTime: number) => void;
	applyCarriers: (simTime: number) => void;
	setPresentationClock: (
		simTime: number,
		receivedAtMs: number,
		tickIntervalMs?: number,
	) => void;
	setPaused: (paused: boolean) => void;
	computeShiftFill: (x: number, y: number) => Array<{ x: number; y: number }>;
	setLobbyMode: (mode: LobbyMode) => void;
	setLastPlaced: (x: number, y: number, tileType: string) => void;
	hasElevatorOverlayAt: (x: number, y: number, tileType?: string) => boolean;
	getElevatorShaftAt: (
		x: number,
		y: number,
	) => { topY: number; bottomY: number; tileType: string } | null;
}

export interface TowerSessionSocket {
	send: (msg: ClientMessage) => void;
	reconnect: () => void;
	onMessage: (listener: (msg: ServerMessage) => void) => () => void;
	onStatus: (listener: (status: ConnectionStatus) => void) => () => void;
}

export interface TowerSessionState {
	connectionStatus: ConnectionStatus;
	starCount: number;
	playerCount: number;
	activeCount: number;
	towerName: string;
	sims: SimStateData[];
	carriers: CarrierCarStateData[];
	speedMultiplier: 1 | 3 | 10;
	freeBuild: boolean;
	paused: boolean;
	activePrompt: ActivePrompt | null;
	inspectedCell: CellInfoData | null;
	sceneReady: boolean;
	lobbyExists: boolean;
	lobbyMode: LobbyMode;
	starUpgrade: { newStarCount: number } | null;
}

export const INITIAL_TOWER_SESSION_STATE: TowerSessionState = {
	connectionStatus: "connecting",
	starCount: 1,
	playerCount: 0,
	activeCount: 0,
	towerName: "",
	sims: [],
	carriers: [],
	speedMultiplier: 1,
	freeBuild: false,
	paused: false,
	activePrompt: null,
	inspectedCell: null,
	sceneReady: false,
	lobbyExists: false,
	lobbyMode: "perfect-parity",
	starUpgrade: null,
};

interface TowerSessionControllerOptions {
	towerId: string;
	playerId: string;
	displayName: string;
	socket: TowerSessionSocket;
	getScene: () => TowerSessionScene | null;
	addToast: (message: string, variant?: "error" | "info") => void;
	onStateChange: (state: TowerSessionState) => void;
	onSimTime: (simTime: number) => void;
	onEconomy: (cash: number, population: number) => void;
}

export class TowerSessionController {
	private readonly towerId: string;
	private readonly playerId: string;
	private readonly displayName: string;
	private readonly socket: TowerSessionSocket;
	private readonly getScene: () => TowerSessionScene | null;
	private readonly addToast: (
		message: string,
		variant?: "error" | "info",
	) => void;
	private readonly onStateChange: (state: TowerSessionState) => void;
	private readonly onSimTime: (simTime: number) => void;
	private readonly onEconomy: (cash: number, population: number) => void;
	private readonly lockstep: TowerLockstepSession;
	private clientSeq = 0;
	private state: TowerSessionState = INITIAL_TOWER_SESSION_STATE;
	private lastEconomyUpdateMs = 0;
	private lastSlowUpdateMs = 0;
	private unsubscribeMessage: (() => void) | null = null;
	private unsubscribeStatus: (() => void) | null = null;

	constructor({
		towerId,
		playerId,
		displayName,
		socket,
		getScene,
		addToast,
		onStateChange,
		onSimTime,
		onEconomy,
	}: TowerSessionControllerOptions) {
		this.towerId = towerId;
		this.playerId = playerId;
		this.displayName = displayName;
		this.socket = socket;
		this.getScene = getScene;
		this.addToast = addToast;
		this.onStateChange = onStateChange;
		this.onSimTime = onSimTime;
		this.onEconomy = onEconomy;
		this.lockstep = new TowerLockstepSession({
			playerId,
			onReset: (state, timing) => {
				this.onSimTime(state.simTime);
				this.onEconomy(state.cash, state.population);
				this.patchState({
					starCount: state.starCount,
					sims: this.lockstep.simsSnapshot(),
					carriers: this.lockstep.carriersSnapshot(),
					lobbyExists: state.cells.some((cell) => cell.tileType === "lobby"),
				});
				const scene = this.getScene();
				scene?.setSnapshotSource({
					readSims: () => this.lockstep.peekSims(),
					readCarriers: () => this.lockstep.carriersSnapshot(),
					readLiveCarriers: () => this.lockstep.peekCarriers(),
					readPendingBySimId: () => this.lockstep.peekPendingBySimId(),
					materializeSim: (sim) => this.lockstep.materializeSim(sim),
					readFireFronts: () => this.lockstep.peekFireFronts(),
				});
				scene?.applyInitState(state.cells, state.simTime);
				scene?.setPresentationClock(state.simTime, timing.receivedAtMs);
				// Wait for Phaser to paint the frame before removing the loading overlay.
				requestAnimationFrame(() => {
					requestAnimationFrame(() => {
						this.patchState({ sceneReady: true });
					});
				});
			},
			onTick: (state) => {
				this.onSimTime(state.simTime);
				const now = state.receivedAtMs;
				const patch: Partial<TowerSessionState> = {};
				if (now - this.lastEconomyUpdateMs >= 100) {
					this.onEconomy(state.cash, state.population);
					this.lastEconomyUpdateMs = now;
				}
				if (now - this.lastSlowUpdateMs >= 500) {
					patch.starCount = state.starCount;
					patch.sims = this.lockstep.simsSnapshot();
					patch.carriers = this.lockstep.carriersSnapshot();
					this.lastSlowUpdateMs = now;
				}
				if (
					!this.state.lobbyExists &&
					state.cellPatches.some((cell) => cell.tileType === "lobby")
				) {
					patch.lobbyExists = true;
				}
				if (Object.keys(patch).length > 0) {
					this.patchState(patch);
				}
				if (state.cellPatches.length > 0) {
					this.getScene()?.applyPatch(state.cellPatches);
				}
				this.getScene()?.applySims(state.simTime);
				this.getScene()?.applyCarriers(state.simTime);
				this.getScene()?.setPresentationClock(
					state.simTime,
					state.receivedAtMs,
					state.tickIntervalMs,
				);
			},
		});
	}

	start(): void {
		this.unsubscribeMessage = this.socket.onMessage((msg) =>
			this.handleMessage(msg),
		);
		this.unsubscribeStatus = this.socket.onStatus((status) =>
			this.handleStatus(status),
		);
	}

	dispose(): void {
		this.unsubscribeMessage?.();
		this.unsubscribeStatus?.();
		this.unsubscribeMessage = null;
		this.unsubscribeStatus = null;
		this.lockstep.dispose();
	}

	getState(): TowerSessionState {
		return this.state;
	}

	setTowerName(value: string): void {
		this.patchState({ towerName: value });
	}

	setInspectedCell(
		updater:
			| CellInfoData
			| null
			| ((previous: CellInfoData | null) => CellInfoData | null),
	): void {
		this.patchState({
			inspectedCell:
				typeof updater === "function"
					? updater(this.state.inspectedCell)
					: updater,
		});
	}

	sendTileCommand(
		x: number,
		y: number,
		tileType: string,
		shift: boolean,
	): void {
		const inputs: SimCommand[] = [];
		if (tileType === "empty") {
			inputs.push({ type: "remove_tile", x, y });
		} else if (shift) {
			const fills = this.getScene()?.computeShiftFill(x, y) ?? [];
			if (fills.length > 0) {
				for (const pos of fills) {
					inputs.push({
						type: "place_tile",
						x: pos.x,
						y: pos.y,
						tileType,
					});
				}
				const last = fills[fills.length - 1];
				this.getScene()?.setLastPlaced(last.x, last.y, tileType);
			} else if (!OVERLAY_TILES.has(tileType)) {
				for (const cell of getRoomFootprint(x, y, tileType)) {
					inputs.push({ type: "remove_tile", x: cell.x, y: cell.y });
				}
				inputs.push({ type: "place_tile", x, y, tileType });
				this.getScene()?.setLastPlaced(x, y, tileType);
			}
		} else if (
			(tileType === "elevator" ||
				tileType === "elevatorExpress" ||
				tileType === "elevatorService") &&
			this.getScene()?.hasElevatorOverlayAt(x, y, tileType)
		) {
			inputs.push({ type: "add_elevator_car", x, y });
		} else if (tileType === "recyclingCenter") {
			inputs.push({
				type: "place_tile",
				x,
				y,
				tileType: "recyclingCenter",
			});
			this.getScene()?.setLastPlaced(x, y, tileType);
		} else {
			inputs.push({ type: "place_tile", x, y, tileType });
			this.getScene()?.setLastPlaced(x, y, tileType);
		}
		this.sendInputBatch(inputs);
	}

	removeElevatorShaft(x: number, topY: number, bottomY: number): void {
		const inputs: SimCommand[] = [];
		for (let y = topY; y <= bottomY; y++) {
			inputs.push({ type: "remove_tile", x, y });
		}
		this.sendInputBatch(inputs);
	}

	inspectCell(x: number, y: number): void {
		this.socket.send({ type: "query_cell", x, y });
	}

	respondToPrompt(accepted: boolean): void {
		if (!this.state.activePrompt) {
			return;
		}
		this.sendInputBatch([
			{
				type: "prompt_response",
				promptId: this.state.activePrompt.promptId,
				accepted,
			},
		]);
		this.patchState({ activePrompt: null });
	}

	dismissStarUpgrade(): void {
		if (!this.state.starUpgrade) return;
		this.patchState({ starUpgrade: null });
	}

	setSpeedMultiplier(multiplier: 1 | 3 | 10): void {
		this.patchState({ speedMultiplier: multiplier });
		this.lockstep.updateSettings({ speedMultiplier: multiplier });
		this.socket.send({
			type: "set_speed",
			multiplier,
		});
	}

	setPaused(paused: boolean): void {
		this.patchState({ paused });
		this.lockstep.updateSettings({ paused });
		this.socket.send({
			type: "set_paused",
			paused,
		});
	}

	setStarCount(starCount: 1 | 2 | 3 | 4 | 5 | 6): void {
		this.patchState({ starCount });
		this.lockstep.setStarCount(starCount);
		this.socket.send({
			type: "set_star_count",
			starCount,
		});
	}

	setFreeBuild(enabled: boolean): void {
		this.patchState({ freeBuild: enabled });
		this.lockstep.updateSettings({ freeBuild: enabled });
		this.socket.send({ type: "set_free_build", enabled });
	}

	setRentLevel(x: number, y: number, rentLevel: number): void {
		this.sendInputBatch([{ type: "set_rent_level", x, y, rentLevel }]);
	}

	addElevatorCar(x: number, y: number): void {
		this.sendInputBatch([{ type: "add_elevator_car", x, y }]);
	}

	removeElevatorCar(x: number, y: number): void {
		this.sendInputBatch([{ type: "remove_elevator_car", x, y }]);
	}

	setElevatorDwellDelay(x: number, y: number, value: number): void {
		this.sendInputBatch([{ type: "set_elevator_dwell_delay", x, y, value }]);
	}

	setElevatorWaitingCarResponse(x: number, y: number, value: number): void {
		this.sendInputBatch([
			{ type: "set_elevator_waiting_car_response", x, y, value },
		]);
	}

	setElevatorHomeFloor(x: number, carIndex: number, floor: number): void {
		this.sendInputBatch([
			{ type: "set_elevator_home_floor", x, carIndex, floor },
		]);
	}

	toggleElevatorFloorStop(x: number, floor: number): void {
		this.sendInputBatch([{ type: "toggle_elevator_floor_stop", x, floor }]);
	}

	setCinemaMoviePool(x: number, y: number, pool: "classic" | "new"): void {
		this.sendInputBatch([{ type: "set_cinema_movie_pool", x, y, pool }]);
	}

	reconnect(): void {
		this.socket.reconnect();
	}

	private sendInputBatch(inputs: SimCommand[]): void {
		if (inputs.length === 0) {
			return;
		}
		this.clientSeq += 1;
		const clientSeq = this.clientSeq;
		const result = this.lockstep.queueLocalBatch(clientSeq, inputs);
		if (!result.ok) {
			this.addToast(result.reason);
			return;
		}
		this.socket.send({
			type: "input_batch",
			clientSeq,
			targetTick: result.targetTick,
			inputs,
		});
	}

	private handleMessage(msg: ServerMessage): void {
		switch (msg.type) {
			case "init_state": {
				const towerName = msg.name || msg.towerId;
				const lobbyMode = msg.snapshot.world.lobbyMode ?? "perfect-parity";
				this.onEconomy(msg.cash, msg.population);
				this.patchState({
					towerName,
					starCount: msg.starCount,
					speedMultiplier: msg.speedMultiplier,
					freeBuild: msg.freeBuild,
					paused: msg.paused,
					lobbyMode,
				});
				this.getScene()?.setLobbyMode(lobbyMode);
				setTowerToolbarCache(this.towerId, {
					towerName,
					starCount: msg.starCount,
					cash: msg.cash,
					population: msg.population,
				});
				this.lockstep.initialize(msg.snapshot, {
					freeBuild: msg.freeBuild,
					speedMultiplier: msg.speedMultiplier,
					paused: msg.paused,
				});
				break;
			}
			case "authoritative_batch":
				this.lockstep.applyAuthoritativeBatch(msg);
				for (const batch of msg.batches) {
					if (batch.playerId === this.playerId && batch.rejectedReason) {
						this.addToast(batch.rejectedReason);
					}
				}
				break;
			case "checkpoint": {
				const lobbyMode = msg.snapshot.world.lobbyMode ?? "perfect-parity";
				this.patchState({
					speedMultiplier: msg.speedMultiplier,
					freeBuild: msg.freeBuild,
					lobbyMode,
				});
				this.getScene()?.setLobbyMode(lobbyMode);
				this.lockstep.applyCheckpoint(msg.snapshot, {
					freeBuild: msg.freeBuild,
					speedMultiplier: msg.speedMultiplier,
					paused: this.state.paused,
				});
				break;
			}
			case "session_settings":
				this.patchState({
					speedMultiplier: msg.speedMultiplier,
					freeBuild: msg.freeBuild,
					paused: msg.paused,
				});
				this.lockstep.updateSettings({
					freeBuild: msg.freeBuild,
					speedMultiplier: msg.speedMultiplier,
					paused: msg.paused,
				});
				break;
			case "presence_update":
				this.patchState({
					playerCount: msg.playerCount,
					activeCount: msg.activeCount,
				});
				break;
			case "economy_update":
				this.onEconomy(msg.cash, msg.population);
				this.patchState({ starCount: msg.starCount });
				setTowerToolbarCache(this.towerId, {
					towerName: this.state.towerName,
					starCount: msg.starCount,
					cash: msg.cash,
					population: msg.population,
				});
				break;
			case "notification":
				if (msg.kind === "star_advanced") {
					const newStarCount = Number.parseInt(msg.message, 10);
					if (Number.isFinite(newStarCount)) {
						this.patchState({ starUpgrade: { newStarCount } });
					}
				}
				break;
			case "prompt":
				this.patchState({
					activePrompt: {
						promptId: msg.promptId,
						promptKind: msg.promptKind,
						message: msg.message,
						cost: msg.cost,
					},
				});
				break;
			case "prompt_dismissed":
				this.patchState({
					activePrompt:
						this.state.activePrompt?.promptId === msg.promptId
							? null
							: this.state.activePrompt,
				});
				break;
			case "cell_info":
				this.patchState({
					inspectedCell: {
						x: msg.x,
						y: msg.y,
						anchorX: msg.anchorX,
						tileType: msg.tileType,
						objectInfo: msg.objectInfo,
						cinemaInfo: msg.cinemaInfo,
						carrierInfo: msg.carrierInfo,
					},
				});
				break;
			case "pong":
				break;
		}
	}

	private handleStatus(status: ConnectionStatus): void {
		this.patchState({ connectionStatus: status });
		if (status === "connected") {
			this.socket.send({
				type: "join_tower",
				playerId: this.playerId,
				displayName: this.displayName,
			});
		}
	}

	private patchState(patch: Partial<TowerSessionState>): void {
		this.state = {
			...this.state,
			...patch,
		};
		this.onStateChange(this.state);
	}
}
