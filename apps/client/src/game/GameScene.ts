import {
	type GameObjects,
	Geom,
	type Input,
	Math as PhaserMath,
	type Types as PhaserTypes,
	type Renderer,
	Scene,
	Textures,
} from "phaser";
import {
	type CarrierRecord,
	type SimRecord,
	simKey,
} from "../../../worker/src/sim/index";
import type { LobbyMode } from "../../../worker/src/sim/world";
import type { PendingBySimId } from "../lib/lockstepSession";
import { getTowerView, setTowerView } from "../lib/storage";
import {
	type CarrierCarStateData,
	DAY_TICK_MAX,
	GRID_HEIGHT,
	GRID_WIDTH,
	type SimStateData,
	TILE_WIDTHS,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
} from "../types";
import { CloudManager } from "./clouds";
import {
	CAR_COLOR,
	COLOR_HOVER,
	DEFAULT_TICK_INTERVAL_MS,
	ENTITY_STRESS_COLORS,
	LABEL_PANEL_WIDTH,
	MAX_ZOOM,
	MIN_ZOOM,
	STATIC_TILE_GAP_X,
	STATIC_TILE_GAP_Y,
	TILE_COLORS,
	TILE_HEIGHT,
	TILE_LABEL_COLORS,
	TILE_LABELS,
	TILE_WIDTH,
} from "./gameSceneConstants";
import {
	anchorX,
	computeShiftFill,
	contiguousShaftExtent,
	getHoverBounds,
	isElevatorTileType,
	type PlacementAnchor,
} from "./gameScenePlacement";
import {
	type CarBounds,
	collectElevatorColumnsByFloor,
	fillCarBounds,
	fillPrevCarIndex,
	getPresentationTime,
	getQueuedSimLayout,
	getQueuedSimQueueKey,
	getSnapshotProgress,
	interpolatedFloor,
	isSimAscending,
	type PresentationClock,
	packCarKey,
	SIM_QUEUE_MAX_SIZE,
	SIM_QUEUE_SPACING_CELLS,
	shouldInterpolateCars,
	type TimedSnapshot,
} from "./gameSceneTransport";
import {
	type SoundFamily,
	SoundManager,
	type TransportDirections,
	tileFamily,
} from "./sound";
import {
	fillOccupancyByCarFromCarriers,
	isQueuedSimLive,
} from "./transportSelectors";

export type CellClickHandler = (x: number, y: number, shift: boolean) => void;
export type CellInspectHandler = (x: number, y: number) => void;
export type QueuedSimInspectHandler = (sim: SimStateData) => void;

export type SnapshotSource = {
	readSims: () => readonly SimRecord[];
	readCarriers: () => CarrierCarStateData[];
	readLiveCarriers: () => readonly CarrierRecord[];
	readPendingBySimId: () => PendingBySimId;
	materializeSim: (sim: SimRecord) => SimStateData | null;
	/**
	 * Per-floor active fire fronts. Each entry maps the binary's internal
	 * floor index (0..119, where 10 = ground) to the leftmost / rightmost
	 * tile column currently on fire. Entries with sentinel 0xffff are
	 * inactive. Used to draw the translucent red on-fire overlay.
	 */
	readFireFronts: () => {
		fireLeftPos: readonly number[];
		fireRightPos: readonly number[];
	} | null;
};

function hashSimVariant(id: string, modulus: number): number {
	let h = 0;
	for (let i = 0; i < id.length; i += 1) {
		h = (h * 31 + id.charCodeAt(i)) | 0;
	}
	return Math.abs(h) % modulus;
}

const EMPTY_PENDING: PendingBySimId = new Map();

type RoomTextureConfig = {
	files: string[];
	dirtyFiles?: string[];
	heightTiles?: number;
};

type NumberTextureStyle = {
	color: string;
	fontSizePx: number;
	fontStyle?: string;
	fontFamily?: string;
	paddingX?: number;
	paddingY?: number;
};

type StaticRowChunk = {
	x: number;
	width: number;
	texture: Textures.CanvasTexture;
	image: GameObjects.Image;
};

type SimQueueCacheEntry = {
	hash: string;
	renderTexture: GameObjects.RenderTexture;
	worldX: number;
	worldY: number;
	width: number;
	height: number;
	seen: boolean;
};

type CockroachState = {
	roomKey: string;
	offsetX: number;
	offsetY: number;
	velX: number;
	velY: number;
	frame: number;
	frameTimer: number;
	dirChangeTimer: number;
};

// One-finger drag past this many CSS pixels promotes a pending tap into a pan.
const TOUCH_PAN_THRESHOLD_SQ = 10 * 10;

const HOTEL_TILE_TYPES = new Set(["hotelSingle", "hotelTwin", "hotelSuite"]);
const EVALUATABLE_OCCUPANCY_TILE_TYPES = new Set([
	"hotelSingle",
	"hotelTwin",
	"hotelSuite",
	"office",
	"condo",
]);
const HOTEL_TURNOVER_STATUS_MIN = 0x28;
const HOTEL_INFESTED_STATUS_MIN = 0x38;
const COCKROACH_PER_ROOM: Partial<Record<string, number>> = {
	hotelSingle: 3,
	hotelTwin: 4,
	hotelSuite: 6,
};
const COCKROACH_FRAMES = 4;
const COCKROACH_FRAME_MS = 110;
const COCKROACH_SVG_SCALE = 32;
const FLOOR_LABEL_RANGE: [number, number] = [-10, 110];
const EVAL_LABEL_RANGE: [number, number] = [0, 300];
const CAR_LABEL_RANGE: [number, number] = [0, 21];
const EVAL_LEVEL_OVERLAY_COLORS: Record<number, string> = {
	0: "rgba(221, 51, 51, 0.5)",
	1: "rgba(221, 204, 0, 0.5)",
	2: "rgba(68, 136, 255, 0.5)",
};
const NUMBER_TEXTURE_RESOLUTION = Math.max(
	1,
	Math.round(window.devicePixelRatio * 4),
);
// Mutable: chosen at scene preload-time based on the live WebGL context's
// limits and the device's pixel ratio. The default keeps memory tame in case
// the computation fails for any reason.
let STATIC_ROW_TEXTURE_SCALE = 2;

/**
 * Pick the static-row canvas oversampling factor.
 *
 * Quality target is driven by the device pixel ratio so retina displays stay
 * crisp up to MAX_ZOOM. A memory budget caps total canvas-backed texture
 * memory; the budget is generous on desktop and tight on mobile (iOS Safari
 * kills the process around ~256 MB of GPU-backed canvas, Android browsers
 * have similar limits). GL MAX_TEXTURE_SIZE is also respected (chunk width is
 * bounded separately by getStaticRowChunkWidth).
 */
function computeStaticRowTextureScale(maxTextureSize: number): number {
	const dpr = Math.max(1, window.devicePixelRatio || 1);
	// ~4× per device pixel keeps it crisp when zoomed in to MAX_ZOOM.
	const idealScale = Math.max(2, Math.min(8, Math.ceil(dpr * 4)));

	const isMobile =
		typeof navigator !== "undefined" &&
		(/iPad|iPhone|iPod|Android/.test(navigator.userAgent) ||
			(/Mac/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
	const budgetBytes = isMobile ? 96 * 1024 * 1024 : 1024 * 1024 * 1024;
	const totalRowPx = GRID_WIDTH * TILE_WIDTH * TILE_HEIGHT * GRID_HEIGHT;
	const maxScaleByBudget = Math.max(
		1,
		Math.floor(Math.sqrt(budgetBytes / (totalRowPx * 4))),
	);

	const maxScaleByTexture = Math.max(
		1,
		Math.floor(maxTextureSize / TILE_HEIGHT),
	);

	return Math.max(1, Math.min(idealScale, maxScaleByBudget, maxScaleByTexture));
}
const STATIC_ROW_CULL_PAD_TILES = 4;
const SIM_QUEUE_TEXTURE_SCALE = 8;
// Sim figure SVG aspect matches its 6×20 viewBox.
const SIM_FIGURE_WIDTH_PX = 0.75 * TILE_WIDTH;
const SIM_FIGURE_HEIGHT_PX = SIM_FIGURE_WIDTH_PX * (20 / 6);
// The sim SVGs are rasterized once at this exact size so they can be stamped
// into the queue RT at 1:1 without any per-stamp scaling.
const SIM_FIGURE_SOURCE_WIDTH = SIM_FIGURE_WIDTH_PX * SIM_QUEUE_TEXTURE_SCALE;
const SIM_FIGURE_SOURCE_HEIGHT = SIM_FIGURE_HEIGHT_PX * SIM_QUEUE_TEXTURE_SCALE;
const STATIC_ROW_DEPTH = 2;
const STATIC_OVERLAY_DEPTH = 2.9;
const DYNAMIC_ENTITY_DEPTH = 3;
const HOVER_DEPTH = 4;

const ROOM_TEXTURES: Partial<Record<string, RoomTextureConfig>> = {
	office: {
		files: [
			"office.svg",
			"office1.svg",
			"office2.svg",
			"office3.svg",
			"office4.svg",
		],
	},
	condo: { files: ["condo.svg"] },
	restaurant: {
		files: [
			"restaurant0.svg",
			"restaurant1.svg",
			"restaurant2.svg",
			"restaurant3.svg",
			"restaurant4.svg",
		],
	},
	fastFood: {
		files: ["fastFood.svg", "fastFood1.svg", "fastFood2.svg", "fastFood3.svg"],
	},
	retail: {
		files: [
			"retail.svg",
			"retail1.svg",
			"retail2.svg",
			"retail3.svg",
			"retail4.svg",
		],
	},
	hotelSingle: {
		files: ["hotelSingle.svg", "hotelSingle1.svg", "hotelSingle2.svg"],
		dirtyFiles: [
			"hotelSingleDirty.svg",
			"hotelSingle1Dirty.svg",
			"hotelSingle2Dirty.svg",
		],
	},
	hotelTwin: {
		files: ["hotelTwin.svg", "hotelTwin1.svg", "hotelTwin2.svg"],
		dirtyFiles: [
			"hotelTwinDirty.svg",
			"hotelTwin1Dirty.svg",
			"hotelTwin2Dirty.svg",
		],
	},
	hotelSuite: {
		files: ["hotelSuite.svg", "hotelSuite1.svg", "hotelSuite2.svg"],
		dirtyFiles: [
			"hotelSuiteDirty.svg",
			"hotelSuite1Dirty.svg",
			"hotelSuite2Dirty.svg",
		],
	},
	cinema: { files: ["cinema.svg"], heightTiles: 2 },
	partyHall: { files: ["partyHall.svg"], heightTiles: 2 },
	recyclingCenterUpper: {
		files: [
			"recyclingCenter0.svg",
			"recyclingCenter1.svg",
			"recyclingCenter2.svg",
			"recyclingCenter3.svg",
			"recyclingCenter4.svg",
		],
		heightTiles: 2,
	},
	parking: {
		files: [
			"parking.svg",
			"parkingFull.svg",
			"parkingFull2.svg",
			"parkingFull3.svg",
			"parkingFull4.svg",
		],
	},
	parkingRamp: { files: ["parkingRamp.svg"] },
	security: { files: ["security.svg"] },
	metro: { files: ["metro.svg"], heightTiles: 3 },
	housekeeping: { files: ["housekeeping.svg"] },
	medical: { files: ["medical.svg"] },
};

/** Tile types whose textures depend on a non-coverage state flag. Mapped
 *  cell key → noAccess SVG file when coverageFlag === 0. */
const PARKING_NO_ACCESS_FILE = "parkingNoAccess.svg";

export class GameScene extends Scene {
	private static readonly UNDERGROUND_TEXTURE_KEY = "underground";
	private static readonly MERGE_TYPES = new Set(["floor", "lobby"]);

	private cellGraphics!: GameObjects.Graphics;
	private simGraphics!: GameObjects.Graphics;
	private fireGraphics!: GameObjects.Graphics;
	private simQueueCache: Map<string, SimQueueCacheEntry> = new Map();
	private cockroachSprites: GameObjects.Sprite[] = [];
	private cockroaches: CockroachState[] = [];
	private carRects: GameObjects.Rectangle[] = [];
	private undergroundBackground: GameObjects.TileSprite | null = null;
	private skyNight: GameObjects.Image | null = null;

	private hoverGraphics!: GameObjects.Graphics;
	private cloudManager!: CloudManager;
	private soundManager: SoundManager | null = null;
	private soundMuted = false;
	private lastSoundUpdateMs = 0;
	private visibleFamiliesScratch: Map<SoundFamily, number> = new Map();
	private floorLabelBg!: GameObjects.Rectangle;
	private floorLabels: GameObjects.Image[] = [];
	private carLabels: GameObjects.Image[] = [];
	private staticRowChunks: StaticRowChunk[][] = [];
	private overlaySprites: GameObjects.Image[] = [];
	private roomTexturesLoaded = false;
	private sceneCreated = false;
	private evalActiveFlagMap: Map<string, number> = new Map();
	private unitStatusMap: Map<string, number> = new Map();
	private evalLevelMap: Map<string, number> = new Map();
	private evalScoreMap: Map<string, number> = new Map();
	private coverageFlagMap: Map<string, number> = new Map();
	private usedOverlaySpriteCount = 0;
	private lastFloorLabelZoom = Number.NaN;
	private lastFloorLabelWidth = -1;
	private simsDirty = true;
	private stressBadgesEnabled = true;
	private paused = false;
	private lastSimWorldView = new Geom.Rectangle();

	// Scratch buffers reused every frame to avoid GC pressure in the render
	// loop. Never hold references across frames.
	private occupancyByCar: Map<number, number> = new Map();
	private prevCarByKey: Map<number, CarrierCarStateData> = new Map();
	private carBoundsScratch: CarBounds = { x: 0, y: 0, width: 0, height: 0 };
	private infestedKeysScratch: Set<string> = new Set();
	private roomCountsScratch: Map<string, number> = new Map();
	private readonly cockroachTextureKeys: readonly string[] = Array.from(
		{ length: 4 },
		(_, i) => `cockroach_${i}`,
	);

	// Stores every occupied cell: "x,y" -> tileType (including extension cells)
	private grid: Map<string, string> = new Map();
	// Keys of anchor cells only (used for rendering)
	private anchorSet: Set<string> = new Set();
	private anchorKeysByRow: Array<Set<string>> = Array.from(
		{ length: GRID_HEIGHT },
		() => new Set<string>(),
	);
	// Overlay tiles (e.g. stairs) keyed by "x,y"
	private overlayGrid: Map<string, string> = new Map();
	private overlayKeysByRow: Array<Set<string>> = Array.from(
		{ length: GRID_HEIGHT },
		() => new Set<string>(),
	);
	private previousCarrierSnapshot: TimedSnapshot<CarrierCarStateData> | null =
		null;
	private currentCarrierSnapshot: TimedSnapshot<CarrierCarStateData> | null =
		null;
	private snapshotSource: SnapshotSource | null = null;
	private lobbyMode: LobbyMode = "perfect-parity";
	private presentationClock: PresentationClock = {
		simTime: 0,
		receivedAtMs: 0,
		tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
	};

	private hoveredCell: { x: number; y: number } | null = null;
	private queuedSimHitboxes: Array<{
		left: number;
		right: number;
		top: number;
		bottom: number;
		simRecord: SimRecord;
	}> = [];
	private selectedTool: string = "floor";
	private onCellClick: CellClickHandler | null = null;
	private onCellInspect: CellInspectHandler | null = null;
	private onQueuedSimInspect: QueuedSimInspectHandler | null = null;

	// Pan state
	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private camStartX = 0;
	private camStartY = 0;

	// Arrow-key pan
	private arrowKeys!: PhaserTypes.Input.Keyboard.CursorKeys;

	// Drag-to-paint state
	private isDragging = false;
	private draggedCells = new Set<string>();

	// Pinch-zoom state (two-finger touch)
	private isPinching = false;
	private pinchPrevDist = 0;
	private pinchPrevMidX = 0;
	private pinchPrevMidY = 0;

	// Pending tap from a touch pointerdown — committed on pointerup so a
	// second finger arriving for pinch can cancel it.
	private pendingTouchTap: {
		x: number;
		y: number;
		shift: boolean;
	} | null = null;

	// Last non-shift placement anchor (for shift-fill)
	private lastPlacedAnchor: PlacementAnchor | null = null;

	// Shift key state (for preview)
	private isShiftHeld = false;

	private towerId: string;

	constructor(towerId: string) {
		super({ key: "GameScene" });
		this.towerId = towerId;
	}

	setOnCellClick(handler: CellClickHandler): void {
		this.onCellClick = handler;
	}

	setOnCellInspect(handler: CellInspectHandler): void {
		this.onCellInspect = handler;
	}

	setOnQueuedSimInspect(handler: QueuedSimInspectHandler): void {
		this.onQueuedSimInspect = handler;
	}

	setSelectedTool(tool: string): void {
		this.selectedTool = tool;
		this.updateCanvasCursor();
		this.drawHover(); // refresh hover preview width
	}

	setStressBadgesEnabled(enabled: boolean): void {
		if (this.stressBadgesEnabled === enabled) return;
		this.stressBadgesEnabled = enabled;
		if (this.staticRowChunks.length > 0) {
			this.redrawStaticRows(Array.from({ length: GRID_HEIGHT }, (_, y) => y));
		}
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) return;
		this.paused = paused;
		if (this.staticRowChunks.length > 0) {
			this.redrawStaticRows(Array.from({ length: GRID_HEIGHT }, (_, y) => y));
		}
	}

	setSoundMuted(muted: boolean): void {
		this.soundMuted = muted;
		this.soundManager?.setMuted(muted);
	}

	setLastPlaced(x: number, y: number, tileType: string): void {
		this.lastPlacedAnchor = { x, y, tileType };
	}

	private resetRowKeyIndexes(): void {
		for (const row of this.anchorKeysByRow) row.clear();
		for (const row of this.overlayKeysByRow) row.clear();
	}

	private addAnchorKey(key: string, y: number): void {
		this.anchorSet.add(key);
		this.anchorKeysByRow[y]?.add(key);
	}

	private removeAnchorKey(key: string, y: number): void {
		this.anchorSet.delete(key);
		this.anchorKeysByRow[y]?.delete(key);
	}

	private addOverlayKey(key: string, y: number, tileType: string): void {
		this.overlayGrid.set(key, tileType);
		this.overlayKeysByRow[y]?.add(key);
	}

	private removeOverlayKey(key: string, y: number): void {
		this.overlayGrid.delete(key);
		this.overlayKeysByRow[y]?.delete(key);
	}

	private markDirtyRows(dirtyRows: Set<number>, y: number): void {
		for (let row = y; row <= y + 1; row += 1) {
			if (row >= 0 && row < GRID_HEIGHT) dirtyRows.add(row);
		}
	}

	/** "Stuck unoccupiable" detection — the binary's signal is occupiedFlag=0
	 * (what we send as evalActiveFlag): handleOfficeMorningGate gates on
	 * occupiedFlag at office.ts:339, so sims skip the commute entirely once
	 * the scoring sweep deactivates the unit (refreshOccupiedFlagAndTripCounters
	 * Branch C: evalLevel=0 with no high-rated donor). Newly-placed units have
	 * occupiedFlag=1 (commands.ts:164), so they won't false-positive. Hotels
	 * use the infested band (unitStatus>=0x38) since their occupiedFlag cycles
	 * with checkout/turnover. */
	private isStuckUnit(
		tileType: string,
		unitStatus: number,
		key: string,
	): boolean {
		if (HOTEL_TILE_TYPES.has(tileType)) return unitStatus >= 0x38;
		if (tileType !== "office" && tileType !== "condo") return false;
		return this.evalActiveFlagMap.get(key) === 0;
	}

	private displayEvalLevel(tileType: string, key: string): number | undefined {
		const evalLevel = this.evalLevelMap.get(key);
		if (evalLevel !== undefined && evalLevel >= 0 && evalLevel <= 2) {
			return evalLevel;
		}
		if (!EVALUATABLE_OCCUPANCY_TILE_TYPES.has(tileType)) {
			return undefined;
		}

		const unitStatus = this.unitStatusMap.get(key);
		if (unitStatus === undefined) {
			return undefined;
		}
		if (HOTEL_TILE_TYPES.has(tileType)) {
			return unitStatus < 0x18 ? 2 : undefined;
		}
		if (tileType === "office") {
			return unitStatus <= 0x0f ? 2 : undefined;
		}
		if (tileType === "condo") {
			return unitStatus <= 0x17 ? 2 : undefined;
		}
		return undefined;
	}

	/** Signature of a cell's visually-rendered state. Changes when (and only
	 *  when) something in drawStaticRowContent would draw differently. */
	private computeCellVisualSig(key: string): string {
		const tileType = this.grid.get(key);
		if (!tileType) return "";
		const isAnchor = this.anchorSet.has(key) ? 1 : 0;
		const unitStatus = this.unitStatusMap.get(key) ?? 0;
		const evalFlag = this.evalActiveFlagMap.get(key);

		let dirty = 0;
		let banner = 0;
		if (HOTEL_TILE_TYPES.has(tileType)) {
			dirty = unitStatus >= HOTEL_TURNOVER_STATUS_MIN ? 1 : 0;
		} else if (tileType === "office") {
			banner = unitStatus > 0x0f ? 1 : 0;
		} else if (tileType === "condo") {
			banner = unitStatus > 0x17 ? 1 : 0;
		} else {
			banner = evalFlag === 0 ? 1 : 0;
		}

		const coverage =
			tileType === "parking" ? (this.coverageFlagMap.get(key) ?? 0) : 0;

		const stuck = this.isStuckUnit(tileType, unitStatus, key) ? 1 : 0;

		let badge = "";
		if (import.meta.env.DEV) {
			const level = this.evalLevelMap.get(key);
			const score = this.evalScoreMap.get(key);
			if (
				level !== undefined &&
				level <= 2 &&
				score !== undefined &&
				score >= 0
			) {
				badge = `${level}:${score}`;
			}
		}
		const evalOverlay = this.paused
			? (this.displayEvalLevel(tileType, key) ?? "")
			: "";
		return `${tileType}:${isAnchor}:${dirty}:${banner}:${coverage}:${stuck}:${badge}:${evalOverlay}`;
	}

	/** Check whether the cell at (x, y) has an elevator-family overlay. */
	hasElevatorOverlayAt(x: number, y: number, tileType?: string): boolean {
		const overlay = this.overlayGrid.get(`${x},${y}`);
		if (tileType !== undefined) return overlay === tileType;
		return (
			overlay === "elevator" ||
			overlay === "elevatorExpress" ||
			overlay === "elevatorService"
		);
	}

	/**
	 * If (x, y) sits on an elevator-shaft overlay, return the contiguous run's
	 * top/bottom rows (inclusive) and the overlay type. Returns null otherwise.
	 */
	getElevatorShaftAt(
		x: number,
		y: number,
	): { topY: number; bottomY: number; tileType: string } | null {
		const overlay = this.overlayGrid.get(`${x},${y}`);
		if (
			overlay !== "elevator" &&
			overlay !== "elevatorExpress" &&
			overlay !== "elevatorService"
		) {
			return null;
		}
		const { topY, bottomY } = contiguousShaftExtent(
			x,
			y,
			overlay,
			this.overlayGrid,
		);
		return { topY, bottomY, tileType: overlay };
	}

	/** Compute shift-fill positions between lastPlacedAnchor and (clickX, clickY).
	 *  Fills every row in the Y range.  Within each row tiles are packed left (if the
	 *  last-placed anchor is to the left of the click) or right (if to the right),
	 *  skipping any already-occupied cells. */
	computeShiftFill(
		clickX: number,
		clickY: number,
	): Array<{ x: number; y: number }> {
		return computeShiftFill(
			clickX,
			clickY,
			this.selectedTool,
			this.lastPlacedAnchor,
			this.grid,
			this.overlayGrid,
			this.lobbyMode,
		);
	}

	setSnapshotSource(source: SnapshotSource): void {
		this.snapshotSource = source;
	}

	setLobbyMode(mode: LobbyMode): void {
		this.lobbyMode = mode;
	}

	applyInitState(
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
	): void {
		const carriers = this.snapshotSource?.readCarriers() ?? [];
		const expectedGrid = new Map<string, string>();
		const expectedOverlay = new Map<string, string>();
		const expectedAnchors = new Set<string>();
		const expectedEvalActiveFlag = new Map<string, number>();
		const expectedUnitStatus = new Map<string, number>();
		const expectedEvalLevel = new Map<string, number>();
		const expectedEvalScore = new Map<string, number>();
		const expectedCoverageFlag = new Map<string, number>();
		const expectedY = new Map<string, number>();
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			expectedY.set(key, cell.y);
			if (cell.isOverlay) {
				if (cell.tileType !== "empty") expectedOverlay.set(key, cell.tileType);
			} else if (cell.tileType !== "empty") {
				expectedGrid.set(key, cell.tileType);
				if (cell.isAnchor) expectedAnchors.add(key);
				if (cell.evalActiveFlag !== undefined)
					expectedEvalActiveFlag.set(key, cell.evalActiveFlag);
				if (cell.unitStatus !== undefined)
					expectedUnitStatus.set(key, cell.unitStatus);
				if (cell.evalLevel !== undefined)
					expectedEvalLevel.set(key, cell.evalLevel);
				if (cell.evalScore !== undefined)
					expectedEvalScore.set(key, cell.evalScore);
				if (cell.coverageFlag !== undefined)
					expectedCoverageFlag.set(key, cell.coverageFlag);
			}
		}

		this.previousCarrierSnapshot = null;
		this.currentCarrierSnapshot = { simTime, items: carriers };
		this.simsDirty = true;
		this.presentationClock = {
			simTime,
			receivedAtMs: performance.now(),
			tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
		};

		const yOf = (key: string): number => {
			const cached = expectedY.get(key);
			if (cached !== undefined) return cached;
			return Number(key.slice(key.indexOf(",") + 1));
		};

		if (!this.sceneCreated) {
			this.grid.clear();
			this.overlayGrid.clear();
			this.anchorSet.clear();
			this.evalActiveFlagMap.clear();
			this.unitStatusMap.clear();
			this.evalLevelMap.clear();
			this.evalScoreMap.clear();
			this.coverageFlagMap.clear();
			this.resetRowKeyIndexes();
			for (const [key, type] of expectedGrid) this.grid.set(key, type);
			for (const [key, type] of expectedOverlay)
				this.addOverlayKey(key, yOf(key), type);
			for (const key of expectedAnchors) this.addAnchorKey(key, yOf(key));
			for (const [key, value] of expectedEvalActiveFlag)
				this.evalActiveFlagMap.set(key, value);
			for (const [key, value] of expectedUnitStatus)
				this.unitStatusMap.set(key, value);
			for (const [key, value] of expectedEvalLevel)
				this.evalLevelMap.set(key, value);
			for (const [key, value] of expectedEvalScore)
				this.evalScoreMap.set(key, value);
			for (const [key, value] of expectedCoverageFlag)
				this.coverageFlagMap.set(key, value);
			return;
		}

		const dirtyRows = new Set<number>();
		let overlayChanged = false;

		for (const [key, type] of expectedOverlay) {
			if (this.overlayGrid.get(key) !== type) {
				this.addOverlayKey(key, yOf(key), type);
				this.markDirtyRows(dirtyRows, yOf(key));
				overlayChanged = true;
			}
		}
		for (const key of [...this.overlayGrid.keys()]) {
			if (!expectedOverlay.has(key)) {
				const y = yOf(key);
				this.removeOverlayKey(key, y);
				this.markDirtyRows(dirtyRows, y);
				overlayChanged = true;
			}
		}

		const gridKeys = new Set<string>();
		for (const k of this.grid.keys()) gridKeys.add(k);
		for (const k of expectedGrid.keys()) gridKeys.add(k);
		for (const k of this.anchorSet) gridKeys.add(k);
		for (const k of expectedAnchors) gridKeys.add(k);
		for (const k of this.evalActiveFlagMap.keys()) gridKeys.add(k);
		for (const k of expectedEvalActiveFlag.keys()) gridKeys.add(k);
		for (const k of this.unitStatusMap.keys()) gridKeys.add(k);
		for (const k of expectedUnitStatus.keys()) gridKeys.add(k);
		for (const k of this.evalLevelMap.keys()) gridKeys.add(k);
		for (const k of expectedEvalLevel.keys()) gridKeys.add(k);
		for (const k of this.evalScoreMap.keys()) gridKeys.add(k);
		for (const k of expectedEvalScore.keys()) gridKeys.add(k);
		for (const k of this.coverageFlagMap.keys()) gridKeys.add(k);
		for (const k of expectedCoverageFlag.keys()) gridKeys.add(k);

		for (const key of gridKeys) {
			const y = yOf(key);
			const prevSig = this.computeCellVisualSig(key);
			const expectedType = expectedGrid.get(key);
			if (expectedType === undefined) {
				this.grid.delete(key);
				this.removeAnchorKey(key, y);
				this.evalActiveFlagMap.delete(key);
				this.unitStatusMap.delete(key);
				this.evalLevelMap.delete(key);
				this.evalScoreMap.delete(key);
				this.coverageFlagMap.delete(key);
			} else {
				if (this.grid.get(key) !== expectedType)
					this.grid.set(key, expectedType);
				const shouldAnchor = expectedAnchors.has(key);
				if (this.anchorSet.has(key) !== shouldAnchor) {
					if (shouldAnchor) this.addAnchorKey(key, y);
					else this.removeAnchorKey(key, y);
				}
				const evalFlag = expectedEvalActiveFlag.get(key);
				if (evalFlag === undefined) this.evalActiveFlagMap.delete(key);
				else if (this.evalActiveFlagMap.get(key) !== evalFlag)
					this.evalActiveFlagMap.set(key, evalFlag);
				const unitStatus = expectedUnitStatus.get(key);
				if (unitStatus === undefined) this.unitStatusMap.delete(key);
				else if (this.unitStatusMap.get(key) !== unitStatus)
					this.unitStatusMap.set(key, unitStatus);
				const evalLevel = expectedEvalLevel.get(key);
				if (evalLevel === undefined) this.evalLevelMap.delete(key);
				else if (this.evalLevelMap.get(key) !== evalLevel)
					this.evalLevelMap.set(key, evalLevel);
				const evalScore = expectedEvalScore.get(key);
				if (evalScore === undefined) this.evalScoreMap.delete(key);
				else if (this.evalScoreMap.get(key) !== evalScore)
					this.evalScoreMap.set(key, evalScore);
				const coverageFlag = expectedCoverageFlag.get(key);
				if (coverageFlag === undefined) this.coverageFlagMap.delete(key);
				else if (this.coverageFlagMap.get(key) !== coverageFlag)
					this.coverageFlagMap.set(key, coverageFlag);
			}
			const newSig = this.computeCellVisualSig(key);
			if (newSig !== prevSig) this.markDirtyRows(dirtyRows, y);
		}

		if (dirtyRows.size > 0) {
			this.redrawStaticRows(dirtyRows);
			this.drawStaticOverlays();
			this.drawDynamicOverlays();
		} else if (overlayChanged) {
			this.drawStaticOverlays();
			this.drawDynamicOverlays();
		}
	}

	applyPatch(
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
	): void {
		let needsRedraw = false;
		const dirtyRows = new Set<number>();
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			if (cell.isOverlay) {
				if (cell.tileType === "empty") {
					if (this.overlayGrid.has(key)) {
						this.removeOverlayKey(key, cell.y);
						this.markDirtyRows(dirtyRows, cell.y);
						needsRedraw = true;
					}
				} else {
					if (this.overlayGrid.get(key) !== cell.tileType) {
						this.addOverlayKey(key, cell.y, cell.tileType);
						this.markDirtyRows(dirtyRows, cell.y);
						needsRedraw = true;
					}
				}
				continue;
			}

			const prevSig = this.computeCellVisualSig(key);
			if (cell.tileType === "empty") {
				const hadContent =
					this.grid.has(key) ||
					this.anchorSet.has(key) ||
					this.evalActiveFlagMap.has(key) ||
					this.unitStatusMap.has(key) ||
					this.evalLevelMap.has(key) ||
					this.evalScoreMap.has(key) ||
					this.coverageFlagMap.has(key);
				if (hadContent) {
					this.grid.delete(key);
					this.removeAnchorKey(key, cell.y);
					this.evalActiveFlagMap.delete(key);
					this.unitStatusMap.delete(key);
					this.evalLevelMap.delete(key);
					this.evalScoreMap.delete(key);
					this.coverageFlagMap.delete(key);
				}
			} else {
				if (this.grid.get(key) !== cell.tileType) {
					this.grid.set(key, cell.tileType);
				}
				if (this.anchorSet.has(key) !== cell.isAnchor) {
					if (cell.isAnchor) {
						this.addAnchorKey(key, cell.y);
					} else {
						this.removeAnchorKey(key, cell.y);
					}
				}
				if (cell.evalActiveFlag !== undefined) {
					this.evalActiveFlagMap.set(key, cell.evalActiveFlag);
				}
				if (cell.unitStatus !== undefined) {
					this.unitStatusMap.set(key, cell.unitStatus);
				}
				if (cell.evalLevel !== undefined) {
					this.evalLevelMap.set(key, cell.evalLevel);
				}
				if (cell.evalScore !== undefined) {
					this.evalScoreMap.set(key, cell.evalScore);
				}
				if (cell.coverageFlag !== undefined) {
					this.coverageFlagMap.set(key, cell.coverageFlag);
				}
			}
			const newSig = this.computeCellVisualSig(key);
			if (newSig !== prevSig) {
				this.markDirtyRows(dirtyRows, cell.y);
				needsRedraw = true;
			}
		}
		if (needsRedraw) {
			this.simsDirty = true;
			this.redrawStaticRows(dirtyRows);
			this.drawStaticOverlays();
			this.drawDynamicOverlays();
		}
	}

	applySims(_simTime: number): void {
		this.simsDirty = true;
	}

	applyCarriers(simTime: number): void {
		this.previousCarrierSnapshot = this.currentCarrierSnapshot;
		this.currentCarrierSnapshot = {
			simTime,
			items: this.snapshotSource?.readCarriers() ?? [],
		};
	}

	setPresentationClock(
		simTime: number,
		receivedAtMs: number,
		tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
	): void {
		this.presentationClock = {
			simTime,
			receivedAtMs,
			tickIntervalMs:
				tickIntervalMs > 0 ? tickIntervalMs : DEFAULT_TICK_INTERVAL_MS,
		};
	}

	preload(): void {
		const renderer = this.renderer as Renderer.WebGL.WebGLRenderer | undefined;
		const gl = renderer?.gl;
		const maxTextureSize =
			gl && typeof gl.getParameter === "function"
				? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))
				: 4096;
		STATIC_ROW_TEXTURE_SCALE = computeStaticRowTextureScale(maxTextureSize);
		const s = STATIC_ROW_TEXTURE_SCALE;
		for (const [room, config] of Object.entries(ROOM_TEXTURES)) {
			const heightTiles = config?.heightTiles ?? 1;
			const w = ((TILE_WIDTHS[room] ?? 1) * TILE_WIDTH - STATIC_TILE_GAP_X) * s;
			const h = (TILE_HEIGHT * heightTiles - STATIC_TILE_GAP_Y) * s;
			for (const [index, file] of config?.files?.entries() ?? []) {
				this.load.svg(`room_${room}_${index}`, `/rooms/${file}`, {
					width: w,
					height: h,
				});
			}
			for (const [index, file] of config?.dirtyFiles?.entries() ?? []) {
				this.load.svg(`room_${room}_dirty_${index}`, `/rooms/${file}`, {
					width: w,
					height: h,
				});
			}
		}
		this.load.svg("room_lobby", "/rooms/lobby.svg", {
			width: (2 * TILE_HEIGHT - STATIC_TILE_GAP_X) * s,
			height: (TILE_HEIGHT - STATIC_TILE_GAP_Y) * s,
		});
		const parkingW =
			((TILE_WIDTHS.parking ?? 1) * TILE_WIDTH - STATIC_TILE_GAP_X) * s;
		const parkingH = (TILE_HEIGHT - STATIC_TILE_GAP_Y) * s;
		this.load.svg("room_parking_noAccess", `/rooms/${PARKING_NO_ACCESS_FILE}`, {
			width: parkingW,
			height: parkingH,
		});
		const bridgeH = (TILE_HEIGHT + TILE_HEIGHT / 3) * s;
		for (const bridge of ["stairs", "escalator"]) {
			this.load.svg(`room_${bridge}`, `/rooms/${bridge}.svg`, {
				width: (TILE_WIDTHS[bridge] ?? 1) * TILE_WIDTH * s,
				height: bridgeH,
			});
		}
		for (const level of ["low-0", "low-1", "low-2", "low-3"] as const) {
			this.load.svg(`sim_figure_${level}`, `/rooms/sim-${level}.svg`, {
				width: SIM_FIGURE_SOURCE_WIDTH,
				height: SIM_FIGURE_SOURCE_HEIGHT,
			});
		}
		for (const level of ["medium", "high"] as const) {
			this.load.svg(`sim_figure_${level}`, `/rooms/sim-${level}.svg`, {
				width: SIM_FIGURE_SOURCE_WIDTH,
				height: SIM_FIGURE_SOURCE_HEIGHT,
			});
		}
		const cockroachSvgW = 10 * COCKROACH_SVG_SCALE;
		const cockroachSvgH = 8 * COCKROACH_SVG_SCALE;
		for (let i = 0; i < COCKROACH_FRAMES; i += 1) {
			this.load.svg(`cockroach_${i}`, `/rooms/cockroach${i}.svg`, {
				width: cockroachSvgW,
				height: cockroachSvgH,
			});
		}
		const bannerW = 180 * 4;
		const bannerH = 80 * 4;
		this.load.svg("for_rent", "/rooms/for-rent.svg", {
			width: bannerW,
			height: bannerH,
		});
		this.load.svg("for_sale", "/rooms/for-sale.svg", {
			width: bannerW,
			height: bannerH,
		});
	}

	create(): void {
		const totalWidth = GRID_WIDTH * TILE_WIDTH;

		// Room textures finished loading in preload() before create() was called.
		this.roomTexturesLoaded = true;

		// Restore the previously-saved zoom and scroll for this tower.
		const savedView = getTowerView(this.towerId);
		const initialZoom = PhaserMath.Clamp(
			savedView.zoom ?? (this.scale.width / totalWidth) * 3,
			MIN_ZOOM,
			MAX_ZOOM,
		);
		this.cameras.main.setZoom(initialZoom);
		if (savedView.scrollX != null && savedView.scrollY != null) {
			this.cameras.main.setScroll(savedView.scrollX, savedView.scrollY);
		} else {
			this.cameras.main.centerOn(
				totalWidth / 2,
				(UNDERGROUND_Y - 8) * TILE_HEIGHT +
					0.2 * (this.scale.height / initialZoom),
			);
		}

		this.cellGraphics = this.add.graphics();
		this.simGraphics = this.add.graphics();
		this.fireGraphics = this.add.graphics();
		this.hoverGraphics = this.add.graphics();

		// Depth ordering: sky (0) -> clouds/ground (1) -> cached rows (2) -> static overlays (2.9) -> sims/cars (3) -> fire (3.5) -> hover (4)
		this.cellGraphics.setDepth(STATIC_OVERLAY_DEPTH);
		this.simGraphics.setDepth(DYNAMIC_ENTITY_DEPTH);
		this.fireGraphics.setDepth(DYNAMIC_ENTITY_DEPTH + 0.5);
		this.hoverGraphics.setDepth(HOVER_DEPTH);

		this.arrowKeys =
			this.input.keyboard?.createCursorKeys() as PhaserTypes.Input.Keyboard.CursorKeys;

		this.drawSky();
		this.loadUndergroundTexture();
		this.drawUndergroundBackground();
		this.setupStaticRowBitmaps();
		this.drawAllCells();

		this.cloudManager = new CloudManager(this, 1);
		this.cloudManager.loadTextures();

		this.setupNumberTextures();

		this.setupInput();
		this.setupFloorLabels();
		this.updateFloorLabels();
		this.soundManager = new SoundManager();
		this.soundManager.setMuted(this.soundMuted);
		this.events.once("shutdown", () => {
			this.soundManager?.destroy();
			this.soundManager = null;
		});
		this.events.once("destroy", () => {
			this.soundManager?.destroy();
			this.soundManager = null;
		});
		this.sceneCreated = true;
	}

	/** Schedule kaching as the next sound effect (call on cash income). */
	playKaching(): void {
		this.soundManager?.triggerCash();
	}

	update(_time: number, delta: number): void {
		const cam = this.cameras.main;
		const PAN_SPEED = 6 / cam.zoom;
		if (this.arrowKeys.left.isDown) cam.scrollX -= PAN_SPEED;
		if (this.arrowKeys.right.isDown) cam.scrollX += PAN_SPEED;
		if (this.arrowKeys.up.isDown) cam.scrollY -= PAN_SPEED;
		if (this.arrowKeys.down.isDown) cam.scrollY += PAN_SPEED;

		this.cloudManager.update(delta);
		if (this.skyNight) this.skyNight.setAlpha(this.nightAlpha());
		if (
			this.lastFloorLabelZoom !== cam.zoom ||
			this.lastFloorLabelWidth !== this.scale.width
		) {
			this.updateFloorLabels();
		}
		this.drawSimsIfNeeded();
		this.drawCars();
		this.drawFireOverlay();
		this.updateCockroaches(delta);
		this.cullStaticRowChunks();
		this.updateSounds();
	}

	private updateSounds(): void {
		const sound = this.soundManager;
		if (!sound) return;
		const now = performance.now();
		if (now - this.lastSoundUpdateMs < 250) return;
		this.lastSoundUpdateMs = now;
		const presentationTime = getPresentationTime(this.presentationClock);
		const dayTick =
			((Math.floor(presentationTime) % DAY_TICK_MAX) + DAY_TICK_MAX) %
			DAY_TICK_MAX;
		const hour = GameScene.dayTickToHour(dayTick);
		sound.updateAmbience(hour);
		sound.updateEffects(
			this.computeVisibleFamilies(),
			this.computeVisibleTransportDirections(),
		);
	}

	private computeVisibleTransportDirections(): TransportDirections {
		const snapshot = this.currentCarrierSnapshot;
		if (!snapshot) return { up: false, down: false };
		const view = this.cameras.main.worldView;
		const left = view.x - TILE_WIDTH;
		const right = view.right + TILE_WIDTH;
		const top = view.y - TILE_HEIGHT;
		const bottom = view.bottom + TILE_HEIGHT;
		const bounds = this.carBoundsScratch;
		let up = false;
		let down = false;
		for (const car of snapshot.items) {
			if (car.currentFloor === car.targetFloor) continue;
			// Span the bounds across the run so a viewport sitting between the
			// two endpoints still counts the car as visible.
			fillCarBounds(car, car.currentFloor, bounds);
			const x0 = bounds.x;
			const x1 = bounds.x + bounds.width;
			const yA = bounds.y;
			const yB = bounds.y + bounds.height;
			fillCarBounds(car, car.targetFloor, bounds);
			const yC = bounds.y;
			const yD = bounds.y + bounds.height;
			const segTop = Math.min(yA, yC);
			const segBottom = Math.max(yB, yD);
			if (x1 < left || x0 > right || segBottom < top || segTop > bottom) {
				continue;
			}
			if (car.targetFloor > car.currentFloor) up = true;
			else down = true;
			if (up && down) break;
		}
		return { up, down };
	}

	private computeVisibleFamilies(): ReadonlyMap<SoundFamily, number> {
		const view = this.cameras.main.worldView;
		const startY = Math.max(0, Math.floor(view.y / TILE_HEIGHT));
		const endY = Math.min(
			GRID_HEIGHT - 1,
			Math.floor(view.bottom / TILE_HEIGHT),
		);
		// Try the center third first; fall back to the full view if empty.
		const thirdW = view.width / 3;
		const centerLeft = view.x + thirdW;
		const centerRight = view.right - thirdW;
		this.fillVisibleFamilies(centerLeft, centerRight, startY, endY);
		if (this.visibleFamiliesScratch.size === 0) {
			this.fillVisibleFamilies(view.x, view.right, startY, endY);
		}
		return this.visibleFamiliesScratch;
	}

	private fillVisibleFamilies(
		left: number,
		right: number,
		startY: number,
		endY: number,
	): void {
		this.visibleFamiliesScratch.clear();
		const bump = (family: SoundFamily) => {
			this.visibleFamiliesScratch.set(
				family,
				(this.visibleFamiliesScratch.get(family) ?? 0) + 1,
			);
		};
		for (let y = startY; y <= endY; y += 1) {
			const anchorRow = this.anchorKeysByRow[y];
			if (anchorRow) {
				for (const key of anchorRow) {
					const tileType = this.grid.get(key);
					if (!tileType) continue;
					const family = tileFamily(tileType);
					if (!family) continue;
					const cx = Number(key.slice(0, key.indexOf(",")));
					const tx = cx * TILE_WIDTH;
					const tw = (TILE_WIDTHS[tileType] ?? 1) * TILE_WIDTH;
					if (tx + tw < left || tx > right) continue;
					bump(family);
				}
			}
			const overlayRow = this.overlayKeysByRow[y];
			if (overlayRow) {
				for (const key of overlayRow) {
					const tileType = this.overlayGrid.get(key);
					if (!tileType) continue;
					const family = tileFamily(tileType);
					if (!family) continue;
					const cx = Number(key.slice(0, key.indexOf(",")));
					const tx = cx * TILE_WIDTH;
					if (tx + TILE_WIDTH < left || tx > right) continue;
					bump(family);
				}
			}
		}
	}

	private cullStaticRowChunks(): void {
		const worldView = this.cameras.main.worldView;
		const padX = TILE_WIDTH * STATIC_ROW_CULL_PAD_TILES;
		const padY = TILE_HEIGHT * STATIC_ROW_CULL_PAD_TILES;
		const left = worldView.x - padX;
		const right = worldView.right + padX;
		const top = worldView.y - padY;
		const bottom = worldView.bottom + padY;
		for (let y = 0; y < this.staticRowChunks.length; y += 1) {
			const rowTop = y * TILE_HEIGHT;
			const rowBottom = rowTop + TILE_HEIGHT;
			const rowVisible = rowBottom >= top && rowTop <= bottom;
			const chunks = this.staticRowChunks[y];
			if (!chunks) continue;
			for (const chunk of chunks) {
				const visible =
					rowVisible && chunk.x + chunk.width >= left && chunk.x <= right;
				if (chunk.image.visible !== visible) chunk.image.setVisible(visible);
			}
		}

		// Floor labels are scrollFactor(0, 1) — pinned horizontally, scroll
		// vertically. Only cull against y; x is always on-screen.
		for (let i = 0; i < this.floorLabels.length; i += 1) {
			const label = this.floorLabels[i];
			if (!label) continue;
			const labelY = i * TILE_HEIGHT + TILE_HEIGHT / 2;
			const visible = labelY >= top && labelY <= bottom;
			if (label.visible !== visible) label.setVisible(visible);
		}
	}

	private setupFloorLabels(): void {
		// Very tall rectangle so it always covers the full viewport height regardless of camera position
		this.floorLabelBg = this.add.rectangle(
			0,
			0,
			LABEL_PANEL_WIDTH,
			1_000_000,
			0x000000,
			0.55,
		);
		this.floorLabelBg.setOrigin(0, 0.5);
		this.floorLabelBg.setScrollFactor(0, 0);
		this.floorLabelBg.setDepth(10);

		for (let i = 0; i < GRID_HEIGHT; i++) {
			const uiLabel = GRID_HEIGHT - 1 - i - UNDERGROUND_FLOORS;
			const isUnderground = i >= UNDERGROUND_Y;
			const textureKey = this.getFloorLabelTextureKey(uiLabel, isUnderground);
			const label = this.add.image(
				0,
				i * TILE_HEIGHT + TILE_HEIGHT / 2,
				textureKey,
			);
			this.applyNumberTexture(label, textureKey);
			label.setScrollFactor(0, 1);
			label.setDepth(11);
			label.setOrigin(0.5, 0.5);
			this.floorLabels.push(label);
		}
	}

	private updateFloorLabels(): void {
		const cam = this.cameras.main;
		const zoom = cam.zoom;
		if (
			this.lastFloorLabelZoom === zoom &&
			this.lastFloorLabelWidth === this.scale.width
		) {
			return;
		}
		// Camera pivots zoom around the screen center, so with scrollFactor(0):
		//   screenX = halfW + zoom * (worldX - halfW)
		// Inverse: worldX = halfW + (screenX - halfW) / zoom
		const halfW = this.scale.width / 2;

		// bg.width is in world units; rendered screen width = LABEL_PANEL_WIDTH * zoom (expands when zoomed in)
		this.floorLabelBg.x = halfW * (1 - 1 / zoom);
		this.floorLabelBg.width = LABEL_PANEL_WIDTH;

		// label center in screen space = LABEL_PANEL_WIDTH * zoom / 2
		const labelX = halfW * (1 - 1 / zoom) + LABEL_PANEL_WIDTH / 2;
		for (let i = 0; i < GRID_HEIGHT; i++) {
			const label = this.floorLabels[i];
			if (!label) continue;
			label.setX(labelX);
		}
		this.lastFloorLabelZoom = zoom;
		this.lastFloorLabelWidth = this.scale.width;
	}

	private getNumberTextureKey(prefix: string, value: number): string {
		const valueToken = value < 0 ? `neg${Math.abs(value)}` : String(value);
		return `${prefix}_${valueToken}`;
	}

	private ensureNumberTexture(
		prefix: string,
		value: number,
		style: NumberTextureStyle,
	): string {
		const key = this.getNumberTextureKey(prefix, value);
		if (this.textures.exists(key)) return key;

		const dpr = NUMBER_TEXTURE_RESOLUTION;
		const fontStyle = style.fontStyle ?? "bold";
		const fontFamily = style.fontFamily ?? "Arial, sans-serif";
		const paddingX = style.paddingX ?? 2;
		const paddingY = style.paddingY ?? 1;
		const cssFont = `${fontStyle} ${style.fontSizePx}px ${fontFamily}`;
		const measureCanvas = document.createElement("canvas");
		const measureCtx = measureCanvas.getContext("2d");
		if (!measureCtx) {
			throw new Error("2D canvas is unavailable for number texture creation");
		}
		measureCtx.font = cssFont;
		const metrics = measureCtx.measureText(String(value));
		const width = Math.max(1, Math.ceil(metrics.width + paddingX * 2) * dpr);
		const height = Math.max(
			1,
			Math.ceil(style.fontSizePx + paddingY * 2) * dpr,
		);
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) {
			throw new Error("2D canvas is unavailable for number texture creation");
		}
		ctx.scale(dpr, dpr);
		ctx.font = cssFont;
		ctx.fillStyle = style.color;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		ctx.fillText(String(value), width / dpr / 2, height / dpr / 2);
		this.textures.addCanvas(key, canvas);
		return key;
	}

	private applyNumberTexture(
		image: GameObjects.Image,
		textureKey: string,
	): void {
		image.setTexture(textureKey);
		const frame = this.textures.getFrame(textureKey);
		if (!frame) return;
		image.setDisplaySize(
			frame.width / NUMBER_TEXTURE_RESOLUTION,
			frame.height / NUMBER_TEXTURE_RESOLUTION,
		);
	}

	private primeNumberTextures(
		prefix: string,
		start: number,
		end: number,
		style: NumberTextureStyle,
	): void {
		for (let value = start; value <= end; value += 1) {
			this.ensureNumberTexture(prefix, value, style);
		}
	}

	private getFloorLabelTextureKey(
		value: number,
		isUnderground: boolean,
	): string {
		return this.ensureNumberTexture(
			isUnderground ? "floor_label_underground" : "floor_label_surface",
			value,
			{
				fontSizePx: 11,
				fontStyle: "bold",
				fontFamily: "Arial, sans-serif",
				color: isUnderground ? "#886644" : "#5588aa",
				paddingX: 2,
				paddingY: 1,
			},
		);
	}

	private getEvalLabelTextureKey(value: number): string {
		return this.ensureNumberTexture("eval_label", value, {
			fontSizePx: Math.round(TILE_HEIGHT * 0.55 * 0.75),
			fontStyle: "bold",
			fontFamily: "Arial, sans-serif",
			color: "#ffffff",
			paddingX: 2,
			paddingY: 1,
		});
	}

	private getCarLabelTextureKey(value: number): string {
		return this.ensureNumberTexture("car_label", value, {
			fontSizePx: 8,
			fontStyle: "bold",
			fontFamily: "Arial, sans-serif",
			color: "#3b2d00",
			paddingX: 2,
			paddingY: 1,
		});
	}

	private setupNumberTextures(): void {
		this.primeNumberTextures(
			"floor_label_surface",
			FLOOR_LABEL_RANGE[0],
			FLOOR_LABEL_RANGE[1],
			{
				fontSizePx: 11,
				fontStyle: "bold",
				fontFamily: "Arial, sans-serif",
				color: "#5588aa",
				paddingX: 2,
				paddingY: 1,
			},
		);
		this.primeNumberTextures(
			"floor_label_underground",
			FLOOR_LABEL_RANGE[0],
			FLOOR_LABEL_RANGE[1],
			{
				fontSizePx: 11,
				fontStyle: "bold",
				fontFamily: "Arial, sans-serif",
				color: "#886644",
				paddingX: 2,
				paddingY: 1,
			},
		);
		this.primeNumberTextures(
			"eval_label",
			EVAL_LABEL_RANGE[0],
			EVAL_LABEL_RANGE[1],
			{
				fontSizePx: Math.round(TILE_HEIGHT * 0.55 * 0.75),
				fontStyle: "bold",
				fontFamily: "Arial, sans-serif",
				color: "#ffffff",
				paddingX: 2,
				paddingY: 1,
			},
		);
		this.primeNumberTextures(
			"car_label",
			CAR_LABEL_RANGE[0],
			CAR_LABEL_RANGE[1],
			{
				fontSizePx: 8,
				fontStyle: "bold",
				fontFamily: "Arial, sans-serif",
				color: "#3b2d00",
				paddingX: 2,
				paddingY: 1,
			},
		);
	}

	private drawSky(): void {
		const skyW = GRID_WIDTH * TILE_WIDTH;
		const skyH = UNDERGROUND_Y * TILE_HEIGHT;

		const buildGradientTexture = (
			key: string,
			stops: [number, string][],
		): void => {
			const canvas = document.createElement("canvas");
			canvas.width = 1;
			canvas.height = skyH;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			const grad = ctx.createLinearGradient(0, 0, 0, skyH);
			for (const [pos, color] of stops) grad.addColorStop(pos, color);
			ctx.fillStyle = grad;
			ctx.fillRect(0, 0, 1, skyH);
			if (this.textures.exists(key)) this.textures.remove(key);
			this.textures.addCanvas(key, canvas);
		};

		buildGradientTexture("skyGradient", [
			[0, "#1a3a6e"],
			[0.6, "#5ba8d4"],
			[1, "#b4ddf0"],
		]);
		const sky = this.add.image(0, 0, "skyGradient");
		sky.setOrigin(0, 0);
		sky.setDisplaySize(skyW, skyH);
		sky.setDepth(0);

		buildGradientTexture("skyGradientNight", [
			[0, "#04091a"],
			[0.5, "#0a1235"],
			[1, "#0e1f4a"],
		]);
		this.skyNight = this.add.image(0, 0, "skyGradientNight");
		this.skyNight.setOrigin(0, 0);
		this.skyNight.setDisplaySize(skyW, skyH);
		this.skyNight.setDepth(0.5);
		this.skyNight.setAlpha(0);
	}

	// Returns the fractional hour (7–31, where 7=7AM, 31=7AM next day) for a dayTick.
	private static dayTickToHour(dayTick: number): number {
		const dp = Math.floor(dayTick / 400);
		const off = dayTick - dp * 400;
		switch (dp) {
			case 0:
				return 7 + (off / 400) * 5;
			case 1:
				return 12 + (off / 400) * 0.5;
			case 2:
				return 12.5 + (off / 400) * 0.5;
			case 3:
				return 13 + (off / 400) * 4;
			case 4:
				return 17 + (off / 400) * 4;
			case 5:
				return 21 + (off / 400) * 4;
			case 6:
				return 25 + (off / 200) * 6;
			default:
				return 7;
		}
	}

	private nightAlpha(): number {
		const presentationTime = getPresentationTime(this.presentationClock);
		const dayTick =
			((Math.floor(presentationTime) % DAY_TICK_MAX) + DAY_TICK_MAX) %
			DAY_TICK_MAX;
		const hour = GameScene.dayTickToHour(dayTick);
		// 8PM–9PM: fade in (hour 20–21)
		if (hour < 20) return 0;
		if (hour < 21) return hour - 20;
		// 9PM–4AM: full night (hour 21–28)
		if (hour < 28) return 1;
		// 4AM–6AM: fade out (hour 28–30)
		if (hour < 30) return 1 - (hour - 28) / 2;
		return 0;
	}

	private loadUndergroundTexture(): void {
		if (this.textures.exists(GameScene.UNDERGROUND_TEXTURE_KEY)) return;
		this.load.image(GameScene.UNDERGROUND_TEXTURE_KEY, "/underground2.webp");
		this.load.once("complete", () => {
			this.drawUndergroundBackground();
			this.drawAllCells();
		});
		this.load.start();
	}

	private drawUndergroundBackground(): void {
		const backgroundWidth = GRID_WIDTH * TILE_WIDTH;
		const backgroundHeight = (GRID_HEIGHT - UNDERGROUND_Y) * TILE_HEIGHT;
		const backgroundY = UNDERGROUND_Y * TILE_HEIGHT;

		if (!this.textures.exists(GameScene.UNDERGROUND_TEXTURE_KEY)) {
			this.undergroundBackground?.destroy();
			this.undergroundBackground = null;
			return;
		}

		const frame = this.textures.getFrame(GameScene.UNDERGROUND_TEXTURE_KEY);
		if (!frame) return;
		const tileScale = backgroundHeight / frame.height;
		const tileWidth = (frame.width / frame.height) * backgroundHeight;
		const tileScaleX = tileWidth / frame.width;

		if (!this.undergroundBackground) {
			this.undergroundBackground = this.add.tileSprite(
				0,
				backgroundY,
				backgroundWidth,
				backgroundHeight,
				GameScene.UNDERGROUND_TEXTURE_KEY,
			);
			this.undergroundBackground.setOrigin(0, 0);
			this.undergroundBackground.setDepth(1);
		} else {
			this.undergroundBackground.setPosition(0, backgroundY);
			this.undergroundBackground.setSize(backgroundWidth, backgroundHeight);
		}
		this.undergroundBackground.setTileScale(tileScaleX, tileScale);
	}

	/** Tile types that use the for-sale banner instead of for-rent. */
	private static readonly FOR_SALE_TYPES = new Set(["condo"]);

	private getRoomVariantIndex(tileType: string, x: number, y: number): number {
		const config = ROOM_TEXTURES[tileType];
		if (!config || config.files.length <= 1) return 0;
		const normalizedY = tileType === "recyclingCenterLower" ? y - 1 : y;
		let h = (x * 374761393 + normalizedY * 668265263) | 0;
		h = ((h ^ (h >>> 13)) * 1274126177) | 0;
		h = (h ^ (h >>> 16)) >>> 0;
		return h % config.files.length;
	}

	private getRoomTextureKey(
		tileType: string,
		x: number,
		y: number,
		dirty = false,
	): string | null {
		const config = ROOM_TEXTURES[tileType];
		if (!config) return null;
		if (tileType === "parking") {
			const coverage = this.coverageFlagMap.get(`${x},${y}`) ?? 0;
			if (coverage === 0) return "room_parking_noAccess";
		}
		const idx = this.getRoomVariantIndex(tileType, x, y);
		if (dirty && config.dirtyFiles && idx < config.dirtyFiles.length) {
			return `room_${tileType}_dirty_${idx}`;
		}
		return `room_${tileType}_${idx}`;
	}

	private isHotelTurnoverStatus(status: number | undefined): boolean {
		return status !== undefined && status >= HOTEL_TURNOVER_STATUS_MIN;
	}

	private isRecyclingCenterLowerCovered(x: number, y: number): boolean {
		return this.grid.get(`${x},${y - 1}`) === "recyclingCenterUpper";
	}

	private hasRoomArt(tileType: string, x: number, y: number): boolean {
		if (
			tileType === "recyclingCenterLower" &&
			this.isRecyclingCenterLowerCovered(x, y)
		) {
			const upperKey = this.getRoomTextureKey("recyclingCenterUpper", x, y - 1);
			return upperKey !== null && this.textures.exists(upperKey);
		}

		const textureKey = this.getRoomTextureKey(tileType, x, y);
		return textureKey !== null && this.textures.exists(textureKey);
	}

	private getOverlaySprite(textureKey: string): GameObjects.Image {
		let sprite = this.overlaySprites[this.usedOverlaySpriteCount];
		if (!sprite) {
			sprite = this.add.image(0, 0, textureKey);
			this.overlaySprites.push(sprite);
		} else if (sprite.texture.key !== textureKey) {
			sprite.setTexture(textureKey);
		}
		sprite.setVisible(true);
		this.usedOverlaySpriteCount += 1;
		return sprite;
	}

	private hideUnusedOverlaySprites(): void {
		for (
			let i = this.usedOverlaySpriteCount;
			i < this.overlaySprites.length;
			i += 1
		) {
			this.overlaySprites[i]?.setVisible(false);
		}
	}

	private getStaticRowTextureKey(y: number, chunkIndex: number): string {
		return `static_row_${this.towerId}_${y}_${chunkIndex}`;
	}

	private getStaticRowChunkWidth(): number {
		const renderer = this.renderer as Renderer.WebGL.WebGLRenderer;
		const gl = renderer.gl;
		const maxTextureSize =
			gl && typeof gl.getParameter === "function"
				? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE))
				: 4096;
		const cellsPerChunk = Math.max(
			1,
			Math.floor(maxTextureSize / (STATIC_ROW_TEXTURE_SCALE * TILE_WIDTH)),
		);
		return cellsPerChunk * TILE_WIDTH;
	}

	private setupStaticRowBitmaps(): void {
		if (this.staticRowChunks.length > 0) return;

		const rowWidth = GRID_WIDTH * TILE_WIDTH;
		const chunkWidth = this.getStaticRowChunkWidth();
		for (let y = 0; y < GRID_HEIGHT; y += 1) {
			const chunks: StaticRowChunk[] = [];
			for (
				let chunkX = 0, chunkIndex = 0;
				chunkX < rowWidth;
				chunkX += chunkWidth, chunkIndex += 1
			) {
				const width = Math.min(chunkWidth, rowWidth - chunkX);
				const textureKey = this.getStaticRowTextureKey(y, chunkIndex);
				if (this.textures.exists(textureKey)) {
					this.textures.remove(textureKey);
				}
				const canvas = document.createElement("canvas");
				canvas.width = width * STATIC_ROW_TEXTURE_SCALE;
				canvas.height = TILE_HEIGHT * STATIC_ROW_TEXTURE_SCALE;
				const texture = this.textures.addCanvas(textureKey, canvas);
				if (!texture) {
					throw new Error(`Failed to create static row texture: ${textureKey}`);
				}
				texture.setFilter(Textures.FilterMode.NEAREST);

				const image = this.add.image(chunkX, y * TILE_HEIGHT, textureKey);
				image.setOrigin(0, 0);
				image.setDisplaySize(width, TILE_HEIGHT);
				image.setDepth(STATIC_ROW_DEPTH);
				image.texture.setFilter(Textures.FilterMode.NEAREST);
				chunks.push({ x: chunkX, width, texture, image });
			}
			this.staticRowChunks.push(chunks);
		}
	}

	private drawTextureToRow(
		ctx: CanvasRenderingContext2D,
		textureKey: string,
		x: number,
		y: number,
		width: number,
		height: number,
	): void {
		if (!this.textures.exists(textureKey)) return;
		const source = this.textures.get(textureKey).getSourceImage();
		ctx.drawImage(source as CanvasImageSource, x, y, width, height);
	}

	private drawRepeatedTextureToRow(
		ctx: CanvasRenderingContext2D,
		textureKey: string,
		x: number,
		y: number,
		width: number,
		height: number,
		repeatWidth: number,
	): void {
		if (!this.textures.exists(textureKey)) return;
		const source = this.textures.get(textureKey).getSourceImage();
		const sourceScale = source.width / repeatWidth;
		for (let drawX = 0; drawX < width; drawX += repeatWidth) {
			const segmentWidth = Math.min(repeatWidth, width - drawX);
			ctx.drawImage(
				source as CanvasImageSource,
				0,
				0,
				segmentWidth * sourceScale,
				source.height,
				x + drawX,
				y,
				segmentWidth,
				height,
			);
		}
	}

	private drawRoundedRectToRow(
		ctx: CanvasRenderingContext2D,
		x: number,
		y: number,
		width: number,
		height: number,
		radius: number,
		fillStyle: string,
	): void {
		const r = Math.min(radius, width / 2, height / 2);
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + width, y, x + width, y + height, r);
		ctx.arcTo(x + width, y + height, x, y + height, r);
		ctx.arcTo(x, y + height, x, y, r);
		ctx.arcTo(x, y, x + width, y, r);
		ctx.closePath();
		ctx.fillStyle = fillStyle;
		ctx.fill();
	}

	private redrawStaticRows(rows: Iterable<number>): void {
		for (const row of rows) {
			if (row < 0 || row >= GRID_HEIGHT) continue;
			this.redrawStaticRow(row);
		}
	}

	private redrawStaticRow(row: number): void {
		const chunks = this.staticRowChunks[row];
		if (!chunks) return;
		for (const chunk of chunks) {
			const ctx = chunk.texture.context;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(
				0,
				0,
				chunk.width * STATIC_ROW_TEXTURE_SCALE,
				TILE_HEIGHT * STATIC_ROW_TEXTURE_SCALE,
			);
			ctx.setTransform(
				STATIC_ROW_TEXTURE_SCALE,
				0,
				0,
				STATIC_ROW_TEXTURE_SCALE,
				-chunk.x * STATIC_ROW_TEXTURE_SCALE,
				0,
			);
			ctx.imageSmoothingEnabled = false;
			this.drawStaticRowContent(ctx, row);
			chunk.texture.refresh();
		}
	}

	private drawStaticRowContent(
		ctx: CanvasRenderingContext2D,
		row: number,
	): void {
		const rowTop = row * TILE_HEIGHT;
		const rowWidth = GRID_WIDTH * TILE_WIDTH;
		if (!this.undergroundBackground && row >= UNDERGROUND_Y) {
			ctx.fillStyle = "#3d2010";
			ctx.fillRect(0, 0, rowWidth, TILE_HEIGHT);
		}

		const candidateAnchorRows = new Set<number>([row, row - 1]);
		for (const candidateRow of candidateAnchorRows) {
			if (candidateRow < 0 || candidateRow >= GRID_HEIGHT) continue;
			for (const key of this.anchorKeysByRow[candidateRow] ?? []) {
				const tileType = this.grid.get(key);
				if (!tileType || GameScene.MERGE_TYPES.has(tileType)) continue;

				const separator = key.indexOf(",");
				const x = Number(key.slice(0, separator));
				const y = Number(key.slice(separator + 1));
				const widthTiles = TILE_WIDTHS[tileType] ?? 1;
				const heightTiles = ROOM_TEXTURES[tileType]?.heightTiles ?? 1;
				if (row < y || row >= y + heightTiles) continue;

				if (
					tileType === "recyclingCenterLower" &&
					this.roomTexturesLoaded &&
					this.hasRoomArt(tileType, x, y)
				) {
					continue;
				}

				const isHotelTile = HOTEL_TILE_TYPES.has(tileType);
				const isDirty =
					isHotelTile &&
					this.isHotelTurnoverStatus(this.unitStatusMap.get(key));
				const texKey = this.getRoomTextureKey(tileType, x, y, isDirty);
				const hasRoomTexture =
					this.roomTexturesLoaded &&
					texKey !== null &&
					this.textures.exists(texKey);
				const drawX = x * TILE_WIDTH;
				const drawY = y * TILE_HEIGHT - rowTop;
				const drawW = widthTiles * TILE_WIDTH - STATIC_TILE_GAP_X;
				const drawH = heightTiles * TILE_HEIGHT - STATIC_TILE_GAP_Y;

				const isStuck = this.isStuckUnit(
					tileType,
					this.unitStatusMap.get(key) ?? 0,
					key,
				);
				if (hasRoomTexture && texKey !== null) {
					if (isStuck) ctx.filter = "grayscale(100%) brightness(0.85)";
					this.drawTextureToRow(ctx, texKey, drawX, drawY, drawW, drawH);
					if (isStuck) ctx.filter = "none";
				} else {
					const color = TILE_COLORS[tileType];
					if (color !== undefined && row === y) {
						ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
						ctx.fillRect(drawX, 0, drawW, TILE_HEIGHT - STATIC_TILE_GAP_Y);
					}
				}

				const evalLevel = this.evalLevelMap.get(key);
				const displayEvalLevel = this.displayEvalLevel(tileType, key);
				if (row === y) {
					const labelText = TILE_LABELS[tileType];
					if (labelText && !hasRoomTexture) {
						ctx.fillStyle = TILE_LABEL_COLORS[tileType] ?? "#ffffff";
						ctx.font = `bold 11px Arial, sans-serif`;
						ctx.textAlign = "center";
						ctx.textBaseline = "middle";
						ctx.fillText(
							labelText,
							(x + widthTiles / 2) * TILE_WIDTH,
							TILE_HEIGHT / 2,
						);
					}

					const evalFlag = this.evalActiveFlagMap.get(key);
					const unitStatus = this.unitStatusMap.get(key);
					let showInactiveBanner: boolean;
					if (tileType === "office") {
						showInactiveBanner = (unitStatus ?? 0) > 0x0f;
					} else if (isHotelTile) {
						showInactiveBanner = false;
					} else if (tileType === "condo") {
						showInactiveBanner = (unitStatus ?? 0) > 0x17;
					} else {
						showInactiveBanner = evalFlag === 0;
					}
					if (this.roomTexturesLoaded && showInactiveBanner) {
						const bannerKey = GameScene.FOR_SALE_TYPES.has(tileType)
							? "for_sale"
							: "for_rent";
						if (this.textures.exists(bannerKey)) {
							const tileW = widthTiles * TILE_WIDTH - STATIC_TILE_GAP_X;
							const tileH = TILE_HEIGHT - STATIC_TILE_GAP_Y;
							const bannerAspect = 9 / 4;
							const tileAspect = tileW / tileH;
							let bw: number;
							let bh: number;
							if (tileAspect > bannerAspect) {
								bh = tileH;
								bw = tileH * bannerAspect;
							} else {
								bw = tileW;
								bh = tileW / bannerAspect;
							}
							this.drawTextureToRow(
								ctx,
								bannerKey,
								x * TILE_WIDTH + (tileW - bw) / 2,
								(tileH - bh) / 2,
								bw,
								bh,
							);
						}
					}

					const evalScore = this.evalScoreMap.get(key);
					if (
						import.meta.env.DEV &&
						this.stressBadgesEnabled &&
						evalScore !== undefined &&
						evalScore >= 0
					) {
						const badgeColor =
							evalLevel === 2
								? "#4488ff"
								: evalLevel === 1
									? "#ddcc00"
									: evalLevel === 0
										? "#dd3333"
										: "#888888";
						const pillH = TILE_HEIGHT * 0.55;
						const pillW = Math.max(
							pillH * 1.4,
							pillH * 0.8 * String(evalScore).length,
						);
						const pillR = pillH / 2;
						const px = x * TILE_WIDTH + 2;
						const py = (TILE_HEIGHT - pillH) / 2;
						this.drawRoundedRectToRow(
							ctx,
							px,
							py,
							pillW,
							pillH,
							pillR,
							badgeColor,
						);
						const evalTextureKey = this.getEvalLabelTextureKey(evalScore);
						const evalFrame = this.textures.getFrame(evalTextureKey);
						if (evalFrame) {
							const evalWidth = evalFrame.width / NUMBER_TEXTURE_RESOLUTION;
							const evalHeight = evalFrame.height / NUMBER_TEXTURE_RESOLUTION;
							this.drawTextureToRow(
								ctx,
								evalTextureKey,
								px + (pillW - evalWidth) / 2,
								py + (pillH - evalHeight) / 2,
								evalWidth,
								evalHeight,
							);
						}
					}
				}

				if (this.paused && displayEvalLevel !== undefined) {
					const overlayColor = EVAL_LEVEL_OVERLAY_COLORS[displayEvalLevel];
					if (overlayColor !== undefined) {
						ctx.fillStyle = overlayColor;
						ctx.fillRect(drawX, drawY, drawW, drawH);
					}
				}
			}
		}

		let runStart = -1;
		let runType: string | null = null;
		for (let x = 0; x <= GRID_WIDTH; x += 1) {
			const cellType =
				x < GRID_WIDTH ? (this.grid.get(`${x},${row}`) ?? null) : null;
			const isMerge = cellType !== null && GameScene.MERGE_TYPES.has(cellType);
			if (isMerge && cellType === runType) {
				continue;
			}
			if (runStart !== -1 && runType !== null) {
				const runPxX = runStart * TILE_WIDTH;
				const runPxW = (x - runStart) * TILE_WIDTH - STATIC_TILE_GAP_X;
				const runPxH = TILE_HEIGHT - STATIC_TILE_GAP_Y;
				if (
					this.roomTexturesLoaded &&
					runType === "lobby" &&
					this.textures.exists("room_lobby")
				) {
					this.drawRepeatedTextureToRow(
						ctx,
						"room_lobby",
						runPxX,
						0,
						runPxW,
						runPxH,
						2 * TILE_HEIGHT - STATIC_TILE_GAP_X,
					);
				} else {
					const color = TILE_COLORS[runType];
					if (color !== undefined) {
						ctx.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
						ctx.fillRect(runPxX, 0, runPxW, runPxH);
					}
				}
			}
			runStart = isMerge ? x : -1;
			runType = isMerge ? cellType : null;
		}
	}

	private drawStaticOverlays(): void {
		const g = this.cellGraphics;
		g.clear();
		g.setDepth(STATIC_OVERLAY_DEPTH);
		this.usedOverlaySpriteCount = 0;

		const shaftRows = new Map<string, number[]>();
		for (const [key, type] of this.overlayGrid) {
			const separator = key.indexOf(",");
			const x = Number(key.slice(0, separator));
			const y = Number(key.slice(separator + 1));
			if (type === "stairs" || type === "escalator") {
				this.drawBridgeOverlay(g, type, x, y);
			} else {
				const shaftKey = `${type}:${x}`;
				const rows = shaftRows.get(shaftKey);
				if (rows) {
					rows.push(y);
				} else {
					shaftRows.set(shaftKey, [y]);
				}
			}
		}

		for (const [shaftKey, rows] of shaftRows) {
			const [type, xText] = shaftKey.split(":");
			const x = Number(xText);
			const width = TILE_WIDTHS[type] ?? 1;
			g.lineStyle(2, 0x222222, 1.0);
			const sortedRows = rows.slice().sort((a, b) => a - b);
			let runStart = sortedRows[0];
			let previousRow = sortedRows[0];
			for (let i = 1; i < sortedRows.length; i += 1) {
				const row = sortedRows[i];
				if (row === previousRow + 1) {
					previousRow = row;
					continue;
				}
				g.strokeRect(
					x * TILE_WIDTH,
					runStart * TILE_HEIGHT,
					width * TILE_WIDTH - STATIC_TILE_GAP_X,
					(previousRow - runStart + 1) * TILE_HEIGHT - STATIC_TILE_GAP_Y,
				);
				runStart = row;
				previousRow = row;
			}
			g.strokeRect(
				x * TILE_WIDTH,
				runStart * TILE_HEIGHT,
				width * TILE_WIDTH - STATIC_TILE_GAP_X,
				(previousRow - runStart + 1) * TILE_HEIGHT - STATIC_TILE_GAP_Y,
			);
		}
		this.hideUnusedOverlaySprites();
	}

	/** Draw a stairs or escalator overlay bridging the floor at (gx,gy) and
	 *  the floor above (gy-1). Rendered outside row caches so bridge edges
	 *  are not clipped or blurred by per-row bitmap boundaries. */
	private drawBridgeOverlay(
		g: GameObjects.Graphics,
		type: "stairs" | "escalator",
		gx: number,
		gy: number,
	): void {
		const width = TILE_WIDTHS[type] ?? 1;
		const cellW = TILE_WIDTH * width;
		const startX = gx * TILE_WIDTH;
		const bottomY = (gy + 1) * TILE_HEIGHT;
		const topY = gy * TILE_HEIGHT - TILE_HEIGHT / 3;
		const heightPx = bottomY - topY;

		const texKey = `room_${type}`;
		if (this.roomTexturesLoaded && this.textures.exists(texKey)) {
			const source = this.textures.get(texKey).getSourceImage();
			const textureKey = `overlay_${type}_${gx}_${gy}`;
			if (!this.textures.exists(textureKey)) {
				const canvas = document.createElement("canvas");
				canvas.width = Math.max(1, Math.ceil(cellW * STATIC_ROW_TEXTURE_SCALE));
				canvas.height = Math.max(
					1,
					Math.ceil(heightPx * STATIC_ROW_TEXTURE_SCALE),
				);
				const ctx = canvas.getContext("2d");
				if (ctx) {
					ctx.scale(STATIC_ROW_TEXTURE_SCALE, STATIC_ROW_TEXTURE_SCALE);
					ctx.drawImage(source as CanvasImageSource, 0, 0, cellW, heightPx);
					this.textures.addCanvas(textureKey, canvas);
				}
			}
			if (this.textures.exists(textureKey)) {
				const sprite = this.getOverlaySprite(textureKey);
				sprite.setPosition(startX, topY);
				sprite.setOrigin(0, 0);
				sprite.setDisplaySize(cellW, heightPx);
				sprite.setDepth(STATIC_OVERLAY_DEPTH);
			}
			return;
		}

		const edgeW = cellW / 6;
		g.fillStyle(0xffffff, 1);
		g.beginPath();
		g.moveTo(startX, bottomY);
		g.lineTo(startX + edgeW, bottomY);
		g.lineTo(startX + cellW, topY);
		g.lineTo(startX + cellW - edgeW, topY);
		g.closePath();
		g.fillPath();
	}

	private drawAllCells(): void {
		this.redrawStaticRows(Array.from({ length: GRID_HEIGHT }, (_, y) => y));
		this.drawStaticOverlays();
		this.drawDynamicOverlays();
	}

	private drawDynamicOverlays(): void {
		this.drawSims();
		this.drawCars();
	}

	private drawSimsIfNeeded(): void {
		const worldView = this.cameras.main.worldView;
		if (
			this.simsDirty ||
			this.lastSimWorldView.x !== worldView.x ||
			this.lastSimWorldView.y !== worldView.y ||
			this.lastSimWorldView.width !== worldView.width ||
			this.lastSimWorldView.height !== worldView.height
		) {
			this.drawSims();
		}
	}

	private drawSims(): void {
		const g = this.simGraphics;
		g.clear();
		this.queuedSimHitboxes = [];
		const worldView = this.cameras.main.worldView;
		const visibleLeft = worldView.x - TILE_WIDTH;
		const visibleRight = worldView.right + TILE_WIDTH;
		const visibleTop = worldView.y - TILE_HEIGHT;
		const visibleBottom = worldView.bottom + TILE_HEIGHT;
		const elevatorColumnsByFloor = collectElevatorColumnsByFloor(
			this.overlayGrid,
		);
		const liveCarriers = this.snapshotSource?.readLiveCarriers() ?? [];
		const carrierColumnsById = new Map<number, number>();
		for (const carrier of liveCarriers) {
			carrierColumnsById.set(carrier.carrierId, carrier.column);
		}
		const sims = this.snapshotSource?.readSims() ?? [];
		const pending = this.snapshotSource?.readPendingBySimId() ?? EMPTY_PENDING;
		const hasTexture =
			this.roomTexturesLoaded && this.textures.exists("sim_figure_low-0");
		// Aspect matches the SVG viewBox (6×20) so the figure isn't stretched.
		const simWidthPx = 0.75 * TILE_WIDTH;
		const simHeightPx = simWidthPx * (20 / 6);

		type QueuedSimLayoutEntry = {
			simRecord: SimRecord;
			id: string;
			stressLevel: "low" | "medium" | "high";
			px: number;
			py: number;
			textureKey: string;
		};

		type QueuedEntry = { simRecord: SimRecord; id: string };

		// Group queued sims by queueKey, sorted by id for stable layout (so the
		// cache hash only changes when queue membership or variants actually change,
		// not when the snapshot happens to reorder).
		const byQueueKey = new Map<string, QueuedEntry[]>();
		for (const simRecord of sims) {
			const id = simKey(simRecord);
			if (!isQueuedSimLive(simRecord, pending, id)) continue;
			const key = getQueuedSimQueueKey(
				simRecord,
				elevatorColumnsByFloor,
				carrierColumnsById,
			);
			const arr = byQueueKey.get(key);
			if (arr) arr.push({ simRecord, id });
			else byQueueKey.set(key, [{ simRecord, id }]);
		}

		const queues = new Map<
			string,
			{ ascending: boolean; sims: QueuedSimLayoutEntry[] }
		>();
		for (const [queueKey, entries] of byQueueKey) {
			entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
			const ascending = isSimAscending((entries[0] as QueuedEntry).simRecord);
			const list: QueuedSimLayoutEntry[] = [];
			for (let queueIndex = 0; queueIndex < entries.length; queueIndex += 1) {
				const { simRecord, id } = entries[queueIndex] as QueuedEntry;
				const simState = this.snapshotSource?.materializeSim(simRecord);
				if (!simState) continue;
				const { gridX, gridY } = getQueuedSimLayout(
					simRecord,
					elevatorColumnsByFloor,
					queueIndex,
					carrierColumnsById,
				);
				const px = gridX * TILE_WIDTH;
				const py = (gridY + 0.5) * TILE_HEIGHT - STATIC_TILE_GAP_Y;
				const stressLevel = simState.currentTripStressLevel;
				const textureKey =
					stressLevel === "low"
						? `sim_figure_low-${hashSimVariant(id, 4)}`
						: `sim_figure_${stressLevel}`;
				list.push({ simRecord, id, stressLevel, px, py, textureKey });
				this.queuedSimHitboxes.push({
					left: px - simWidthPx / 2,
					right: px + simWidthPx / 2,
					top: py - simHeightPx,
					bottom: py,
					simRecord,
				});
			}
			queues.set(queueKey, { ascending, sims: list });
		}

		if (!hasTexture) {
			// Pre-load fallback: rectangles via the graphics object, no caching.
			for (const { sims } of queues.values()) {
				for (const { stressLevel, px, py } of sims) {
					const left = px - simWidthPx / 2;
					const top = py - simHeightPx;
					if (
						left + simWidthPx < visibleLeft ||
						left > visibleRight ||
						py < visibleTop ||
						top > visibleBottom
					) {
						continue;
					}
					const color = ENTITY_STRESS_COLORS[stressLevel] ?? 0x111111;
					g.fillStyle(color, 1);
					g.fillRect(left, top, simWidthPx, simHeightPx);
				}
			}
			for (const entry of this.simQueueCache.values()) {
				this.destroyQueueCacheEntry(entry);
			}
			this.simQueueCache.clear();
			this.lastSimWorldView.setTo(
				worldView.x,
				worldView.y,
				worldView.width,
				worldView.height,
			);
			this.simsDirty = false;
			return;
		}

		for (const entry of this.simQueueCache.values()) {
			entry.seen = false;
		}

		const scale = SIM_QUEUE_TEXTURE_SCALE;

		// Fixed bbox sized for the max possible queue so membership changes don't
		// resize the RT. Anchored to the queueIndex=0 sim's position, which depends
		// only on the queueKey's elevator column (stable across frames).
		const fullSpanPx =
			(SIM_QUEUE_MAX_SIZE - 1) * SIM_QUEUE_SPACING_CELLS * TILE_WIDTH;

		for (const [queueKey, { ascending, sims }] of queues) {
			if (sims.length === 0) continue;

			const firstPx = (sims[0] as QueuedSimLayoutEntry).px;
			const firstPy = (sims[0] as QueuedSimLayoutEntry).py;
			const leftmost = ascending
				? firstPx - fullSpanPx - simWidthPx / 2
				: firstPx - simWidthPx / 2;
			const rightmost = ascending
				? firstPx + simWidthPx / 2
				: firstPx + fullSpanPx + simWidthPx / 2;
			const bboxX = Math.floor(leftmost);
			const bboxY = Math.floor(firstPy - simHeightPx);
			const bboxW = Math.max(1, Math.ceil(rightmost - bboxX));
			const bboxH = Math.max(1, Math.ceil(firstPy - bboxY));

			const existing = this.simQueueCache.get(queueKey);
			if (
				bboxX + bboxW < visibleLeft ||
				bboxX > visibleRight ||
				bboxY + bboxH < visibleTop ||
				bboxY > visibleBottom
			) {
				if (existing) {
					existing.renderTexture.setVisible(false);
					existing.seen = true;
				}
				continue;
			}

			const hashParts: string[] = [];
			for (const { id, textureKey } of sims) {
				hashParts.push(`${id}|${textureKey}`);
			}
			const hash = `${ascending ? "u" : "d"}|${bboxW}x${bboxH}@${bboxX},${bboxY}|${hashParts.join(";")}`;

			if (existing && existing.hash === hash) {
				existing.renderTexture.setVisible(true);
				existing.seen = true;
				continue;
			}

			let entry: SimQueueCacheEntry;
			if (!existing) {
				const rt = this.add.renderTexture(
					bboxX,
					bboxY,
					bboxW * scale,
					bboxH * scale,
				);
				rt.setOrigin(0, 0);
				rt.setDisplaySize(bboxW, bboxH);
				rt.setDepth(DYNAMIC_ENTITY_DEPTH);
				entry = {
					hash: "",
					renderTexture: rt,
					worldX: bboxX,
					worldY: bboxY,
					width: bboxW,
					height: bboxH,
					seen: true,
				};
				this.simQueueCache.set(queueKey, entry);
			} else {
				entry = existing;
				if (entry.width !== bboxW || entry.height !== bboxH) {
					entry.renderTexture.resize(bboxW * scale, bboxH * scale);
					entry.renderTexture.setDisplaySize(bboxW, bboxH);
					entry.width = bboxW;
					entry.height = bboxH;
				}
				entry.renderTexture.setPosition(bboxX, bboxY);
				entry.worldX = bboxX;
				entry.worldY = bboxY;
			}

			entry.renderTexture.clear();
			// Sim SVGs are preloaded at exactly the RT's per-sim pixel footprint,
			// so each stamp is 1:1 — flip via a negative x-scale for descenders.
			// stamp() also captures the texture key by value in the command buffer,
			// unlike draw(sprite) which re-reads sprite state at render time and
			// would collapse every sim onto the last-set texture.
			const flippedScaleX = ascending ? 1 : -1;
			for (const { px, py, textureKey } of sims) {
				if (!this.textures.exists(textureKey)) continue;
				const rtX = (px - bboxX) * scale;
				const rtY = (py - bboxY) * scale;
				entry.renderTexture.stamp(textureKey, undefined, rtX, rtY, {
					originX: 0.5,
					originY: 1,
					scaleX: flippedScaleX,
				});
			}
			entry.renderTexture.render();
			entry.hash = hash;
			entry.renderTexture.setVisible(true);
			entry.seen = true;
		}

		for (const [key, entry] of this.simQueueCache) {
			if (!entry.seen) {
				this.destroyQueueCacheEntry(entry);
				this.simQueueCache.delete(key);
			}
		}

		this.lastSimWorldView.setTo(
			worldView.x,
			worldView.y,
			worldView.width,
			worldView.height,
		);
		this.simsDirty = false;
	}

	private destroyQueueCacheEntry(entry: SimQueueCacheEntry): void {
		entry.renderTexture.destroy();
	}

	/**
	 * Translucent red overlay over on-fire cells. Reads the per-floor active
	 * fire fronts (`g_fire_left_pos` / `g_fire_right_pos`, indexed by binary
	 * internal floor 0..119) and paints a rectangle from `fireLeftPos[F]` to
	 * `fireRightPos[F] + 12` on each floor whose front isn't the 0xffff
	 * sentinel. Cleared each frame; overlay vanishes when fire resolves and
	 * the worker drains the front arrays.
	 */
	private drawFireOverlay(): void {
		const g = this.fireGraphics;
		g.clear();
		const fronts = this.snapshotSource?.readFireFronts();
		if (!fronts) return;
		const cam = this.cameras.main;
		const view = cam.worldView;
		// Internal floor F → grid y = (GRID_HEIGHT - 1 - F). y_pixel = y * TILE_HEIGHT.
		g.fillStyle(0xff3010, 0.45);
		for (let f = 0; f < fronts.fireLeftPos.length; f++) {
			const left = fronts.fireLeftPos[f];
			const right = fronts.fireRightPos[f];
			const leftActive = left !== 0xffff;
			const rightActive = right !== 0xffff;
			if (!leftActive && !rightActive) continue;
			// Burning span runs from the left front's tile to (right front + 12)
			// — the right front's deletion offset, matching the binary's
			// `delete_object_covering_floor_tile(floor, right + 12)`.
			const spanLeft = leftActive ? left : right;
			const spanRight = rightActive ? right + 12 : left + 1;
			if (spanRight <= spanLeft) continue;
			const yGrid = GRID_HEIGHT - 1 - f;
			const py = yGrid * TILE_HEIGHT;
			const px = spanLeft * TILE_WIDTH;
			const pw = (spanRight - spanLeft) * TILE_WIDTH;
			// Cull off-screen rows.
			if (py + TILE_HEIGHT < view.y || py > view.bottom) continue;
			if (px + pw < view.x || px > view.right) continue;
			g.fillRect(px, py, pw, TILE_HEIGHT);
		}
	}

	private drawCars(): void {
		const liveCarriers = this.snapshotSource?.readLiveCarriers() ?? [];
		const occupancyByCar = this.occupancyByCar;
		fillOccupancyByCarFromCarriers(liveCarriers, occupancyByCar);

		const current = this.currentCarrierSnapshot;
		if (!current) {
			for (let i = 0; i < this.carRects.length; i += 1) {
				this.carRects[i]?.setVisible(false);
				this.carLabels[i]?.setVisible(false);
			}
			return;
		}

		const interpolate = shouldInterpolateCars(
			current,
			this.previousCarrierSnapshot,
			this.presentationClock,
		);
		const progress = interpolate
			? getSnapshotProgress(this.presentationClock)
			: 0;
		const prevByKey = this.prevCarByKey;
		if (interpolate) {
			fillPrevCarIndex(this.previousCarrierSnapshot, prevByKey);
		} else {
			prevByKey.clear();
		}

		const worldView = this.cameras.main.worldView;
		const visibleLeft = worldView.x - TILE_WIDTH;
		const visibleRight = worldView.right + TILE_WIDTH;
		const visibleTop = worldView.y - TILE_HEIGHT;
		const visibleBottom = worldView.bottom + TILE_HEIGHT;
		const bounds = this.carBoundsScratch;

		let usedCount = 0;
		for (const car of current.items) {
			const floor = interpolate
				? interpolatedFloor(
						car,
						prevByKey.get(packCarKey(car.carrierId, car.carIndex)),
						progress,
					)
				: car.currentFloor;
			fillCarBounds(car, floor, bounds);
			const right = bounds.x + bounds.width;
			const bottom = bounds.y + bounds.height;
			if (
				right < visibleLeft ||
				bounds.x > visibleRight ||
				bottom < visibleTop ||
				bounds.y > visibleBottom
			) {
				continue;
			}
			const occupancy =
				occupancyByCar.get(packCarKey(car.carrierId, car.carIndex)) ?? 0;

			// Each car (rect + label) gets a unique depth slice so cars never
			// interleave with other cars' labels.
			const depth = 3 + usedCount * 0.01;
			this.drawCarOccupancyLabel(
				usedCount,
				bounds.x,
				bounds.y,
				bounds.width,
				bounds.height,
				occupancy,
				depth,
			);
			usedCount += 1;
		}

		for (let i = usedCount; i < this.carRects.length; i += 1) {
			this.carRects[i]?.setVisible(false);
			this.carLabels[i]?.setVisible(false);
		}
	}

	private drawCarOccupancyLabel(
		carIndex: number,
		x: number,
		y: number,
		width: number,
		height: number,
		occupancy: number,
		depth: number,
	): void {
		let rect = this.carRects[carIndex];
		if (!rect) {
			rect = this.add.rectangle(x, y, width, height, CAR_COLOR);
			rect.setOrigin(0, 0);
			rect.setStrokeStyle(1, 0x6b5a1b, 1);
			this.carRects.push(rect);
		}
		rect.setPosition(x, y);
		rect.setSize(width, height);
		rect.setDisplaySize(width, height);
		rect.setDepth(depth);
		rect.setVisible(true);

		let label = this.carLabels[carIndex];
		if (!label) {
			const textureKey = this.getCarLabelTextureKey(0);
			label = this.add.image(0, 0, textureKey);
			this.applyNumberTexture(label, textureKey);
			label.setOrigin(0.5, 0.5);
			this.carLabels.push(label);
		}
		this.applyNumberTexture(label, this.getCarLabelTextureKey(occupancy));
		label.setPosition(x + width / 2, y + height / 2);
		label.setDepth(depth + 0.005);
		label.setVisible(true);
	}

	private updateCockroaches(delta: number): void {
		const cockroachW = TILE_WIDTH * 0.55;
		const cockroachH = cockroachW * (8 / 10);

		const infestedKeys = this.infestedKeysScratch;
		infestedKeys.clear();
		for (const [key, status] of this.unitStatusMap) {
			if (
				status >= HOTEL_INFESTED_STATUS_MIN &&
				HOTEL_TILE_TYPES.has(this.grid.get(key) ?? "")
			) {
				infestedKeys.add(key);
			}
		}

		// In-place filter: keep only cockroaches whose room is still infested.
		let write = 0;
		for (let i = 0; i < this.cockroaches.length; i += 1) {
			const c = this.cockroaches[i];
			if (c && infestedKeys.has(c.roomKey)) {
				if (write !== i) this.cockroaches[write] = c;
				write += 1;
			}
		}
		this.cockroaches.length = write;

		const roomCounts = this.roomCountsScratch;
		roomCounts.clear();
		for (const c of this.cockroaches) {
			roomCounts.set(c.roomKey, (roomCounts.get(c.roomKey) ?? 0) + 1);
		}

		const roomHeightPx = TILE_HEIGHT - STATIC_TILE_GAP_Y;
		const maxOffsetY = Math.max(0, roomHeightPx - cockroachH);

		for (const key of infestedKeys) {
			const count = roomCounts.get(key) ?? 0;
			const tileType = this.grid.get(key);
			const target = COCKROACH_PER_ROOM[tileType ?? ""] ?? 3;
			if (count < target) {
				const roomTileWidth = TILE_WIDTHS[tileType ?? ""] ?? 1;
				const roomWidthPx = roomTileWidth * TILE_WIDTH - STATIC_TILE_GAP_X;
				const maxOffsetX = Math.max(0, roomWidthPx - cockroachW);
				for (let i = count; i < target; i += 1) {
					const angle = Math.random() * 2 * Math.PI;
					const speed = (1.6 + Math.random() * 3.2) / 1000;
					this.cockroaches.push({
						roomKey: key,
						offsetX: Math.random() * maxOffsetX,
						offsetY: Math.random() * maxOffsetY,
						velX: Math.cos(angle) * speed,
						velY: Math.sin(angle) * speed,
						frame: Math.floor(Math.random() * COCKROACH_FRAMES),
						frameTimer: Math.random() * COCKROACH_FRAME_MS,
						dirChangeTimer: 1200 + Math.random() * 2800,
					});
				}
			}
		}

		const worldView = this.cameras.main.worldView;
		const padX = TILE_WIDTH;
		const padY = TILE_HEIGHT;
		const viewLeft = worldView.x - padX;
		const viewRight = worldView.right + padX;
		const viewTop = worldView.y - padY;
		const viewBottom = worldView.bottom + padY;

		let usedCount = 0;

		for (const c of this.cockroaches) {
			const tileType = this.grid.get(c.roomKey);
			const roomTileWidth = TILE_WIDTHS[tileType ?? ""] ?? 1;
			const roomWidthPx = roomTileWidth * TILE_WIDTH - STATIC_TILE_GAP_X;
			const maxOffsetX = Math.max(0, roomWidthPx - cockroachW);

			// Fast-path off-screen cockroaches: their room's world-position
			// bounds are tighter than their per-cockroach bounds, so if the
			// whole room is off-screen we can skip physics and rendering.
			const separator = c.roomKey.indexOf(",");
			const gx = Number(c.roomKey.slice(0, separator));
			const gy = Number(c.roomKey.slice(separator + 1));
			const roomLeft = gx * TILE_WIDTH;
			const roomTop = gy * TILE_HEIGHT;
			const roomRight = roomLeft + roomWidthPx;
			const roomBottom = roomTop + TILE_HEIGHT;
			if (
				roomRight < viewLeft ||
				roomLeft > viewRight ||
				roomBottom < viewTop ||
				roomTop > viewBottom
			) {
				continue;
			}

			c.dirChangeTimer -= delta;
			if (c.dirChangeTimer <= 0) {
				c.dirChangeTimer = 1200 + Math.random() * 2800;
				const angle = Math.random() * 2 * Math.PI;
				const speed = (1.6 + Math.random() * 3.2) / 1000;
				c.velX = Math.cos(angle) * speed;
				c.velY = Math.sin(angle) * speed;
			}

			c.offsetX += c.velX * delta;
			c.offsetY += c.velY * delta;
			if (c.offsetX <= 0) {
				c.offsetX = 0;
				c.velX = Math.abs(c.velX);
			} else if (c.offsetX >= maxOffsetX) {
				c.offsetX = maxOffsetX;
				c.velX = -Math.abs(c.velX);
			}
			if (c.offsetY <= 0) {
				c.offsetY = 0;
				c.velY = Math.abs(c.velY);
			} else if (c.offsetY >= maxOffsetY) {
				c.offsetY = maxOffsetY;
				c.velY = -Math.abs(c.velY);
			}

			c.frameTimer -= delta;
			if (c.frameTimer <= 0) {
				c.frameTimer += COCKROACH_FRAME_MS;
				c.frame = (c.frame + 1) % COCKROACH_FRAMES;
			}

			const worldX = roomLeft + c.offsetX + cockroachW / 2;
			const worldY = roomTop + c.offsetY + cockroachH / 2;

			const textureKey =
				this.cockroachTextureKeys[c.frame] ?? this.cockroachTextureKeys[0];
			if (textureKey === undefined) continue;
			let sprite = this.cockroachSprites[usedCount];
			if (!sprite) {
				sprite = this.add.sprite(0, 0, textureKey);
				sprite.setOrigin(0.5, 0.5);
				sprite.setDepth(DYNAMIC_ENTITY_DEPTH + 0.1);
				sprite.texture.setFilter(Textures.FilterMode.LINEAR);
				sprite.setDisplaySize(cockroachW, cockroachH);
				this.cockroachSprites.push(sprite);
			} else if (sprite.texture.key !== textureKey) {
				sprite.setTexture(textureKey);
			}
			sprite.setVisible(true);
			sprite.setPosition(worldX, worldY);
			sprite.setRotation(Math.atan2(c.velY, c.velX));
			usedCount += 1;
		}

		for (let i = usedCount; i < this.cockroachSprites.length; i += 1) {
			this.cockroachSprites[i]?.setVisible(false);
		}
	}

	private drawHover(): void {
		const g = this.hoverGraphics;
		if (!g) return;
		g.clear();
		if (!this.hoveredCell) return;
		if (this.selectedTool === "inspect" || this.selectedTool === "empty")
			return;

		if (
			this.isShiftHeld &&
			this.lastPlacedAnchor &&
			this.selectedTool !== "empty"
		) {
			this.drawShiftPreview();
			return;
		}

		const { x, y } = this.hoveredCell;
		const hoverBounds = getHoverBounds(x, y, this.selectedTool, this.lobbyMode);
		if (!hoverBounds) return;

		g.fillStyle(COLOR_HOVER, 0.2);
		g.lineStyle(1, COLOR_HOVER, 0.9);
		g.fillRect(
			hoverBounds.x,
			hoverBounds.y,
			hoverBounds.width,
			hoverBounds.height,
		);
		g.strokeRect(
			hoverBounds.x,
			hoverBounds.y,
			hoverBounds.width,
			hoverBounds.height,
		);
	}

	private drawShiftPreview(): void {
		if (!this.hoveredCell) return;
		const g = this.hoverGraphics;
		const ax = anchorX(this.hoveredCell.x, this.selectedTool);
		const fills = this.computeShiftFill(ax, this.hoveredCell.y);
		if (fills.length === 0) return;

		const tileWidth = TILE_WIDTHS[this.selectedTool] ?? 1;
		const pw = tileWidth * TILE_WIDTH - STATIC_TILE_GAP_X;
		const ph = TILE_HEIGHT - STATIC_TILE_GAP_Y;

		g.fillStyle(COLOR_HOVER, 0.12);
		g.lineStyle(1, COLOR_HOVER, 0.75);

		if (isElevatorTileType(this.selectedTool) && this.lastPlacedAnchor) {
			const last = this.lastPlacedAnchor;
			let yMin = last.y;
			let yMax = last.y;
			for (const { y } of fills) {
				if (y < yMin) yMin = y;
				if (y > yMax) yMax = y;
			}
			const px = last.x * TILE_WIDTH;
			const py = yMin * TILE_HEIGHT;
			const spanHeight = (yMax - yMin + 1) * TILE_HEIGHT - STATIC_TILE_GAP_Y;
			g.fillRect(px, py, pw, spanHeight);
			g.strokeRect(px, py, pw, spanHeight);
			return;
		}

		if (this.selectedTool === "lobby") {
			const byY = new Map<number, number[]>();
			for (const { x, y } of fills) {
				const xs = byY.get(y) ?? [];
				xs.push(x);
				byY.set(y, xs);
			}
			for (const [y, xs] of byY) {
				xs.sort((a, b) => a - b);
				let runStart = xs[0];
				let runEnd = xs[0];
				const flush = () => {
					const px = runStart * TILE_WIDTH;
					const py = y * TILE_HEIGHT;
					const runWidth =
						(runEnd - runStart + tileWidth) * TILE_WIDTH - STATIC_TILE_GAP_X;
					g.fillRect(px, py, runWidth, ph);
					g.strokeRect(px, py, runWidth, ph);
				};
				for (let i = 1; i < xs.length; i++) {
					if (xs[i] === runEnd + tileWidth) {
						runEnd = xs[i];
					} else {
						flush();
						runStart = xs[i];
						runEnd = xs[i];
					}
				}
				flush();
			}
			return;
		}

		for (const { x, y } of fills) {
			const px = x * TILE_WIDTH;
			const py = y * TILE_HEIGHT;
			g.fillRect(px, py, pw, ph);
			g.strokeRect(px, py, pw, ph);
		}
	}

	private worldToCell(wx: number, wy: number): { x: number; y: number } {
		return {
			x: Math.floor(wx / TILE_WIDTH),
			y: Math.floor(wy / TILE_HEIGHT),
		};
	}

	private getQueuedSimAtWorldPoint(
		worldX: number,
		worldY: number,
	): SimStateData | null {
		for (let i = this.queuedSimHitboxes.length - 1; i >= 0; i -= 1) {
			const hitbox = this.queuedSimHitboxes[i];
			if (
				hitbox &&
				worldX >= hitbox.left &&
				worldX <= hitbox.right &&
				worldY >= hitbox.top &&
				worldY <= hitbox.bottom
			) {
				return this.snapshotSource?.materializeSim(hitbox.simRecord) ?? null;
			}
		}
		return null;
	}

	private updateCanvasCursor(): void {
		const canvas = this.sys.game?.canvas;
		if (!canvas) return;
		if (this.selectedTool === "inspect") {
			canvas.style.cursor = "zoom-in";
		} else if (this.selectedTool === "empty") {
			canvas.style.cursor = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M4 4 L16 16 M16 4 L4 16" stroke="white" stroke-width="4" stroke-linecap="round"/><path d="M4 4 L16 16 M16 4 L4 16" stroke="%23e53935" stroke-width="2" stroke-linecap="round"/></svg>') 10 10, not-allowed`;
		} else {
			canvas.style.cursor = "default";
		}
	}

	// Detect that two pointers are now down and snapshot the starting pinch
	// geometry. Returns true if pinch mode was just entered.
	private beginPinchIfReady(): boolean {
		if (this.isPinching) return true;
		const p1 = this.input.pointer1;
		const p2 = this.input.pointer2;
		if (!p1?.isDown || !p2?.isDown) return false;
		this.isPinching = true;
		this.isDragging = false;
		this.draggedCells.clear();
		this.isPanning = false;
		this.pendingTouchTap = null;
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		this.pinchPrevDist = Math.hypot(dx, dy);
		this.pinchPrevMidX = (p1.x + p2.x) / 2;
		this.pinchPrevMidY = (p1.y + p2.y) / 2;
		return true;
	}

	// Apply incremental zoom + pan from the current two-pointer geometry.
	// Returns true when pinch is active (caller should skip other move logic).
	private updatePinch(cam: Phaser.Cameras.Scene2D.Camera): boolean {
		if (!this.isPinching) return false;
		const p1 = this.input.pointer1;
		const p2 = this.input.pointer2;
		if (!p1?.isDown || !p2?.isDown) return true;
		const dx = p2.x - p1.x;
		const dy = p2.y - p1.y;
		const newDist = Math.hypot(dx, dy);
		const newMidX = (p1.x + p2.x) / 2;
		const newMidY = (p1.y + p2.y) / 2;
		if (this.pinchPrevDist > 0) {
			const ratio = newDist / this.pinchPrevDist;
			const oldZoom = cam.zoom;
			const newZoom = PhaserMath.Clamp(oldZoom * ratio, MIN_ZOOM, MAX_ZOOM);
			cam.preRender();
			const worldBefore = cam.getWorldPoint(newMidX, newMidY);
			cam.setZoom(newZoom);
			cam.preRender();
			const worldAfter = cam.getWorldPoint(newMidX, newMidY);
			cam.scrollX += worldBefore.x - worldAfter.x;
			cam.scrollY += worldBefore.y - worldAfter.y;
			cam.scrollX -= (newMidX - this.pinchPrevMidX) / newZoom;
			cam.scrollY -= (newMidY - this.pinchPrevMidY) / newZoom;
			cam.preRender();
		}
		this.pinchPrevDist = newDist;
		this.pinchPrevMidX = newMidX;
		this.pinchPrevMidY = newMidY;
		return true;
	}

	private setupInput(): void {
		const cam = this.cameras.main;

		// Enable a second simultaneous touch pointer for pinch-to-zoom.
		this.input.addPointer(1);
		// Suppress the browser's native touch gestures (page pan/zoom) over the canvas
		// so two-finger pinch reaches Phaser instead of zooming the page.
		this.game.canvas.style.touchAction = "none";

		this.input.on("pointerdown", () => this.soundManager?.unlock());
		this.input.keyboard?.on("keydown", () => this.soundManager?.unlock());

		this.input.on("pointermove", (pointer: Input.Pointer) => {
			if (this.updatePinch(cam)) return;

			// Convert a pending touch tap into a pan once the finger has moved
			// past a small threshold.
			if (this.pendingTouchTap && pointer.isDown) {
				const dx = pointer.x - this.panStartX;
				const dy = pointer.y - this.panStartY;
				if (dx * dx + dy * dy > TOUCH_PAN_THRESHOLD_SQ) {
					this.pendingTouchTap = null;
					this.isPanning = true;
				}
			}

			const cell = this.worldToCell(pointer.worldX, pointer.worldY);
			const shift = !!(pointer.event as MouseEvent).shiftKey;

			const cellChanged =
				cell.x !== this.hoveredCell?.x || cell.y !== this.hoveredCell?.y;
			const shiftChanged = shift !== this.isShiftHeld;
			this.hoveredCell = cell;
			this.isShiftHeld = shift;
			if (cellChanged || shiftChanged) this.drawHover();

			if (this.isPanning) {
				const dx = pointer.x - this.panStartX;
				const dy = pointer.y - this.panStartY;
				cam.setScroll(
					this.camStartX - dx / cam.zoom,
					this.camStartY - dy / cam.zoom,
				);
			} else if (this.isDragging && pointer.leftButtonDown()) {
				const cellKey = `${cell.x},${cell.y}`;
				if (
					!this.draggedCells.has(cellKey) &&
					cell.x >= 0 &&
					cell.x < GRID_WIDTH &&
					cell.y >= 0 &&
					cell.y < GRID_HEIGHT
				) {
					this.draggedCells.add(cellKey);
					const ax = anchorX(cell.x, this.selectedTool);
					this.onCellClick?.(ax, cell.y, false);
				}
			}
		});

		this.input.on("pointerdown", (pointer: Input.Pointer) => {
			// If a second finger has joined, switch to pinch-zoom and abandon
			// any in-progress paint or pan from the first pointer.
			if (this.beginPinchIfReady()) return;
			if (this.isPinching) return;

			if (pointer.rightButtonDown()) {
				const cell = this.worldToCell(pointer.worldX, pointer.worldY);
				if (
					cell.x >= 0 &&
					cell.x < GRID_WIDTH &&
					cell.y >= 0 &&
					cell.y < GRID_HEIGHT
				) {
					this.onCellInspect?.(cell.x, cell.y);
				}
				return;
			}
			if (pointer.middleButtonDown()) {
				this.isPanning = true;
				this.panStartX = pointer.x;
				this.panStartY = pointer.y;
				this.camStartX = cam.scrollX;
				this.camStartY = cam.scrollY;
				return;
			}

			if (pointer.leftButtonDown()) {
				if (this.selectedTool === "inspect") {
					const queuedSim = this.getQueuedSimAtWorldPoint(
						pointer.worldX,
						pointer.worldY,
					);
					if (queuedSim) {
						this.onQueuedSimInspect?.(queuedSim);
						return;
					}
				}
				const cell = this.worldToCell(pointer.worldX, pointer.worldY);
				if (
					cell.x < 0 ||
					cell.x >= GRID_WIDTH ||
					cell.y < 0 ||
					cell.y >= GRID_HEIGHT
				)
					return;
				const shift = !!(pointer.event as MouseEvent).shiftKey;
				const ax = anchorX(cell.x, this.selectedTool);
				// Defer touch taps so a second finger can switch us into pinch
				// mode before the click commits. Mouse stays immediate.
				if (pointer.wasTouch) {
					this.pendingTouchTap = { x: ax, y: cell.y, shift };
					this.panStartX = pointer.x;
					this.panStartY = pointer.y;
					this.camStartX = cam.scrollX;
					this.camStartY = cam.scrollY;
					return;
				}
				this.isDragging = true;
				this.draggedCells.clear();
				this.draggedCells.add(`${cell.x},${cell.y}`);
				this.onCellClick?.(ax, cell.y, shift);
			}
		});

		this.input.on("pointerup", (pointer: Input.Pointer) => {
			if (this.isPinching) {
				const p1 = this.input.pointer1;
				const p2 = this.input.pointer2;
				if (!p1?.isDown || !p2?.isDown) {
					this.isPinching = false;
					this.pendingTouchTap = null;
					setTowerView(this.towerId, {
						zoom: cam.zoom,
						scrollX: cam.scrollX,
						scrollY: cam.scrollY,
					});
				}
				return;
			}
			if (this.pendingTouchTap) {
				const tap = this.pendingTouchTap;
				this.pendingTouchTap = null;
				this.onCellClick?.(tap.x, tap.y, tap.shift);
			}
			if (!pointer.middleButtonDown() && !pointer.rightButtonDown()) {
				if (this.isPanning) {
					setTowerView(this.towerId, {
						scrollX: cam.scrollX,
						scrollY: cam.scrollY,
					});
				}
				this.isPanning = false;
			}
			this.isDragging = false;
		});

		this.input.on(
			"wheel",
			(p: Input.Pointer, _o: unknown[], deltaX: number, deltaY: number) => {
				const wheelEvent = p.event as WheelEvent;
				if (wheelEvent.ctrlKey || wheelEvent.shiftKey) {
					// Pinch or shift-modified trackpad scroll -> zoom around mouse position.
					// Use Phaser's camera transform helpers instead of duplicating the math,
					// so the anchor remains stable with RESIZE scaling and centered cameras.
					const oldZoom = cam.zoom;
					const newZoom = PhaserMath.Clamp(
						oldZoom * (deltaY > 0 ? 0.9 : 1.1),
						MIN_ZOOM,
						MAX_ZOOM,
					);
					if (newZoom === oldZoom) return;
					cam.preRender();
					const worldPointBefore = cam.getWorldPoint(p.x, p.y);
					cam.setZoom(newZoom);
					cam.preRender();
					const worldPointAfter = cam.getWorldPoint(p.x, p.y);
					cam.scrollX += worldPointBefore.x - worldPointAfter.x;
					cam.scrollY += worldPointBefore.y - worldPointAfter.y;
					cam.preRender();
					setTowerView(this.towerId, {
						zoom: newZoom,
						scrollX: cam.scrollX,
						scrollY: cam.scrollY,
					});
				} else {
					// Two-finger scroll -> pan
					cam.scrollX += deltaX / cam.zoom;
					cam.scrollY += deltaY / cam.zoom;
					setTowerView(this.towerId, {
						scrollX: cam.scrollX,
						scrollY: cam.scrollY,
					});
				}
			},
		);

		this.game.canvas.addEventListener("contextmenu", (e) => e.preventDefault());
		this.updateCanvasCursor();

		// Redraw hover when shift is pressed/released without moving the mouse
		this.input.keyboard?.on("keydown-SHIFT", () => {
			this.isShiftHeld = true;
			this.drawHover();
		});
		this.input.keyboard?.on("keyup-SHIFT", () => {
			this.isShiftHeld = false;
			this.drawHover();
		});
	}
}
