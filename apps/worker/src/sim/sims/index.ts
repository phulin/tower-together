import { handleCathedralSimArrival, processCathedralSim } from "../cathedral";
import {
	gateEntertainmentGuestState,
	handleEntertainmentSimArrival,
} from "../families/entertainment";
import { maybeDispatchQueuedRouteAfterWait } from "../families/maybe-dispatch-after-wait";
import type { LedgerState } from "../ledger";
import {
	type RouteResolution,
	resolveSimRouteBetweenFloors,
} from "../queue/resolve";
import {
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOUSEKEEPING,
	FAMILY_OFFICE,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { isSimInTransit } from "../sim-access/state-bits";
import { handleCommercialSimArrival, processCommercialSim } from "./commercial";
import { handleCondoSimArrival, processCondoSim } from "./condo";

export {
	closeCommercialVenues,
	closeCommercialVenuesByFamily,
	rebuildCommercialVenueRuntime,
	rebuildRestaurantFacilityRecords,
	refundUnhappyFacilities,
} from "./facility-refunds";

import { handleHotelSimArrival, processHotelSim } from "./hotel";
import {
	handleHousekeepingSimArrival,
	processHousekeepingSim,
} from "./housekeeping";

export {
	advanceObjectStayPhaseTiers,
	handleExtendedVacancyExpiry,
	normalizeUnitStatusEndOfDay,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "./hotel-facilities";

import { addDelayToCurrentSim } from "../stress/add-delay";
import { advanceSimTripCounters } from "../stress/trip-counters";
import {
	handleMedicalSimArrival,
	processMedicalSim,
	STATE_MEDICAL_DWELL,
	STATE_MEDICAL_TRIP,
	STATE_MEDICAL_TRIP_TRANSIT,
} from "./medical";
import { handleOfficeSimArrival, processOfficeSim } from "./office";
import { clearSimRoute, simKey } from "./population";
import {
	CATHEDRAL_FAMILIES,
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_VENUE_DWELL_TICKS,
	ENTITY_REFRESH_STRIDE,
	INVALID_FLOOR,
	LOBBY_FLOOR,
	STATE_ACTIVE_TRANSIT,
	STATE_AT_WORK_TRANSIT,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_MORNING_TRANSIT,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	STATE_VENUE_TRIP_TRANSIT,
} from "./states";

export {
	rebuildParkingCoverage,
	rebuildParkingDemandLog,
	tryAssignParkingService,
} from "./parking";
export {
	cleanupSimsForRemovedTile,
	clearSimRoute,
	findObjectForSim,
	findSiblingSims,
	rebuildRuntimeSims,
	resetSimRuntimeState,
	simKey,
} from "./population";
export {
	averageTripStressTicks,
	createSimStateRecord,
	createSimStateRecords,
	currentTripStressLevel,
	currentTripStressTicks,
	maybeApplyDistanceFeedback,
	recomputeAllObjectOperationalStatus,
	recomputeObjectOperationalStatus,
	refreshOccupiedFlagAndTripCounters,
	type SimStateRecord,
} from "./scoring";
export {
	CATHEDRAL_FAMILIES,
	EVAL_ZONE_FLOOR,
	LOBBY_FLOOR,
	NO_EVAL_ENTITY,
	STATE_ACTIVE,
	STATE_ARRIVED,
	STATE_DEPARTURE,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_GATE,
	STATE_PARKED,
} from "./states";
export {
	addDelayToCurrentSim,
	advanceSimTripCounters,
	rebaseSimElapsedFromClock,
	resetFacilitySimTripCounters,
	resetSimTripCounters,
} from "./trip-counters";

import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type SimRecord,
	sampleRng,
	VENUE_CLOSED,
	VENUE_DORMANT,
	type WorldState,
	yToFloor,
} from "../world";

export function releaseServiceRequest(
	_world: WorldState,
	sim: SimRecord,
): void {
	sim.destinationFloor = -1;
	clearSimRoute(sim);
}

function recomputeRoutesViableFlag(world: WorldState): void {
	// Binary-grounded: rebuild_path_seed_bucket_table unconditionally latches
	// routesViable = 1 whenever star_count > 2; no route-scoring predicate found.
	world.gateFlags.routesViable = world.starCount > 2 ? 1 : 0;
}

interface VenueSelection {
	record: CommercialVenueRecord;
	floor: number;
	heightMetric: number;
	/** PlacedObjectRecord.objectTypeCode of the venue's owning facility.
	 * Mirrors binary `record[+0]` (sim_type) for the type/variant gate in
	 * `acquire_commercial_venue_slot` (11b0:0d92). */
	ownerFamily: number;
}

/**
 * Mirror of binary helper that finds an office worker's chosen commercial
 * venue at a specific floor by family. The binary keeps the picked venue
 * record index in entity[+6] and re-resolves through that on each
 * dispatch; we don't currently store the index, so we look up by
 * `(arrival floor, family set)`. For the current fixtures (one venue per
 * floor of each family), this is unambiguous and matches the binary.
 *
 * Returns the first venue found at `floor` whose family is in `families`
 * and whose record is non-INVALID; null otherwise.
 */
export function findCommercialVenueAtFloor(
	world: WorldState,
	floor: number,
	families: Set<number>,
): CommercialVenueRecord | null {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (!families.has(object.objectTypeCode)) continue;
		if (object.linkedRecordIndex < 0) continue;
		const [, y] = key.split(",").map(Number);
		if (yToFloor(y) !== floor) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.ownerSubtypeIndex === INVALID_FLOOR) continue;
		return record;
	}
	return null;
}

/** Result code mirroring binary `acquire_commercial_venue_slot` (11b0:0d92). */
export const VENUE_SLOT_ACQUIRED = 3;
export const VENUE_SLOT_FULL = 2;
export const VENUE_SLOT_UNAVAILABLE = -1;

/**
 * Mirror of binary `acquire_commercial_venue_slot` (11b0:0d92) for an
 * office worker arriving at a venue. Returns the binary's service-route
 * state code (3=acquired, 2=full, -1=unavailable). Increments the venue's
 * `currentPopulation` (binary record+9) on the success path and stamps
 * the sim's `lastDemandTick` with the current dayTick (binary entity+0xa).
 *
 * Capacity gate: binary uses `if ('\'' < currentPopulation)` i.e. > 39.
 * Match that exactly (rather than the off-by-one `< 39` used in
 * commercial.ts:135 for venue owners' own arrivals) so visiting workers
 * see the same threshold the binary's elevator-arrival handler does.
 *
 * Per binary, on the success path `record[+0x10]` (acquireCount) is
 * also incremented when the visitor's type/variant differs from the
 * venue owner's. For office workers visiting fast-food the gate fires
 * (office=family 7, fast-food=family 12); for a venue owner sim
 * arriving at their own venue the gate suppresses the bump (same family).
 * Pass `venueOwnerFamily` so the helper can apply the gate correctly.
 *
 * Note: the binary does NOT touch `record[+7]` (todayVisitCount,
 * staff-emit count) at acquire time — that counter is only bumped by
 * `try_consume_commercial_venue_capacity` (11b0:1150) at MORNING_GATE
 * and is what feeds the population/star ledger after the daily roll.
 */
export function tryAcquireOfficeVenueSlot(
	venue: CommercialVenueRecord,
	sim: SimRecord,
	time: TimeState,
	venueOwnerFamily: number,
):
	| typeof VENUE_SLOT_ACQUIRED
	| typeof VENUE_SLOT_FULL
	| typeof VENUE_SLOT_UNAVAILABLE {
	if (
		venue.ownerSubtypeIndex === 0xff ||
		venue.availabilityState === VENUE_DORMANT ||
		venue.availabilityState === VENUE_CLOSED
	) {
		return VENUE_SLOT_UNAVAILABLE;
	}
	if (venue.currentPopulation > 39) {
		// Binary 11b0:0f6c+: writes entity[+0xa] = g_day_tick on the full path
		// before returning 2. We don't mirror that latch in TS because our
		// per-stride office handler doesn't gate on lastDemandTick (it gates
		// on queueTick, set only on successful 0x22 transition); stamping
		// lastDemandTick on the rejection path here would interfere with the
		// stress-rebase pipeline without a corresponding gating use.
		return VENUE_SLOT_FULL;
	}
	venue.currentPopulation += 1;
	if (sim.familyCode !== venueOwnerFamily) {
		// Binary 11b0:0f3a–0f55: bump record+0x10 (acquireCount) only when
		// the visitor's type/variant differ from the venue owner's. This is
		// the gate that prevents the venue's own owner sim (arriving at their
		// home venue via MORNING_GATE) from double-counting today's visitor
		// acquisitions. acquireCount feeds closure cashflow bands, NOT the
		// population/star ledger — that path reads `todayVisitCount`
		// (staff-emit count, binary +0x7) after the daily roll.
		venue.acquireCount += 1;
	}
	sim.lastDemandTick = time.dayTick;
	return VENUE_SLOT_ACQUIRED;
}

/**
 * Mirror of binary `release_commercial_venue_slot` (11b0:0fae) for an
 * office worker leaving a venue. Decrements `currentPopulation` if the
 * venue is non-dormant. Returns true if the slot was released (and the
 * caller may proceed with the return route), false if the dwell timer
 * has not expired yet (binary returns 0 in that case).
 *
 * The dwell gate is the standard `dayTick - lastAcquireTick >=
 * COMMERCIAL_VENUE_DWELL_TICKS` (60 ticks) check. Office callers that
 * already enforce the dwell gate themselves can pass `skipDwellGate=true`.
 */
export function releaseOfficeVenueSlot(
	venue: CommercialVenueRecord,
	sim: SimRecord,
	time: TimeState,
	skipDwellGate = false,
): boolean {
	if (
		venue.ownerSubtypeIndex === 0xff ||
		venue.availabilityState === VENUE_DORMANT ||
		venue.availabilityState === VENUE_CLOSED
	) {
		return true;
	}
	if (
		!skipDwellGate &&
		time.dayTick - sim.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS
	) {
		return false;
	}
	if (venue.currentPopulation > 0) {
		venue.currentPopulation -= 1;
	}
	return true;
}

function pickAvailableVenue(
	world: WorldState,
	_fromFloor: number,
	allowedFamilies: Set<number>,
): VenueSelection | null {
	// Binary select_random_commercial_venue_record_from_bucket (11b0:1361):
	// consults the per-family zone bucket built at placement time and picks
	// uniformly at random. The bucket contains every placed venue of the
	// family — availability, capacity, and route viability are all checked
	// AFTER the RNG call. To match PRNG parity we mirror that shape: call
	// sampleRng whenever the bucket has any entry, even if the chosen venue
	// ends up rejected.
	const bucket: VenueSelection[] = [];
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (!allowedFamilies.has(object.objectTypeCode)) continue;
		if (object.linkedRecordIndex < 0) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.ownerSubtypeIndex === INVALID_FLOOR) continue;

		const [, y] = key.split(",").map(Number);
		bucket.push({
			record,
			floor: yToFloor(y),
			heightMetric: object.leftTileIndex,
			ownerFamily: object.objectTypeCode,
		});
	}

	if (bucket.length === 0) return null;
	const picked = bucket[sampleRng(world) % bucket.length];

	if (
		picked.record.availabilityState === VENUE_CLOSED ||
		picked.record.availabilityState === VENUE_DORMANT
	) {
		return null;
	}
	// Binary `select_random_commercial_venue_record_from_bucket` (11b0:1361)
	// does NOT filter on capacity or route viability at pick time. Both are
	// enforced later: capacity by `acquire_commercial_venue_slot` (11b0:0d92)
	// at arrival, and route viability by `resolve_sim_route_between_floors`
	// (which fires the 300-tick failure delay + advance_sim_trip_counters on
	// rc=-1). The caller's resolve call therefore needs to run for unreachable
	// venues so those side effects fire.
	return picked;
}

// Phase 7: `reduceElapsedForLobbyBoarding` was promoted into the inline
// boarding path in `queue/process-travel.ts`, where
// `accumulate_elapsed_delay_into_current_sim` runs as part of the boarding
// loop (matching the binary's 1218:0d4e `assign_request_to_runtime_route`).

// NOTE: there is no `completeSimTransitEvent` in the binary. The 6
// `add_or_update_sim_trip_counters` (== `advance_sim_trip_counters` 11e0:0000)
// call sites are:
//   1218:0046  resolve_sim_route_between_floors rc=3 (same-floor arrival)
//                — modeled in queue/resolve.ts:171 + same-floor short-circuit
//                  paths (sims/index.ts:364, sims/hotel.ts:564)
//   1218:00a4  resolve_sim_route_between_floors rc=-1 (no-route failure)
//                — modeled in queue/resolve.ts:189 + 247 (no-carrier failure)
//   1228:18dc  dispatch_sim_behavior (per-tick refresh; HK family 0x0f bypassed)
//                — modeled via families/maybe-dispatch-after-wait.ts:104
//   1228:1592  finalize_runtime_route_state (called from update_sim_tile_span)
//                — modeled in families/finalize.ts:36
//   11b0:0e0e  acquire_commercial_venue_slot venue-unavailable failure branch
//                — modeled in dispatchCommercialVenueVisit no-venue path
//                  (sims/index.ts:332). The advance fires ONLY in the failure
//                  branch (owner_subtype==0xff || venue offset+2 in {-1,3});
//                  the retry-overflow (rc=2) and success (rc=3) paths do NOT
//                  advance.
//   1178:02e1  office_sim_check_medical_service_slot target-gone failure branch
//                — modeled in sims/medical.ts processMedicalSim targetGone
//                  branch. Advance fires ONLY when slot.target == -1; the
//                  retry-overflow and success paths do NOT advance.
//
// The arrival dispatcher `dispatch_destination_queue_entries` (1218:0883)
// does NOT invoke `dispatch_sim_behavior` and does NOT advance trip counters
// — it writes sim+7 to the destination floor and jumps directly into the
// family-specific state handler. Mirrors of that path therefore must NOT
// advance counters at arrival.

function beginCommercialVenueDwell(
	sim: SimRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
): void {
	sim.destinationFloor = -1;
	sim.selectedFloor = arrivalFloor;
	clearSimRoute(sim);
	sim.venueReturnState = returnState;
	sim.stateCode = COMMERCIAL_DWELL_STATE;
	sim.lastDemandTick = time.dayTick;
}

function beginCommercialVenueTrip(
	sim: SimRecord,
	destinationFloor: number,
	tripState: number,
): void {
	sim.destinationFloor = destinationFloor;
	// For office + hotel + condo families the prior resolve already wrote
	// selectedFloor to the next leg endpoint; preserve it. For other families
	// that don't yet do per-tick re-resolution, reset to floorAnchor
	// (legacy behavior).
	const usesPerLeg =
		sim.familyCode === FAMILY_OFFICE ||
		sim.familyCode === FAMILY_CONDO ||
		sim.familyCode === FAMILY_HOTEL_SINGLE ||
		sim.familyCode === FAMILY_HOTEL_TWIN ||
		sim.familyCode === FAMILY_HOTEL_SUITE;
	if (!usesPerLeg) {
		sim.selectedFloor = sim.floorAnchor;
	}
	sim.stateCode = tripState;
}

export function finishCommercialVenueDwell(
	sim: SimRecord,
	time: TimeState,
	defaultState: number,
): boolean {
	if (sim.stateCode !== COMMERCIAL_DWELL_STATE) return false;
	if (time.dayTick - sim.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS)
		return true;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = sim.venueReturnState || defaultState;
	sim.venueReturnState = 0;
	return true;
}

export function finishCommercialVenueTrip(
	sim: SimRecord,
	returnState: number,
): boolean {
	if (sim.stateCode !== STATE_VENUE_TRIP) return false;
	if (sim.selectedFloor !== sim.destinationFloor) return true;
	sim.destinationFloor = -1;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = returnState;
	return true;
}

export function dispatchCommercialVenueVisit(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	options: {
		venueFamilies: Set<number>;
		returnState: number;
		tripState?: number;
		unavailableState?: number;
		skipPenaltyOnUnavailable?: boolean;
		advanceBeforeSameFloorDwell?: boolean;
		onVenueReserved?: () => void;
	},
): boolean {
	const venue = pickAvailableVenue(
		world,
		sim.floorAnchor,
		options.venueFamilies,
	);
	if (!venue) {
		if (!options.skipPenaltyOnUnavailable) {
			addDelayToCurrentSim(sim, 300);
			advanceSimTripCounters(sim);
		}
		if (options.unavailableState !== undefined) {
			sim.stateCode = options.unavailableState;
		}
		return false;
	}

	// Route requirement: resolve route before reserving venue.
	if (venue.floor !== sim.floorAnchor) {
		const dirFlag = venue.floor > sim.floorAnchor ? 1 : 0;
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.floorAnchor,
			venue.floor,
			dirFlag,
			time,
		);
		if (routeResult === -1) {
			// Binary `route_sim_to_commercial_venue` (1238:0000) hides the resolve
			// failure when called from state 0x01: writes sim+5=tripState (0x41),
			// sim+6=0xff sentinel, sim+7=origin, sim+8=0xff and returns success
			// to the caller. The resolve has already cleared the route and
			// applied the 300-tick failure delay + trip-counter advance. On the
			// next-stride state-0x41 alias re-entry, the binary skips selection
			// and `get_current_commercial_venue_destination_floor` reads the
			// 0xff sentinel and returns floor 10 (lobby) — so the recovery
			// resolve targets the lobby. We model that by writing the lobby
			// destination directly here, so the standard transit handler at
			// the next stride simply re-resolves anchor → lobby and assigns a
			// carrier route without re-running the venue dispatch (which would
			// fail again and incorrectly stack another 300-tick delay).
			sim.stateCode = options.tripState ?? STATE_VENUE_TRIP;
			sim.selectedFloor = sim.floorAnchor;
			sim.destinationFloor = LOBBY_FLOOR;
			return true;
		}
		if (routeResult === 0) {
			if (options.unavailableState !== undefined) {
				sim.stateCode = options.unavailableState;
			}
			return false;
		}

		// Binary `route_sim_to_commercial_venue` (1238:0000) state-0x01 cross-
		// floor branch: resolve returns 0/1/2 (in transit) → state 0x41
		// (tripState). Acquire is NOT called here; it fires when the per-
		// stride state-0x41 handler re-resolves the next leg and gets rc=3
		// at carrier arrival (modeled in office.ts handleOfficeSimArrival
		// STATE_ACTIVE_TRANSIT branch). The `onVenueReserved` callback fires
		// here so per-family bookkeeping (e.g. hotel activationTickCount) can
		// register the trip start.
		options.onVenueReserved?.();
		beginCommercialVenueTrip(
			sim,
			venue.floor,
			options.tripState ?? STATE_VENUE_TRIP,
		);
		return true;
	}

	// Same-floor branch: binary `route_sim_to_commercial_venue` (1238:0000)
	// state-0x01 same-floor path takes resolve rc=3 and immediately calls
	// `acquire_commercial_venue_slot` (11b0:0d92). Mirror that here so the
	// pick-time bump of `acquireCount` is gated on capacity (currentPopulation
	// > 39 → SLOT_FULL → no bump) and on the visitor-vs-owner type gate.
	if (options.advanceBeforeSameFloorDwell) {
		// Binary: resolve_sim_route(floor→floor) returns 3 → advanceSimTripCounters
		advanceSimTripCounters(sim);
	}
	const acquireResult = tryAcquireOfficeVenueSlot(
		venue.record,
		sim,
		time,
		venue.ownerFamily,
	);
	if (acquireResult === VENUE_SLOT_FULL) {
		// Binary state-0x01 same-floor + acquire=2: writes state=0x41 (tripState)
		// — the sim stays in the in-transit alias and the per-stride 0x41 handler
		// re-attempts acquire next stride. Restore route fields to the same-floor
		// shape so the retry loop is well-formed.
		sim.stateCode = options.tripState ?? STATE_VENUE_TRIP;
		sim.selectedFloor = sim.floorAnchor;
		sim.destinationFloor = sim.floorAnchor;
		sim.venueReturnState = options.returnState;
		return true;
	}
	options.onVenueReserved?.();
	beginCommercialVenueDwell(sim, venue.floor, options.returnState, time);
	return true;
}

export function handleCommercialVenueArrival(
	sim: SimRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
	tripState: number = STATE_VENUE_TRIP,
): boolean {
	if (sim.stateCode !== tripState || sim.destinationFloor !== arrivalFloor) {
		return false;
	}
	beginCommercialVenueDwell(sim, arrivalFloor, returnState, time);
	return true;
}

// Phase 5b: the office wait-timeout logic moved to
// `families/maybe-dispatch-after-wait.ts` (1228:15a0
// maybe_dispatch_queued_route_after_wait). The stride refresh calls
// `maybeDispatchQueuedRouteAfterWait` directly now.

export function advanceSimRefreshStride(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	if (world.sims.length === 0) return;

	const stride = time.dayTick % ENTITY_REFRESH_STRIDE;
	for (let index = 0; index < world.sims.length; index++) {
		if (index % ENTITY_REFRESH_STRIDE !== stride) continue;
		const sim = world.sims[index];
		// Binary parity: `refresh_runtime_entities_for_tick_stride` (1228:0d64)
		// does NOT call `rebase_sim_elapsed_from_clock` at all. The only stride-
		// time rebase points in the binary are inside `dispatch_sim_behavior`
		// (1228:186c) — invoked by `dispatch_queued_route_until_request` when a
		// queued carrier route pops — and `cancel_runtime_route_request`
		// (1218:1b85) when a request is canceled. Per-family refresh handlers
		// (1228:1cb5 office, 1228:2aec hotel, 1228:3a2f condo, etc.) drive the
		// state machine directly without rebasing.
		//
		// Sim+0xa (`lastDemandTick`) is multipurpose in the binary: it serves as
		// the carrier-queue enqueue stamp (set by `resolve_sim_route_between_floors`
		// rc=2), the commercial-venue acquire/dwell stamp (set by
		// `acquire_commercial_venue_slot` rc=2/3), and the medical-slot acquire
		// stamp (set by `office_sim_check_medical_service_slot`). A per-stride
		// rebase would corrupt those stamps — most visibly, after an office
		// worker acquires a fast-food slot, the next stride would add the
		// 16-tick delta into elapsedTicks, inflating stress by ~6 per visit.
		finalizePendingRouteLeg(sim);
		// Binary: refresh_object_family_office_state_handler (1228:1cb5) for
		// state >= 0x40 + on-carrier sims calls maybe_dispatch_queued_route_after_wait
		// (1228:15a0). After 300 ticks (g_route_delay_table_base, loaded from
		// resource type 0xff05 id 1000 word 0), it dispatches to the family-7
		// state-0x60 handler at 1228:193d which writes sim[+5] = 0x26 (NIGHT_B).
		// Phase 5b: delegated to families/maybe-dispatch-after-wait.ts.
		// Capture the binary's gate (state_code & 0x40 && sim+8 >= 0x40, the
		// carrier-queued alias) BEFORE invoking the helper: on timeout
		// `dispatchTimedOutOfficeQueueEntry` rewrites the state and clears the
		// route, so a post-helper check would let the per-state handler run
		// this stride and double-sample RNG. Binary 1228:1d59-1d6e takes a
		// hard either/or — when the helper runs, per-state dispatch is skipped.
		const wasQueuedCarrierAlias =
			isSimInTransit(sim.stateCode) && sim.route.mode === "carrier";
		maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
		if (wasQueuedCarrierAlias) {
			continue;
		}
		// Binary: sims with carrier route (sim+8 >= 0x40) are gated by
		// maybe_dispatch_queued_route_after_wait above; the family state handler
		// is NOT re-invoked. Sims with segment route (sim+8 < 0x40) DO go through
		// the family handler every stride — that's how segment legs progress
		// (each call to resolve writes one leg into sim+7, sim+8). Idle sims
		// also dispatch the family handler.
		// Other families have not migrated to per-leg progression yet; skip the
		// state handler for any non-idle route to preserve their legacy behavior.
		if (sim.route.mode === "carrier") {
			continue;
		}
		// Phase 4 + housekeeping + commercial: office + condo + hotel +
		// housekeeping + restaurant/fast-food/retail have migrated to per-stride
		// per-leg re-resolution. Other families still rely on the legacy
		// whole-trip finalizer in `reconcileSimTransport`.
		if (
			sim.route.mode === "segment" &&
			sim.familyCode !== FAMILY_OFFICE &&
			sim.familyCode !== FAMILY_CONDO &&
			sim.familyCode !== FAMILY_HOTEL_SINGLE &&
			sim.familyCode !== FAMILY_HOTEL_TWIN &&
			sim.familyCode !== FAMILY_HOTEL_SUITE &&
			sim.familyCode !== FAMILY_HOUSEKEEPING &&
			sim.familyCode !== FAMILY_RESTAURANT &&
			sim.familyCode !== FAMILY_FAST_FOOD &&
			sim.familyCode !== FAMILY_RETAIL &&
			sim.familyCode !== FAMILY_CINEMA &&
			sim.familyCode !== FAMILY_CINEMA_LOWER &&
			sim.familyCode !== FAMILY_CINEMA_STAIRS_UPPER &&
			sim.familyCode !== FAMILY_CINEMA_STAIRS_LOWER &&
			sim.familyCode !== FAMILY_PARTY_HALL &&
			sim.familyCode !== FAMILY_PARTY_HALL_LOWER
		) {
			continue;
		}
		switch (sim.familyCode) {
			case FAMILY_HOTEL_SINGLE:
			case FAMILY_HOTEL_TWIN:
			case FAMILY_HOTEL_SUITE:
				processHotelSim(world, ledger, time, sim);
				break;
			case FAMILY_OFFICE:
				if (
					sim.stateCode === STATE_MEDICAL_TRIP ||
					sim.stateCode === STATE_MEDICAL_TRIP_TRANSIT ||
					sim.stateCode === STATE_MEDICAL_DWELL
				) {
					processMedicalSim(world, time, sim);
				} else {
					processOfficeSim(world, ledger, time, sim);
				}
				break;
			case FAMILY_CONDO:
				processCondoSim(world, ledger, time, sim);
				break;
			case FAMILY_RESTAURANT:
			case FAMILY_FAST_FOOD:
			case FAMILY_RETAIL:
				processCommercialSim(world, ledger, time, sim);
				break;
			case FAMILY_HOUSEKEEPING:
				processHousekeepingSim(world, time, sim);
				break;
			case FAMILY_CINEMA:
			case FAMILY_CINEMA_LOWER:
			case FAMILY_CINEMA_STAIRS_UPPER:
			case FAMILY_CINEMA_STAIRS_LOWER:
			case FAMILY_PARTY_HALL:
			case FAMILY_PARTY_HALL_LOWER:
				gateEntertainmentGuestState(world, ledger, time, sim);
				break;
			default:
				if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
					processCathedralSim(world, time, sim);
				}
				break;
		}
	}

	recomputeRoutesViableFlag(world);
}

// 1228:0d64 refresh_runtime_entities_for_tick_stride — binary-named alias
// for advanceSimRefreshStride. Used by tick/carrier-tick.ts. Existing callers
// (tests, TowerSim.step via re-export) continue using the old name.
export const refreshRuntimeEntitiesForTickStride = advanceSimRefreshStride;

export { type RouteResolution, resolveSimRouteBetweenFloors };

function shouldFinalizeSegmentTrip(sim: SimRecord): boolean {
	// Phase 1d-ii / Phase 4: office + condo + hotel families are now driven by
	// per-stride per-leg re-resolution; arrivals fire from inside the
	// per-state handler when resolve returns 3 (same-floor). Skip the
	// legacy whole-trip finalizer for these segment sims.
	if (sim.familyCode === FAMILY_OFFICE) return false;
	if (sim.familyCode === FAMILY_CONDO) return false;
	if (
		sim.familyCode === FAMILY_HOTEL_SINGLE ||
		sim.familyCode === FAMILY_HOTEL_TWIN ||
		sim.familyCode === FAMILY_HOTEL_SUITE
	)
		return false;
	if (
		sim.familyCode === FAMILY_RESTAURANT ||
		sim.familyCode === FAMILY_FAST_FOOD ||
		sim.familyCode === FAMILY_RETAIL
	) {
		// Commercial families (restaurant/fast-food/retail) migrated to
		// per-stride per-leg re-resolution via processCommercialSim's
		// MORNING_TRANSIT (0x60) and DEPARTURE_TRANSIT (0x45) handlers.
		// The legacy whole-trip teleport here would short-circuit the binary's
		// 16-tick stride wait between MORNING_GATE -> MORNING_TRANSIT -> arrival.
		return false;
	}
	if (sim.familyCode === FAMILY_HOUSEKEEPING) {
		// Phase 5b/c: HK migrated to per-stride per-leg re-resolution like
		// office/condo/hotel. The whole-trip teleport here would race with the
		// per-stride state-3 dispatch — for a 1-floor route the same-tick
		// teleport fires `dispatchSimArrival` → `handleHousekeepingSimArrival`
		// → `tryClaimOnCurrentFloor` → `promoteClaim`, advancing the HK helper
		// to state 2 in the same tick the route is initiated. The binary
		// requires a separate stride for the state-3 re-resolve to return 3
		// (same-floor) before the claim fires. Skip the legacy finalizer.
		return false;
	}
	if (
		sim.familyCode === FAMILY_CINEMA ||
		sim.familyCode === FAMILY_CINEMA_LOWER ||
		sim.familyCode === FAMILY_CINEMA_STAIRS_UPPER ||
		sim.familyCode === FAMILY_CINEMA_STAIRS_LOWER ||
		sim.familyCode === FAMILY_PARTY_HALL ||
		sim.familyCode === FAMILY_PARTY_HALL_LOWER
	) {
		return false;
	}
	return (
		sim.stateCode === STATE_COMMUTE ||
		sim.stateCode === STATE_COMMUTE_TRANSIT ||
		sim.stateCode === STATE_ACTIVE_TRANSIT ||
		sim.stateCode === STATE_VENUE_TRIP ||
		sim.stateCode === STATE_VENUE_TRIP_TRANSIT ||
		sim.stateCode === STATE_DEPARTURE ||
		sim.stateCode === STATE_DEPARTURE_TRANSIT ||
		sim.stateCode === STATE_MORNING_TRANSIT ||
		sim.stateCode === STATE_AT_WORK_TRANSIT ||
		sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
		sim.stateCode === STATE_DWELL_RETURN_TRANSIT
	);
}

function finalizePendingRouteLeg(sim: SimRecord): void {
	if (sim.route.mode !== "segment") return;
	if (sim.transitTicksRemaining > 0) return;
	// Phase 1d-ii: office family is now driven by per-stride per-leg re-resolution
	// (resolveSimRouteBetweenFloors writes sim.selectedFloor to the next leg
	// endpoint). Skip the legacy whole-trip teleport for office sims so it
	// doesn't race with per-leg progression. Other families still rely on
	// this finalizer to advance segment trips until they migrate to the
	// per-tick model.
	if (sim.familyCode === FAMILY_OFFICE) return;
	if (sim.familyCode === FAMILY_CONDO) return;
	if (
		sim.familyCode === FAMILY_HOTEL_SINGLE ||
		sim.familyCode === FAMILY_HOTEL_TWIN ||
		sim.familyCode === FAMILY_HOTEL_SUITE
	)
		return;
	if (
		sim.familyCode === FAMILY_RESTAURANT ||
		sim.familyCode === FAMILY_FAST_FOOD ||
		sim.familyCode === FAMILY_RETAIL
	)
		return;
	if (
		sim.familyCode === FAMILY_CINEMA ||
		sim.familyCode === FAMILY_CINEMA_LOWER ||
		sim.familyCode === FAMILY_CINEMA_STAIRS_UPPER ||
		sim.familyCode === FAMILY_CINEMA_STAIRS_LOWER ||
		sim.familyCode === FAMILY_PARTY_HALL ||
		sim.familyCode === FAMILY_PARTY_HALL_LOWER
	)
		return;
	// Transit countdown is handled by reconcileSimTransport; here we just
	// sync selectedFloor once the leg is complete so processXxxSim sees it.
	sim.selectedFloor = sim.route.destination;
}

// Phase 7: `dispatchSimArrival` is now called inline from
// `queue/dispatch-arrivals.ts` (1218:0883 dispatch_destination_queue_entries),
// mirroring the binary's inline family-dispatch at arrival time. The former
// `onCarrierArrival` callback trampoline has been removed.
//
// NOTE: arrival does NOT advance trip counters in the binary —
// `dispatch_destination_queue_entries` writes sim+7 then calls the family
// handler directly (no `dispatch_sim_behavior`, no `advance_sim_trip_counters`).
// All advance sites that would naturally fire as part of an arrival are
// covered by `resolve_sim_route_between_floors` rc=3 inside the per-stride
// state handlers, which is the only legitimate "trip ended" advance for
// segment-based progression.
export function dispatchSimArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	const arrivedViaCarrier = sim.route.mode === "carrier";
	sim.selectedFloor = arrivalFloor;
	clearSimRoute(sim);
	switch (sim.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			handleHotelSimArrival(world, ledger, time, sim, arrivalFloor);
			return;
		case FAMILY_OFFICE:
			if (sim.stateCode === STATE_MEDICAL_TRIP_TRANSIT) {
				handleMedicalSimArrival(world, sim, arrivalFloor);
				return;
			}
			handleOfficeSimArrival(world, time, sim, arrivalFloor);
			return;
		case FAMILY_CONDO:
			handleCondoSimArrival(sim, arrivalFloor, time, arrivedViaCarrier);
			return;
		case FAMILY_RESTAURANT:
		case FAMILY_FAST_FOOD:
		case FAMILY_RETAIL:
			handleCommercialSimArrival(world, sim, arrivalFloor, time);
			return;
		case FAMILY_HOUSEKEEPING:
			handleHousekeepingSimArrival(world, time, sim, arrivalFloor);
			return;
		case FAMILY_CINEMA:
		case FAMILY_CINEMA_LOWER:
		case FAMILY_CINEMA_STAIRS_UPPER:
		case FAMILY_CINEMA_STAIRS_LOWER:
		case FAMILY_PARTY_HALL:
		case FAMILY_PARTY_HALL_LOWER:
			handleEntertainmentSimArrival(world, time, sim, arrivalFloor);
			return;
		default:
			if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
				handleCathedralSimArrival(world, time, sim, arrivalFloor);
			}
			return;
	}
}

// Arrival dispatches inline inside
// `queue/dispatch-arrivals.ts` (`dispatchDestinationQueueEntries` calls
// `dispatchSimArrival` directly on each unloaded slot, matching the binary's
// inline call into `dispatch_object_family_*_state_handler`). Boarding stress
// accumulation was promoted into `queue/process-travel.ts` so
// `accumulate_elapsed_delay_into_current_sim` runs inside the boarding loop
// at 1218:0d4e's binary-equivalent site.

export function reconcileSimTransport(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const sim of world.sims) {
		if (sim.route.mode !== "segment") continue;
		if (!shouldFinalizeSegmentTrip(sim)) continue;
		if (sim.transitTicksRemaining > 0) {
			sim.transitTicksRemaining -= 1;
			continue;
		}
		dispatchSimArrival(world, ledger, time, sim, sim.route.destination);
	}

	const completed = new Set<string>();
	for (const carrier of world.carriers) {
		for (const routeId of carrier.completedRouteIds) completed.add(routeId);
		carrier.completedRouteIds = [];
	}

	for (const sim of world.sims) {
		if (sim.destinationFloor < 0) continue;
		if (!completed.has(simKey(sim))) continue;
		// Office FULL-retry path: `handleOfficeSimArrival` may intentionally
		// leave `destinationFloor` set when `acquire_commercial_venue_slot`
		// returns 2 (capacity FULL), so the per-stride 0x41 handler can
		// re-attempt next stride. The binary mirrors this by NOT re-dispatching
		// the same arrival — `dispatch_destination_queue_entries` (1218:0883)
		// fires the family handler exactly once per arrival. Mirror that here:
		// skip the re-fire if the sim's route was already cleared (mode=idle)
		// OR if the inline handler re-enqueued the sim onto a new carrier for
		// the next transfer leg (mode=carrier). Re-firing in the carrier-mode
		// case would teleport the sim to its FINAL destination, bypassing the
		// next leg entirely (e.g., sky-office sims arriving at the sky lobby
		// would skip the local elevator transfer).
		if (sim.route.mode === "idle" || sim.route.mode === "carrier") continue;
		dispatchSimArrival(world, ledger, time, sim, sim.destinationFloor);
	}
}
