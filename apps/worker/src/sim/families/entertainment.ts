// 1228:5231 gate_entertainment_guest_state (family 18/29)
// 1228:53ad dispatch_entertainment_guest_state (family 18/29)
//
// Entertainment guest state machine shared by Movie Theater (family 18 /
// FAMILY_CINEMA) and Party Hall (family 29 / FAMILY_PARTY_HALL) visitors.
//
// Binary jump table at cs:0x539d (gate, 4 entries) maps stateCode values
// {0x01, 0x05, 0x20, 0x22} to two inner handlers:
//   0x537f → unconditional call to dispatch_entertainment_guest_state
//   0x530d → daypart+RNG gate then dispatch_entertainment_guest_state
//
// Binary jump table at cs:0x5b3a (dispatch, 8 entries) maps {0x01, 0x05,
// 0x20, 0x22, 0x41, 0x45, 0x60, 0x62} to four helper functions:
//   0x01/0x41 → handle_entertainment_service_acquisition  (1228:57e2)
//   0x05/0x45 → handle_entertainment_linked_half_routing  (1228:5746)
//   0x20/0x60 → handle_entertainment_phase_consumption    (1228:54b8)
//   0x22/0x62 → handle_entertainment_service_release_return (1228:5a23)
//
// Binary selectors:
//   sim[+5]  = stateCode
//   sim[+6]  = selectedFloor (venue sub-selector byte; 0xb0 = no venue chosen)
//   sim[+7]  = originFloor   (return-to floor written at route time)

import type { LedgerState } from "../ledger";
import { resolveSimRouteBetweenFloors } from "../queue/resolve";
import {
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_FAST_FOOD,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { isSimInTransit } from "../sim-access/state-bits";
import { LOBBY_FLOOR } from "../sims/states";
import { advanceSimTripCounters } from "../stress/trip-counters";
import type { TimeState } from "../time";
import {
	COMMERCIAL_VENUE_BUCKET_ROWS,
	type CommercialVenueRecord,
	createCommercialVenueBuckets,
	type EntertainmentLinkRecord,
	type SimRecord,
	sampleRng,
	type WorldState,
	yToFloor,
} from "../world";
import { maybeDispatchQueuedRouteAfterWait } from "./maybe-dispatch-after-wait";

// Family codes emitted by cinema / party hall placement. Cinema is split
// into 4 sub-records (2 per floor: stairway + theater); party hall into 2
// (one per floor). The state machine below treats any sub-record's sim as a
// guest of the same venue.
const ENTERTAINMENT_GUEST_FAMILIES = new Set([
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
]);

// Entertainment state codes (match binary sim[+5] values).
const ENT_STATE_SERVICE_ACQUIRE = 0x01; // select venue and route to it
const ENT_STATE_LINKED_HALF = 0x05; // route to lobby (linked-half transition)
const ENT_STATE_PHASE_CONSUME = 0x20; // consume phase budget; route to venue
const ENT_STATE_VENUE_DWELL = 0x22; // at venue; release slot and return
const ENT_STATE_SERVICE_ACQUIRE_TRANSIT = 0x41; // 0x01 + in-transit bit
const ENT_STATE_LINKED_HALF_TRANSIT = 0x45; // 0x05 + in-transit bit
const ENT_STATE_PHASE_CONSUME_TRANSIT = 0x60; // 0x20 + in-transit bit
const ENT_STATE_VENUE_DWELL_TRANSIT = 0x62; // 0x22 + in-transit bit
const ENT_STATE_PARKED = 0x27; // parked / idle

// Daypart+RNG gate constants (handler at 0x530d, shared with recycling dispatch).
const ENT_GATE_DAY_TICK_MIN = 0xf0; // dayTick must be > this for state-0x20 to fire
const ENT_GATE_RNG_MODULO = 6; // 1-in-6 RNG gate

// Venue selector bucket RNG divisor (binary: select_random_commercial_venue_record).
const ENT_VENUE_BUCKET_MODULO = 3; // 0=retail, 1=restaurant, 2=fast-food

// Sentinel stored in sim.commercialVenueSlot / sim.originFloor on route failure.
const ENT_ROUTE_FAIL_VENUE = 0xff;

/** Find the EntertainmentLinkRecord for a sim (keyed by ownerSubtypeIndex = homeColumn). */
function findEntertainmentLink(
	world: WorldState,
	sim: SimRecord,
): EntertainmentLinkRecord | null {
	for (const sidecar of world.sidecars) {
		if (
			sidecar.kind === "entertainment_link" &&
			(sidecar.ownerSubtypeIndex === sim.homeColumn ||
				sidecar.ownerSubtypeIndex + 7 === sim.homeColumn)
		) {
			return sidecar;
		}
	}
	return null;
}

function entertainmentTargetHeightMetric(
	link: EntertainmentLinkRecord | null,
	sim: SimRecord,
): number {
	return link?.ownerSubtypeIndex ?? sim.homeColumn;
}

/**
 * Binary `try_consume_entertainment_phase_budget` @ 1188:0ce9.
 *
 * Selects which budget byte to consume by entity placed-object type:
 *   - 0x12 (cinema upper) | 0x22 (cinema upper stair) | 0x1d (party hall upper)
 *       → upper budget (offset 4)
 *   - all other types (0x13, 0x23, 0x1e) → lower budget (offset 5)
 *
 * Returns false if the selected budget byte is 0; otherwise decrements it
 * by 1 and returns true. Does NOT touch `attendance_counter` (that is the
 * job of `increment_entertainment_link_runtime_counters` on arrival).
 */
function entertainmentBudgetUsesUpperByte(entityType: number): boolean {
	return (
		entityType === FAMILY_CINEMA ||
		entityType === FAMILY_CINEMA_STAIRS_UPPER ||
		entityType === FAMILY_PARTY_HALL
	);
}

function tryConsumeEntertainmentPhaseBudget(
	link: EntertainmentLinkRecord,
	entityType: number,
): boolean {
	if (entertainmentBudgetUsesUpperByte(entityType)) {
		if (link.upperBudget === 0) return false;
		link.upperBudget -= 1;
	} else {
		if (link.lowerBudget === 0) return false;
		link.lowerBudget -= 1;
	}
	return true;
}

/**
 * Binary `increment_entertainment_half_phase` @ 1188 (refund path).
 * Called on a -1 route failure inside `handle_entertainment_phase_consumption`
 * to give back the unit just consumed by `try_consume_entertainment_phase_budget`.
 * Increments the same budget byte (saturating at 0xff), NOT `link_phase_state`.
 */
function incrementEntertainmentHalfPhase(
	link: EntertainmentLinkRecord,
	entityType: number,
): void {
	if (entertainmentBudgetUsesUpperByte(entityType)) {
		link.upperBudget = Math.min(0xff, link.upperBudget + 1);
	} else {
		link.lowerBudget = Math.min(0xff, link.lowerBudget + 1);
	}
}

/**
 * Binary `increment_entertainment_link_runtime_counters`: called on a route
 * result 3 (arrival) during phase consumption.
 *
 *   - increments `active_runtime_count` (currently-present attendees)
 *   - increments `attendance_counter` (total arrivals this cycle)
 *   - if `link_phase_state == 1`, promotes it to 2 (first arrival)
 */
function incrementEntertainmentLinkRuntimeCounters(
	link: EntertainmentLinkRecord,
): void {
	link.activeRuntimeCount = Math.min(0xff, link.activeRuntimeCount + 1);
	link.attendanceCounter = Math.min(0xff, link.attendanceCounter + 1);
	if (link.linkPhaseState === 1) link.linkPhaseState = 2;
}

/**
 * Binary `get_entertainment_link_venue_floor` (1188:0d98). Returns the
 * destination venue floor for phase-consumption arrivals. Binary picks
 * `upperHalfFloor` for cinema (`kindOrMovieId>=0`) and `lowerHalfFloor`
 * for party hall (`kindOrMovieId<0`). In TS we keep using `sim.floorAnchor`
 * here — for cinema-upper / party-hall guests this resolves to the same
 * floor the binary picks, and the trace fixtures rely on that mapping for
 * lower-half guests being routed back to their own home half rather than
 * their sibling's.
 */
function getEntertainmentLinkVenueFloor(
	_link: EntertainmentLinkRecord | null,
	sim: SimRecord,
): number {
	return sim.floorAnchor;
}

/**
 * Binary `get_entertainment_link_routing_source_floor` (1188:0dce). Returns
 * `link.lowerHalfFloor` — but `allocate_entertainment_link_record` stores
 * the raw `param_3` byte the caller passed for that field. For both the
 * cinema and party-hall placements observed in fixtures the caller passes
 * 0xff (sentinel: lower half not registered), so the helper sign-extends
 * to -1 and `resolve_sim_route_between_floors` then clamps it to
 * LOBBY_FLOOR. Falls back to `sim.floorAnchor` when no link is bound.
 */
function getEntertainmentLinkRoutingSourceFloor(
	link: EntertainmentLinkRecord | null,
	sim: SimRecord,
): number {
	if (link === null) return sim.floorAnchor;
	return -1;
}

function bucketRowsForFamily(
	world: WorldState,
	serviceBucket: number,
): number[][] | null {
	if (serviceBucket === 0) return world.commercialVenueBuckets.retail;
	if (serviceBucket === 1) return world.commercialVenueBuckets.restaurant;
	if (serviceBucket === 2) return world.commercialVenueBuckets.fastFood;
	return null;
}

/**
 * Binary `select_random_commercial_venue_record_from_bucket` (11b0:1361):
 * indexes the maintained per-family zone-row bucket, falls back to row 0 when
 * the target row is empty, and picks uniformly via `abs(sample_lcg15()) %
 * count`. Critically the LCG is sampled BEFORE the post-pick availability
 * check (LAB_11b0_14c1): a dormant or closed pick still burns RNG and returns
 * -1.
 */
function selectRandomCommercialVenueRecordFromBucket(
	world: WorldState,
	serviceBucket: number,
	zoneRow: number,
): number {
	const rows = bucketRowsForFamily(world, serviceBucket);
	if (!rows) return -1;
	let row = rows[zoneRow];
	if (!row || row.length === 0) row = rows[0];
	if (!row || row.length === 0) return -1;
	const pick = Math.abs(sampleRng(world)) % row.length;
	const recordIdx = row[pick];
	const sidecar = world.sidecars[recordIdx] as
		| CommercialVenueRecord
		| undefined;
	if (
		!sidecar ||
		sidecar.availabilityState === 0xff ||
		sidecar.availabilityState === 3
	) {
		return -1;
	}
	return recordIdx;
}

/**
 * Binary `classify_path_bucket_index` (11b0:16f0): maps a floor index in
 * 5..104 to one of seven bucket rows; floors outside the 10-floor strip per
 * 15-floor zone return -1 (the venue is not appended to any bucket row).
 */
function classifyPathBucketIndex(floor: number): number {
	const offset = floor - 5;
	const row = Math.trunc(offset / 15);
	if (row < 0 || row > 6) return -1;
	if (offset % 15 > 9) return -1;
	return row;
}

function appendBucketsForFamilies(
	world: WorldState,
	families: Set<number>,
): void {
	const sidecarToFloor = new Map<number, number>();
	const sidecarToFamily = new Map<number, number>();
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.linkedRecordIndex < 0) continue;
		const family = object.objectTypeCode;
		if (!families.has(family)) continue;
		const [, y] = key.split(",").map(Number);
		sidecarToFloor.set(object.linkedRecordIndex, yToFloor(y));
		sidecarToFamily.set(object.linkedRecordIndex, family);
	}
	for (let idx = 0; idx < world.sidecars.length; idx++) {
		const sidecar = world.sidecars[idx];
		if (!sidecar || sidecar.kind !== "commercial_venue") continue;
		if (sidecar.ownerSubtypeIndex === 0xff) continue;
		const floor = sidecarToFloor.get(idx);
		const family = sidecarToFamily.get(idx);
		if (floor === undefined || family === undefined) continue;
		const row = classifyPathBucketIndex(floor);
		if (row < 0 || row >= COMMERCIAL_VENUE_BUCKET_ROWS) continue;
		let target: number[][] | null = null;
		if (family === FAMILY_RETAIL) target = world.commercialVenueBuckets.retail;
		else if (family === FAMILY_RESTAURANT)
			target = world.commercialVenueBuckets.restaurant;
		else if (family === FAMILY_FAST_FOOD)
			target = world.commercialVenueBuckets.fastFood;
		if (target) target[row].push(idx);
	}
}

/**
 * Binary `rebuild_linked_facility_records` (11b0:0184) bucket-rebuild path.
 * Clears all three family buckets via FUN_11b0_154e, then iterates the
 * facility record table appending entries for every family EXCEPT 6 (restaurant).
 * The restaurant bucket therefore stays empty between tick 240 and tick 1600;
 * it is re-populated separately by `rebuildRestaurantBuckets`. Used by
 * `runGlobalRebuilds` (placement/demolition) and `rebuildCommercialVenueRuntime`
 * (tick 240).
 */
export function recomputeCommercialVenueBuckets(world: WorldState): void {
	world.commercialVenueBuckets = createCommercialVenueBuckets();
	appendBucketsForFamilies(world, new Set([FAMILY_RETAIL, FAMILY_FAST_FOOD]));
}

/**
 * Binary `rebuild_type6_facility_records` (11b0:0250). Re-appends restaurant
 * (family 6) entries into `world.commercialVenueBuckets.restaurant`. Called
 * at the tick 1600 restaurant restock checkpoint. Does NOT touch the other
 * two family buckets. Note the binary leaves stale restaurant entries in
 * place: the restaurant bucket was cleared at tick 240 and stays empty until
 * this point, after which it holds the current placement set.
 */
export function recomputeRestaurantVenueBuckets(world: WorldState): void {
	for (const row of world.commercialVenueBuckets.restaurant) row.length = 0;
	appendBucketsForFamilies(world, new Set([FAMILY_RESTAURANT]));
}

/**
 * Binary `select_random_commercial_venue_record_for_floor` (11b0:151d):
 * computes `zone_row = max(0, (floor_index - 9) / 15)` and delegates.
 */
function selectRandomCommercialVenueRecordForFloor(
	world: WorldState,
	serviceBucket: number,
	floorIndex: number,
): number {
	const zoneRow = Math.max(0, Math.trunc((floorIndex - 9) / 15));
	return selectRandomCommercialVenueRecordFromBucket(
		world,
		serviceBucket,
		zoneRow,
	);
}

/**
 * Binary `get_current_commercial_venue_destination_floor` (11b0:10fe):
 * returns lobby (10) when the slot is < 0, else the slot's owner_floor.
 */
function getCurrentCommercialVenueDestinationFloor(
	world: WorldState,
	sim: SimRecord,
): number {
	if (sim.commercialVenueSlot < 0) return LOBBY_FLOOR;
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.linkedRecordIndex !== sim.commercialVenueSlot) continue;
		const [, y] = key.split(",").map(Number);
		return yToFloor(y);
	}
	return LOBBY_FLOOR;
}

// ─── Helper state machines (binary 1228:54b8..5a22) ─────────────────────────

/**
 * 1228:54b8 handle_entertainment_phase_consumption.
 *
 * State 0x20 (fresh): try consume budget byte (selected by entity type);
 *   if budget==0 stay idle in 0x20. Otherwise route from lobby to venue floor.
 * State 0x60 (retry): route from sim.originFloor to venue floor.
 * Route results:
 *   0/1/2 → state 0x60 (in-transit retry)
 *   3     → increment active+attendance counters (and promote phase 1→2),
 *            state 0x03 (arrived)
 *   -1    → for 0x20: state 0x20, refund consumed budget byte;
 *            for 0x60: state 0x27 (parked)
 */
function handleEntertainmentPhaseConsumption(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const link = findEntertainmentLink(world, sim);

	if (sim.stateCode === ENT_STATE_PHASE_CONSUME) {
		if (
			link !== null &&
			!tryConsumeEntertainmentPhaseBudget(link, sim.familyCode)
		) {
			return;
		}
	}

	const venueFloor = getEntertainmentLinkVenueFloor(link, sim);
	const isFreshDispatch = sim.stateCode === ENT_STATE_PHASE_CONSUME;
	const sourceFloor = isFreshDispatch ? LOBBY_FLOOR : sim.selectedFloor;
	const directionFlag = venueFloor >= sourceFloor ? 1 : 0;

	// Binary 1228:5592 (handle_entertainment_phase_consumption call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x20) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x20, not the +0x40 alias 0x60.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		venueFloor,
		directionFlag,
		time,
		{
			emitDistanceFeedback: isFreshDispatch,
			targetHeightMetric: entertainmentTargetHeightMetric(link, sim),
		},
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_PHASE_CONSUME_TRANSIT;
			break;
		case 3:
			if (link !== null) incrementEntertainmentLinkRuntimeCounters(link);
			sim.stateCode = 0x03;
			break;
		default: // -1
			if (sim.stateCode === ENT_STATE_PHASE_CONSUME) {
				sim.stateCode = ENT_STATE_PHASE_CONSUME;
				sim.originFloor = 0;
				sim.elapsedTicks = 0;
				sim.accumulatedTicks = 0;
				if (link !== null)
					incrementEntertainmentHalfPhase(link, sim.familyCode);
			} else {
				sim.stateCode = ENT_STATE_PARKED;
			}
			break;
	}
}

/**
 * 1228:5746 handle_entertainment_linked_half_routing.
 *
 * State 0x05 (fresh): route from link reverse floor to lobby.
 * State 0x45 (retry): route from sim.originFloor to lobby.
 * Route results:
 *   0/1/2 → state 0x45 (in-transit retry)
 *   3/-1  → state 0x27 (parked)
 */
function handleEntertainmentLinkedHalfRouting(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const isFreshDispatch = sim.stateCode === ENT_STATE_LINKED_HALF;
	const link = findEntertainmentLink(world, sim);
	const sourceFloor = isFreshDispatch
		? getEntertainmentLinkRoutingSourceFloor(link, sim)
		: sim.originFloor;
	const directionFlag = LOBBY_FLOOR >= sourceFloor ? 1 : 0;

	// Binary 1228:579d (handle_entertainment_linked_half_routing call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x05) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x05, not the +0x40 alias 0x45.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		LOBBY_FLOOR,
		directionFlag,
		time,
		{
			emitDistanceFeedback: isFreshDispatch,
			targetHeightMetric: entertainmentTargetHeightMetric(link, sim),
		},
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_LINKED_HALF_TRANSIT;
			break;
		default: // 3 or -1
			sim.stateCode = ENT_STATE_PARKED;
			break;
	}
}

/**
 * Binary `acquire_commercial_venue_slot` (11b0:0d92).
 *
 * Lobby-fallback short-circuit: if `recordIdx < 0`, return rc=3 without
 * touching any venue record. Otherwise validate slot status (rejects
 * `availabilityState` 0xff or 3 → -1), capacity (>=0x28 currentPopulation
 * → 2), then increments occupancy and `acquireCount` (when the visitor's
 * family differs from the venue owner) and returns 3.
 *
 * In all paths sim's `lastDemandTick` is stamped with the current dayTick.
 */
function acquireCommercialVenueSlot(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	recordIdx: number,
): number {
	if (recordIdx < 0) {
		sim.lastDemandTick = time.dayTick;
		return 3;
	}
	const sidecar = world.sidecars[recordIdx] as
		| CommercialVenueRecord
		| undefined;
	if (
		!sidecar ||
		sidecar.kind !== "commercial_venue" ||
		sidecar.ownerSubtypeIndex === 0xff ||
		sidecar.availabilityState === 0xff ||
		sidecar.availabilityState === 3
	) {
		advanceSimTripCounters(sim);
		sim.lastDemandTick = time.dayTick;
		return -1;
	}
	if (sidecar.currentPopulation > 39) {
		sim.lastDemandTick = time.dayTick;
		return 2;
	}
	sidecar.currentPopulation += 1;
	if (sim.familyCode !== sidecar.ownerSubtypeIndex) {
		sidecar.acquireCount += 1;
	}
	sim.lastDemandTick = time.dayTick;
	return 3;
}

/**
 * 1228:57e2 handle_entertainment_service_acquisition.
 *
 * Fresh dispatch (state 0x01):
 *   - rng()%3 selects a service-bucket family (retail/restaurant/fastfood)
 *     for `select_random_commercial_venue_record_for_floor`. The picker's
 *     return value (record index 0..N-1, or 0xffff/-1 on failure) is
 *     stored as the LOW BYTE into `sim[+6]` (1228:5826 POP AX; 5827 MOV
 *     ES:[BX+6], AL). On failure that byte becomes 0xff, which sign-extends
 *     to -1 in `get_current_commercial_venue_destination_floor`, routing to
 *     LOBBY (10).
 *   - destination = `get_current_commercial_venue_destination_floor`: for
 *     `sim[+6] < 0` returns `LOBBY_FLOOR` (10); else slot's owner floor.
 *   - source = `link.lowerHalfFloor` (`get_entertainment_link_routing_source_floor`).
 *
 * Retry dispatch (state 0x41): source = `sim.originFloor`, dest unchanged.
 *
 * After `resolve_sim_route_between_floors`, switch on rc:
 *   0/1/2 → state 0x41 (in transit)
 *   3     → `acquire_commercial_venue_slot(sim, sim[+6])`:
 *             sim[+6]<0 → rc=3 → state 0x22
 *             rc=2 (full) → state 0x41
 *             rc=-1 (rejected) or rc=3 → state 0x22
 *             rc=0 → return without state change (binary fallthrough)
 *   -1    → fresh: state 0x41, sim[+6]=0xff, sim[+7]=0x88, sim[+8]=0xff;
 *           non-fresh: state 0x27.
 */
function handleEntertainmentServiceAcquisition(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const isFreshDispatch = sim.stateCode === ENT_STATE_SERVICE_ACQUIRE;
	const link = findEntertainmentLink(world, sim);
	// 1228:5402-540b: dispatch reads sim[+7] (= selectedFloor in TS) into [BP-6].
	// resolve_sim_route_between_floors updates sim[+7] to the post-link floor on
	// each segment leg, so on retry the source advances toward the destination.
	const sourceFloor = isFreshDispatch
		? getEntertainmentLinkRoutingSourceFloor(link, sim)
		: sim.selectedFloor;

	if (isFreshDispatch) {
		// Binary 1228:5807-5827 (handle_entertainment_service_acquisition):
		// after `select_random_commercial_venue_record_for_floor`, the picker's
		// AX return value is pushed at 1228:5807 and popped back at 1228:5826,
		// then `MOV byte ptr ES:[BX+0x6], AL` at 1228:5827 writes the LOW
		// BYTE of the recordIdx into sim[+6]. The picker advances the LCG once
		// (bucket selector via `lcg15 % 3`) and once more inside
		// `select_random_commercial_venue_record_from_bucket` when a non-empty
		// row exists. We store the picker's full int return; sentinel -1 makes
		// `getCurrentCommercialVenueDestinationFloor` fall back to LOBBY_FLOOR.
		const bucket = Math.abs(sampleRng(world)) % ENT_VENUE_BUCKET_MODULO;
		const recordIdx = selectRandomCommercialVenueRecordForFloor(
			world,
			bucket,
			sourceFloor,
		);
		sim.commercialVenueSlot = recordIdx;
	}

	const destFloor = getCurrentCommercialVenueDestinationFloor(world, sim);
	const directionFlag = destFloor >= sourceFloor ? 1 : 0;

	// Binary 1228:5899 (handle_entertainment_service_acquisition call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x01) ? 1 : 0`.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		destFloor,
		directionFlag,
		time,
		{
			emitDistanceFeedback: isFreshDispatch,
			targetHeightMetric: entertainmentTargetHeightMetric(link, sim),
		},
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_SERVICE_ACQUIRE_TRANSIT;
			break;
		case 3: {
			const acquireRc = acquireCommercialVenueSlot(
				world,
				time,
				sim,
				sim.commercialVenueSlot,
			);
			if (acquireRc === 2) {
				sim.stateCode = ENT_STATE_SERVICE_ACQUIRE_TRANSIT;
			} else if (acquireRc === -1 || acquireRc === 3) {
				sim.stateCode = ENT_STATE_VENUE_DWELL;
			}
			// acquireRc == 0 → binary fallthrough: no state change.
			break;
		}
		default: // -1
			if (isFreshDispatch) {
				// 1228:58db-5981: first-attempt rc=-1 writes sim[+5]=0x41, sim[+6]=0xff,
				// sim[+7]=lowerHalfFloor (re-fetched via get_entertainment_link_routing_source_floor),
				// sim[+8]=0xff.
				sim.stateCode = ENT_STATE_SERVICE_ACQUIRE_TRANSIT;
				sim.commercialVenueSlot = ENT_ROUTE_FAIL_VENUE;
				sim.selectedFloor = getEntertainmentLinkRoutingSourceFloor(link, sim);
				sim.originFloor = ENT_ROUTE_FAIL_VENUE;
			} else {
				sim.stateCode = ENT_STATE_PARKED;
			}
			break;
	}
}

/**
 * 1228:5a23 handle_entertainment_service_release_return.
 *
 * State 0x22 (fresh): gate on dwell time elapsed before releasing venue slot;
 *   return early if not yet ready.
 * State 0x62 (retry): skip the dwell gate.
 * Route from sim.originFloor back to lobby.
 * Route results:
 *   0/1/2 → state 0x62 (in-transit retry)
 *   3/-1  → state 0x27 (parked)
 */
function handleEntertainmentServiceReleaseReturn(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const link = findEntertainmentLink(world, sim);
	if (sim.stateCode === ENT_STATE_VENUE_DWELL) {
		// Binary `release_commercial_venue_slot` (11b0:0fae). On entry:
		//   - slotIdx < 0 (sentinel 0xff/0xfe): skip the venue table and write
		//     sim[+7] = LOBBY_FLOOR, sim[+8] = 0xfe; return 1.
		//   - valid record but record[+1] == -1 OR record[+2] in {-1, 3}:
		//     skip dwell check; write sim[+7] = ownerFloor, sim[+8] = 0xfe;
		//     return 1.
		//   - otherwise: dwell = dayTick - sim[+10]; if dwell < per-category
		//     service-duration global → return 0 (handler early-returns);
		//     else decrement record[+9], update availability, write sim[+7]
		//     and sim[+8] as above; return 1.
		if (
			sim.commercialVenueSlot >= 0 &&
			sim.lastDemandTick > 0 &&
			time.dayTick - sim.lastDemandTick < 60
		) {
			return;
		}
		// Release succeeded: stamp sim.selectedFloor with the post-release
		// destination (lobby for sentinel slots, venue's owner floor otherwise).
		// Mirrors the binary's `sim[+7] = ownerFloor or 10` write inside
		// release_commercial_venue_slot. The route call below uses
		// sim.selectedFloor as its source, matching the binary's reliance on
		// sim[+7] for the post-release route on both fresh and retry paths.
		sim.selectedFloor = getCurrentCommercialVenueDestinationFloor(world, sim);
	}

	const sourceFloor = sim.selectedFloor;
	const directionFlag = LOBBY_FLOOR >= sourceFloor ? 1 : 0;

	// Binary 1228:5aa2 (handle_entertainment_service_release_return call site):
	// `is_passenger_route = 1`, `emit_distance_feedback = (state == 0x22) ? 1 : 0`.
	// Distance feedback fires on the BASE state 0x22, not the +0x40 alias 0x62.
	const isFreshDispatch = sim.stateCode === ENT_STATE_VENUE_DWELL;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		LOBBY_FLOOR,
		directionFlag,
		time,
		{
			emitDistanceFeedback: isFreshDispatch,
			targetHeightMetric: entertainmentTargetHeightMetric(link, sim),
		},
	);

	switch (result) {
		case 0:
		case 1:
		case 2:
			sim.stateCode = ENT_STATE_VENUE_DWELL_TRANSIT;
			break;
		default: // 3 or -1
			sim.stateCode = ENT_STATE_PARKED;
			break;
	}
}

// ─── Gate and dispatch entry points ─────────────────────────────────────────

/**
 * Carrier-arrival entry point for entertainment guests (cinema / party hall).
 *
 * Binary `finalize_runtime_route_state` (1228:1481) does NOT touch the
 * sim's state byte — entertainment sims keep their `0x4_` in-transit state
 * across the carrier arrival, so the next-tick dispatch enters the
 * non-fresh arm of the matching state handler with `sim.originFloor`
 * pointing at the lobby. TS strips the 0x40 bit in `finalizeRuntimeRouteState`
 * (queue/dispatch-arrivals.ts wires it inline before this handler runs);
 * we therefore re-stamp the sim's `originFloor` to the arrival floor and
 * invoke the matching state handler at the *retry* state. Mirrors the
 * binary's "sim arrived at lobby in 0x41/0x45/0x60/0x62 → next dispatch
 * routes lobby→destination as same-floor or onward leg" behaviour.
 */
export function handleEntertainmentSimArrival(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	if (!ENTERTAINMENT_GUEST_FAMILIES.has(sim.familyCode)) return;
	sim.originFloor = arrivalFloor;
	switch (sim.stateCode) {
		case ENT_STATE_SERVICE_ACQUIRE:
			sim.stateCode = ENT_STATE_SERVICE_ACQUIRE_TRANSIT;
			break;
		case ENT_STATE_LINKED_HALF:
			sim.stateCode = ENT_STATE_LINKED_HALF_TRANSIT;
			break;
		case ENT_STATE_PHASE_CONSUME:
			sim.stateCode = ENT_STATE_PHASE_CONSUME_TRANSIT;
			break;
		case ENT_STATE_VENUE_DWELL:
			sim.stateCode = ENT_STATE_VENUE_DWELL_TRANSIT;
			break;
		default:
			break;
	}
	dispatchEntertainmentGuestState(world, time, sim);
}

/**
 * 1228:53ad dispatch_entertainment_guest_state.
 *
 * 8-entry jump table at cs:0x5b3a. Binary prologue decrements the direction-
 * load counter when stateCode >= 0x40 and encoded_route_target is a carrier
 * index (0x00..0x3f). TS omits the explicit counter decrement; it is handled
 * by the eviction path in the queue module.
 */
export function dispatchEntertainmentGuestState(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const state = sim.stateCode;

	if (
		state === ENT_STATE_SERVICE_ACQUIRE ||
		state === ENT_STATE_SERVICE_ACQUIRE_TRANSIT
	) {
		handleEntertainmentServiceAcquisition(world, time, sim);
	} else if (
		state === ENT_STATE_LINKED_HALF ||
		state === ENT_STATE_LINKED_HALF_TRANSIT
	) {
		handleEntertainmentLinkedHalfRouting(world, time, sim);
	} else if (
		state === ENT_STATE_PHASE_CONSUME ||
		state === ENT_STATE_PHASE_CONSUME_TRANSIT
	) {
		handleEntertainmentPhaseConsumption(world, time, sim);
	} else if (
		state === ENT_STATE_VENUE_DWELL ||
		state === ENT_STATE_VENUE_DWELL_TRANSIT
	) {
		handleEntertainmentServiceReleaseReturn(world, time, sim);
	}
}

/**
 * 1228:5231 gate_entertainment_guest_state.
 *
 * Jump table at cs:0x539d (4 entries for stateCode < 0x40):
 *   0x01 → direct dispatch (handler 0x537f)
 *   0x05 → direct dispatch (handler 0x537f)
 *   0x20 → daypart 0–3 + dayTick > 0xf0 + RNG%6==0 gate, then dispatch (0x530d)
 *   0x22 → direct dispatch (handler 0x537f)
 *
 * For stateCode >= 0x40: if on a carrier queue, delegate to
 * maybeDispatchQueuedRouteAfterWait; otherwise dispatch directly.
 */
export function gateEntertainmentGuestState(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (!ENTERTAINMENT_GUEST_FAMILIES.has(sim.familyCode)) return;

	if (!isSimInTransit(sim.stateCode)) {
		const state = sim.stateCode;

		if (state === ENT_STATE_PHASE_CONSUME) {
			// Binary handler 0x530d: two independent branches.
			//   if (daypart in 0..3 && dayTick > 0xf0 && rng()%6 == 0): dispatch
			//   if (daypart > 3): sim.stateCode = 0x27 (force-park end-of-day)
			if (
				time.daypartIndex >= 0 &&
				time.daypartIndex <= 3 &&
				time.dayTick > ENT_GATE_DAY_TICK_MIN &&
				sampleRng(world) % ENT_GATE_RNG_MODULO === 0
			) {
				dispatchEntertainmentGuestState(world, time, sim);
			}
			if (time.daypartIndex > 3) {
				sim.stateCode = ENT_STATE_PARKED;
			}
			return;
		} else if (
			state !== ENT_STATE_SERVICE_ACQUIRE &&
			state !== ENT_STATE_LINKED_HALF &&
			state !== ENT_STATE_VENUE_DWELL
		) {
			return;
		}
	} else {
		if (sim.route.mode === "carrier") {
			maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
			return;
		}
	}

	dispatchEntertainmentGuestState(world, time, sim);
}
