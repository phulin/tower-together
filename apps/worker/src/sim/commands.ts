import { rebuild_carrier_list } from "./carriers";
import {
	cleanup_entities_for_removed_tile,
	rebuild_parking_demand_log,
	rebuild_runtime_entities,
} from "./entities";
import { type LedgerState, rebuild_facility_ledger } from "./ledger";
import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOUSEKEEPING,
	FAMILY_METRO,
	FAMILY_OFFICE,
	FAMILY_RETAIL,
	FAMILY_SECURITY,
	LEGACY_VIP_TILE_TO_STANDARD,
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
	UNDERGROUND_Y,
	type WorldState,
	yToFloor,
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

export type SimCommand =
	| { type: "place_tile"; x: number; y: number; tileType: string }
	| { type: "remove_tile"; x: number; y: number }
	| { type: "prompt_response"; promptId: string; accepted: boolean }
	| { type: "set_rent_level"; x: number; y: number; rentLevel: number }
	| { type: "add_elevator_car"; x: number }
	| { type: "remove_elevator_car"; x: number };

// ─── Infrastructure tiles (no PlacedObjectRecord) ─────────────────────────────

const INFRASTRUCTURE_TILES = new Set(["floor", "lobby", "stairs"]);

// Families whose rentLevel initialises to 1; all others initialise to 4 (no payout).
const VARIANT_INIT_ONE_FAMILIES = new Set([3, 4, 5, 7, 9, FAMILY_RETAIL]);

// ─── PlacedObjectRecord helpers ───────────────────────────────────────────────

function make_placed_object(
	x: number,
	y: number,
	tileType: string,
	world: WorldState,
	vipFlag = false,
): PlacedObjectRecord {
	const width = TILE_WIDTHS[tileType] ?? 1;
	const familyCode = TILE_TO_FAMILY_CODE[tileType] ?? 0;
	const sidecarIndex = alloc_sidecar(tileType, x, y, world);
	return {
		leftTileIndex: x,
		rightTileIndex: x + width - 1,
		objectTypeCode: familyCode,
		unitStatus: 0,
		linkedRecordIndex: sidecarIndex,
		auxValueOrTimer: 0,
		needsRefreshFlag: 1, // picked up by next refresh sweep
		evalLevel: -1, // invalid; first scoring sweep populates
		evalActiveFlag: 1, // first-activation latch
		activationTickCount: 0,
		rentLevel: VARIANT_INIT_ONE_FAMILIES.has(familyCode) ? 1 : 4,
		vipFlag,
	};
}

/** Allocate a sidecar for tiles that need one. Returns index or −1. */
function alloc_sidecar(
	tileType: string,
	x: number,
	y: number,
	world: WorldState,
): number {
	let record: WorldState["sidecars"][number] | null = null;

	if (
		tileType === "restaurant" ||
		tileType === "fastFood" ||
		tileType === "retail"
	) {
		const r: CommercialVenueRecord = {
			kind: "commercial_venue",
			ownerSubtypeIndex: x,
			capacity: tileType === "restaurant" ? 6 : tileType === "fastFood" ? 4 : 3,
			visitCount: 0,
			todayVisitCount: 0,
			yesterdayVisitCount: 0,
			availabilityState: 1,
		};
		record = r;
	} else if (
		tileType === "security" ||
		tileType === "housekeeping" ||
		tileType === "parking"
	) {
		const r: ServiceRequestEntry = {
			kind: "service_request",
			ownerSubtypeIndex: x,
			floorIndex: tileType === "parking" ? yToFloor(y) : undefined,
			coverageFlag: 0,
		};
		record = r;
	} else if (tileType === "cinema" || tileType === "entertainment") {
		const r: EntertainmentLinkRecord = {
			kind: "entertainment_link",
			ownerSubtypeIndex: x,
			pairedSubtypeIndex: 0xff,
			familySelectorOrSingleLinkFlag:
				tileType === "entertainment" ? Math.floor(Math.random() * 14) : 0xff,
			linkAgeCounter: 0,
			forwardBudget: 0,
			reverseBudget: 0,
			linkPhaseState: 0,
			pendingTransitionFlag: 0,
			attendanceCounter: 0,
			activeRuntimeCount: 0,
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
	if (rec) rec.ownerSubtypeIndex = 0xff;
}

function get_overlay_anchor_key(
	world: WorldState,
	x: number,
	y: number,
): string | null {
	const key = `${x},${y}`;
	return world.overlayToAnchor[key] ?? (world.overlays[key] ? key : null);
}

function elevator_mode_for_overlay(
	type: string,
): "standard" | "express" | "service" | null {
	if (type === "elevator") return "standard";
	if (type === "elevatorExpress") return "express";
	if (type === "elevatorService") return "service";
	return null;
}

function has_misaligned_adjacent_overlay(
	world: WorldState,
	x: number,
	y: number,
	type: "elevator" | "escalator",
	width: number,
): boolean {
	for (const adjacentY of [y - 1, y + 1]) {
		if (adjacentY < 0 || adjacentY >= world.height) continue;
		const adjacentAnchors = new Set<string>();
		for (let dx = 0; dx < width; dx++) {
			const anchorKey = get_overlay_anchor_key(world, x + dx, adjacentY);
			if (!anchorKey) continue;
			if (world.overlays[anchorKey] !== type) continue;
			adjacentAnchors.add(anchorKey);
		}
		if (adjacentAnchors.size === 0) continue;
		if (adjacentAnchors.size > 1) return true;
		const [anchorKey] = adjacentAnchors;
		if (!anchorKey) continue;
		const [anchorX] = anchorKey.split(",").map(Number);
		if (anchorX !== x) return true;
	}
	return false;
}

function has_adjacent_elevator_mode_conflict(
	world: WorldState,
	x: number,
	y: number,
	type: string,
	width: number,
): boolean {
	const mode = elevator_mode_for_overlay(type);
	if (!mode) return false;

	for (const adjacentY of [y - 1, y + 1]) {
		if (adjacentY < 0 || adjacentY >= world.height) continue;
		for (let dx = 0; dx < width; dx++) {
			const anchorKey = get_overlay_anchor_key(world, x + dx, adjacentY);
			if (!anchorKey) continue;
			const adjacentType = world.overlays[anchorKey];
			const adjacentMode = adjacentType
				? elevator_mode_for_overlay(adjacentType)
				: null;
			if (!adjacentMode) continue;
			if (adjacentMode !== mode) return true;
		}
	}

	return false;
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
	world.gateFlags.officePlaced = 0;
	world.gateFlags.metroPlaced = 0;
	world.gateFlags.vipSuiteFloor = 0xffff;
	world.gateFlags.securityLedgerScale = 0;
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode === FAMILY_OFFICE)
			world.gateFlags.officePlaced = 1;
		if (object.objectTypeCode === FAMILY_METRO) {
			world.gateFlags.metroPlaced = 1;
			const [, y] = key.split(",").map(Number);
			world.gateFlags.vipSuiteFloor = world.height - 1 - y;
		}
		if (object.objectTypeCode === FAMILY_SECURITY)
			world.gateFlags.securityLedgerScale += 1;
	}

	rebuild_facility_ledger(ledger, world);
	rebuild_runtime_entities(world);
	rebuild_parking_demand_log(world);
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
	const normalizedTileType = LEGACY_VIP_TILE_TO_STANDARD[tileType] ?? tileType;
	const vipFlag = tileType in LEGACY_VIP_TILE_TO_STANDARD;

	if (!VALID_TILE_TYPES.has(normalizedTileType)) {
		return { accepted: false, reason: "Invalid tile type" };
	}
	if (x < 0 || x >= world.width || y < 0 || y >= world.height) {
		return { accepted: false, reason: "Out of bounds" };
	}

	// ── Elevator / Escalator: overlay on a floor/lobby tile ─────────────────────
	if (
		normalizedTileType === "elevator" ||
		normalizedTileType === "elevatorExpress" ||
		normalizedTileType === "elevatorService" ||
		normalizedTileType === "escalator"
	) {
		const patch: CellPatch[] = [];
		const overlayWidth = TILE_WIDTHS[normalizedTileType] ?? 1;
		if (x + overlayWidth - 1 >= world.width) {
			return { accepted: false, reason: "Out of bounds" };
		}
		for (let dx = 0; dx < overlayWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (world.overlays[key] || world.overlayToAnchor[key]) {
				return { accepted: false, reason: "Cell already has an overlay" };
			}
		}
		if (
			(normalizedTileType === "elevator" ||
				normalizedTileType === "elevatorExpress" ||
				normalizedTileType === "elevatorService") &&
			has_misaligned_adjacent_overlay(world, x, y, "elevator", overlayWidth)
		) {
			return {
				accepted: false,
				reason: "Elevator must align with adjacent shaft segments",
			};
		}
		if (
			has_adjacent_elevator_mode_conflict(
				world,
				x,
				y,
				normalizedTileType,
				overlayWidth,
			)
		) {
			return {
				accepted: false,
				reason: "Elevator shaft mode must match adjacent segments",
			};
		}
		// Auto-place floor tiles where empty but supported
		// (below for above-ground; above for underground floors).
		for (let dx = 0; dx < overlayWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (world.cells[key] || world.cellToAnchor[key]) continue;
			const supportY = y >= UNDERGROUND_Y ? y - 1 : y + 1;
			const supportKey = `${x + dx},${supportY}`;
			if (
				supportY < 0 ||
				supportY >= world.height ||
				!world.cells[supportKey]
			) {
				return {
					accepted: false,
					reason: "Elevator requires a base tile or support",
				};
			}
			world.cells[key] = "floor";
			patch.push({ x: x + dx, y, tileType: "floor", isAnchor: true });
		}
		world.overlays[`${x},${y}`] = normalizedTileType;
		for (let dx = 1; dx < overlayWidth; dx++) {
			world.overlayToAnchor[`${x + dx},${y}`] = `${x},${y}`;
		}
		patch.push({
			x,
			y,
			tileType: normalizedTileType,
			isAnchor: true,
			isOverlay: true,
		});
		run_global_rebuilds(world, ledger);
		return { accepted: true, patch };
	}

	// ── Stairs: overlay on existing base tiles ────────────────────────────────
	if (normalizedTileType === "stairs") {
		const overlayWidth = TILE_WIDTHS.stairs ?? 1;
		if (x + overlayWidth - 1 >= GRID_WIDTH) {
			return { accepted: false, reason: "Out of bounds" };
		}
		for (let dx = 0; dx < overlayWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (!world.cells[key] && !world.cellToAnchor[key]) {
				return { accepted: false, reason: "Stairs require a base tile" };
			}
			if (world.overlays[key] || world.overlayToAnchor[key]) {
				return { accepted: false, reason: "Cell already has an overlay" };
			}
		}
		world.overlays[`${x},${y}`] = "stairs";
		for (let dx = 1; dx < overlayWidth; dx++) {
			world.overlayToAnchor[`${x + dx},${y}`] = `${x},${y}`;
		}
		run_global_rebuilds(world, ledger);
		return {
			accepted: true,
			patch: [{ x, y, tileType: "stairs", isAnchor: true, isOverlay: true }],
		};
	}

	// ── Standard tile placement ───────────────────────────────────────────────
	const tileWidth = TILE_WIDTHS[normalizedTileType] ?? 1;
	const cost = TILE_COSTS[normalizedTileType] ?? 0;

	if (x + tileWidth - 1 >= world.width) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (normalizedTileType === "lobby" && !isValidLobbyY(y)) {
		return {
			accepted: false,
			reason: "Lobby only allowed on ground floor or every 15 floors above",
		};
	}
	if (cost > ledger.cashBalance) {
		return { accepted: false, reason: "Insufficient funds" };
	}

	const canReplaceFloor = normalizedTileType !== "floor";
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

	// All non-lobby tiles need support from the adjacent row
	// (below for above-ground tiles; above for underground floors).
	if (normalizedTileType !== "lobby") {
		const supportY = y >= UNDERGROUND_Y ? y - 1 : y + 1;
		for (let dx = 0; dx < tileWidth; dx++) {
			const supportKey = `${x + dx},${supportY}`;
			if (
				supportY < 0 ||
				supportY >= world.height ||
				!world.cells[supportKey]
			) {
				return { accepted: false, reason: "No support" };
			}
		}
	}

	// Service stack proximity: security/housekeeping must overlap an existing
	// 0x14/0x15 stack within the recovered search band (anchor-2 .. anchor+1).
	const familyCode = TILE_TO_FAMILY_CODE[normalizedTileType] ?? 0;
	if (familyCode === FAMILY_SECURITY || familyCode === FAMILY_HOUSEKEEPING) {
		const proposedFloor = yToFloor(y);
		let hasExisting = false;
		let overlaps = false;
		for (const [key, obj] of Object.entries(world.placedObjects)) {
			if (
				obj.objectTypeCode !== FAMILY_SECURITY &&
				obj.objectTypeCode !== FAMILY_HOUSEKEEPING
			) {
				continue;
			}
			hasExisting = true;
			const [, oy] = key.split(",").map(Number);
			const existingFloor = yToFloor(oy);
			if (
				proposedFloor >= existingFloor - 2 &&
				proposedFloor <= existingFloor + 1
			) {
				overlaps = true;
				break;
			}
		}
		if (hasExisting && !overlaps) {
			return {
				accepted: false,
				reason:
					"Service facility must be placed near an existing security or housekeeping stack",
			};
		}
	}

	// Apply placement
	for (const key of floorToRemove) delete world.cells[key];
	world.cells[`${x},${y}`] = normalizedTileType;
	for (let dx = 1; dx < tileWidth; dx++) {
		world.cells[`${x + dx},${y}`] = normalizedTileType;
		world.cellToAnchor[`${x + dx},${y}`] = `${x},${y}`;
	}
	ledger.cashBalance -= cost;

	// PlacedObjectRecord
	if (!INFRASTRUCTURE_TILES.has(normalizedTileType)) {
		world.placedObjects[`${x},${y}`] = make_placed_object(
			x,
			y,
			normalizedTileType,
			world,
			vipFlag,
		);
	}

	const patch: CellPatch[] = Array.from({ length: tileWidth }, (_, dx) => ({
		x: x + dx,
		y,
		tileType: normalizedTileType,
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
		if (
			overlayType === "elevator" ||
			overlayType === "elevatorExpress" ||
			overlayType === "elevatorService" ||
			overlayType === "escalator" ||
			overlayType === "stairs"
		) {
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
	const rec = world.placedObjects[anchorKey];
	if (rec) {
		if (rec.linkedRecordIndex >= 0) {
			free_sidecar(rec.linkedRecordIndex, world);
		}
		delete world.placedObjects[anchorKey];
	}

	cleanup_entities_for_removed_tile(world, ax, ay);

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

// ─── Rent level adjustment ────────────────────────────────────────────────────

/** Families that support rent level changes (rent_level 0-3). */
const RENT_ADJUSTABLE_FAMILIES = new Set([
	3,
	4,
	5,
	6,
	7,
	9,
	FAMILY_RETAIL,
	FAMILY_FAST_FOOD,
]);

export function handle_set_rent_level(
	x: number,
	y: number,
	rentLevel: number,
	world: WorldState,
	time: { daypartIndex: number; starCount: number },
): CommandResult {
	if (rentLevel < 0 || rentLevel > 3) {
		return { accepted: false, reason: "Rent level must be 0-3" };
	}
	const anchorKey = world.cellToAnchor[`${x},${y}`] ?? `${x},${y}`;
	const record = world.placedObjects[anchorKey];
	if (!record) {
		return { accepted: false, reason: "No facility here" };
	}
	if (!RENT_ADJUSTABLE_FAMILIES.has(record.objectTypeCode)) {
		return {
			accepted: false,
			reason: "This facility does not have adjustable rent",
		};
	}
	if (record.objectTypeCode === FAMILY_CONDO && record.unitStatus < 0x18) {
		return {
			accepted: false,
			reason: "Sold condos cannot change rent",
		};
	}
	record.rentLevel = rentLevel;
	record.needsRefreshFlag = 1;
	// Immediate recompute keeps the inspected facility in sync with the command.
	void time;
	return { accepted: true, patch: [] };
}

// ─── Elevator car management ─────────────────────────────────────────────────

export function handle_add_elevator_car(
	x: number,
	world: WorldState,
): CommandResult {
	const carrier = world.carriers.find((c) => c.column === x);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	const activeCars = carrier.cars.filter((c) => c.active).length;
	if (activeCars >= 8) {
		return { accepted: false, reason: "Maximum 8 cars per shaft" };
	}
	// Activate first inactive car
	for (const car of carrier.cars) {
		if (!car.active) {
			car.active = true;
			car.currentFloor = carrier.bottomServedFloor;
			car.targetFloor = carrier.bottomServedFloor;
			car.prevFloor = carrier.bottomServedFloor;
			car.homeFloor = carrier.bottomServedFloor;
			return { accepted: true, patch: [] };
		}
	}
	return { accepted: false, reason: "No car slots available" };
}

export function handle_remove_elevator_car(
	x: number,
	world: WorldState,
): CommandResult {
	const carrier = world.carriers.find((c) => c.column === x);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	const activeCars = carrier.cars.filter((c) => c.active);
	if (activeCars.length <= 1) {
		return { accepted: false, reason: "Must keep at least 1 car" };
	}
	const hasActiveTraffic =
		carrier.pendingRoutes.length > 0 ||
		carrier.cars.some(
			(car) =>
				car.assignedCount > 0 ||
				car.pendingAssignmentCount > 0 ||
				car.activeRouteSlots.some((slot) => slot.active),
		);
	if (hasActiveTraffic) {
		world.eventState.pendingCarrierEditColumn = x;
		world.pendingPrompts.push({
			promptId: `carrier_remove_${x}`,
			promptKind: "carrier_edit_confirmation",
			message:
				"Removing this elevator car will disrupt active traffic. Continue?",
		});
		return { accepted: true, patch: [] };
	}
	return apply_remove_elevator_car(world, x);
}

export function apply_remove_elevator_car(
	world: WorldState,
	x: number,
): CommandResult {
	const carrier = world.carriers.find((c) => c.column === x);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	const activeCars = carrier.cars.filter((c) => c.active);
	if (activeCars.length <= 1) {
		return { accepted: false, reason: "Must keep at least 1 car" };
	}
	const lastCar = activeCars[activeCars.length - 1];
	lastCar.active = false;
	lastCar.assignedCount = 0;
	lastCar.pendingAssignmentCount = 0;
	lastCar.pendingRouteIds = [];
	return { accepted: true, patch: [] };
}

// ─── Gap-fill helper ──────────────────────────────────────────────────────────

/** After a placement on row y, fill supported horizontal gaps with free floor tiles. */
export function fill_row_gaps(
	y: number,
	world: WorldState,
	patch: CellPatch[],
): void {
	const supportY = y >= UNDERGROUND_Y ? y - 1 : y + 1;
	if (supportY < 0 || supportY >= world.height) return;

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
		if (!world.cells[`${x},${supportY}`]) continue;
		world.cells[key] = "floor";
		patch.push({ x, y, tileType: "floor", isAnchor: true });
	}
}
