import type { RouteRequestRing } from "./queue/route-record";

// Grid and floor model constants
export const GRID_WIDTH = 375;
export const GRID_HEIGHT = 120; // floor indices 0–119; floor 10 = ground ("0"), floor 119 = top

/** Convert grid Y coordinate to floor index (0=bottom underground, 119=top). */
export function yToFloor(y: number): number {
	return GRID_HEIGHT - 1 - y;
}

/** Convert floor index to grid Y coordinate. */
export function floorToY(floor: number): number {
	return GRID_HEIGHT - 1 - floor;
}
export const UNDERGROUND_FLOORS = 10; // floors 0–9 underground; floor 10 = ground ("0")
export const UNDERGROUND_Y = GRID_HEIGHT - UNDERGROUND_FLOORS; // Y=110: first underground row
export const GROUND_Y = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS; // Y=109: ground lobby row

/**
 * Lobby placement mode.
 *   "perfect-parity": ground + sky lobbies at floors 0, 14, 29, 44, ...
 *     (matches the SimTower binary's express-stop convention; required for
 *     trace-test parity).
 *   "modern": ground + sky lobbies at floors 0, 15, 30, 45, ... (cleaner
 *     every-15 cadence; used for new towers in modern play).
 */
export type LobbyMode = "perfect-parity" | "modern";

export const DEFAULT_LOBBY_MODE: LobbyMode = "modern";

/** True iff the given Y is a valid lobby row for the given lobby mode. */
export function isValidLobbyY(y: number, mode: LobbyMode): boolean {
	const floorsAboveGround = GROUND_Y - y;
	if (floorsAboveGround < 0) return false;
	if (floorsAboveGround === 0) return true;
	const offset = mode === "modern" ? 0 : 14;
	return floorsAboveGround % 15 === offset;
}

// ─── PRNG ────────────────────────────────────────────────────────────────────

/** Sample a 15-bit LCG value from the world RNG and advance its state.
 * 32-bit LCG: state = state * 0x15a4e35 + 1 (mod 2^32).
 * Returns upper 15 bits: (state >>> 16) & 0x7fff. */
// DEBUG SHIM toggle for RNG call tracing (flipped on from test harness around
// the tick we want to inspect). Keep this alongside the sampler so toggling it
// at a single site is safe.
export const __RNG_TRACE = { on: false };

export function sampleRng(world: WorldState): number {
	world.rngState = (Math.imul(world.rngState, 0x15a4e35) + 1) | 0;
	world.rngCallCount += 1;
	if (__RNG_TRACE.on) {
		const stack = new Error().stack ?? "";
		const lines = stack
			.split("\n")
			.slice(2, 8)
			.map((l) => l.trim())
			.join(" | ");
		console.log(`[RNG ${world.rngCallCount}] ${lines}`);
	}
	return (world.rngState >>> 16) & 0x7fff;
}

// ─── Carrier types ────────────────────────────────────────────────────────────

export interface CarrierCar {
	active: boolean;
	currentFloor: number;
	settleCounter: number;
	dwellCounter: number;
	assignedCount: number;
	pendingAssignmentCount: number;
	dwellStartPendingAssignmentCount: number;
	/** 0 = downward, 1 = upward (matches binary convention). */
	directionFlag: number;
	targetFloor: number;
	prevFloor: number;
	homeFloor: number;
	/**
	 * Binary -0x51 nearest_work_floor: scan-direction nearest floor with
	 * pending work for this car (queued rider OR primary/secondary slot ==
	 * carIndex+1), with `homeFloor` as the no-work fallback. Maintained at
	 * the end of `recomputeCarTargetAndDirection`. Used as the wrap-cost
	 * "turn floor" in `findBestAvailableCarForFloor` and as the idle-home
	 * test (current == nearest_work_floor) in the same routine.
	 */
	nearestWorkFloor: number;
	scheduleFlag: number;
	/** Binary -0x57: latch set once car reaches a target; gates A1 dwell write. */
	arrivalSeen: number;
	/** Binary -0x56: dayTick latched when A1 fires. */
	arrivalTick: number;
	arrivalDispatchThisTick: boolean;
	arrivalDispatchStartingAssignedCount: number;
	suppressDwellOppositeDirectionFlip: boolean;
	/** Waiting sim count indexed by floor slot. */
	waitingCount: number[];
	destinationCountByFloor: number[];
	nonemptyDestinationCount: number;
	activeRouteSlots: CarrierRouteSlot[];
	pendingRouteIds: string[];
}

export interface CarrierRouteSlot {
	routeId: string;
	sourceFloor: number;
	destinationFloor: number;
	boarded: boolean;
	active: boolean;
}

export interface CarrierFloorQueue {
	up: RouteRequestRing;
	down: RouteRequestRing;
}

export interface CarrierPendingRoute {
	simId: string;
	sourceFloor: number;
	destinationFloor: number;
	boarded: boolean;
	directionFlag: number;
	assignedCarIndex: number;
}

export interface CarrierRecord {
	carrierId: number;
	/** X column of the shaft. */
	column: number;
	/**
	 * 0 = Express Elevator, 1 = Standard Elevator, 2 = Service Elevator.
	 * The route scorer treats modes 0/1 as local-mode and mode 2 as the
	 * express long-hop carrier. Escalators are NOT carriers — they are
	 * special-link segments.
	 */
	carrierMode: 0 | 1 | 2;
	topServedFloor: number;
	bottomServedFloor: number;
	/** 14 entries: 7 dayparts × 2 calendar phases. 1 = floor served, 0 = skipped. */
	servedFloorFlags: number[];
	primaryRouteStatusByFloor: number[];
	secondaryRouteStatusByFloor: number[];
	serviceScheduleFlags: number[];
	/**
	 * 14 entries: 7 dayparts × 2 calendar phases. Holds the per-daypart
	 * departure-dwell multiplier; the actual dwell is `multiplier * 30` ticks.
	 * Distinct from `serviceScheduleFlags` which is the schedule-enable byte.
	 * Default = 1.
	 */
	dwellDelay: number[];
	/**
	 * 14 entries: 7 dayparts × 2 calendar phases. Controls alternate-direction
	 * queue drain behavior per daypart. 0 = normal (both directions),
	 * 1 = express to top (prefer upward, skip alternate downward drain),
	 * 2 = express to bottom (prefer downward, skip alternate upward drain).
	 */
	expressDirectionFlags: number[];
	waitingCarResponseThreshold: number;
	assignmentCapacity: number;
	floorQueues: CarrierFloorQueue[];
	pendingRoutes: CarrierPendingRoute[];
	completedRouteIds: string[];
	suppressedFloorAssignments: string[];
	/** Per-slot (floor) stop flag. 1 = elevator stops here, 0 = passes through. */
	stopFloorEnabled: number[];
	cars: CarrierCar[];
}

// ─── Runtime sims ────────────────────────────────────────────────────────

export type RouteState =
	| { mode: "idle" }
	| { mode: "segment"; segmentId: number; destination: number }
	| {
			mode: "carrier";
			carrierId: number;
			direction: "up" | "down";
			source: number;
	  };

export interface SimRecord {
	floorAnchor: number;
	homeColumn: number;
	baseOffset: number;
	/** Per-floor local object index (binary sim+1 / BP+0xc): index of this sim's home object within its floor's object list, in placement (x-ascending) order. */
	facilitySlot: number;
	familyCode: number;
	/**
	 * SimRecord+5 state_code byte (ROUTING-BINARY-MAP.md §4.1):
	 *   bits 0..3: phase (0..7)
	 *   bit 5 (0x20): currently waiting (queue-full parked)
	 *   bit 6 (0x40): route queued / in-transit on carrier or segment
	 * Phase 5b makes the two mode bits the authoritative source for
	 * routing-mode branching (via `sim-access/state-bits.ts`). The
	 * `route` auxiliary struct stays as bookkeeping for carrier/segment
	 * ids and direction.
	 */
	stateCode: number;
	route: RouteState;
	selectedFloor: number;
	originFloor: number;
	destinationFloor: number;
	venueReturnState: number;
	queueTick: number;
	/** Current elapsed ticks for the in-progress service visit (maps to low 10 bits of elapsed_packed). */
	elapsedTicks: number;
	transitTicksRemaining: number;
	lastDemandTick: number;
	tripCount: number;
	accumulatedTicks: number;
	/** Housekeeping helper (family 0x0f): selected hotel room's floor, with -1 as the searching sentinel. */
	targetRoomFloor: number;
	/** Housekeeping helper: leftTileIndex (column) of the claimed room. Paired with targetRoomFloor to uniquely identify the room at cleanup time, mirroring binary sim+0xc (the floor-local object id written by find_matching_vacant_unit_floor). */
	targetRoomColumn: number;
	/** Housekeeping helper: recorded spawn floor used as the candidate-search seed and modulo class. */
	spawnFloor: number;
	/** Housekeeping helper: 3-tick post-claim countdown. */
	postClaimCountdown: number;
	/** Housekeeping helper: encoded subtype/slot of the claimed room (`(0 - floor) * 0x400`). */
	encodedTargetFloor: number;
	/**
	 * Binary sim[+6] commercial-venue slot index for entertainment guests
	 * (handle_entertainment_service_acquisition at 1228:57e2). Holds the
	 * sidecar index of the picked CommercialVenueRecord; -1 means lobby
	 * fallback (no candidate). Other families overload sim[+6] differently
	 * and use `selectedFloor` for that.
	 */
	commercialVenueSlot: number;
}

// ─── Routing types ────────────────────────────────────────────────────────────

export const MAX_SPECIAL_LINKS = 64;
export const MAX_SPECIAL_LINK_RECORDS = 8;
export const MAX_TRANSFER_GROUPS = 16;

export interface SpecialLinkSegment {
	active: boolean;
	/** bit 0 = stairs cost bit (0 = Escalator branch, 1 = Stairs branch); bits 7:1 = inclusive span length in floors. */
	flags: number;
	/** Height-based cost metric used by the routing pathfinder. */
	heightMetric: number;
	entryFloor: number;
	reservedByte: number;
	descendingLoadCounter: number;
	ascendingLoadCounter: number;
}

export interface SpecialLinkRecord {
	active: boolean;
	lowerFloor: number;
	upperFloor: number;
	reachabilityMasksByFloor: number[];
}

export interface TransferGroupEntry {
	active: boolean;
	taggedFloor: number;
	carrierMask: number;
}

// ─── PlacedObjectRecord ───────────────────────────────────────────────────────

/**
 * Per-object simulation record for every placed non-infrastructure tile.
 * Keyed in WorldState.placedObjects by "anchorX,y".
 */
export interface PlacedObjectRecord {
	/** Leftmost tile x (anchor column). */
	leftTileIndex: number;
	/** Rightmost tile x (anchor x + width − 1). */
	rightTileIndex: number;
	/** SimTower family code (e.g. FAMILY_HOTEL_SINGLE, FAMILY_RESTAURANT). */
	objectTypeCode: number;
	/** Per-family lifecycle byte (unit status / open-close state). */
	unitStatus: number;
	/** Runtime cycle counter for the per-family refresh rotation. */
	auxValueOrTimer: number;
	/** Index into WorldState.sidecars; −1 when no sidecar is attached. */
	linkedRecordIndex: number;
	/**
	 * Binary PlacedObjectRecord +0x13 (byte): "dirty" / cashflow-needed flag.
	 * Set to 1 by most activation paths (office/retail/condo/hotel
	 * `activate_*_cashflow`, stay-phase advance/decrement/sync, service-request
	 * allocate/release, parking/coverage recalc, placement init). Read by the
	 * ledger rollover sweep to know which placed objects need a cashflow pass
	 * in the current 3-day cycle. Independent of operational scoring.
	 */
	dirtyFlag: number;
	/**
	 * Binary PlacedObjectRecord +0x14 (byte): "occupied" / scored flag.
	 * Set by the scoring sweep (`recompute_object_operational_status` at
	 * 1138:09d6) once `evalLevel > 0`, and by placement init. Cleared by
	 * `deactivate_*_cashflow` paths and `handle_extended_vacancy_expiry`.
	 * Read by the office state-0x20 morning gate at 1228:1df3 and the retail
	 * state-0x20 gate at 1228:4044 (both are RNG gates that skip the dispatch
	 * unless the object has been scored).
	 */
	occupiedFlag: number;
	/** Operational rating: 0 = bad/refund-eligible, 1 = ok, 2 = good. −1 until first scoring sweep. */
	evalLevel: number;
	/**
	 * Raw average stress score (per-occupant trip stress, before rent/noise
	 * modifiers and threshold bucketing). -1 when no occupant has logged a
	 * trip yet. Display-only; evalLevel is the value that drives game logic.
	 */
	evalScore: number;
	/** Pricing tier 0–3 (0 = best payout, 3 = worst); 4 = no payout. */
	rentLevel: number;
	/** Cumulative activation count, capped. */
	activationTickCount: number;
	/** Housekeeping has claimed this room for turnover service. */
	housekeepingClaimedFlag: number;
	/** VIP suite flag normalized onto standard hotel room types. */
	vipFlag?: boolean;
}

// ─── Gate flags ───────────────────────────────────────────────────────────────

/**
 * Global simulation gate flags. These drive the per-star qualitative
 * advancement conditions and recycling-center adequacy state.
 */
export interface GateFlags {
	/** Purpose unresolved; initialized to all-ones. */
	unknownC198: number;
	/** Set when a metro object is placed. */
	metroPlaced: number;
	/** Top/anchor floor index of the metro stack; -1 when absent. */
	metroStationFloorIndex: number;
	/** Set when an office object is placed. */
	officePlaced: number;
	/** Set when a security-office (family 0x0e) object is placed. 2→3 gate. */
	securityPlaced: number;
	/** Updated by office-service evaluation every 9th day. */
	officeServiceOk: number;
	/** Daily "office medical service ok" flag; latched at day-start (star > 2),
	 * cleared on any failed medical trip, gates star 3→4 and 4→5 advancement. */
	officeServiceOkMedical: number;
	/** Set by update_recycling_center_state. */
	recyclingAdequate: number;
	/** Set by the facility rebuild pipeline once enough routes exist. */
	routesViable: number;
	/** Floor index of placed VIP suite; 0xffff = none. */
	vipSuiteFloor: number;
	/** Cathedral/evaluation placed-object index/floor sentinel; 0xffff = none. */
	evalSimIndex: number;
	/** Number of placed recycling-center upper slices. */
	recyclingCenterCount: number;
	/** Set every 8 days while the tower is below 5-star rank. */
	facilityProgressOverride: number;
	/** Daily hotel sale counter, reset at the morning sale checkpoint. */
	family345SaleCount: number;
	/** Display/news trigger latch used by hotel checkout milestones. */
	newspaperTrigger: number;
}

export function createGateFlags(): GateFlags {
	return {
		unknownC198: 0xffffffff,
		metroPlaced: 0,
		metroStationFloorIndex: -1,
		officePlaced: 0,
		securityPlaced: 0,
		officeServiceOk: 0,
		officeServiceOkMedical: 0,
		recyclingAdequate: 0,
		routesViable: 0,
		vipSuiteFloor: 0xffff, // −1: no VIP suite
		evalSimIndex: 0xffff, // −1: no cathedral placed
		recyclingCenterCount: 0,
		facilityProgressOverride: 0,
		family345SaleCount: 0,
		newspaperTrigger: 0,
	};
}

// ─── Sidecar records ──────────────────────────────────────────────────────────

export interface CommercialVenueRecord {
	kind: "commercial_venue";
	/** 0xff = invalid / demolished. */
	ownerSubtypeIndex: number;
	capacity: number;
	visitCount: number;
	/**
	 * Today's STAFF-EMIT count (binary record+0x7). Written ONLY by
	 * `try_consume_commercial_venue_capacity` (11b0:11c3 `INC byte +0x7`),
	 * capped against `remainingCapacity` (binary +0x6). Rolled at daily
	 * reseed: `yesterdayVisitCount = todayVisitCount; todayVisitCount = 0`.
	 * `yesterdayVisitCount` (binary +0x8) feeds the population/star ledger
	 * via `add_to_primary_family_ledger_bucket`. NOT used by closure
	 * cashflow — that path reads `acquireCount` (binary +0x10).
	 */
	todayVisitCount: number;
	yesterdayVisitCount: number;
	/**
	 * Visitor acquisition count (binary record+0x10, word). Incremented by
	 * BOTH `try_consume_commercial_venue_capacity` (11b0:11cd
	 * `INC word +0x10`) at MORNING_GATE AND
	 * `acquire_commercial_venue_slot` (11b0:0ee3 `INC word +0x10`) on the
	 * arrival success path when the visitor's type/variant differs from
	 * the venue owner's. NOT capped by `remainingCapacity`. Reset to 0 at
	 * daily reseed. Read by `seed_facility_runtime_link_state` →
	 * `derive_commercial_venue_state_code` for closure cashflow bands.
	 */
	acquireCount: number;
	availabilityState: number;
	/**
	 * Number of sims currently inside the venue (binary offset +0x09,
	 * "active_assignment_count"). Incremented by acquireCommercialVenueSlot
	 * when a sim takes a slot, decremented by releaseCommercialVenueSlot on
	 * departure. Saturates at 39 in the binary; when > 39 new arrivals are
	 * queued rather than admitted.
	 */
	currentPopulation: number;
	/**
	 * dayTick of the most recent slot acquisition (binary offset +0x0a).
	 * Used by releaseCommercialVenueSlot to gate the minimum dwell time
	 * against the family's service-duration ticks before a departure is
	 * accepted.
	 */
	lastAcquireTick: number;
	/**
	 * Signed eligibility threshold (binary offset +0x0c). When negative, the
	 * sim's current state word must not exceed `1 - eligibilityThreshold` for
	 * tryConsumeCommercialVenueCapacity to succeed. Prevents rapid re-visits.
	 */
	eligibilityThreshold: number;
	/**
	 * Remaining daily slots (binary offset +0x06). Refilled from the active
	 * phase seed at daypart 0 by rebuildCommercialVenueRuntime for fast-food
	 * and retail (restaurants use a separate midday mechanism). Decremented on
	 * each successful dispatch.
	 */
	remainingCapacity: number;
	/**
	 * Phase A capacity seed (binary offset +0x03). Grows by +2 (low stress)
	 * or +1 (medium stress) after each sim visit via clampVenueSeed, and is
	 * consumed/cleared by the daily rebuild. Used when calendar_phase == 0.
	 */
	phaseASeed: number;
	/**
	 * Phase B capacity seed (binary offset +0x04). Used when calendar_phase != 0.
	 */
	phaseBSeed: number;
	/**
	 * Override capacity seed (binary offset +0x05). Used when
	 * facility_progress_override is active.
	 */
	overrideSeed: number;
}

/**
 * Per-family runtime path buckets. Mirrors the binary's
 * `g_retail_shop_bucket_table` / `g_restaurant_bucket_table` /
 * `g_fast_food_bucket_table` (each 7 zone rows × variable slot count).
 * Each row holds sidecar indices appended by `append_facility_path_bucket_entry`
 * (11b0:161b) when the venue is placed/recomputed. The selector
 * (`select_random_commercial_venue_record_from_bucket`, 11b0:1361) reads from
 * the requested zone row, falling back to row 0 when the requested row is
 * empty, then validates the picked record's availabilityState post-pick.
 */
export interface CommercialVenueBuckets {
	retail: number[][];
	restaurant: number[][];
	fastFood: number[][];
}

export const COMMERCIAL_VENUE_BUCKET_ROWS = 7;

export function createCommercialVenueBuckets(): CommercialVenueBuckets {
	const empty = (): number[][] =>
		Array.from({ length: COMMERCIAL_VENUE_BUCKET_ROWS }, () => []);
	return {
		retail: empty(),
		restaurant: empty(),
		fastFood: empty(),
	};
}

// CommercialVenueRecord.availabilityState values
export const VENUE_AVAILABLE = 0;
export const VENUE_PARTIAL = 1; // active_assignment_count 1..9
export const VENUE_NEAR_FULL = 2; // active_assignment_count >= 10
export const VENUE_CLOSED = 3; // daily off-hours closure
export const VENUE_DORMANT = 0xff; // inactive

export interface ServiceRequestEntry {
	kind: "service_request";
	ownerSubtypeIndex: number;
	/** Floor index of the service provider (used by parking demand log). */
	floorIndex?: number;
	/** 0 = uncovered / active, 1 = covered / suppressed by ramp. */
	coverageFlag?: number;
}

export interface EntertainmentLinkRecord {
	kind: "entertainment_link";
	ownerSubtypeIndex: number;
	/** 0xff = no pair yet. */
	pairedSubtypeIndex: number;
	/** 0xff for single-venue records; 0..13 paired selector bucket. */
	familySelectorOrSingleLinkFlag: number;
	/** Incremented at 0x0f0 each day; saturates at 0x7f. */
	linkAgeCounter: number;
	/** Upper-half attendance budget (seeded at 0x0f0). */
	upperBudget: number;
	/** Lower-half attendance budget (seeded at 0x0f0). */
	lowerBudget: number;
	/** 0=idle, 1=activated, 2=attendance started, 3=ready. */
	linkPhaseState: number;
	/** Reserved flag used by the placement/runtime pipeline. */
	pendingTransitionFlag: number;
	/** Cumulative attendance this cycle. */
	attendanceCounter: number;
	/** Active runtime attendee count (decremented on phase advance). */
	activeRuntimeCount: number;
	/**
	 * Binary `EntertainmentLinkRecord.lowerHalfFloor` (offset +0x03).
	 * Floor index of the lower half of the venue. Used as routing source by
	 * `get_entertainment_link_routing_source_floor` (1188:0dce) for
	 * entertainment guest service-acquire / linked-half / dwell-return
	 * routing, and as the destination for party hall in
	 * `get_entertainment_link_venue_floor` (1188:0d98).
	 */
	lowerHalfFloor: number;
	/**
	 * Binary `EntertainmentLinkRecord.upperHalfFloor` (offset +0x00). Floor
	 * index of the upper half of the venue. Returned by
	 * `get_entertainment_link_venue_floor` (1188:0d98) for cinema (when
	 * `familySelectorOrSingleLinkFlag` is non-negative as a signed byte).
	 */
	upperHalfFloor: number;
}

export interface MedicalCenterRecord {
	kind: "medical_center";
	/** 0xff = invalid / demolished. */
	ownerSubtypeIndex: number;
	/** Count of office-worker sims currently queued at this center. */
	pendingVisitorsCount: number;
}

export type SidecarRecord =
	| CommercialVenueRecord
	| ServiceRequestEntry
	| EntertainmentLinkRecord
	| MedicalCenterRecord;

/**
 * Global medical service-request slot. Binary allocates 10 fixed slots of
 * (source_floor, subtype_index, retry_counter, _pad); first-fit scan on
 * allocation, retry counter overflows at 0x28 (40) forcing the visit to
 * resolve.
 */
export interface MedicalServiceSlot {
	active: boolean;
	/** Sim key (simKey()) of the queued office worker. */
	simId: string;
	/** Floor the worker is queued from. */
	sourceFloor: number;
	/** Sidecar index of the target medical center. */
	targetSidecarIndex: number;
	/** Per-tick retry counter; hits 40 → forced serve. */
	retryCounter: number;
}

export const MAX_MEDICAL_SERVICE_SLOTS = 10;
export const MEDICAL_RETRY_OVERFLOW = 0x28;

export function createMedicalServiceSlots(): MedicalServiceSlot[] {
	return Array.from({ length: MAX_MEDICAL_SERVICE_SLOTS }, () => ({
		active: false,
		simId: "",
		sourceFloor: -1,
		targetSidecarIndex: -1,
		retryCounter: 0,
	}));
}

// ─── Event state ─────────────────────────────────────────────────────────────

export interface EventState {
	/**
	 * Active-event bitfield:
	 * bit 0 = bomb active search, bit 3 = fire active,
	 * bit 5 = bomb found, bit 6 = bomb detonated.
	 */
	gameStateFlags: number;
	/** Floor where the bomb was placed. */
	bombFloor: number;
	/** Tile where the bomb was placed. */
	bombTile: number;
	/** Day tick deadline for bomb detonation / post-resolution cleanup. */
	bombDeadline: number;
	/** Floor where the fire started. */
	fireFloor: number;
	/** Tile column where fire starts (right_tile - 0x20). */
	fireTile: number;
	/** Day tick when fire started. */
	fireStartTick: number;
	/** Per-floor left-spreading fire front position (120 entries, 0xffff = inactive). */
	fireLeftPos: number[];
	/** Per-floor right-spreading fire front position (120 entries, 0xffff = inactive). */
	fireRightPos: number[];
	/** Rescue countdown (with emergency coverage); 0 = no countdown active. */
	rescueCountdown: number;
	/** Helicopter extinguish position; 0 = not active. */
	helicopterExtinguishPos: number;
	/** LCG15 state for event randomness. */
	lcgState: number;
	/** Deterministic bomb-search helper floor bounds / cursor state. */
	bombSearchLowerBound: number;
	bombSearchUpperBound: number;
	bombSearchCurrentFloor: number;
	bombSearchScanTile: number;
	/** Pending carrier-edit prompt target column, -1 when idle. */
	pendingCarrierEditColumn: number;
	/** Pending carrier-edit prompt target y, -1 when idle. */
	pendingCarrierEditY: number;
	/** When true, suppress triggerRandomNewsEvent (trace-test only). */
	disableNewsEvents?: boolean;
	/**
	 * Firefighter rescue helpers, spawned by the binary's
	 * `initialize_service_response_entities(8)` (1100:033d) when the player
	 * declines the helicopter rescue prompt. The binary repurposes the slot-0
	 * occupant of each placed security office; we store an abstract record per
	 * helper here. Each helper walks right-to-left at one tile per tick on its
	 * spawn floor; when its column enters the fire's arrival window
	 * `[left, left+6) ∪ [right+6, right+12)` it pauses for an extinguish-delay
	 * wind-up then calls the asymmetric front clear. Drained when fire
	 * resolves (binary `initialize_service_response_entities(0)`).
	 */
	fireRescueHelpers: FireRescueHelper[];
}

export interface FireRescueHelper {
	/** Internal floor (binary index) the helper patrols. Set on spawn from the
	 * helper's home security office's floor. */
	floor: number;
	/** Current tile column. Decrements toward 0 each `walk_delay` tick. */
	column: number;
	/** Helper status: 0=walking, 1=winding-up extinguish, 2=relocating to
	 * another floor with active fire, 3=idle/done. */
	status: number;
	/** Wind-up countdown (ticks remaining until front clear fires). */
	windupRemaining: number;
}

export function createEventState(): EventState {
	return {
		gameStateFlags: 0,
		bombFloor: 0,
		bombTile: 0,
		bombDeadline: 0,
		fireFloor: 0,
		fireTile: 0,
		fireStartTick: 0,
		fireLeftPos: new Array(GRID_HEIGHT).fill(0xffff),
		fireRightPos: new Array(GRID_HEIGHT).fill(0xffff),
		rescueCountdown: 0,
		helicopterExtinguishPos: 0,
		lcgState: 1,
		bombSearchLowerBound: -1,
		bombSearchUpperBound: -1,
		bombSearchCurrentFloor: -1,
		bombSearchScanTile: -1,
		pendingCarrierEditColumn: -1,
		pendingCarrierEditY: -1,
		fireRescueHelpers: [],
	};
}

// ─── WorldState ───────────────────────────────────────────────────────────────

/** All placed tile data for one tower. */
export interface WorldState {
	towerId: string;
	name: string;
	width: number;
	height: number;
	/** Lobby slice height in floors; defaults to 1 until expanded-lobby support exists. */
	lobbyHeight: number;
	/**
	 * Lobby placement / express-stop spacing mode.
	 *   "perfect-parity": sky lobbies at floors 0, 14, 29, 44, ... (binary parity).
	 *   "modern": sky lobbies at floors 0, 15, 30, 45, ... (regular every-15 cadence).
	 */
	lobbyMode: LobbyMode;
	/** Global simulation gate flags (star advancement, recycling adequacy, etc.). */
	gateFlags: GateFlags;
	/** "x,y" → tileType for every occupied cell (anchors and extensions alike). */
	cells: Record<string, string>;
	/** Extension cell key → anchor cell key. */
	cellToAnchor: Record<string, string>;
	/** Anchor cell key → overlay tileType (e.g. "stairs"). */
	overlays: Record<string, string>;
	/** Extension cell key → anchor cell key for overlays. */
	overlayToAnchor: Record<string, string>;
	/**
	 * "anchorX,y" → PlacedObjectRecord for every simulated (non-infrastructure)
	 * placed tile. Infrastructure tiles (floor, lobby, stairs) do not have records.
	 */
	placedObjects: Record<string, PlacedObjectRecord>;
	/** Sidecar records, indexed by PlacedObjectRecord.linkedRecordIndex. */
	sidecars: SidecarRecord[];
	/** Runtime sim population rebuilt from placed objects. */
	sims: SimRecord[];
	/** One CarrierRecord per elevator/escalator shaft. Rebuilt from cells on mutation. */
	carriers: CarrierRecord[];
	/** Special-link segment table (max MAX_SPECIAL_LINKS entries). Rebuilt from carriers. */
	specialLinks: SpecialLinkSegment[];
	/** Special-link record table (max MAX_SPECIAL_LINK_RECORDS entries). */
	specialLinkRecords: SpecialLinkRecord[];
	/** Per-floor walkability bitmask (bit 0 = Escalator-branch, bit 1 = Stairs-branch). Size = GRID_HEIGHT. */
	floorWalkabilityFlags: number[];
	/** Tagged transfer-concourse entries (max MAX_TRANSFER_GROUPS entries). */
	transferGroupEntries: TransferGroupEntry[];
	/** Per-floor bitmask of carrier IDs that serve each floor. Size = GRID_HEIGHT. */
	transferGroupCache: number[];
	/** Sidecar indices of uncovered parking spaces feeding the demand log. */
	parkingDemandLog: number[];
	/** Global medical service-request slots (10 fixed slots, first-fit). */
	medicalServiceSlots: MedicalServiceSlot[];
	/** LCG state for general-purpose simulation randomness. */
	rngState: number;
	/** Cumulative count of sampleRng calls (for trace alignment). */
	rngCallCount: number;
	/** 1–6 (6 = Tower). */
	starCount: number;
	/**
	 * Binary `g_primary_family_ledger_total` @ 1288:c13a. Population-weighted
	 * activation total used by `compute_tower_tier_from_ledger` (1148:041d) to
	 * gate star advancement, AND surfaced as the player-facing population
	 * count. Updated via `add_to_primary_family_ledger_bucket` (1068:07f7) and
	 * `clear_primary_family_ledger_bucket` (1068:07b3) on the binary's
	 * family-ledger events:
	 *   - office (family 7) activate/deactivate: ±6
	 *   - hotel single (family 3) activate/deactivate: ±1
	 *   - hotel twin/suite (family 4/5) activate/deactivate: ±2
	 *   - condo (family 9) sale/refund: ±3
	 *   - retail (family 10) activation: +10
	 *   - restaurant/fastfood (family 6/12) and entertainment families: rebuilt
	 *     daily from runtime budgets (clear+seed pattern).
	 */
	currentPopulation: number;
	/**
	 * Binary `g_per_family_ledger_buckets` @ DS:0xc112 — per-family slot
	 * accumulators that sum to `currentPopulation`. Mirrors the binary's
	 * invariant: `currentPopulation == sum(currentPopulationBuckets)`.
	 * `add_to_primary_family_ledger_bucket` updates bucket+total;
	 * `clear_primary_family_ledger_bucket` subtracts bucket from total then
	 * zeroes the bucket. Used to net out daily resets of fast-food/retail/
	 * restaurant per-day visit-count contributions: clear-then-add-yesterday
	 * gives a delta of (newVisits - oldVisits) on the running total.
	 */
	currentPopulationBuckets: Record<number, number>;
	/**
	 * Per-family path buckets used by entertainment guests / hotel guests when
	 * picking a commercial venue. Maintained in sync with the binary's
	 * `recompute_facility_runtime_state` (11b0:02f2) and
	 * `append_facility_path_bucket_entry` (11b0:161b). Rebuilt at venue
	 * placement/demolition (`runGlobalRebuilds`) and at the daily restock
	 * checkpoints (tick 240 fast-food/retail, tick 1600 restaurant).
	 */
	commercialVenueBuckets: CommercialVenueBuckets;
	/** Bomb/fire/VIP event state. */
	eventState: EventState;
	/** Pending notifications emitted during the current tick (drained by the transport layer). */
	pendingNotifications: SimNotification[];
	/** Pending prompts requiring player response (drained by the transport layer). */
	pendingPrompts: SimPrompt[];
}

export type SimNotification = {
	kind: "route_failure" | "event" | "star_advanced";
	message?: string;
};

export type SimPrompt = {
	promptId: string;
	promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
	message: string;
	cost?: number;
};
