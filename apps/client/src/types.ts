import {
	STARTING_CASH as WORKER_STARTING_CASH,
	TILE_COSTS as WORKER_TILE_COSTS,
	TILE_WIDTHS as WORKER_TILE_WIDTHS,
} from "../../worker/src/sim/resources";
import {
	GRID_HEIGHT,
	GRID_WIDTH,
	GROUND_Y,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
} from "../../worker/src/sim/world";

// ─── Grid constants (shared with apps/worker/src/sim) ────────────────────────

export { GRID_HEIGHT, GRID_WIDTH, GROUND_Y, UNDERGROUND_FLOORS, UNDERGROUND_Y };

// ─── Time constants (must match apps/worker/src/sim/time.ts) ─────────────────

/** Ticks per in-game day. */
export const DAY_TICK_MAX = 2600;

// ─── Tile registry (must match apps/worker/src/sim/resources.ts) ─────────────

export type TileType =
	| "empty"
	// Infrastructure
	| "floor"
	| "lobby"
	| "stairs"
	| "elevator"
	| "escalator"
	// Hotels
	| "hotelSingle"
	| "hotelTwin"
	| "hotelSuite"
	// Commercial
	| "restaurant"
	| "fastFood"
	| "retail"
	// Office / Condo
	| "office"
	| "condo"
	// Entertainment
	| "cinema"
	| "entertainment"
	// Services
	| "security"
	| "housekeeping"
	| "parking"
	| "metro"
	| "fireSuppressor";

export type SelectedTool = TileType;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Width in grid cells for each placeable tile type. */
export const TILE_WIDTHS: Record<string, number> = WORKER_TILE_WIDTHS;

/** Construction cost in dollars. */
export const TILE_COSTS: Record<string, number> = WORKER_TILE_COSTS;
export const STARTING_CASH = WORKER_STARTING_CASH;

// ─── Wire protocol ────────────────────────────────────────────────────────────

export type CellData = {
	x: number;
	y: number;
	tileType: string;
	isAnchor: boolean;
	isOverlay?: boolean;
};

export type EntityStateData = {
	id: string;
	floorAnchor: number;
	selectedFloor: number;
	subtypeIndex: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	stressLevel: "low" | "medium" | "high";
};

export type CarrierCarStateData = {
	carrierId: number;
	carIndex: number;
	carCount: number;
	column: number;
	carrierMode: 0 | 1 | 2;
	currentFloor: number;
	targetFloor: number;
	speedCounter: number;
	doorWaitCounter: number;
};

export type ServerMessage =
	| {
			type: "init_state";
			towerId: string;
			name: string;
			simTime: number;
			cash: number;
			width: number;
			height: number;
			cells: CellData[];
			entities: EntityStateData[];
			carriers: CarrierCarStateData[];
	  }
	| { type: "state_patch"; cells: CellData[] }
	| { type: "entity_update"; entities: EntityStateData[] }
	| { type: "carrier_update"; carriers: CarrierCarStateData[] }
	| {
			type: "command_result";
			accepted: boolean;
			patch?: { cells: CellData[] };
			reason?: string;
	  }
	| { type: "presence_update"; playerCount: number }
	| { type: "time_update"; simTime: number }
	| { type: "economy_update"; cash: number }
	| { type: "pong" };

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| { type: "place_tile"; x: number; y: number; tileType: string }
	| { type: "remove_tile"; x: number; y: number }
	| { type: "ping" };
