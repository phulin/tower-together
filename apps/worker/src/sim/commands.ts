import { rebuild_carrier_list } from "./carriers";
import { type LedgerState, rebuild_facility_ledger } from "./ledger";
import {
	TILE_COSTS,
	TILE_TO_FAMILY_CODE,
	TILE_WIDTHS,
	VALID_TILE_TYPES,
} from "./resources";
import {
	rebuild_special_links,
	rebuild_transfer_group_cache,
	rebuild_walkability_flags,
} from "./routing";
import {
	type CommercialVenueRecord,
	type EntertainmentLinkRecord,
	GRID_WIDTH,
	isValidLobbyY,
	type PlacedObjectRecord,
	type ServiceRequestEntry,
	type WorldState,
} from "./world";

// ─── Patch type ───────────────────────────────────────────────────────────────

export type CellPatch = {
	x: number;
	y: number;
	tileType: string;
	isAnchor: boolean;
	isOverlay?: boolean;
};

export interface CommandResult {
	accepted: boolean;
	patch?: CellPatch[];
	reason?: string;
	economyChanged?: boolean;
}

// ─── Infrastructure tiles (no PlacedObjectRecord) ─────────────────────────────

const INFRASTRUCTURE_TILES = new Set(["floor", "lobby", "stairs"]);

// Families whose variant_index initialises to 1; all others initialise to 4 (no payout).
const VARIANT_INIT_ONE_FAMILIES = new Set([3, 4, 5, 7, 9, 10]);

// ─── PlacedObjectRecord helpers ───────────────────────────────────────────────

function make_placed_object(
	x: number,
	tileType: string,
	world: WorldState,
): PlacedObjectRecord {
	const width = TILE_WIDTHS[tileType] ?? 1;
	const familyCode = TILE_TO_FAMILY_CODE[tileType] ?? 0;
	const sidecarIndex = alloc_sidecar(tileType, x, world);
	return {
		left_tile_index: x,
		right_tile_index: x + width - 1,
		object_type_code: familyCode,
		stay_phase: 0,
		linked_record_index: sidecarIndex,
		aux_value_or_timer: 0,
		needs_refresh_flag: 1, // picked up by next refresh sweep
		pairing_status: -1, // invalid; first scoring sweep populates
		pairing_active_flag: 1, // first-activation latch
		activation_tick_count: 0,
		variant_index: VARIANT_INIT_ONE_FAMILIES.has(familyCode) ? 1 : 4,
	};
}

/** Allocate a sidecar for tiles that need one. Returns index or −1. */
function alloc_sidecar(tileType: string, x: number, world: WorldState): number {
	let record: WorldState["sidecars"][number] | null = null;

	if (
		tileType === "restaurant" ||
		tileType === "fast_food" ||
		tileType === "retail"
	) {
		const r: CommercialVenueRecord = {
			kind: "commercial_venue",
			owner_subtype_index: x,
			capacity:
				tileType === "restaurant" ? 6 : tileType === "fast_food" ? 4 : 3,
			visit_count: 0,
		};
		record = r;
	} else if (tileType === "security" || tileType === "housekeeping") {
		const r: ServiceRequestEntry = {
			kind: "service_request",
			owner_subtype_index: x,
		};
		record = r;
	} else if (tileType === "cinema" || tileType === "entertainment") {
		const r: EntertainmentLinkRecord = {
			kind: "entertainment_link",
			owner_subtype_index: x,
			paired_subtype_index: 0xff,
		};
		record = r;
	}

	if (!record) return -1;
	world.sidecars.push(record);
	return world.sidecars.length - 1;
}

/** Mark a sidecar as invalid (demolished). */
function free_sidecar(index: number, world: WorldState): void {
	const rec = world.sidecars[index];
	if (rec) rec.owner_subtype_index = 0xff;
}

// ─── Global rebuilds ──────────────────────────────────────────────────────────

/**
 * Run all post-build / post-demolish global rebuilds.
 * Order matters: carriers → special_links → walkability → transfer_cache.
 */
export function run_global_rebuilds(
	world: WorldState,
	ledger: LedgerState,
): void {
	rebuild_facility_ledger(ledger, world);
	rebuild_carrier_list(world);
	rebuild_special_links(world);
	rebuild_walkability_flags(world);
	rebuild_transfer_group_cache(world);
}

// ─── Place tile ───────────────────────────────────────────────────────────────

export function handle_place_tile(
	x: number,
	y: number,
	tileType: string,
	world: WorldState,
	ledger: LedgerState,
): CommandResult {
	if (!VALID_TILE_TYPES.has(tileType)) {
		return { accepted: false, reason: "Invalid tile type" };
	}
	if (x < 0 || x >= world.width || y < 0 || y >= world.height) {
		return { accepted: false, reason: "Out of bounds" };
	}

	// ── Elevator / Escalator: 1-wide overlay on a floor/lobby tile ──────────────
	if (tileType === "elevator" || tileType === "escalator") {
		const key = `${x},${y}`;
		if (world.overlays[key] || world.overlayToAnchor[key]) {
			return { accepted: false, reason: "Cell already has an overlay" };
		}
		const patch: CellPatch[] = [];
		// Auto-place a floor tile if the cell is empty but has support below
		if (!world.cells[key] && !world.cellToAnchor[key]) {
			const belowKey = `${x},${y + 1}`;
			if (y + 1 >= world.height || !world.cells[belowKey]) {
				return {
					accepted: false,
					reason: "Elevator requires a base tile or support below",
				};
			}
			world.cells[key] = "floor";
			patch.push({ x, y, tileType: "floor", isAnchor: true });
		}
		world.overlays[key] = tileType;
		patch.push({ x, y, tileType, isAnchor: true, isOverlay: true });
		run_global_rebuilds(world, ledger);
		return { accepted: true, patch };
	}

	// ── Stairs: overlay on existing base tiles ────────────────────────────────
	if (tileType === "stairs") {
		if (x + 1 >= GRID_WIDTH) {
			return { accepted: false, reason: "Out of bounds" };
		}
		for (let dx = 0; dx < 2; dx++) {
			const key = `${x + dx},${y}`;
			if (!world.cells[key] && !world.cellToAnchor[key]) {
				return { accepted: false, reason: "Stairs require a base tile" };
			}
			if (world.overlays[key] || world.overlayToAnchor[key]) {
				return { accepted: false, reason: "Cell already has an overlay" };
			}
		}
		world.overlays[`${x},${y}`] = "stairs";
		world.overlayToAnchor[`${x + 1},${y}`] = `${x},${y}`;
		return {
			accepted: true,
			patch: [{ x, y, tileType: "stairs", isAnchor: true, isOverlay: true }],
		};
	}

	// ── Standard tile placement ───────────────────────────────────────────────
	const tileWidth = TILE_WIDTHS[tileType] ?? 1;
	const cost = TILE_COSTS[tileType] ?? 0;

	if (x + tileWidth - 1 >= world.width) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (tileType === "lobby" && !isValidLobbyY(y)) {
		return {
			accepted: false,
			reason: "Lobby only allowed on ground floor or every 15 floors above",
		};
	}
	if (cost > ledger.cash_balance) {
		return { accepted: false, reason: "Insufficient funds" };
	}

	const canReplaceFloor = tileType !== "floor";
	const floorToRemove: string[] = [];
	for (let dx = 0; dx < tileWidth; dx++) {
		const key = `${x + dx},${y}`;
		if (world.cellToAnchor[key]) {
			return { accepted: false, reason: "Cell already occupied" };
		}
		const existing = world.cells[key];
		if (existing) {
			if (canReplaceFloor && existing === "floor") {
				floorToRemove.push(key);
			} else {
				return { accepted: false, reason: "Cell already occupied" };
			}
		}
	}

	// All non-lobby tiles need support from the row below
	if (tileType !== "lobby") {
		for (let dx = 0; dx < tileWidth; dx++) {
			const belowKey = `${x + dx},${y + 1}`;
			if (y + 1 >= world.height || !world.cells[belowKey]) {
				return { accepted: false, reason: "No support below" };
			}
		}
	}

	// Apply placement
	for (const key of floorToRemove) delete world.cells[key];
	world.cells[`${x},${y}`] = tileType;
	for (let dx = 1; dx < tileWidth; dx++) {
		world.cells[`${x + dx},${y}`] = tileType;
		world.cellToAnchor[`${x + dx},${y}`] = `${x},${y}`;
	}
	ledger.cash_balance -= cost;

	// PlacedObjectRecord
	if (!INFRASTRUCTURE_TILES.has(tileType)) {
		world.placed_objects[`${x},${y}`] = make_placed_object(x, tileType, world);
	}

	const patch: CellPatch[] = Array.from({ length: tileWidth }, (_, dx) => ({
		x: x + dx,
		y,
		tileType,
		isAnchor: dx === 0,
	}));

	fill_row_gaps(y, world, patch);

	run_global_rebuilds(world, ledger);

	return { accepted: true, patch, economyChanged: cost > 0 };
}

// ─── Remove tile ──────────────────────────────────────────────────────────────

export function handle_remove_tile(
	x: number,
	y: number,
	world: WorldState,
	ledger: LedgerState,
): CommandResult {
	if (x < 0 || x >= world.width || y < 0 || y >= world.height) {
		return { accepted: false, reason: "Out of bounds" };
	}
	const clickedKey = `${x},${y}`;

	// Remove overlay first if present
	const overlayAnchorKey =
		world.overlayToAnchor[clickedKey] ??
		(world.overlays[clickedKey] ? clickedKey : null);
	if (overlayAnchorKey !== null) {
		const overlayType = world.overlays[overlayAnchorKey];
		const ow = TILE_WIDTHS[overlayType] ?? 1;
		const [ax] = overlayAnchorKey.split(",").map(Number);
		delete world.overlays[overlayAnchorKey];
		for (let dx = 1; dx < ow; dx++) {
			delete world.overlayToAnchor[`${ax + dx},${y}`];
		}
		const [oax, oay] = overlayAnchorKey.split(",").map(Number);
		// Carrier overlays require a routing rebuild on removal
		if (overlayType === "elevator" || overlayType === "escalator") {
			run_global_rebuilds(world, ledger);
		}
		return {
			accepted: true,
			patch: [
				{ x: oax, y: oay, tileType: "empty", isAnchor: true, isOverlay: true },
			],
		};
	}

	const anchorKey = world.cellToAnchor[clickedKey] ?? clickedKey;
	const tileType = world.cells[anchorKey];
	if (!tileType) {
		return { accepted: false, reason: "Cell is empty" };
	}

	const [ax, ay] = anchorKey.split(",").map(Number);
	const tileWidth = TILE_WIDTHS[tileType] ?? 1;

	// Determine replacement: floor if anything sits above or tile is between neighbours
	let hasAbove = false;
	for (let dx = 0; dx < tileWidth && !hasAbove; dx++) {
		if (world.cells[`${ax + dx},${ay - 1}`]) hasAbove = true;
	}
	let hasLeft = false;
	for (let lx = ax - 1; lx >= 0 && !hasLeft; lx--) {
		if (world.cells[`${lx},${ay}`]) hasLeft = true;
	}
	let hasRight = false;
	for (let rx = ax + tileWidth; rx < world.width && !hasRight; rx++) {
		if (world.cells[`${rx},${ay}`]) hasRight = true;
	}
	const turnToFloor = hasAbove || (hasLeft && hasRight);

	delete world.cells[anchorKey];
	for (let dx = 1; dx < tileWidth; dx++) {
		delete world.cells[`${ax + dx},${ay}`];
		delete world.cellToAnchor[`${ax + dx},${ay}`];
	}

	// Remove PlacedObjectRecord and free sidecar
	const rec = world.placed_objects[anchorKey];
	if (rec) {
		if (rec.linked_record_index >= 0) {
			free_sidecar(rec.linked_record_index, world);
		}
		delete world.placed_objects[anchorKey];
	}

	const patch: CellPatch[] = [];
	for (let dx = 0; dx < tileWidth; dx++) {
		const resultType = turnToFloor ? "floor" : "empty";
		if (turnToFloor) world.cells[`${ax + dx},${ay}`] = "floor";
		patch.push({ x: ax + dx, y: ay, tileType: resultType, isAnchor: true });
	}

	run_global_rebuilds(world, ledger);

	return { accepted: true, patch };
}

// ─── Gap-fill helper ──────────────────────────────────────────────────────────

/** After a placement on row y, fill supported horizontal gaps with free floor tiles. */
export function fill_row_gaps(
	y: number,
	world: WorldState,
	patch: CellPatch[],
): void {
	if (y + 1 >= world.height) return;

	let leftmost = -1;
	let rightmost = -1;
	for (let x = 0; x < world.width; x++) {
		if (world.cells[`${x},${y}`]) {
			if (leftmost === -1) leftmost = x;
			rightmost = x;
		}
	}
	if (leftmost === -1) return;

	for (let x = leftmost; x <= rightmost; x++) {
		const key = `${x},${y}`;
		if (world.cells[key]) continue;
		if (!world.cells[`${x},${y + 1}`]) continue;
		world.cells[key] = "floor";
		patch.push({ x, y, tileType: "floor", isAnchor: true });
	}
}
