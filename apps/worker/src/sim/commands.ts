import { floorToSlot, makeCarrierCar, rebuildCarrierList } from "./carriers";
import { recomputeCommercialVenueBuckets } from "./families/entertainment";
import { type LedgerState, rebuildFacilityLedger } from "./ledger";
import { cancelRuntimeRouteRequest } from "./queue/cancel";
import {
	rebuildRouteReachabilityTables,
	rebuildTransferGroupCache,
} from "./reachability/rebuild-tables";
import { rebuildSpecialLinkRouteRecords } from "./reachability/special-link-records";
import {
	CARRIER_CAR_CONSTRUCTION_COST,
	CARRIER_EXTEND_FLOOR_COST,
	CINEMA_CLASSIC_MOVIE_COST,
	CINEMA_NEW_MOVIE_COST,
	FAMILY_CATHEDRAL_BASE,
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_METRO_BOTTOM,
	FAMILY_METRO_MIDDLE,
	FAMILY_METRO_TOP,
	FAMILY_OFFICE,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
	FAMILY_RECYCLING_CENTER_LOWER,
	FAMILY_RECYCLING_CENTER_UPPER,
	FAMILY_RETAIL,
	FAMILY_SECURITY,
	LEGACY_TILE_ALIASES,
	LEGACY_VIP_TILE_TO_STANDARD,
	TILE_COSTS,
	TILE_TO_FAMILY_CODE,
	TILE_WIDTHS,
	UNDERGROUND_ALLOWED_TILES,
	VALID_TILE_TYPES,
} from "./resources";
import {
	cleanupSimsForRemovedTile,
	rebuildParkingCoverage,
	rebuildParkingDemandLog,
	rebuildRuntimeSims,
} from "./sims";
import { invalidateMedicalSlotsForSidecar } from "./sims/medical";
import { clearSimRoute, simKey } from "./sims/population";
import {
	type CommercialVenueRecord,
	type EntertainmentLinkRecord,
	GRID_WIDTH,
	GROUND_Y,
	isValidLobbyY,
	type MedicalCenterRecord,
	type PlacedObjectRecord,
	type ServiceRequestEntry,
	sampleRng,
	UNDERGROUND_Y,
	VENUE_DORMANT,
	VENUE_PARTIAL,
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
	evalActiveFlag?: number;
	unitStatus?: number;
	evalLevel?: number;
	evalScore?: number;
	coverageFlag?: number;
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
	| { type: "add_elevator_car"; x: number; y: number }
	| { type: "remove_elevator_car"; x: number; y: number }
	| { type: "set_elevator_dwell_delay"; x: number; y: number; value: number }
	| {
			type: "set_elevator_waiting_car_response";
			x: number;
			y: number;
			value: number;
	  }
	| {
			type: "set_elevator_home_floor";
			x: number;
			carIndex: number;
			floor: number;
	  }
	| { type: "toggle_elevator_floor_stop"; x: number; floor: number }
	| {
			type: "set_cinema_movie_pool";
			x: number;
			y: number;
			pool: "classic" | "new";
	  };

// ─── Infrastructure tiles (no PlacedObjectRecord) ─────────────────────────────

const INFRASTRUCTURE_TILES = new Set(["floor", "stairs"]);
const CATHEDRAL_ANCHOR_LOGICAL_FLOOR = 103;
const CATHEDRAL_SLICE_COUNT = 5;
const METRO_STACK_TILE_TYPE = "metro";
const METRO_STACK_HEIGHT = 3;
const METRO_FAMILIES = [
	FAMILY_METRO_TOP,
	FAMILY_METRO_MIDDLE,
	FAMILY_METRO_BOTTOM,
] as const;

// Families whose rentLevel initialises to 1; all others initialise to 4 (no payout).
const VARIANT_INIT_ONE_FAMILIES = new Set([3, 4, 5, 7, 9, FAMILY_RETAIL]);

// ─── PlacedObjectRecord helpers ───────────────────────────────────────────────

const HOTEL_INIT_FAMILIES = new Set([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
]);

function makePlacedObject(
	x: number,
	y: number,
	tileType: string,
	world: WorldState,
	time: { daypartIndex: number },
	vipFlag = false,
): PlacedObjectRecord {
	const width = TILE_WIDTHS[tileType] ?? 1;
	const familyCode = TILE_TO_FAMILY_CODE[tileType] ?? 0;
	const sidecarIndex = allocSidecar(tileType, x, y, world);
	// Spec: hotel/condo start in vacant/unsold band (0x18 or 0x20 by half-day branch).
	// Office starts at 0x10 (unoccupied). Others start at 0.
	let unitStatus = 0;
	if (familyCode === FAMILY_OFFICE) {
		unitStatus = 0x10;
	} else if (
		HOTEL_INIT_FAMILIES.has(familyCode) ||
		familyCode === FAMILY_CONDO
	) {
		unitStatus = time.daypartIndex < 4 ? 0x18 : 0x20;
	}
	return {
		leftTileIndex: x,
		rightTileIndex: x + width - 1,
		objectTypeCode: familyCode,
		unitStatus,
		linkedRecordIndex: sidecarIndex,
		auxValueOrTimer: 0,
		evalLevel: 0xff,
		evalScore: -1,
		// Binary placement (place_object_on_floor 1200:1ee3/1ef4,
		// place_mergeable_span_object_on_floor 1200:2e81/2e92,
		// expand_type21_object_layout 11f0:00fb/010c etc.) writes both +0x13
		// and +0x14 = 1 on fresh placement.
		dirtyFlag: 1,
		occupiedFlag: 1,
		activationTickCount: 0,
		rentLevel: VARIANT_INIT_ONE_FAMILIES.has(familyCode) ? 1 : 4,
		housekeepingClaimedFlag: 0,
		vipFlag,
	};
}

function placeCathedralStack(
	x: number,
	y: number,
	world: WorldState,
	ledger: LedgerState,
	freeBuild: boolean,
): CommandResult {
	const tileType = "cathedral";
	const tileWidth = TILE_WIDTHS[tileType] ?? 28;
	const cost = TILE_COSTS[tileType] ?? 0;
	const logicalFloor = GROUND_Y - y;

	if (logicalFloor !== CATHEDRAL_ANCHOR_LOGICAL_FLOOR) {
		return { accepted: false, reason: "Cathedral must be placed on floor 103" };
	}
	if (
		world.gateFlags.evalSimIndex >= 0 &&
		world.gateFlags.evalSimIndex !== 0xffff
	) {
		return { accepted: false, reason: "Cathedral already placed" };
	}
	if (x + tileWidth - 1 >= world.width) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (!freeBuild && cost > ledger.cashBalance) {
		return { accepted: false, reason: "Insufficient funds" };
	}

	const rows = Array.from({ length: CATHEDRAL_SLICE_COUNT }, (_, i) => y + i);
	for (const rowY of rows) {
		if (rowY < 0 || rowY >= world.height) {
			return { accepted: false, reason: "Out of bounds" };
		}
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${rowY}`;
			if (world.cellToAnchor[key]) {
				return { accepted: false, reason: "Cell already occupied" };
			}
			const existing = world.cells[key];
			if (existing && existing !== "floor") {
				return { accepted: false, reason: "Cell already occupied" };
			}
		}
	}

	const bottomY = y + CATHEDRAL_SLICE_COUNT - 1;
	const supportY = bottomY + 1;
	for (let dx = 0; dx < tileWidth; dx++) {
		if (
			supportY < 0 ||
			supportY >= world.height ||
			!world.cells[`${x + dx},${supportY}`]
		) {
			return { accepted: false, reason: "No support" };
		}
	}

	for (const rowY of rows) {
		for (let dx = 0; dx < tileWidth; dx++) {
			delete world.cells[`${x + dx},${rowY}`];
		}
	}

	const visualAnchorKey = `${x},${y}`;
	const patch: CellPatch[] = [];
	for (let slice = 0; slice < CATHEDRAL_SLICE_COUNT; slice++) {
		const rowY = bottomY - slice;
		const familyCode = FAMILY_CATHEDRAL_BASE + slice;
		const objectKey = `${x},${rowY}`;
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${rowY}`;
			world.cells[key] = tileType;
			if (key !== visualAnchorKey) world.cellToAnchor[key] = visualAnchorKey;
			patch.push({
				x: x + dx,
				y: rowY,
				tileType,
				isAnchor: key === visualAnchorKey,
			});
		}
		world.placedObjects[objectKey] = {
			leftTileIndex: x,
			rightTileIndex: x + tileWidth - 1,
			objectTypeCode: familyCode,
			unitStatus: 0,
			linkedRecordIndex: -1,
			auxValueOrTimer: 0,
			evalLevel: 0xff,
			evalScore: -1,
			dirtyFlag: 1,
			occupiedFlag: 1,
			activationTickCount: 0,
			rentLevel: 4,
			housekeepingClaimedFlag: 0,
			vipFlag: false,
		};
	}

	world.gateFlags.evalSimIndex = yToFloor(bottomY);
	if (!freeBuild) ledger.cashBalance -= cost;

	for (const rowY of rows) fillRowGaps(rowY, world, patch);
	runGlobalRebuilds(world, ledger);

	return { accepted: true, patch, economyChanged: cost > 0 };
}

function placeMetroStationStack(
	x: number,
	y: number,
	world: WorldState,
	ledger: LedgerState,
	freeBuild: boolean,
	time: { daypartIndex: number },
): CommandResult {
	const tileWidth = TILE_WIDTHS.metro ?? 30;
	const cost = TILE_COSTS.metro ?? 0;
	if (world.gateFlags.metroStationFloorIndex >= 0) {
		return { accepted: false, reason: "Metro station already placed" };
	}
	if (y < UNDERGROUND_Y) {
		return {
			accepted: false,
			reason: "Metro station may only be placed underground",
		};
	}
	if (
		y + METRO_STACK_HEIGHT - 1 >= world.height ||
		x + tileWidth - 1 >= world.width
	) {
		return { accepted: false, reason: "Out of bounds" };
	}

	const stackCells = new Set<string>();
	for (let rowOffset = 0; rowOffset < METRO_STACK_HEIGHT; rowOffset++) {
		const rowY = y + rowOffset;
		for (let dx = 0; dx < tileWidth; dx++) {
			stackCells.add(`${x + dx},${rowY}`);
		}
	}

	const floorToRemove: string[] = [];
	for (const key of stackCells) {
		if (world.cellToAnchor[key]) {
			return { accepted: false, reason: "Cell already occupied" };
		}
		const existing = world.cells[key];
		if (!existing) continue;
		if (existing === "floor") {
			floorToRemove.push(key);
		} else {
			return { accepted: false, reason: "Cell already occupied" };
		}
	}

	for (let rowOffset = 0; rowOffset < METRO_STACK_HEIGHT; rowOffset++) {
		const rowY = y + rowOffset;
		for (let dx = 0; dx < tileWidth; dx++) {
			const supportY = rowY - 1;
			const supportKey = `${x + dx},${supportY}`;
			if (
				supportY < 0 ||
				(!world.cells[supportKey] && !stackCells.has(supportKey))
			) {
				return { accepted: false, reason: "No support" };
			}
		}
	}

	const initialStatus = time.daypartIndex < 4 ? 0 : 1;
	const shouldCharge = !freeBuild;
	if (shouldCharge && cost > ledger.cashBalance) {
		return { accepted: false, reason: "Insufficient funds" };
	}

	for (const key of floorToRemove) delete world.cells[key];

	const visualAnchorKey = `${x},${y}`;
	const patch: CellPatch[] = [];
	for (let rowOffset = 0; rowOffset < METRO_STACK_HEIGHT; rowOffset++) {
		const rowY = y + rowOffset;
		const objectKey = `${x},${rowY}`;
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${rowY}`;
			world.cells[key] = METRO_STACK_TILE_TYPE;
			if (key !== visualAnchorKey) world.cellToAnchor[key] = visualAnchorKey;
			patch.push({
				x: x + dx,
				y: rowY,
				tileType: METRO_STACK_TILE_TYPE,
				isAnchor: key === visualAnchorKey,
			});
		}
		world.placedObjects[objectKey] = {
			leftTileIndex: x,
			rightTileIndex: x + tileWidth - 1,
			objectTypeCode: METRO_FAMILIES[rowOffset],
			unitStatus: initialStatus,
			linkedRecordIndex: -1,
			auxValueOrTimer: 0,
			evalLevel: 0xff,
			evalScore: -1,
			dirtyFlag: 1,
			occupiedFlag: 1,
			activationTickCount: 0,
			rentLevel: 4,
			housekeepingClaimedFlag: 0,
			vipFlag: false,
		};
	}

	if (shouldCharge) ledger.cashBalance -= cost;
	world.gateFlags.metroPlaced = 1;
	world.gateFlags.metroStationFloorIndex = yToFloor(y);

	for (let rowOffset = 0; rowOffset < METRO_STACK_HEIGHT; rowOffset++) {
		fillRowGaps(y + rowOffset, world, patch);
	}
	runGlobalRebuilds(world, ledger);

	return { accepted: true, patch, economyChanged: shouldCharge && cost > 0 };
}

/** Allocate a sidecar for tiles that need one. Returns index or −1. */
function allocSidecar(
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
			capacity: 48,
			visitCount: 0,
			// Binary `allocate_facility_record` (11b0:07d3) link-disabled branch
			// seeds `record[+7] = 10`. For restaurant (family 6) this branch is
			// always taken; for fast-food/retail it's taken when (daypart != 0
			// || dayTick <= 240) — i.e. game-startup placement. The rebuild
			// at tick 240 (fastfood/retail) / tick 1600 (restaurant) rolls
			// this into yesterdayVisitCount and pushes +10 into the bucket.
			todayVisitCount: 10,
			yesterdayVisitCount: 0,
			acquireCount: 0,
			// Retail starts dormant (unrented); restaurant/fast-food start active
			availabilityState: tileType === "retail" ? VENUE_DORMANT : VENUE_PARTIAL,
			currentPopulation: 0,
			lastAcquireTick: 0,
			eligibilityThreshold: 0,
			remainingCapacity: 0,
			phaseASeed: 10,
			phaseBSeed: 10,
			overrideSeed: 10,
		};
		record = r;
	} else if (
		tileType === "recyclingCenterUpper" ||
		tileType === "recyclingCenterLower" ||
		tileType === "parking"
	) {
		const r: ServiceRequestEntry = {
			kind: "service_request",
			ownerSubtypeIndex: x,
			floorIndex: tileType === "parking" ? yToFloor(y) : undefined,
			coverageFlag: 0,
		};
		record = r;
	} else if (tileType === "medical") {
		const r: MedicalCenterRecord = {
			kind: "medical_center",
			ownerSubtypeIndex: x,
			pendingVisitorsCount: 0,
		};
		record = r;
	}
	// Cinema and party hall allocate their sidecar in placeEntertainmentVenue
	// (they share one sidecar across 4 / 2 sub-records).

	if (!record) return -1;
	world.sidecars.push(record);
	return world.sidecars.length - 1;
}

/** Mark a sidecar as invalid (demolished). */
function freeSidecar(index: number, world: WorldState): void {
	const rec = world.sidecars[index];
	if (rec) rec.ownerSubtypeIndex = 0xff;
}

function getOverlayAnchorKey(
	world: WorldState,
	x: number,
	y: number,
): string | null {
	const key = `${x},${y}`;
	return world.overlayToAnchor[key] ?? (world.overlays[key] ? key : null);
}

function elevatorModeForOverlay(
	type: string,
): "standard" | "express" | "service" | null {
	if (type === "elevator") return "standard";
	if (type === "elevatorExpress") return "express";
	if (type === "elevatorService") return "service";
	return null;
}

/**
 * Stairs may not horizontally overlap each other unless they share the
 * exact same anchor column (i.e. they're stacked floor-to-floor). Returns
 * true if any existing stair overlay shares column range with the proposed
 * placement at a different x.
 */
function hasOverlappingMisalignedStairs(
	world: WorldState,
	x: number,
	y: number,
	width: number,
): boolean {
	const newRight = x + width - 1;
	const otherWidth = TILE_WIDTHS.stairs ?? width;
	for (const [key, type] of Object.entries(world.overlays)) {
		if (type !== "stairs") continue;
		const [oxStr, oyStr] = key.split(",");
		const ox = Number(oxStr);
		const oy = Number(oyStr);
		if (ox === x && oy === y) continue;
		if (ox === x) continue;
		const otherRight = ox + otherWidth - 1;
		if (otherRight < x || ox > newRight) continue;
		return true;
	}
	return false;
}

function hasMisalignedAdjacentOverlay(
	world: WorldState,
	x: number,
	y: number,
	type: "elevator",
	width: number,
): boolean {
	for (const adjacentY of [y - 1, y + 1]) {
		if (adjacentY < 0 || adjacentY >= world.height) continue;
		const adjacentAnchors = new Set<string>();
		for (let dx = 0; dx < width; dx++) {
			const anchorKey = getOverlayAnchorKey(world, x + dx, adjacentY);
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

/**
 * Minimum empty-tile gap a shaft requires on each side, edge-to-edge.
 * Express shafts want 8 clear tiles; standard and service want 4. When
 * two shafts are adjacent, the required gap is `max` of the two.
 */
const ELEVATOR_STANDARD_MIN_GAP = 4;
const ELEVATOR_EXPRESS_MIN_GAP = 8;

/** Max contiguous floors a standard or service shaft may span. Express unlimited. */
const ELEVATOR_NONEXPRESS_MAX_FLOORS = 31;
/** Max total elevator shafts per tower. */
const ELEVATOR_MAX_SHAFTS = 24;

function shaftMinGap(mode: 0 | 1 | 2): number {
	return mode === 0 ? ELEVATOR_EXPRESS_MIN_GAP : ELEVATOR_STANDARD_MIN_GAP;
}

/**
 * Resolve a carrier whose served-floor range covers `floor` at column `x`.
 * Returns null when nothing is served there — disconnected segments at the
 * same column are independent carriers.
 */
function findCarrierByColumnAndFloor(
	world: WorldState,
	x: number,
	floor: number,
): WorldState["carriers"][number] | null {
	for (const c of world.carriers) {
		if (
			c.column === x &&
			floor >= c.bottomServedFloor &&
			floor <= c.topServedFloor
		)
			return c;
	}
	return null;
}

/**
 * Resolve a carrier from a click coordinate. Two carriers can share a column
 * if they are vertically separated, so the floor at `y` is required to pick
 * the right one — falls back to the closest segment when the click landed
 * outside any served range.
 */
function findCarrierAtClick(
	world: WorldState,
	x: number,
	y: number,
): WorldState["carriers"][number] | null {
	const floor = yToFloor(y);
	const direct = findCarrierByColumnAndFloor(world, x, floor);
	if (direct) return direct;
	let best: WorldState["carriers"][number] | null = null;
	let bestDistance = Infinity;
	for (const c of world.carriers) {
		if (c.column !== x) continue;
		const distance =
			floor < c.bottomServedFloor
				? c.bottomServedFloor - floor
				: floor - c.topServedFloor;
		if (distance < bestDistance) {
			best = c;
			bestDistance = distance;
		}
	}
	return best;
}

function overlayTypeToMode(type: string): 0 | 1 | 2 {
	if (type === "elevatorExpress") return 0;
	if (type === "elevatorService") return 2;
	return 1;
}

function carrierOverlayWidth(mode: 0 | 1 | 2): number {
	if (mode === 0) return TILE_WIDTHS.elevatorExpress ?? 6;
	if (mode === 2) return TILE_WIDTHS.elevatorService ?? 4;
	return TILE_WIDTHS.elevator ?? 4;
}

function tooCloseToExistingShaft(
	world: WorldState,
	x: number,
	width: number,
	newMode: 0 | 1 | 2,
): boolean {
	const newRight = x + width - 1;
	for (const carrier of world.carriers) {
		if (carrier.column === x) continue;
		const otherWidth = carrierOverlayWidth(carrier.carrierMode);
		const otherRight = carrier.column + otherWidth - 1;
		const gap =
			carrier.column > newRight
				? carrier.column - newRight - 1
				: x > otherRight
					? x - otherRight - 1
					: -1;
		const requiredGap = Math.max(
			shaftMinGap(newMode),
			shaftMinGap(carrier.carrierMode),
		);
		if (gap < requiredGap) return true;
	}
	return false;
}

function hasAdjacentElevatorModeConflict(
	world: WorldState,
	x: number,
	y: number,
	type: string,
	width: number,
): boolean {
	const mode = elevatorModeForOverlay(type);
	if (!mode) return false;

	for (const adjacentY of [y - 1, y + 1]) {
		if (adjacentY < 0 || adjacentY >= world.height) continue;
		for (let dx = 0; dx < width; dx++) {
			const anchorKey = getOverlayAnchorKey(world, x + dx, adjacentY);
			if (!anchorKey) continue;
			const adjacentType = world.overlays[anchorKey];
			const adjacentMode = adjacentType
				? elevatorModeForOverlay(adjacentType)
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
/**
 * Append a CellPatch for every parking-space anchor with its current
 * coverageFlag. Used after place/remove of a parkingRamp or parking tile so
 * the client can refresh distant parking visuals whose coverage changed.
 */
function appendParkingCoveragePatches(
	world: WorldState,
	patch: CellPatch[],
): void {
	for (const [key, obj] of Object.entries(world.placedObjects)) {
		if (obj.objectTypeCode !== TILE_TO_FAMILY_CODE.parking) continue;
		const [x, y] = key.split(",").map(Number);
		const sidecar = world.sidecars[obj.linkedRecordIndex];
		if (sidecar?.kind !== "service_request") continue;
		patch.push({
			x,
			y,
			tileType: "parking",
			isAnchor: true,
			coverageFlag: sidecar.coverageFlag ?? 0,
		});
	}
}

export function runGlobalRebuilds(
	world: WorldState,
	ledger: LedgerState,
): void {
	world.gateFlags.officePlaced = 0;
	world.gateFlags.metroPlaced = 0;
	world.gateFlags.metroStationFloorIndex = -1;
	world.gateFlags.securityPlaced = 0;
	world.gateFlags.vipSuiteFloor = 0xffff;
	world.gateFlags.recyclingCenterCount = 0;
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode === FAMILY_OFFICE)
			world.gateFlags.officePlaced = 1;
		if (object.objectTypeCode === FAMILY_METRO_TOP) {
			world.gateFlags.metroPlaced = 1;
			const [, y] = key.split(",").map(Number);
			world.gateFlags.metroStationFloorIndex = yToFloor(y);
		}
		if (object.objectTypeCode === FAMILY_SECURITY)
			world.gateFlags.securityPlaced = 1;
		if (object.objectTypeCode === FAMILY_RECYCLING_CENTER_UPPER)
			world.gateFlags.recyclingCenterCount += 1;
	}

	rebuildFacilityLedger(ledger, world);
	rebuildRuntimeSims(world);
	rebuildParkingCoverage(world);
	rebuildParkingDemandLog(world);
	rebuildCarrierList(world);
	rebuildSpecialLinkRouteRecords(world);
	rebuildRouteReachabilityTables(world);
	rebuildTransferGroupCache(world);
	recomputeCommercialVenueBuckets(world);
}

function hasRecyclingStackOverlap(
	world: WorldState,
	proposedFloor: number,
): boolean {
	let hasExisting = false;
	let overlaps = false;
	for (const [key, obj] of Object.entries(world.placedObjects)) {
		if (
			obj.objectTypeCode !== FAMILY_RECYCLING_CENTER_UPPER &&
			obj.objectTypeCode !== FAMILY_RECYCLING_CENTER_LOWER
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
	return !hasExisting || overlaps;
}

function placeRecyclingCenterStack(
	x: number,
	y: number,
	normalizedTileType: string,
	world: WorldState,
	ledger: LedgerState,
	freeBuild: boolean,
	time: { daypartIndex: number },
): CommandResult {
	const tileWidth = TILE_WIDTHS.recyclingCenterUpper ?? 2;
	const upperY = normalizedTileType === "recyclingCenterUpper" ? y : y - 1;
	const lowerY = upperY + 1;
	const cost = TILE_COSTS.recyclingCenter;

	if (
		upperY < 0 ||
		lowerY >= world.height ||
		x + tileWidth - 1 >= world.width
	) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (!freeBuild && cost > ledger.cashBalance) {
		return { accepted: false, reason: "Insufficient funds" };
	}
	if (!hasRecyclingStackOverlap(world, yToFloor(upperY))) {
		return {
			accepted: false,
			reason:
				"Recycling center must be placed near an existing recycling-center stack",
		};
	}

	const stackCells = new Set<string>();
	for (const rowY of [upperY, lowerY]) {
		for (let dx = 0; dx < tileWidth; dx++) {
			stackCells.add(`${x + dx},${rowY}`);
		}
	}

	const floorToRemove: string[] = [];
	for (const key of stackCells) {
		if (world.cellToAnchor[key]) {
			return { accepted: false, reason: "Cell already occupied" };
		}
		const existing = world.cells[key];
		if (existing) {
			if (existing === "floor") {
				floorToRemove.push(key);
			} else {
				return { accepted: false, reason: "Cell already occupied" };
			}
		}
	}

	for (const rowY of [upperY, lowerY]) {
		const supportY = rowY >= UNDERGROUND_Y ? rowY - 1 : rowY + 1;
		for (let dx = 0; dx < tileWidth; dx++) {
			const supportKey = `${x + dx},${supportY}`;
			if (
				supportY < 0 ||
				supportY >= world.height ||
				(!world.cells[supportKey] && !stackCells.has(supportKey))
			) {
				return { accepted: false, reason: "No support" };
			}
		}
	}

	for (const key of floorToRemove) delete world.cells[key];
	for (const [rowY, tileType] of [
		[upperY, "recyclingCenterUpper"],
		[lowerY, "recyclingCenterLower"],
	] as const) {
		world.cells[`${x},${rowY}`] = tileType;
		for (let dx = 1; dx < tileWidth; dx++) {
			world.cells[`${x + dx},${rowY}`] = tileType;
			world.cellToAnchor[`${x + dx},${rowY}`] = `${x},${rowY}`;
		}
		world.placedObjects[`${x},${rowY}`] = makePlacedObject(
			x,
			rowY,
			tileType,
			world,
			time,
		);
	}
	if (!freeBuild) ledger.cashBalance -= cost;

	const patch: CellPatch[] = [];
	for (const [rowY, tileType] of [
		[upperY, "recyclingCenterUpper"],
		[lowerY, "recyclingCenterLower"],
	] as const) {
		const record = world.placedObjects[`${x},${rowY}`];
		for (let dx = 0; dx < tileWidth; dx++) {
			patch.push({
				x: x + dx,
				y: rowY,
				tileType,
				isAnchor: dx === 0,
				...(dx === 0 && record
					? {
							// evalActiveFlag is the user-facing "scored/operational" bit:
							// binary +0x14 (occupied).
							evalActiveFlag: record.occupiedFlag,
							unitStatus: record.unitStatus,
						}
					: {}),
			});
		}
	}

	fillRowGaps(upperY, world, patch);
	fillRowGaps(lowerY, world, patch);
	runGlobalRebuilds(world, ledger);

	return { accepted: true, patch, economyChanged: cost > 0 };
}

/**
 * Sub-record layout for a cinema or party-hall placement. The binary splits
 * cinema placements through `split_entertainment_object_into_link_pair`
 * (1188:0352) into a stairway sub-object and a theater sub-object per floor,
 * yielding 4 PlacedObjectRecords per cinema. Party halls are not split —
 * they keep a single sub-object per floor (2 total).
 *
 * All sub-records for a single placement share one EntertainmentLinkRecord
 * sidecar (allocated by `register_entertainment_upper_half` @ 1188:01ad on
 * first upper-half dispatch; theater sub-records inherit the link index via
 * the adjacent-record read in `recompute_object_runtime_links_by_type`).
 */
interface EntertainmentSubRecord {
	offsetX: number;
	rowY: number;
	width: number;
	familyCode: number;
}

function cinemaSubRecords(
	x: number,
	upperY: number,
	lowerY: number,
): EntertainmentSubRecord[] {
	return [
		{
			offsetX: 0,
			rowY: upperY,
			width: 7,
			familyCode: FAMILY_CINEMA_STAIRS_UPPER,
		},
		{ offsetX: 7, rowY: upperY, width: 24, familyCode: FAMILY_CINEMA_LOWER },
		{
			offsetX: 0,
			rowY: lowerY,
			width: 7,
			familyCode: FAMILY_CINEMA_STAIRS_LOWER,
		},
		{ offsetX: 7, rowY: lowerY, width: 24, familyCode: FAMILY_CINEMA },
	].map((r) => ({ ...r, offsetX: x + r.offsetX }) as EntertainmentSubRecord);
}

function partyHallSubRecords(
	x: number,
	upperY: number,
	lowerY: number,
): EntertainmentSubRecord[] {
	return [
		{ offsetX: x, rowY: upperY, width: 27, familyCode: FAMILY_PARTY_HALL },
		{
			offsetX: x,
			rowY: lowerY,
			width: 27,
			familyCode: FAMILY_PARTY_HALL_LOWER,
		},
	];
}

function sampleCinemaInitialSelector(world: WorldState): number {
	// Binary placement reaches `allocate_entertainment_link_record` after the
	// deferred object rebuild path has consumed 13 placement-time RNG samples.
	for (let i = 0; i < 13; i++) sampleRng(world);
	return sampleRng(world) % 14;
}

function placeEntertainmentVenue(
	x: number,
	y: number,
	tileType: "cinema" | "partyHall",
	world: WorldState,
	ledger: LedgerState,
	freeBuild: boolean,
	time: { daypartIndex: number },
): CommandResult {
	const tileWidth = TILE_WIDTHS[tileType] ?? 1;
	const cost = TILE_COSTS[tileType] ?? 0;
	const upperY = y - 1;
	const lowerY = y;

	if (
		upperY < 0 ||
		lowerY >= world.height ||
		x + tileWidth - 1 >= world.width
	) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (!freeBuild && cost > ledger.cashBalance) {
		return { accepted: false, reason: "Insufficient funds" };
	}

	const structureCells = new Set<string>();
	for (const rowY of [upperY, lowerY]) {
		for (let dx = 0; dx < tileWidth; dx++) {
			structureCells.add(`${x + dx},${rowY}`);
		}
	}

	const floorToRemove: string[] = [];
	for (const key of structureCells) {
		if (world.cellToAnchor[key]) {
			return { accepted: false, reason: "Cell already occupied" };
		}
		const existing = world.cells[key];
		if (existing) {
			if (existing === "floor") {
				floorToRemove.push(key);
			} else {
				return { accepted: false, reason: "Cell already occupied" };
			}
		}
	}

	const supportY = lowerY >= UNDERGROUND_Y ? lowerY - 1 : lowerY + 1;
	if (supportY < 0 || supportY >= world.height) {
		return { accepted: false, reason: "No support" };
	}
	for (let dx = 0; dx < tileWidth; dx++) {
		const supportKey = `${x + dx},${supportY}`;
		if (!world.cells[supportKey] && !structureCells.has(supportKey)) {
			return { accepted: false, reason: "No support" };
		}
	}

	// Binary `allocate_entertainment_link_record` @ 1188:0073: `venue_selector`
	// (offset 7) is `rand() % 14` iff the registering sub-type is 0x22/0x23
	// (cinema stairway). Party hall (and any other caller) gets 0xff.
	const upperHalfFloor = yToFloor(lowerY);
	const lowerHalfFloor = upperHalfFloor - 1;
	const sidecar: EntertainmentLinkRecord = {
		kind: "entertainment_link",
		ownerSubtypeIndex: x,
		pairedSubtypeIndex: 0xff,
		familySelectorOrSingleLinkFlag:
			tileType === "cinema" ? sampleCinemaInitialSelector(world) : 0xff,
		linkAgeCounter: 0,
		upperBudget: 0,
		lowerBudget: 0,
		linkPhaseState: 0,
		pendingTransitionFlag: 0,
		attendanceCounter: 0,
		activeRuntimeCount: 0,
		lowerHalfFloor,
		upperHalfFloor,
	};
	world.sidecars.push(sidecar);
	const sidecarIndex = world.sidecars.length - 1;

	for (const key of floorToRemove) delete world.cells[key];

	// Lay down cells with the facility's visual tile string. All cells route
	// to the upper-left visual anchor for rendering/removal lookups.
	const visualAnchorKey = `${x},${upperY}`;
	for (const rowY of [upperY, lowerY]) {
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${rowY}`;
			world.cells[key] = tileType;
			if (key !== visualAnchorKey) world.cellToAnchor[key] = visualAnchorKey;
		}
	}

	// Emit one PlacedObjectRecord per binary sub-record, all sharing the
	// single sidecar. Keys use each sub-record's top-left position.
	const subs =
		tileType === "cinema"
			? cinemaSubRecords(x, upperY, lowerY)
			: partyHallSubRecords(x, upperY, lowerY);
	for (const sub of subs) {
		const key = `${sub.offsetX},${sub.rowY}`;
		world.placedObjects[key] = {
			leftTileIndex: sub.offsetX,
			rightTileIndex: sub.offsetX + sub.width - 1,
			objectTypeCode: sub.familyCode,
			unitStatus: 0,
			linkedRecordIndex: sidecarIndex,
			auxValueOrTimer: 0,
			evalLevel: 0xff,
			evalScore: -1,
			// split_entertainment_object_into_stairway_pair (1188:03b9/03ca,
			// 054f/0560) sets both flags on placement.
			dirtyFlag: 1,
			occupiedFlag: 1,
			activationTickCount: 0,
			rentLevel: 4,
			housekeepingClaimedFlag: 0,
			vipFlag: false,
		};
	}
	void time;

	if (!freeBuild) ledger.cashBalance -= cost;

	const anchorRecord = world.placedObjects[visualAnchorKey];
	const patch: CellPatch[] = [];
	for (const rowY of [upperY, lowerY]) {
		for (let dx = 0; dx < tileWidth; dx++) {
			const isAnchor = dx === 0 && rowY === upperY;
			patch.push({
				x: x + dx,
				y: rowY,
				tileType,
				isAnchor,
				...(isAnchor && anchorRecord
					? {
							evalActiveFlag: anchorRecord.occupiedFlag,
							unitStatus: anchorRecord.unitStatus,
						}
					: {}),
			});
		}
	}

	fillRowGaps(upperY, world, patch);
	fillRowGaps(lowerY, world, patch);
	runGlobalRebuilds(world, ledger);

	return { accepted: true, patch, economyChanged: cost > 0 };
}

// ─── Place tile ───────────────────────────────────────────────────────────────

export function handlePlaceTile(
	x: number,
	y: number,
	tileType: string,
	world: WorldState,
	ledger: LedgerState,
	freeBuild = false,
	time: { daypartIndex: number } = { daypartIndex: 0 },
): CommandResult {
	const normalizedTileType =
		LEGACY_TILE_ALIASES[LEGACY_VIP_TILE_TO_STANDARD[tileType] ?? tileType] ??
		LEGACY_VIP_TILE_TO_STANDARD[tileType] ??
		tileType;
	const vipFlag = tileType in LEGACY_VIP_TILE_TO_STANDARD;

	if (!VALID_TILE_TYPES.has(normalizedTileType)) {
		return { accepted: false, reason: "Invalid tile type" };
	}
	if (x < 0 || x >= world.width || y < 0 || y >= world.height) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (
		y >= UNDERGROUND_Y &&
		!UNDERGROUND_ALLOWED_TILES.has(normalizedTileType)
	) {
		return {
			accepted: false,
			reason: "This tile cannot be placed underground",
		};
	}

	if (normalizedTileType === METRO_STACK_TILE_TYPE) {
		return placeMetroStationStack(x, y, world, ledger, freeBuild, time);
	}

	const metroFloor = world.gateFlags.metroStationFloorIndex;
	const targetFloor = yToFloor(y);
	if (
		metroFloor >= 0 &&
		(normalizedTileType === "cinema" ||
			normalizedTileType === "partyHall" ||
			normalizedTileType === "recyclingCenter" ||
			normalizedTileType === "recyclingCenterUpper") &&
		targetFloor < metroFloor
	) {
		return {
			accepted: false,
			reason: "This facility cannot be placed below the metro station",
		};
	}

	if (normalizedTileType === "cinema" || normalizedTileType === "partyHall") {
		return placeEntertainmentVenue(
			x,
			y,
			normalizedTileType,
			world,
			ledger,
			freeBuild,
			time,
		);
	}

	if (normalizedTileType === "cathedral") {
		return placeCathedralStack(x, y, world, ledger, freeBuild);
	}

	if (
		normalizedTileType === "recyclingCenter" ||
		normalizedTileType === "recyclingCenterUpper" ||
		normalizedTileType === "recyclingCenterLower"
	) {
		return placeRecyclingCenterStack(
			x,
			y,
			normalizedTileType,
			world,
			ledger,
			freeBuild,
			time,
		);
	}

	// ── Elevator: overlay on a floor/lobby tile ─────────────────────────────────
	if (
		normalizedTileType === "elevator" ||
		normalizedTileType === "elevatorExpress" ||
		normalizedTileType === "elevatorService"
	) {
		const patch: CellPatch[] = [];
		const overlayWidth = TILE_WIDTHS[normalizedTileType] ?? 1;
		if (
			world.gateFlags.metroStationFloorIndex >= 0 &&
			yToFloor(y) < world.gateFlags.metroStationFloorIndex - 1
		) {
			return {
				accepted: false,
				reason: "Elevator cannot extend below the metro station",
			};
		}
		if (x + overlayWidth - 1 >= world.width) {
			return { accepted: false, reason: "Out of bounds" };
		}
		for (let dx = 0; dx < overlayWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (world.overlays[key] || world.overlayToAnchor[key]) {
				return { accepted: false, reason: "Cell already has an overlay" };
			}
		}
		// Shaft creation charges the base tile cost on the first segment
		// at a column. Later floors extending an existing shaft charge
		// a per-floor extension cost (binary: `charge_floor_range_construction_cost`
		// at 1180:02e5, called from `FUN_10a8_0819`/`FUN_10a8_0b87`).
		// A placement only counts as an extension when it is vertically
		// adjacent to (or inside) an existing same-column shaft — disconnected
		// segments at the same column form independent carriers.
		const placedFloor = yToFloor(y);
		const isNewShaft = !world.carriers.some(
			(c) =>
				c.column === x &&
				placedFloor >= c.bottomServedFloor - 1 &&
				placedFloor <= c.topServedFloor + 1,
		);
		const shaftMode = overlayTypeToMode(normalizedTileType);
		const shaftCost = isNewShaft
			? (TILE_COSTS[normalizedTileType] ?? 0)
			: (CARRIER_EXTEND_FLOOR_COST[shaftMode] ?? 0);
		if (!freeBuild && shaftCost > ledger.cashBalance) {
			return { accepted: false, reason: "Insufficient funds" };
		}
		if (isNewShaft && world.carriers.length >= ELEVATOR_MAX_SHAFTS) {
			return {
				accepted: false,
				reason: `Maximum ${ELEVATOR_MAX_SHAFTS} elevator shafts per tower`,
			};
		}
		if (normalizedTileType !== "elevatorExpress") {
			let topY = y;
			let bottomY = y;
			while (
				topY > 0 &&
				world.overlays[`${x},${topY - 1}`] === normalizedTileType
			)
				topY -= 1;
			while (
				bottomY < world.height - 1 &&
				world.overlays[`${x},${bottomY + 1}`] === normalizedTileType
			)
				bottomY += 1;
			if (bottomY - topY + 1 > ELEVATOR_NONEXPRESS_MAX_FLOORS) {
				return {
					accepted: false,
					reason: `${normalizedTileType === "elevatorService" ? "Service" : "Standard"} shaft may span at most ${ELEVATOR_NONEXPRESS_MAX_FLOORS} floors`,
				};
			}
		}
		if (
			isNewShaft &&
			tooCloseToExistingShaft(world, x, overlayWidth, shaftMode)
		) {
			return {
				accepted: false,
				reason: "Elevator too close to an adjacent shaft",
			};
		}
		if (
			(normalizedTileType === "elevator" ||
				normalizedTileType === "elevatorExpress" ||
				normalizedTileType === "elevatorService") &&
			hasMisalignedAdjacentOverlay(world, x, y, "elevator", overlayWidth)
		) {
			return {
				accepted: false,
				reason: "Elevator must align with adjacent shaft segments",
			};
		}
		if (
			hasAdjacentElevatorModeConflict(
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
		if (!freeBuild) ledger.cashBalance -= shaftCost;
		runGlobalRebuilds(world, ledger);
		return { accepted: true, patch };
	}

	// ── Stairs / Escalator: bridge overlay on existing base tiles ─────────────
	if (normalizedTileType === "stairs" || normalizedTileType === "escalator") {
		const overlayWidth = TILE_WIDTHS[normalizedTileType] ?? 1;
		const overlayCost = TILE_COSTS[normalizedTileType] ?? 0;
		if (x + overlayWidth - 1 >= GRID_WIDTH) {
			return { accepted: false, reason: "Out of bounds" };
		}
		if (!freeBuild && overlayCost > ledger.cashBalance) {
			return { accepted: false, reason: "Insufficient funds" };
		}
		const baseRequiredLabel =
			normalizedTileType === "stairs" ? "Stairs" : "Escalators";
		for (let dx = 0; dx < overlayWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (!world.cells[key] && !world.cellToAnchor[key]) {
				return {
					accepted: false,
					reason: `${baseRequiredLabel} require a base tile`,
				};
			}
			if (world.overlays[key] || world.overlayToAnchor[key]) {
				return { accepted: false, reason: "Cell already has an overlay" };
			}
		}
		if (y === GROUND_Y) {
			for (let dx = 0; dx < overlayWidth; dx++) {
				const upperLandingKey = `${x + dx},${y - 1}`;
				if (
					!world.cells[upperLandingKey] &&
					!world.cellToAnchor[upperLandingKey]
				) {
					return {
						accepted: false,
						reason: `${baseRequiredLabel} require a base tile on the floor above`,
					};
				}
			}
		}
		if (
			normalizedTileType === "stairs" &&
			hasOverlappingMisalignedStairs(world, x, y, overlayWidth)
		) {
			return {
				accepted: false,
				reason:
					"Stairs must align with existing stairs in the same column or not overlap them",
			};
		}
		world.overlays[`${x},${y}`] = normalizedTileType;
		for (let dx = 1; dx < overlayWidth; dx++) {
			world.overlayToAnchor[`${x + dx},${y}`] = `${x},${y}`;
		}
		if (!freeBuild) ledger.cashBalance -= overlayCost;
		runGlobalRebuilds(world, ledger);
		return {
			accepted: true,
			patch: [
				{
					x,
					y,
					tileType: normalizedTileType,
					isAnchor: true,
					isOverlay: true,
				},
			],
		};
	}

	// ── Standard tile placement ───────────────────────────────────────────────
	const tileWidth = TILE_WIDTHS[normalizedTileType] ?? 1;
	const cost = TILE_COSTS[normalizedTileType] ?? 0;

	if (x + tileWidth - 1 >= world.width) {
		return { accepted: false, reason: "Out of bounds" };
	}
	if (normalizedTileType === "lobby" && !isValidLobbyY(y, world.lobbyMode)) {
		const cadence = world.lobbyMode === "modern" ? "15" : "14, then 15";
		return {
			accepted: false,
			reason: `Lobby only allowed on ground floor or every 15 floors above (offsets +${cadence})`,
		};
	}
	if (!freeBuild && cost > ledger.cashBalance) {
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

	// Tiles need support from the adjacent row (below for above-ground; above
	// for underground). Only the ground-floor lobby is exempt — sky lobbies
	// still require support like any other tile.
	if (!(normalizedTileType === "lobby" && y === GROUND_Y)) {
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

	// Parking ramps live underground and stack downward: the topmost ramp sits
	// at the row just below the ground floor (y === UNDERGROUND_Y), and each
	// ramp below must hang off the ramp one row above it.
	if (normalizedTileType === "parkingRamp") {
		if (y < UNDERGROUND_Y) {
			return {
				accepted: false,
				reason: "Parking ramps may only be placed underground",
			};
		}
		const isTopOfStack = y === UNDERGROUND_Y;
		const rampAboveKey = `${x},${y - 1}`;
		const hasRampAbove = world.cells[rampAboveKey] === "parkingRamp";
		if (!isTopOfStack && !hasRampAbove) {
			return {
				accepted: false,
				reason:
					"Parking ramp must hang from the row above (top of stack at floor B1)",
			};
		}
	}

	// Recycling-center stacks must overlap an existing 0x14/0x15 stack within
	// the recovered search band (anchor-2 .. anchor+1).
	const familyCode = TILE_TO_FAMILY_CODE[normalizedTileType] ?? 0;
	if (
		familyCode === FAMILY_RECYCLING_CENTER_UPPER ||
		familyCode === FAMILY_RECYCLING_CENTER_LOWER
	) {
		const proposedFloor = yToFloor(y);
		let hasExisting = false;
		let overlaps = false;
		for (const [key, obj] of Object.entries(world.placedObjects)) {
			if (
				obj.objectTypeCode !== FAMILY_RECYCLING_CENTER_UPPER &&
				obj.objectTypeCode !== FAMILY_RECYCLING_CENTER_LOWER
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
					"Recycling center must be placed near an existing recycling-center stack",
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
	if (!freeBuild) ledger.cashBalance -= cost;

	// PlacedObjectRecord
	if (!INFRASTRUCTURE_TILES.has(normalizedTileType)) {
		world.placedObjects[`${x},${y}`] = makePlacedObject(
			x,
			y,
			normalizedTileType,
			world,
			time,
			vipFlag,
		);
	}

	const record = world.placedObjects[`${x},${y}`];
	const patch: CellPatch[] = Array.from({ length: tileWidth }, (_, dx) => ({
		x: x + dx,
		y,
		tileType: normalizedTileType,
		isAnchor: dx === 0,
		...(dx === 0 && record
			? {
					evalActiveFlag: record.occupiedFlag,
					unitStatus: record.unitStatus,
				}
			: {}),
	}));

	fillRowGaps(y, world, patch);

	runGlobalRebuilds(world, ledger);

	if (
		normalizedTileType === "parking" ||
		normalizedTileType === "parkingRamp"
	) {
		appendParkingCoveragePatches(world, patch);
	}

	return { accepted: true, patch, economyChanged: cost > 0 };
}

// ─── Remove tile ──────────────────────────────────────────────────────────────

export function handleRemoveTile(
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
			runGlobalRebuilds(world, ledger);
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
	const isTwoFloor = tileType === "cinema" || tileType === "partyHall";
	const isCathedral = tileType === "cathedral";
	const isMetro = tileType === METRO_STACK_TILE_TYPE;
	const occupiedRows = isCathedral
		? Array.from({ length: CATHEDRAL_SLICE_COUNT }, (_, i) => ay + i)
		: isMetro
			? Array.from({ length: METRO_STACK_HEIGHT }, (_, i) => ay + i)
			: isTwoFloor
				? [ay, ay + 1]
				: [ay];
	// "Above" for turnToFloor considers the row above the topmost occupied row.
	const topRow = occupiedRows[0];
	// The lowest occupied row decides neighbour-in-row (left/right) logic and
	// is where the replacement floor would sit.
	const baseRow = occupiedRows[occupiedRows.length - 1];

	// Determine replacement: floor if anything sits above or tile is between neighbours
	let hasAbove = false;
	for (let dx = 0; dx < tileWidth && !hasAbove; dx++) {
		if (world.cells[`${ax + dx},${topRow - 1}`]) hasAbove = true;
	}
	let hasLeft = false;
	for (let lx = ax - 1; lx >= 0 && !hasLeft; lx--) {
		if (world.cells[`${lx},${baseRow}`]) hasLeft = true;
	}
	let hasRight = false;
	for (let rx = ax + tileWidth; rx < world.width && !hasRight; rx++) {
		if (world.cells[`${rx},${baseRow}`]) hasRight = true;
	}
	const turnToFloor = hasAbove || (hasLeft && hasRight);

	for (const rowY of occupiedRows) {
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${ax + dx},${rowY}`;
			delete world.cells[key];
			if (key !== anchorKey) delete world.cellToAnchor[key];
		}
	}

	// Remove PlacedObjectRecord(s) and free sidecar.
	// Entertainment venues (cinema / party hall) store 4 / 2 sub-records that
	// share one sidecar; collect all records referencing the same sidecar
	// within the placement footprint before deleting.
	const subRecordKeys =
		isTwoFloor || isCathedral || isMetro
			? Object.keys(world.placedObjects).filter((key) => {
					const [kx, ky] = key.split(",").map(Number);
					return (
						ky >= ay &&
						ky <= occupiedRows[occupiedRows.length - 1] &&
						kx >= ax &&
						kx <= ax + tileWidth - 1
					);
				})
			: [anchorKey];

	const freedSidecars = new Set<number>();
	for (const key of subRecordKeys) {
		const rec = world.placedObjects[key];
		if (!rec) continue;
		if (
			rec.linkedRecordIndex >= 0 &&
			!freedSidecars.has(rec.linkedRecordIndex)
		) {
			const sidecar = world.sidecars[rec.linkedRecordIndex];
			if (sidecar?.kind === "medical_center") {
				invalidateMedicalSlotsForSidecar(world, rec.linkedRecordIndex);
			}
			freeSidecar(rec.linkedRecordIndex, world);
			freedSidecars.add(rec.linkedRecordIndex);
		}
		delete world.placedObjects[key];
	}
	if (isCathedral) world.gateFlags.evalSimIndex = 0xffff;
	if (isMetro) {
		world.gateFlags.metroPlaced = 0;
		world.gateFlags.metroStationFloorIndex = -1;
	}

	cleanupSimsForRemovedTile(world, ax, ay);

	const patch: CellPatch[] = [];
	for (const rowY of occupiedRows) {
		const emitFloor = turnToFloor && rowY === baseRow;
		for (let dx = 0; dx < tileWidth; dx++) {
			const resultType = emitFloor ? "floor" : "empty";
			if (emitFloor) world.cells[`${ax + dx},${rowY}`] = "floor";
			patch.push({
				x: ax + dx,
				y: rowY,
				tileType: resultType,
				isAnchor: true,
			});
		}
	}

	runGlobalRebuilds(world, ledger);

	if (tileType === "parking" || tileType === "parkingRamp") {
		appendParkingCoveragePatches(world, patch);
	}

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

export function handleSetRentLevel(
	x: number,
	y: number,
	rentLevel: number,
	world: WorldState,
	time: { daypartIndex: number },
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
	// Immediate recompute keeps the inspected facility in sync with the command.
	void time;
	return { accepted: true, patch: [] };
}

// ─── Cinema movie pool ───────────────────────────────────────────────────────

const CINEMA_FAMILY_CODES = new Set([
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
]);

/**
 * Cycle the cinema's movie selector within the chosen pool and charge the
 * player. Mirrors `MOVIETITLEDIALOGFILTER` WM_COMMAND case 1 (new) / case 3
 * (classic) at 0x1108:45C1: classic = `(cur+1)%7`, new = `((cur+1)%7)+7`,
 * both reset `link_age_counter` so the next 240 rebuild reseeds budgets from
 * age tier 0.
 */
export function handleSetCinemaMoviePool(
	x: number,
	y: number,
	pool: "classic" | "new",
	world: WorldState,
	ledger: LedgerState,
	freeBuild: boolean,
): CommandResult {
	const anchorKey = world.cellToAnchor[`${x},${y}`] ?? `${x},${y}`;
	const record = world.placedObjects[anchorKey];
	if (!record || !CINEMA_FAMILY_CODES.has(record.objectTypeCode)) {
		return { accepted: false, reason: "Not a cinema" };
	}
	const sidecar = world.sidecars[record.linkedRecordIndex];
	if (!sidecar || sidecar.kind !== "entertainment_link") {
		return { accepted: false, reason: "Cinema sidecar missing" };
	}
	if (sidecar.familySelectorOrSingleLinkFlag === 0xff) {
		return { accepted: false, reason: "Not a cinema" };
	}

	const cost =
		pool === "classic" ? CINEMA_CLASSIC_MOVIE_COST : CINEMA_NEW_MOVIE_COST;
	if (!freeBuild && ledger.cashBalance < cost) {
		return { accepted: false, reason: "Insufficient funds" };
	}

	const cur = sidecar.familySelectorOrSingleLinkFlag;
	const next = pool === "classic" ? (cur + 1) % 7 : ((cur + 1) % 7) + 7;
	sidecar.familySelectorOrSingleLinkFlag = next;
	sidecar.linkAgeCounter = 0;

	if (!freeBuild) ledger.cashBalance -= cost;

	return { accepted: true, patch: [], economyChanged: !freeBuild };
}

// ─── Elevator car management ─────────────────────────────────────────────────

export function handleAddElevatorCar(
	x: number,
	y: number,
	world: WorldState,
	ledger: LedgerState,
	freeBuild: boolean,
): CommandResult {
	const carrier = findCarrierAtClick(world, x, y);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	const activeCars = carrier.cars.filter((c) => c.active).length;
	if (activeCars >= 8) {
		return { accepted: false, reason: "Maximum 8 cars per shaft" };
	}
	const cost = CARRIER_CAR_CONSTRUCTION_COST[carrier.carrierMode] ?? 0;
	if (!freeBuild && cost > ledger.cashBalance) {
		return { accepted: false, reason: "Insufficient funds" };
	}
	if (!freeBuild) ledger.cashBalance -= cost;
	// Binary add-car branch (place_carrier_shaft at an existing column)
	// stores `param_3` — the click's floor — at each car's home_floor byte
	// (carrier +0xBA..0xC1). Use the same convention so per-car home
	// tracking matches the emulator's build_carrier output.
	const clicked = yToFloor(y);
	const homeFloor = Math.max(
		carrier.bottomServedFloor,
		Math.min(carrier.topServedFloor, clicked),
	);
	// Activate first inactive car
	for (const car of carrier.cars) {
		if (!car.active) {
			car.active = true;
			car.currentFloor = homeFloor;
			car.targetFloor = homeFloor;
			car.prevFloor = homeFloor;
			car.homeFloor = homeFloor;
			return { accepted: true, patch: [] };
		}
	}
	// All existing cars are active — add a new one
	const newCar = makeCarrierCar(
		carrier.topServedFloor - carrier.bottomServedFloor + 1,
		homeFloor,
	);
	carrier.cars.push(newCar);
	return { accepted: true, patch: [] };
}

export function handleRemoveElevatorCar(
	x: number,
	y: number,
	world: WorldState,
): CommandResult {
	const carrier = findCarrierAtClick(world, x, y);
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
		world.eventState.pendingCarrierEditY = y;
		world.pendingPrompts.push({
			promptId: `carrier_remove_${x}_${y}`,
			promptKind: "carrier_edit_confirmation",
			message:
				"Removing this elevator car will disrupt active traffic. Continue?",
		});
		return { accepted: true, patch: [] };
	}
	return applyRemoveElevatorCar(world, x, y);
}

export function applyRemoveElevatorCar(
	world: WorldState,
	x: number,
	y: number,
): CommandResult {
	const carrier = findCarrierAtClick(world, x, y);
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

export function handleSetElevatorDwellDelay(
	x: number,
	y: number,
	value: number,
	world: WorldState,
): CommandResult {
	const carrier = findCarrierAtClick(world, x, y);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	carrier.dwellDelay = new Array(14).fill(value);
	return { accepted: true, patch: [] };
}

export function handleSetElevatorWaitingCarResponse(
	x: number,
	y: number,
	value: number,
	world: WorldState,
): CommandResult {
	const carrier = findCarrierAtClick(world, x, y);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	carrier.waitingCarResponseThreshold = value;
	return { accepted: true, patch: [] };
}

export function handleSetElevatorHomeFloor(
	x: number,
	carIndex: number,
	floor: number,
	world: WorldState,
): CommandResult {
	const carrier = findCarrierByColumnAndFloor(world, x, floor);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	const activeCars = carrier.cars.filter((c) => c.active);
	const car = activeCars[carIndex];
	if (!car) {
		return { accepted: false, reason: "Car not found" };
	}
	if (floorToSlot(carrier, floor) < 0) {
		return { accepted: false, reason: "Floor not served by this elevator" };
	}
	car.homeFloor = floor;
	return { accepted: true, patch: [] };
}

export function handleToggleElevatorFloorStop(
	x: number,
	floor: number,
	world: WorldState,
): CommandResult {
	const carrier = findCarrierByColumnAndFloor(world, x, floor);
	if (!carrier) {
		return { accepted: false, reason: "No elevator at this column" };
	}
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) {
		return { accepted: false, reason: "Floor not served by this elevator" };
	}
	const wasEnabled = (carrier.stopFloorEnabled[slot] ?? 1) !== 0;
	carrier.stopFloorEnabled[slot] = wasEnabled ? 0 : 1;

	// Binary FUN_10a8_0085 follow-up: when disabling, FUN_10a8_14cc clears
	// route-status slots so cars en route to the disabled floor get
	// re-targeted on the next recompute. Mirror by zeroing primary/secondary
	// per-floor status and decrementing the assigned car's pending count.
	if (wasEnabled) {
		const primaryTag = carrier.primaryRouteStatusByFloor[slot] ?? 0;
		if (primaryTag !== 0) {
			carrier.primaryRouteStatusByFloor[slot] = 0;
			const car = carrier.cars[primaryTag - 1];
			if (car && car.pendingAssignmentCount > 0)
				car.pendingAssignmentCount -= 1;
		}
		const secondaryTag = carrier.secondaryRouteStatusByFloor[slot] ?? 0;
		if (secondaryTag !== 0) {
			carrier.secondaryRouteStatusByFloor[slot] = 0;
			const car = carrier.cars[secondaryTag - 1];
			if (car && car.pendingAssignmentCount > 0)
				car.pendingAssignmentCount -= 1;
		}

		// Sims with a pending route touching the disabled floor would otherwise
		// stay in line forever — visually, riders queue up and the elevator
		// never arrives (or arrives without being able to drop them off).
		// Evict every not-yet-boarded route whose source OR destination is the
		// disabled floor, then clear each sim's route so the family state
		// machine re-resolves on its next tick (which now scores the disabled
		// floor as ineligible and picks a peer carrier or transfer).
		const evictedIds = carrier.pendingRoutes
			.filter(
				(route) =>
					!route.boarded &&
					(route.sourceFloor === floor || route.destinationFloor === floor),
			)
			.map((route) => route.simId);
		for (const evictedId of evictedIds) {
			cancelRuntimeRouteRequest(carrier, evictedId);
		}
		if (evictedIds.length > 0) {
			const evictedSet = new Set(evictedIds);
			for (const sim of world.sims) {
				if (evictedSet.has(simKey(sim))) clearSimRoute(sim);
			}
		}
	}

	// Binary FUN_10a8_0085 unconditionally rebuilds the transfer-group cache
	// and route-reachability tables after any toggle.
	rebuildTransferGroupCache(world);
	rebuildRouteReachabilityTables(world);

	return { accepted: true, patch: [] };
}

// ─── Gap-fill helper ──────────────────────────────────────────────────────────

/** After a placement on row y, fill supported horizontal gaps with free floor tiles. */
export function fillRowGaps(
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
