import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import { addToPopulationBucket } from "../progression";
import { FAMILY_CONDO } from "../resources";
import { advanceSimTripCounters } from "../stress/trip-counters";
import { preDay4, type TimeState } from "../time";
import {
	type PlacedObjectRecord,
	type SimRecord,
	sampleRng,
	type WorldState,
} from "../world";
import {
	dispatchCommercialVenueVisit,
	dispatchSimArrival,
	findObjectForSim,
	resolveSimRouteBetweenFloors,
} from "./index";
import {
	COMMERCIAL_VENUE_DWELL_TICKS,
	CONDO_SELECTOR_FAST_FOOD,
	CONDO_SELECTOR_RESTAURANT,
	CONDO_SELECTOR_RETAIL,
	LOBBY_FLOOR,
	STATE_ACTIVE,
	STATE_ACTIVE_TRANSIT,
	STATE_AT_WORK,
	STATE_AT_WORK_TRANSIT,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_TRANSITION,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	UNIT_STATUS_CONDO_VACANT,
} from "./states";

/**
 * finalize_condo_sale @ family-9 helper: credits YEN #1001 condo payout,
 * drops unit_status into the occupied band (0 pre-day-4, 8 after), and
 * marks the slot sold. Idempotent because `unit_status >= 0x18` guards the
 * caller.
 */
function finalizeCondoSale(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	object: PlacedObjectRecord,
): void {
	addCashflowFromFamilyResource(
		ledger,
		"condo",
		object.rentLevel,
		object.objectTypeCode,
	);
	object.unitStatus = preDay4(time) ? 0x00 : 0x08;
	addToPopulationBucket(world, FAMILY_CONDO, 3);
}

/**
 * dispatch_0x20 (MORNING_GATE) per condo-handler-decomp / spec PEOPLE.md
 * §0x20/0x60. Routes the new resident from the lobby UP to the unit; the
 * SALE point fires when the unit is still vacant and resolve returned
 * 0/1/2/3. Per-leg progression is driven by re-entry to
 * handleCondoMorningTransit on subsequent strides.
 *
 * Binary 1228:3b71 (state-0x20 handler) pushes:
 *   source_floor = 0xa (LOBBY, hardcoded at 1228:3bb2 for state==0x20)
 *   target_floor = sim's home floor ([BP+0xa] = floorAnchor)
 * The state-0x20 trip is "lobby → home", not "home → lobby". The earlier
 * wiring had the args reversed, which made resolve enqueue a DOWN call
 * from the home floor (stamping secondaryRouteStatusByFloor[homeSlot]=1)
 * and pulled the elevator car up to the home floor before any rider
 * boarded.
 *
 * Transition table (matches binary + spec):
 *   rc=-1 + sold     → INC unit_status → 0x04 (CHECKOUT_QUEUE)
 *   rc=-1 + unsold   → 0x60 (no sale; retry next stride)
 *   rc=0/1/2+unsold  → 0x60 + SALE
 *   rc=3   + unsold  → INC → 0x04 + SALE
 *   rc=3   + sold    → INC → 0x04
 *
 * Resolve owns sim.selectedFloor / sim.destinationFloor on rc=1/2 (per-leg
 * progression) — do NOT overwrite them after the call.
 */
function dispatchCondoMorningGate(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		directionFlag,
		time,
	);
	const wasVacant = object.unitStatus >= UNIT_STATUS_CONDO_VACANT;

	if (result === -1) {
		// Sold sims terminate to CHECKOUT_QUEUE; unsold sims stay in the
		// transit state to retry next stride.
		sim.stateCode = wasVacant ? STATE_MORNING_TRANSIT : STATE_CHECKOUT_QUEUE;
		return;
	}

	if (wasVacant) {
		finalizeCondoSale(world, ledger, time, object);
	}

	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}

	// rc=0/1/2: in transit. Resolve owns sim+7/sim+0x12 — handler sets state only.
	sim.stateCode = STATE_MORNING_TRANSIT;
}

// --- Per-state handlers ---

/** condo_refresh_0x20 — morning gate (STATE_MORNING_GATE). */
function handleCondoMorningGate(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	// Binary 1228:375e: CMP byte ptr ES:[BX+0x14],0x0 — reads occupied flag.
	// refresh_0x20: slot+0x14 != 0 AND daypart < 5 → dispatch.
	if (object.occupiedFlag === 0) return;
	if (time.daypartIndex >= 5) return;
	dispatchCondoMorningGate(world, ledger, time, sim, object);
}

/**
 * condo_refresh_0x60 — in-transit morning gate (STATE_MORNING_TRANSIT). Per
 * binary jump table, state 0x60 aliases state 0x20's handler with variant
 * flag = 0. Per stride, re-resolves the route from sim+7 to LOBBY; resolve
 * advances sim+7 by one leg. On rc=3 (arrived) the SALE finalizes and the
 * sim transitions to CHECKOUT_QUEUE. On rc=-1 with a still-vacant unit the
 * sim stays in the transit state to retry next stride (matches binary's
 * "unsold" branch staying at 0x60).
 */
function handleCondoMorningTransit(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (sim.route.mode === "carrier") return;
	const sourceFloor = sim.selectedFloor;
	const targetFloor = sim.floorAnchor;
	// Alias state 0x60 (MORNING_TRANSIT): in the binary `emit_distance_feedback`
	// is `0` here. Distance feedback was already applied by the base state
	// 0x20 dispatch. Per binary 1228:3b71 the trip target is the sim's home
	// floor ([BP+0xa] = floorAnchor) — same as state 0x20 — with the source
	// taken from the in-transit local (sim.selectedFloor) on the 0x60 alias.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		targetFloor,
		targetFloor > sourceFloor ? 1 : 0,
		time,
		{ emitDistanceFeedback: false },
	);
	const wasVacant = object.unitStatus >= UNIT_STATUS_CONDO_VACANT;

	if (result === -1) {
		sim.stateCode = wasVacant ? STATE_MORNING_TRANSIT : STATE_CHECKOUT_QUEUE;
		return;
	}

	if (wasVacant) {
		finalizeCondoSale(world, ledger, time, object);
	}

	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	// rc=0/1/2: stay in transit; next stride re-resolves the next leg.
}

/**
 * condo_refresh_0x40 — in-transit commute (STATE_COMMUTE_TRANSIT). Binary
 * 0x40 aliases 0x00 (handler 1228:3a77). Per binary mapping table:
 *   rc=-1 → 0x40 (transit; we treat as CHECKOUT_QUEUE on hard fail per office
 *            pattern)
 *   rc=0/1/2 → stay in transit (next stride re-resolves)
 *   rc=3 → arrived → AT_WORK (via dispatchSimArrival → handleCondoSimArrival)
 *
 * Source = sim+7 (selectedFloor); Target = 0xa (LOBBY_FLOOR). Resolve owns
 * sim+7/sim+0x12 on rc=1/2 — handler must not overwrite.
 */
function handleCondoCommuteTransit(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (sim.route.mode === "carrier") return;
	const sourceFloor = sim.selectedFloor;
	const targetFloor = LOBBY_FLOOR;
	// Alias state 0x40 (COMMUTE_TRANSIT): in the binary `emit_distance_feedback`
	// is `0` here. Distance feedback was already applied by the base state
	// 0x00 dispatch.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		targetFloor,
		targetFloor > sourceFloor ? 1 : 0,
		time,
		{ emitDistanceFeedback: false },
	);
	if (result === -1) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (result === 3) {
		// Arrived. Trip counter + lastDemandTick reset already done inside
		// resolve's same-floor branch (1218:0046). The binary arrival path
		// 1218:0883 has no further advance.
		dispatchSimArrival(world, ledger, time, sim, targetFloor);
	}
}

/**
 * condo_refresh_0x61 — in-transit at-work return (STATE_AT_WORK_TRANSIT).
 * Binary 0x61 aliases 0x21 (handler 1228:3d8a). Per binary mapping table:
 *   rc=-1 → 0x04 (CHECKOUT_QUEUE)
 *   rc=0/1/2 → 0x61 (stays; next stride re-resolves)
 *   rc=3 → 0x04 (CHECKOUT_QUEUE)
 *
 * Source = sim+7 (selectedFloor); Target = arg (floorAnchor / home). Resolve
 * owns sim+7/sim+0x12 on rc=1/2 — handler must not overwrite.
 */
function handleCondoAtWorkTransit(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (sim.route.mode === "carrier") return;
	const sourceFloor = sim.selectedFloor;
	const targetFloor = sim.floorAnchor;
	// Alias state 0x61 (AT_WORK_TRANSIT): in the binary `emit_distance_feedback`
	// is `0` here. Distance feedback was already applied by the base state
	// 0x21 dispatch.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		targetFloor,
		targetFloor > sourceFloor ? 1 : 0,
		time,
		{ emitDistanceFeedback: false },
	);
	if (result === -1) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (result === 3) {
		// Arrived. Trip counter + lastDemandTick reset already done inside
		// resolve's same-floor branch (1218:0046).
		dispatchSimArrival(world, ledger, time, sim, targetFloor);
	}
}

/**
 * condo_refresh_0x41 — in-transit active/venue (STATE_ACTIVE_TRANSIT). Binary
 * state 0x01/0x41 does NOT call resolve in the per-tick handler; the venue
 * selector (1238:0000) is invoked once at dispatch time. For per-leg segment
 * progression, however, the handler still must advance one leg per stride;
 * otherwise the sim is stuck because the legacy whole-trip finalizer is now
 * skipped for condos. Carrier-routed sims are skipped here (handled by
 * maybe_dispatch_queued_route_after_wait per the binary).
 */
function handleCondoActiveTransit(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (sim.route.mode === "carrier") return;
	if (sim.destinationFloor < 0) return;
	const sourceFloor = sim.selectedFloor;
	const targetFloor = sim.destinationFloor;
	// Alias state 0x41 (ACTIVE_TRANSIT): in the binary `emit_distance_feedback`
	// is `0` here. Distance feedback was already applied by the base state
	// 0x01 dispatch (which uses the venue selector, not resolve, but follows
	// the same base-vs-alias contract).
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		targetFloor,
		targetFloor > sourceFloor ? 1 : 0,
		time,
		{ emitDistanceFeedback: false },
	);
	if (result === -1) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (result === 3) {
		// Arrived. Trip counter + lastDemandTick reset already done inside
		// resolve's same-floor branch (1218:0046).
		dispatchSimArrival(world, ledger, time, sim, targetFloor);
	}
}

/**
 * condo_refresh_0x62 — in-transit venue-home (STATE_VENUE_HOME_TRANSIT).
 * Binary state 0x22/0x62 does NOT call resolve in the per-tick handler
 * (uses 1238:0244 release path). Per-leg segment progression still requires
 * a re-resolve here so the sim isn't stuck. Carrier-routed sims are skipped
 * (handled by maybe_dispatch_queued_route_after_wait).
 */
function handleCondoVenueHomeTransit(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	if (sim.route.mode === "carrier") return;
	if (sim.destinationFloor < 0) return;
	const sourceFloor = sim.selectedFloor;
	const targetFloor = sim.destinationFloor;
	// Alias state 0x62 (VENUE_HOME_TRANSIT): in the binary `emit_distance_feedback`
	// is `0` here. Distance feedback was already applied by the base state
	// 0x22 dispatch.
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		targetFloor,
		targetFloor > sourceFloor ? 1 : 0,
		time,
		{ emitDistanceFeedback: false },
	);
	if (result === -1) {
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (result === 3) {
		// Arrived. Trip counter + lastDemandTick reset already done inside
		// resolve's same-floor branch (1218:0046).
		dispatchSimArrival(world, ledger, time, sim, targetFloor);
	}
}

/** condo_refresh_0x04 — checkout queue (STATE_CHECKOUT_QUEUE). */
function handleCondoCheckoutQueue(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// refresh_0x04: baseOffset==2 branch dispatches unconditionally at
	// daypart>=5 (no RNG). Other siblings roll 1/12 until dayTick>=2401,
	// then dispatch unconditionally.
	if (time.daypartIndex < 5) return;
	if (sim.baseOffset !== 2 && time.dayTick < 2401) {
		if (sampleRng(world) % 12 !== 0) return;
	}
	sim.stateCode = STATE_TRANSITION;
}

/** condo_refresh_0x10 — unit status transition (STATE_TRANSITION). */
function handleCondoTransition(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// refresh_0x10: daypart < 5 → dispatch; daypart >= 5 AND
	// dayTick < 2567 → skip; daypart >= 5 AND dayTick >= 2567 →
	// 1/12 RNG → dispatch.
	if (time.daypartIndex >= 5) {
		if (time.dayTick < 2567) return;
		if (sampleRng(world) % 12 !== 0) return;
	}
	// dispatch_0x10 per FUN_1228_397b:
	//   weekend_flag == 1 && BP+0xc % 2 != 0 → 0x04 (CHECKOUT_QUEUE)
	//   weekend_flag == 1 && BP+0xc % 2 == 0 → 0x01 (ACTIVE)
	//   weekend_flag != 1 && BP+0xe == 1     → 0x01 (ACTIVE)
	//   weekend_flag != 1 && BP+0xe != 1     → 0x00 (COMMUTE)
	if (time.weekendFlag === 1) {
		sim.stateCode =
			sim.facilitySlot % 2 !== 0 ? STATE_CHECKOUT_QUEUE : STATE_ACTIVE;
	} else {
		sim.stateCode = sim.baseOffset === 1 ? STATE_ACTIVE : STATE_COMMUTE;
	}
}

/** condo_refresh_0x00 — commute (STATE_COMMUTE). */
function handleCondoCommute(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// refresh_0x00: daypart 0 → 1/12 RNG; daypart 6 → skip; else dispatch.
	if (time.daypartIndex === 6) return;
	if (time.daypartIndex === 0) {
		if (sampleRng(world) % 12 !== 0) return;
	}
	dispatchCondoCommute(world, time, sim);
}

/** condo_refresh_0x01 — active / venue selection (STATE_ACTIVE). */
function handleCondoActive(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// refresh_0x01 (1228:3681):
	//   weekend_flag == 1 AND BP+8 (facilitySlot) % 4 == 0:
	//     daypart 4: 1/6 RNG → dispatch (fallthrough)
	//     daypart > 4: set state = 0x04 (CHECKOUT_QUEUE) directly, return
	//     daypart < 4: return
	//   else (non-weekend or slot%4 != 0):
	//     daypart 0: dayTick > 240 AND 1/12 RNG → dispatch
	//     daypart 6: skip
	//     else: dispatch
	if (time.weekendFlag === 1 && sim.facilitySlot % 4 === 0) {
		if (time.daypartIndex === 4) {
			if (sampleRng(world) % 6 === 0) {
				dispatchCondoActive(world, time, sim);
			}
			return;
		}
		if (time.daypartIndex > 4) {
			sim.stateCode = STATE_CHECKOUT_QUEUE;
			return;
		}
		return;
	}
	if (time.daypartIndex === 6) return;
	if (time.daypartIndex === 0) {
		if (time.dayTick < 0xf1) return;
		if (sampleRng(world) % 12 !== 0) return;
	}
	dispatchCondoActive(world, time, sim);
}

/** condo_refresh_0x21 — at work (STATE_AT_WORK). */
function handleCondoAtWork(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// refresh_0x21: baseOffset==2 branch fires a daypart earlier.
	if (sim.baseOffset === 2) {
		if (time.daypartIndex < 3) return;
		if (time.daypartIndex === 3) {
			if (sampleRng(world) % 12 !== 0) return;
		}
	} else {
		if (time.daypartIndex < 4) return;
		if (time.daypartIndex === 4) {
			if (sampleRng(world) % 12 !== 0) return;
		}
	}
	dispatchCondoAtWork(world, time, sim);
}

/** condo_refresh_0x22 — venue trip (STATE_VENUE_TRIP). */
function handleCondoVenueTrip(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord,
): void {
	// refresh_0x22: daypart > 2 → dispatch.
	if (time.daypartIndex <= 2) return;
	// Binary release_commercial_venue_slot gates the exit on service_duration.
	if (
		sim.venueReturnState !== STATE_CHECKOUT_QUEUE &&
		time.dayTick - sim.queueTick < COMMERCIAL_VENUE_DWELL_TICKS
	) {
		return;
	}
	dispatchCondoVenueTrip(world, time, sim);
}

export type CondoHandler = (
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
) => void;

/** Family-9 (condo) refresh dispatch table (state_code → handler). */
export const CONDO_REFRESH_HANDLER_TABLE: ReadonlyMap<number, CondoHandler> =
	new Map([
		[STATE_MORNING_GATE, handleCondoMorningGate], // 0x20
		[STATE_MORNING_TRANSIT, handleCondoMorningTransit], // 0x60 alias of 0x20
		[STATE_CHECKOUT_QUEUE, handleCondoCheckoutQueue], // 0x04
		[STATE_TRANSITION, handleCondoTransition], // 0x10
		[STATE_COMMUTE, handleCondoCommute], // 0x00
		[STATE_COMMUTE_TRANSIT, handleCondoCommuteTransit], // 0x40 alias of 0x00
		[STATE_ACTIVE, handleCondoActive], // 0x01
		[STATE_ACTIVE_TRANSIT, handleCondoActiveTransit], // 0x41 (no resolve in binary;
		// per-leg progression here for our merged-segment model)
		[STATE_AT_WORK, handleCondoAtWork], // 0x21
		[STATE_AT_WORK_TRANSIT, handleCondoAtWorkTransit], // 0x61 alias of 0x21
		[STATE_VENUE_TRIP, handleCondoVenueTrip], // 0x22
		[STATE_VENUE_HOME_TRANSIT, handleCondoVenueHomeTransit], // 0x62
	]);

export function processCondoSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	const handler = CONDO_REFRESH_HANDLER_TABLE.get(sim.stateCode);
	if (handler) {
		handler(world, ledger, time, sim, object);
	}
}

/**
 * dispatch_0x00 (COMMUTE) — route from home to LOBBY. Binary state 0x00 in the
 * condo dispatch maps:
 *   rc=-1 → 0x40 (transit; retry)   [our model: CHECKOUT_QUEUE on hard-fail]
 *   rc=0/1/2 → 0x40 (in transit)
 *   rc=3 → arrival → 0x21 (AT_WORK)
 *
 * Resolve owns sim.selectedFloor / sim.destinationFloor on rc=1/2.
 */
function dispatchCondoCommute(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		LOBBY_FLOOR,
		directionFlag,
		time,
	);
	if (result === -1) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_AT_WORK;
		return;
	}
	// rc=0/1/2: in transit. Don't overwrite resolve's per-leg writes.
	sim.stateCode = STATE_COMMUTE_TRANSIT;
}

function dispatchCondoActive(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	// dispatch_0x01 selector (1228:3b34-3b54):
	//   weekend_flag == 0               → 0 (retail)
	//   weekend_flag != 0, slot % 4 == 0 → 1 (restaurant)
	//   weekend_flag != 0, slot % 4 != 0 → 2 (fast food)
	const venueFamilies =
		time.weekendFlag === 0
			? CONDO_SELECTOR_RETAIL
			: sim.facilitySlot % 4 === 0
				? CONDO_SELECTOR_RESTAURANT
				: CONDO_SELECTOR_FAST_FOOD;
	// Per family-9 dispatch table (spec PEOPLE.md §0x22/0x62): on dwell complete /
	// home arrival, INC unit_status → STATE_CHECKOUT_QUEUE. Re-entry to STATE_ACTIVE
	// happens via STATE_TRANSITION (0x04 → 0x10 → 0x01), not directly off the dwell.
	const dispatched = dispatchCommercialVenueVisit(world, time, sim, {
		venueFamilies,
		returnState: STATE_CHECKOUT_QUEUE,
		tripState: STATE_ACTIVE_TRANSIT,
		skipPenaltyOnUnavailable: true,
	});
	if (!dispatched) {
		routeCondoToLobbyNoVenue(world, time, sim);
	}
}

/**
 * Binary route_sim_to_commercial_venue (1238:0000) state-0x01 branch: when
 * `pickAvailableVenue` returns null, the helper still resolves a route from
 * the home floor to the lobby and forces state=0x41 (no failure path is
 * exposed to the family-9 dispatcher). Mirrors hotel's
 * `routeHotelToLobbyNoVenue`. The `venueReturnState = STATE_CHECKOUT_QUEUE`
 * marker steers `handleCondoSimArrival` to drop into STATE_VENUE_TRIP on
 * lobby arrival, matching the binary's hidden 0x22 transition.
 */
function routeCondoToLobbyNoVenue(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 0 : 1;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.floorAnchor,
		LOBBY_FLOOR,
		directionFlag,
		time,
	);
	if (result === -1 || result === 0) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	sim.venueReturnState = STATE_CHECKOUT_QUEUE;
	if (result === 3) {
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}
	// rc=1/2: in transit. Don't overwrite resolve's per-leg writes.
	sim.stateCode = STATE_ACTIVE_TRANSIT;
}

function dispatchCondoAtWork(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > LOBBY_FLOOR ? 1 : 0;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		LOBBY_FLOOR,
		sim.floorAnchor,
		directionFlag,
		time,
	);
	if (result === -1 || result === 3) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	// rc=0/1/2: in transit. Don't overwrite resolve's per-leg writes.
	sim.stateCode = STATE_AT_WORK_TRANSIT;
}

function dispatchCondoVenueTrip(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const directionFlag = sim.floorAnchor > sim.selectedFloor ? 1 : 0;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sim.selectedFloor,
		sim.floorAnchor,
		directionFlag,
		time,
	);
	if (result === -1 || result === 3) {
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	// rc=0/1/2: in transit. Don't overwrite resolve's per-leg writes.
	sim.stateCode = STATE_VENUE_HOME_TRANSIT;
}

export function handleCondoSimArrival(
	sim: SimRecord,
	arrivalFloor: number,
	time: TimeState,
	arrivedViaCarrier: boolean,
): void {
	// Binary's per-stride 0x60/0x40/0x41/0x61/0x62 handler re-resolves(target,
	// target)=3 on arrival, draining stress via advance_sim_trip_counters at
	// 1218:0046. The carrier-delivery shortcut (queue/dispatch-arrivals.ts)
	// invokes this dispatcher instead of running the per-stride handler, so
	// the advance must fire here for carrier-routed arrivals. Stair/segment
	// arrivals reach this dispatcher via the per-stride handler's rc=3 →
	// dispatchSimArrival path, where resolve already advanced trip counters,
	// so we gate on `arrivedViaCarrier` (captured pre-clearSimRoute) to avoid
	// double-counting.
	if (
		sim.stateCode === STATE_MORNING_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		// Binary 1228:3b71 state-0x20 trip target is sim.floorAnchor (home),
		// not LOBBY: morning gate is the new resident moving lobby → home.
		if (arrivedViaCarrier) advanceSimTripCounters(sim);
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (sim.stateCode === STATE_COMMUTE_TRANSIT && arrivalFloor === LOBBY_FLOOR) {
		if (arrivedViaCarrier) advanceSimTripCounters(sim);
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_AT_WORK;
		return;
	}
	if (
		sim.stateCode === STATE_ACTIVE_TRANSIT &&
		arrivalFloor === LOBBY_FLOOR &&
		sim.venueReturnState === STATE_CHECKOUT_QUEUE
	) {
		// No-venue fallback arrival: binary 1238:0000 state-0x01 lobby path
		// (acquire_slot(-1)=3 fall-through) lands in state 0x22 (VENUE_TRIP).
		// The existing 0x22/0x62 handler then unwinds via 0x04 (CHECKOUT_QUEUE).
		if (arrivedViaCarrier) advanceSimTripCounters(sim);
		sim.destinationFloor = -1;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		return;
	}
	if (sim.stateCode === STATE_ACTIVE_TRANSIT && arrivalFloor !== LOBBY_FLOOR) {
		// Condo arrived at a real commercial venue: binary 1228:4fab writes
		// state=0x22 (VENUE_TRIP) with queueTick latched for the dwell gate.
		// Clear venueReturnState so the 0x22 handler treats this as real-venue
		// (binary release_commercial_venue_slot gates on service_duration when
		// facilitySlot >= 0; stale CHECKOUT_QUEUE marker from a prior fake-lunch
		// must not short-circuit the dwell).
		if (arrivedViaCarrier) advanceSimTripCounters(sim);
		sim.destinationFloor = -1;
		sim.selectedFloor = arrivalFloor;
		sim.stateCode = STATE_VENUE_TRIP;
		sim.queueTick = time.dayTick;
		sim.venueReturnState = 0;
		return;
	}
	if (
		sim.stateCode === STATE_AT_WORK_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		// Spec PEOPLE.md §0x21/0x61: arrived → INC unit_status → 0x04. Re-entry
		// to ACTIVE happens via STATE_TRANSITION (0x04 → 0x10 → 0x01).
		if (arrivedViaCarrier) advanceSimTripCounters(sim);
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
	if (
		sim.stateCode === STATE_VENUE_HOME_TRANSIT &&
		arrivalFloor === sim.floorAnchor
	) {
		// Binary family-9 dispatch table: state 0x22/0x62 fail/arrived →
		// INC unit_status → 0x04 (CHECKOUT_QUEUE). Arrival here is the
		// "arrived" branch.
		if (arrivedViaCarrier) advanceSimTripCounters(sim);
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}
}
