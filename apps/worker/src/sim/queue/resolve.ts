// 1218:0000 resolve_sim_route_between_floors
//
// Binary-faithful route resolver. Consults the route scorer, then either
// (a) walks the sim over a special-link segment, (b) enqueues onto a
// carrier queue, or (c) reports no-route / same-floor.

import {
	FAMILY_CATHEDRAL_BASE,
	FAMILY_CATHEDRAL_MAX,
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
import { perStopParityDelay } from "../route-scoring/delay-table";
import {
	type RouteCandidate,
	selectBestRouteCandidate,
} from "../route-scoring/select-candidate";
import { selectCathedralRoute } from "../route-scoring/select-cathedral";
import { selectHousekeepingRoute } from "../route-scoring/select-housekeeping";
import { setSimInTransit, setSimWaiting } from "../sim-access/state-bits";
import { clearSimRoute, simKey } from "../sims/population";
import { maybeApplyDistanceFeedback } from "../sims/scoring";
import { LOBBY_FLOOR } from "../sims/states";
import { addDelayToCurrentSim } from "../stress/add-delay";
import { advanceSimTripCounters } from "../stress/trip-counters";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import { enqueueRequestIntoRouteQueue } from "./enqueue";

/**
 * Family → route-selector dispatch.
 *
 * Earlier comments here claimed the binary's `assign_request_to_runtime_route`
 * (1218:0d4e) hosted per-family *route* selectors for families
 * {0x0f, 0x12, 0x1d, 0x21, 0x24}. That was a misreading: the jump table at
 * 1218:0f4b dispatches to per-family **target-floor** selectors
 * (`get_housekeeping_room_claim_selector` 1228:6757,
 * `dispatch_entertainment_guest_substate` 1228:662a,
 * `resolve_family_recycling_center_lower_selector_value` 1228:65c1,
 * `resolve_family_parking_selector_value` 1228:6700) whose results feed
 * `choose_transfer_floor_from_carrier_reachability` (11b8:0e41) on the
 * carrier-queue boarding path — not `select_best_route_candidate` (11b8:1484).
 *
 * The actual route selector (`select_best_route_candidate`) is family-agnostic.
 * Family differentiation happens only via the `is_passenger_route` argument
 * passed to `resolve_sim_route_between_floors` (1218:0000), which forwards it
 * as `prefer_local_mode` to `select_best_route_candidate`. Per the binary
 * call-site survey:
 *
 *   - Housekeeping (0x0f): `is_passenger_route = 0` (service mode).
 *     Sources: `update_object_family_housekeeping_connection_state`
 *     (1228:602b) at 1228:620f and 1228:6320.
 *   - Cathedral (0x24-0x28): `is_passenger_route = 1` (passenger mode).
 *     Sources: `handle_family_parking_outbound_route` (1228:5ddd) and
 *     `handle_family_parking_return_route` (1228:5e7e).
 *   - All other passenger families: `is_passenger_route = 1`.
 *
 * The per-family wrappers below make the family→selector mapping explicit and
 * binary-traceable; each is a thin shim over `selectBestRouteCandidate` with
 * the binary-correct `prefer_local_mode` value baked in.
 */
const SHARED_ROUTE_SELECTOR_FAMILIES = new Set<number>([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_RESTAURANT,
	FAMILY_OFFICE,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
]);

function isCathedralFamily(familyCode: number): boolean {
	return (
		familyCode >= FAMILY_CATHEDRAL_BASE && familyCode <= FAMILY_CATHEDRAL_MAX
	);
}

/**
 * Phase 5b: families whose state machine reads the 0x40 / 0x20 bits of
 * `sim.stateCode` through the binary's `dispatch_sim_behavior` (1228:186c)
 * two-tier switch. See ROUTING-BINARY-MAP.md §4.2 + families/state-tables/
 * family-prologue.ts (cs:1c71). Other families have their own low-valued
 * state machines (housekeeping: 0..4; cathedral: family-specific; etc.) and
 * are NOT driven by the 0x40 / 0x20 bits, so resolver-side state-bit sync
 * would corrupt their states vs. the reference trace.
 */
const STATE_BIT_FAMILIES = new Set<number>([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_RESTAURANT,
	FAMILY_OFFICE,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
]);

function familyUsesStateBits(familyCode: number): boolean {
	return STATE_BIT_FAMILIES.has(familyCode);
}

function selectRouteForFamily(
	world: WorldState,
	familyCode: number,
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): RouteCandidate | null {
	if (familyCode === FAMILY_HOUSEKEEPING) {
		return selectHousekeepingRoute(
			world,
			fromFloor,
			toFloor,
			targetHeightMetric,
		);
	}
	if (isCathedralFamily(familyCode)) {
		return selectCathedralRoute(world, fromFloor, toFloor, targetHeightMetric);
	}
	if (SHARED_ROUTE_SELECTOR_FAMILIES.has(familyCode)) {
		return selectBestRouteCandidate(
			world,
			fromFloor,
			toFloor,
			/* preferLocalMode = */ true,
			targetHeightMetric,
		);
	}
	return null;
}

/**
 * Return codes mirror `resolveSimRouteBetweenFloors` from
 * ROUTING.md / SPEC.md:
 *
 *  -1 = no viable route (sim remains unrouted)
 *   0 = carrier queue full; sim[+8] = 0xff and sim[+7] = source floor,
 *       so the sim stays parked on the source floor and retries next tick
 *   1 = direct special-link leg accepted; sim[+8] = segment index,
 *       sim[+7] = post-link floor (the leg's destination)
 *   2 = queued onto a carrier; sim[+8] = 0x40 + id (up) or 0x58 + id (down),
 *       sim[+7] = source floor
 *   3 = same-floor success (treated as immediate arrival by the caller)
 *
 * Binary quirk: same-floor returns 3 (not 2) — distinct from the enqueued
 * case so the caller can short-circuit the arrival path.
 */
export type RouteResolution = -1 | 0 | 1 | 2 | 3;

/**
 * Optional flags for `resolveSimRouteBetweenFloors`. These mirror the binary's
 * two short arguments to `resolve_sim_route_between_floors` (1218:0000):
 *
 *   Stack[0x4]:2 → `is_passenger_route` (the variable Ghidra previously named
 *     `prefer_local_mode` for the helper). In the binary it gates:
 *       - `advance_sim_trip_counters` on same-floor (rc=3) and route-failure
 *         (rc=-1) branches
 *       - `add_delay_to_current_sim(g_route_failure_delay = 300)` on rc=-1
 *       - `add_delay_to_current_sim(g_waiting_state_delay = 5)` on rc=0
 *       - `add_delay_to_current_sim(per_stop_parity_delay × step)` on rc=1
 *     and is forwarded as `prefer_local_mode` to `select_best_route_candidate`
 *     (11b8:1484), which biases scoring toward escalators over stairs.
 *
 *     At every binary call site this is `1` for passenger families (office,
 *     hotel, condo, commercial, cathedral, entertainment) and `0` for service
 *     families (housekeeping at 1228:620f / 1228:6320).
 *
 *   Stack[0x6]:2 → `emit_distance_feedback`. Gates the long-trip distance
 *     penalty (`add_delay_to_current_sim` 30-tick / 60-tick branches) on the
 *     segment success and carrier success branches.
 *
 *     At every passenger-family binary call site this is computed as
 *     `(current_state_code == base_state_code) ? 1 : 0` — i.e. fire the
 *     distance penalty exactly once per trip, on the BASE state handler, and
 *     suppress it on the +0x40 transit alias re-entries. Housekeeping passes
 *     `0` at both call sites (1228:620f / 1228:6320).
 *
 * Defaults: `isPassengerRoute = true` and `emitDistanceFeedback = true` match
 * the most common base-state passenger-family call site.
 */
export interface ResolveSimRouteOptions {
	targetHeightMetric?: number;
	isPassengerRoute?: boolean;
	emitDistanceFeedback?: boolean;
}

export function resolveSimRouteBetweenFloors(
	world: WorldState,
	sim: SimRecord,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
	time: TimeState | undefined,
	options: ResolveSimRouteOptions = {},
): RouteResolution {
	const targetHeightMetric = options.targetHeightMetric ?? sim.homeColumn;
	const isPassengerRoute = options.isPassengerRoute ?? true;
	const emitDistanceFeedback = options.emitDistanceFeedback ?? true;

	// Binary 1218:001e/0029: clamp negative source/target to LOBBY_FLOOR (10).
	// Sentinel -1 reaches here from `get_entertainment_link_routing_source_floor`
	// (binary stores 0xff in the half it has not registered yet) and from
	// `get_current_commercial_venue_destination_floor` (lobby fallback).
	if (sourceFloor < 0) sourceFloor = LOBBY_FLOOR;
	if (destinationFloor < 0) destinationFloor = LOBBY_FLOOR;

	if (sourceFloor === destinationFloor) {
		// Binary quirk: same-floor result code is 3 (not 2). The caller treats
		// this as an immediate arrival and does not enqueue onto a carrier.
		// Binary 1218:0046: same-floor branch is one of the 6 advance call sites,
		// gated on `is_passenger_route != 0`.
		if (isPassengerRoute) advanceSimTripCounters(sim);
		return 3;
	}

	// `prefer_local_mode` is now baked into the per-family selector wrappers
	// (`selectHousekeepingRoute` passes false, `selectCathedralRoute` and the
	// shared passenger families pass true), matching the binary's call-site
	// pattern in 1228:602b vs 1228:5ddd/5e7e vs all other family handlers.
	//
	// Note: the binary forwards `is_passenger_route` to `select_best_route_candidate`
	// as `prefer_local_mode`. Here we already differentiate per-family in
	// `selectRouteForFamily`, so the value of `isPassengerRoute` does not feed
	// route selection — it only gates the post-resolve delay/trip-counter writes
	// below.
	const route = selectRouteForFamily(
		world,
		sim.familyCode,
		sourceFloor,
		destinationFloor,
		targetHeightMetric,
	);
	if (!route) {
		clearSimRoute(sim);
		// Binary 1218:00ec-ish (no-route path): both the failure-delay (300) and
		// trip-counter advance are gated on `is_passenger_route`.
		if (isPassengerRoute) {
			addDelayToCurrentSim(sim, 300);
			advanceSimTripCounters(sim);
		}
		return -1;
	}

	if (route.kind === "segment") {
		// Binary 1218:0140-019d: resolve writes ONE leg per call. sim+7 jumps to
		// `source ± ((segment.mode_and_span >> 1) + 1)` (the leg endpoint), and
		// sim+8 = leg index. The per-tick stride dispatcher re-invokes the state
		// handler every 16 ticks per sim, which re-calls resolve to advance the
		// next leg. When source == destination on a re-call, the same-floor branch
		// (1218:0046) advances trip counters and returns 3, signaling arrival.
		//
		// With per-tile placement (extent_minus_one = 0 for a 2-floor stair tile),
		// (flags >> 1) + 1 == 1, so each leg advances exactly one floor.
		if (emitDistanceFeedback) {
			const segment = world.specialLinks[route.id];
			maybeApplyDistanceFeedback(
				world,
				sim,
				segment?.heightMetric ?? targetHeightMetric,
				targetHeightMetric,
				true,
			);
		}
		const direction = destinationFloor > sourceFloor ? 1 : -1;
		const nextFloor = sourceFloor + direction;
		sim.route = {
			mode: "segment",
			segmentId: route.id,
			destination: destinationFloor,
		};
		// Phase 5b: `sim.stateCode` bits are authoritative for routing mode
		// in the hotel / office / condo / restaurant / fast-food / retail
		// families (the `dispatch_sim_behavior` families per cs:1c71).
		if (familyUsesStateBits(sim.familyCode)) setSimInTransit(sim, true);
		sim.queueTick = time?.dayTick ?? sim.queueTick;
		sim.selectedFloor = nextFloor;
		sim.destinationFloor = destinationFloor;
		// Per-leg stress penalty (binary: add_delay_to_current_sim with per-stop
		// parity delay × step). Step is 1 here (one floor per leg), matching the
		// binary's per-tile segment processing. Gated on `is_passenger_route` —
		// service routes (housekeeping) skip this entirely in the binary.
		if (isPassengerRoute) {
			const segment = world.specialLinks[route.id];
			const parityBit = segment ? segment.flags & 1 : 0;
			addDelayToCurrentSim(sim, perStopParityDelay[parityBit]);
		}
		// transitTicksRemaining is no longer used to gate segment progression —
		// the per-stride state handler re-resolves the next leg.
		sim.transitTicksRemaining = 0;
		if (time) sim.lastDemandTick = time.dayTick;
		return 1;
	}

	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === route.id,
	);
	if (!carrier) {
		clearSimRoute(sim);
		if (isPassengerRoute) {
			addDelayToCurrentSim(sim, 300);
			advanceSimTripCounters(sim);
		}
		return -1;
	}

	const queued = enqueueRequestIntoRouteQueue(
		carrier,
		simKey(sim),
		sourceFloor,
		destinationFloor,
		directionFlag,
		world.lobbyMode,
	);
	if (!queued) {
		// Binary 1218:021f-ish (queue-full path): writes sim+8 = 0xff and
		// sim+7 = source floor, sets waiting bit. 5-tick penalty matches
		// g_waiting_state_delay and is gated on `is_passenger_route` in the
		// binary; the family handler retries next stride.
		clearSimRoute(sim);
		if (familyUsesStateBits(sim.familyCode)) setSimWaiting(sim, true);
		sim.selectedFloor = sourceFloor;
		sim.destinationFloor = destinationFloor;
		if (isPassengerRoute) addDelayToCurrentSim(sim, 5);
		return 0;
	}

	sim.route = {
		mode: "carrier",
		carrierId: route.id,
		direction: directionFlag === 1 ? "up" : "down",
		source: sourceFloor,
	};
	// Phase 5b: idle → carrier (enqueued, boarding pending) → set 0x40 for
	// dispatch_sim_behavior families. See `familyUsesStateBits` below.
	if (familyUsesStateBits(sim.familyCode)) setSimInTransit(sim, true);
	sim.queueTick = time?.dayTick ?? sim.queueTick;
	// Binary: carrier branch writes sim+7 = source_floor (sim parks at source
	// while waiting for the carrier; the carrier-arrival path will later set
	// sim+7 = destination_floor when the car deposits the sim).
	sim.selectedFloor = sourceFloor;
	sim.destinationFloor = destinationFloor;
	if (emitDistanceFeedback) {
		maybeApplyDistanceFeedback(
			world,
			sim,
			carrier.column,
			targetHeightMetric,
			carrier.carrierMode !== 0,
		);
	}
	if (time) sim.lastDemandTick = time.dayTick;
	return 2;
}
