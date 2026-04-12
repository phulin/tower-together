import { enqueueCarrierRoute } from "../carriers";
import { checkEvalCompletionAndAward, processCathedralSim } from "../cathedral";
import type { LedgerState } from "../ledger";
import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { type RouteCandidate, selectBestRouteCandidate } from "../routing";
import { processCondoSim } from "./condo";

export {
	closeCommercialVenues,
	refundUnhappyFacilities,
	resetCommercialVenueCycle,
} from "./facility-refunds";

import { checkoutHotelStay, processHotelSim } from "./hotel";

export {
	handleExtendedVacancyExpiry,
	normalizeUnitStatusEndOfDay,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "./hotel-facilities";

import {
	advanceOfficePresenceCounter,
	nextOfficeReturnState,
	processOfficeSim,
} from "./office";
import { clearSimRoute, findObjectForSim, simKey } from "./population";
import { maybeApplyDistanceFeedback } from "./scoring";
import {
	CATHEDRAL_FAMILIES,
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_VENUE_DWELL_TICKS,
	ELEVATOR_DEMAND_STATES,
	ENTITY_REFRESH_STRIDE,
	EVAL_ZONE_FLOOR,
	EVALUATABLE_FAMILIES,
	INVALID_FLOOR,
	LOBBY_FLOOR,
	ROUTE_IDLE,
	STATE_ACTIVE,
	STATE_ACTIVE_TRANSIT,
	STATE_ARRIVED,
	STATE_AT_WORK,
	STATE_AT_WORK_TRANSIT,
	STATE_CHECKOUT_QUEUE,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_B,
	STATE_PARKED,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	STATE_VENUE_TRIP_TRANSIT,
} from "./states";
import {
	addDelayToCurrentSim,
	advanceSimTripCounters,
	rebaseSimElapsedFromClock,
} from "./trip-counters";

export { rebuildParkingDemandLog, tryAssignParkingService } from "./parking";
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
	createSimStateRecords,
	maybeApplyDistanceFeedback,
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
} from "./trip-counters";

import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type SimRecord,
	VENUE_CLOSED,
	VENUE_DORMANT,
	type WorldState,
	yToFloor,
} from "../world";

function hasViableRouteBetweenFloors(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	return (
		fromFloor === toFloor ||
		selectBestRouteCandidate(world, fromFloor, toFloor) !== null
	);
}

export function releaseServiceRequest(
	_world: WorldState,
	sim: SimRecord,
): void {
	sim.destinationFloor = -1;
	clearSimRoute(sim);
}

function recomputeRoutesViableFlag(world: WorldState, time: TimeState): void {
	// Binary-grounded: rebuild_path_seed_bucket_table unconditionally latches
	// routesViable = 1 whenever star_count > 2; no route-scoring predicate found.
	world.gateFlags.routesViable = time.starCount > 2 ? 1 : 0;
}

interface VenueSelection {
	record: CommercialVenueRecord;
	floor: number;
}

function pickAvailableVenue(
	world: WorldState,
	fromFloor: number,
	allowedFamilies: Set<number>,
): VenueSelection | null {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (!allowedFamilies.has(object.objectTypeCode)) continue;
		if (object.linkedRecordIndex < 0) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.ownerSubtypeIndex === INVALID_FLOOR) continue;
		if (
			record.availabilityState === VENUE_CLOSED ||
			record.availabilityState === VENUE_DORMANT
		)
			continue;
		if (record.todayVisitCount >= record.capacity) continue;

		const [, y] = key.split(",").map(Number);
		if (!hasViableRouteBetweenFloors(world, fromFloor, yToFloor(y))) {
			continue;
		}

		return { record, floor: yToFloor(y) };
	}

	return null;
}

/**
 * Reduce elapsed time when boarding a non-service carrier from the lobby.
 * Spec: reduce_elapsed_for_lobby_boarding.
 */
function reduceElapsedForLobbyBoarding(
	sim: SimRecord,
	sourceFloor: number,
	world: WorldState,
): void {
	if (sourceFloor !== LOBBY_FLOOR) return;
	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const discount = lobbyHeight >= 3 ? 50 : lobbyHeight === 2 ? 25 : 0;
	if (discount === 0) return;
	sim.elapsedTicks = Math.max(0, sim.elapsedTicks - discount);
}

function completeSimTransitEvent(
	sim: SimRecord,
	time: TimeState | undefined,
): void {
	if (time) {
		rebaseSimElapsedFromClock(sim, time);
	}
	advanceSimTripCounters(sim);
}

function reserveVenue(record: CommercialVenueRecord): void {
	record.todayVisitCount += 1;
	record.visitCount = record.todayVisitCount;
}

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
): void {
	sim.destinationFloor = destinationFloor;
	sim.selectedFloor = sim.floorAnchor;
	sim.stateCode = STATE_VENUE_TRIP;
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
		unavailableState?: number;
		skipPenaltyOnUnavailable?: boolean;
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
		const dirFlag = venue.floor > sim.floorAnchor ? 0 : 1;
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.floorAnchor,
			venue.floor,
			dirFlag,
			time,
		);
		if (routeResult === -1 || routeResult === 0) {
			if (options.unavailableState !== undefined) {
				sim.stateCode = options.unavailableState;
			}
			return false;
		}
	}

	reserveVenue(venue.record);
	rebaseSimElapsedFromClock(sim, time);
	advanceSimTripCounters(sim);
	options.onVenueReserved?.();
	if (venue.floor === sim.floorAnchor) {
		beginCommercialVenueDwell(sim, venue.floor, options.returnState, time);
	} else {
		beginCommercialVenueTrip(sim, venue.floor);
	}
	return true;
}

export function handleCommercialVenueArrival(
	sim: SimRecord,
	arrivalFloor: number,
	returnState: number,
	time: TimeState,
): boolean {
	if (
		sim.stateCode !== STATE_VENUE_TRIP ||
		sim.destinationFloor !== arrivalFloor
	) {
		return false;
	}
	beginCommercialVenueDwell(sim, arrivalFloor, returnState, time);
	return true;
}

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
		// Spec: dispatch_sim_behavior calls rebase_sim_elapsed_from_clock every tick.
		rebaseSimElapsedFromClock(sim, time);
		finalizePendingRouteLeg(sim);
		switch (sim.familyCode) {
			case FAMILY_HOTEL_SINGLE:
			case FAMILY_HOTEL_TWIN:
			case FAMILY_HOTEL_SUITE:
				processHotelSim(world, ledger, time, sim);
				break;
			case FAMILY_OFFICE:
				processOfficeSim(world, ledger, time, sim);
				break;
			case FAMILY_CONDO:
				processCondoSim(world, ledger, time, sim);
				break;
			default:
				if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
					processCathedralSim(world, time, sim);
				}
				break;
		}
	}

	recomputeRoutesViableFlag(world, time);
}

function shouldSeedElevatorDemand(sim: SimRecord): boolean {
	if (sim.routeRetryDelay > 0) return false;
	if (sim.route.mode !== "idle") return false;
	if (!ELEVATOR_DEMAND_STATES.has(sim.stateCode)) return false;
	if (
		!EVALUATABLE_FAMILIES.has(sim.familyCode) &&
		!CATHEDRAL_FAMILIES.has(sim.familyCode)
	) {
		return false;
	}
	return true;
}

function getElevatorDemand(sim: SimRecord): {
	sourceFloor: number;
	destinationFloor: number;
	directionFlag: number;
} | null {
	// Active office/hotel/condo routes carry their destination on the sim.
	if (
		sim.destinationFloor >= 0 &&
		(sim.stateCode === STATE_COMMUTE ||
			sim.stateCode === STATE_COMMUTE_TRANSIT ||
			sim.stateCode === STATE_ACTIVE_TRANSIT ||
			sim.stateCode === STATE_VENUE_TRIP_TRANSIT ||
			sim.stateCode === STATE_DEPARTURE_TRANSIT ||
			sim.stateCode === STATE_MORNING_TRANSIT ||
			sim.stateCode === STATE_AT_WORK_TRANSIT ||
			sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
			sim.stateCode === STATE_DWELL_RETURN_TRANSIT)
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: sim.destinationFloor,
			directionFlag: sim.destinationFloor > sim.selectedFloor ? 0 : 1,
		};
	}

	if (
		sim.stateCode === STATE_CHECKOUT_QUEUE ||
		sim.stateCode === STATE_DEPARTURE
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 1,
		};
	}

	if (sim.stateCode === STATE_VENUE_TRIP && sim.destinationFloor >= 0) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: sim.destinationFloor,
			directionFlag: sim.destinationFloor > sim.selectedFloor ? 0 : 1,
		};
	}

	// Cathedral guest: outbound routes to eval zone
	if (
		CATHEDRAL_FAMILIES.has(sim.familyCode) &&
		sim.stateCode === STATE_EVAL_OUTBOUND
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: EVAL_ZONE_FLOOR,
			directionFlag: 0,
		};
	}
	// Cathedral guest: return routes to lobby
	if (
		CATHEDRAL_FAMILIES.has(sim.familyCode) &&
		sim.stateCode === STATE_EVAL_RETURN
	) {
		return {
			sourceFloor: sim.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 1,
		};
	}

	return null;
}

/**
 * Family selector tables.
 *
 * Per ROUTING.md, the binary's `assign_request_to_runtime_route` uses one
 * shared route selector for families {3,4,5,6,7,9,10,0x0c} and dispatches to
 * custom selectors for {0x0f, 0x12, 0x1d, 0x21, 0x24}. The custom selectors
 * are not yet modeled in the clean-room sim — for now they fall through to the
 * shared selector so the call site can still ask "is there any route?".
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
]);
const CUSTOM_ROUTE_SELECTOR_FAMILIES = new Set<number>([
	0x0f, 0x12, 0x1d, 0x21, 0x24, 0x25, 0x26, 0x27, 0x28,
]);

function selectRouteForFamily(
	world: WorldState,
	familyCode: number,
	fromFloor: number,
	toFloor: number,
	preferLocalMode: boolean,
): RouteCandidate | null {
	if (
		SHARED_ROUTE_SELECTOR_FAMILIES.has(familyCode) ||
		CUSTOM_ROUTE_SELECTOR_FAMILIES.has(familyCode)
	) {
		return selectBestRouteCandidate(world, fromFloor, toFloor, preferLocalMode);
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
 */
export type RouteResolution = -1 | 0 | 1 | 2 | 3;

export function resolveSimRouteBetweenFloors(
	world: WorldState,
	sim: SimRecord,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
	time: TimeState | undefined,
): RouteResolution {
	if (sourceFloor === destinationFloor) {
		completeSimTransitEvent(sim, time);
		return 3;
	}

	// Family 0x0f (housekeeping) uses stairs-only routing (rejects escalators).
	// All other families use local (escalator-preferred) routing.
	const preferLocalMode = sim.familyCode !== 0x0f;

	const route = selectRouteForFamily(
		world,
		sim.familyCode,
		sourceFloor,
		destinationFloor,
		preferLocalMode,
	);
	if (!route) {
		clearSimRoute(sim);
		sim.routeRetryDelay = 300;
		addDelayToCurrentSim(sim, 300);
		advanceSimTripCounters(sim);
		return -1;
	}

	if (route.kind === "segment") {
		maybeApplyDistanceFeedback(world, sim, sourceFloor, destinationFloor, true);
		sim.route = {
			mode: "segment",
			segmentId: route.id,
			destination: destinationFloor,
		};
		sim.queueTick = time?.dayTick ?? sim.queueTick;
		sim.destinationFloor = destinationFloor;
		// Per-stop transit delay: Escalator branch = 16 ticks/floor,
		// Stairs branch = 35 ticks/floor.
		const segment = world.specialLinks[route.id];
		const isStairsBranch = segment ? (segment.flags & 1) !== 0 : false;
		const perStopDelay = isStairsBranch ? 35 : 16;
		sim.transitTicksRemaining =
			Math.abs(destinationFloor - sourceFloor) * perStopDelay;
		// Route-start timestamp: start the clock for elapsed tracking.
		if (time) sim.lastDemandTick = time.dayTick;
		return 1;
	}

	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === route.id,
	);
	if (!carrier) {
		clearSimRoute(sim);
		addDelayToCurrentSim(sim, 300);
		advanceSimTripCounters(sim);
		return -1;
	}

	const queued = enqueueCarrierRoute(
		carrier,
		simKey(sim),
		sourceFloor,
		destinationFloor,
		directionFlag,
	);
	if (!queued) {
		// Queue full: sim remains parked here and retries after a short delay.
		sim.route = { mode: "queued", source: sourceFloor };
		sim.destinationFloor = destinationFloor;
		sim.routeRetryDelay = 5;
		addDelayToCurrentSim(sim, 5);
		return 0;
	}

	sim.route = {
		mode: "carrier",
		carrierId: route.id,
		direction: directionFlag === 0 ? "up" : "down",
		source: sourceFloor,
	};
	sim.queueTick = time?.dayTick ?? sim.queueTick;
	sim.destinationFloor = destinationFloor;
	// Spec: accumulate_elapsed_delay_into_current_sim for non-service carriers.
	if (time && carrier.carrierMode !== 2) {
		rebaseSimElapsedFromClock(sim, time);
		reduceElapsedForLobbyBoarding(sim, sourceFloor, world);
	}
	maybeApplyDistanceFeedback(
		world,
		sim,
		sourceFloor,
		destinationFloor,
		carrier.carrierMode !== 2,
	);
	// Route-start timestamp: start the clock for elapsed tracking.
	if (time) sim.lastDemandTick = time.dayTick;
	return 2;
}

function shouldFinalizeSegmentTrip(sim: SimRecord): boolean {
	return (
		sim.stateCode === STATE_COMMUTE ||
		sim.stateCode === STATE_COMMUTE_TRANSIT ||
		sim.stateCode === STATE_ACTIVE_TRANSIT ||
		sim.stateCode === STATE_VENUE_TRIP ||
		sim.stateCode === STATE_VENUE_TRIP_TRANSIT ||
		sim.stateCode === STATE_CHECKOUT_QUEUE ||
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
	if (sim.transitTicksRemaining > 0) {
		sim.transitTicksRemaining -= 1;
		return;
	}
	sim.selectedFloor = sim.route.destination;
	clearSimRoute(sim);
}

function dispatchSimArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	if (sim.destinationFloor >= 0 && arrivalFloor === sim.destinationFloor) {
		completeSimTransitEvent(sim, time);
	}
	sim.selectedFloor = arrivalFloor;
	clearSimRoute(sim);

	const object = findObjectForSim(world, sim);
	switch (sim.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			// Arrived at room from check-in commute
			if (sim.stateCode === STATE_COMMUTE && arrivalFloor === sim.floorAnchor) {
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.stateCode = STATE_ACTIVE;
				return;
			}
			if (handleCommercialVenueArrival(sim, arrivalFloor, STATE_ACTIVE, time)) {
				return;
			}
			if (
				(sim.stateCode === STATE_CHECKOUT_QUEUE ||
					sim.stateCode === STATE_DEPARTURE) &&
				arrivalFloor === LOBBY_FLOOR
			) {
				sim.destinationFloor = -1;
				if (object) checkoutHotelStay(world, ledger, time, sim, object);
			}
			return;
		case FAMILY_OFFICE:
			if (
				sim.stateCode === STATE_MORNING_TRANSIT &&
				arrivalFloor === sim.floorAnchor
			) {
				if (object) advanceOfficePresenceCounter(object);
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.stateCode = STATE_DEPARTURE;
				return;
			}
			if (
				sim.stateCode === STATE_AT_WORK_TRANSIT &&
				arrivalFloor === sim.floorAnchor
			) {
				if (object) advanceOfficePresenceCounter(object);
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.stateCode = STATE_DEPARTURE;
				return;
			}
			if (
				(sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
					sim.stateCode === STATE_DWELL_RETURN_TRANSIT) &&
				arrivalFloor === sim.floorAnchor
			) {
				if (object) advanceOfficePresenceCounter(object);
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.venueReturnState = 0;
				sim.stateCode = nextOfficeReturnState(sim);
				return;
			}
			if (
				sim.stateCode === STATE_DEPARTURE_TRANSIT &&
				arrivalFloor === LOBBY_FLOOR
			) {
				sim.stateCode = STATE_PARKED;
				sim.selectedFloor = LOBBY_FLOOR;
				releaseServiceRequest(world, sim);
				return;
			}
			if (
				sim.stateCode === STATE_COMMUTE_TRANSIT ||
				sim.stateCode === STATE_ACTIVE_TRANSIT ||
				sim.stateCode === STATE_VENUE_TRIP_TRANSIT
			) {
				if (object) advanceOfficePresenceCounter(object);
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.stateCode = STATE_DEPARTURE;
				return;
			}
			if (
				sim.stateCode === STATE_DEPARTURE_TRANSIT ||
				sim.stateCode === STATE_MORNING_TRANSIT ||
				sim.stateCode === STATE_AT_WORK_TRANSIT ||
				sim.stateCode === STATE_VENUE_HOME_TRANSIT ||
				sim.stateCode === STATE_DWELL_RETURN_TRANSIT
			) {
				releaseServiceRequest(world, sim);
				sim.stateCode = STATE_NIGHT_B;
				return;
			}
			// Arrived at office floor from morning commute
			if (sim.stateCode === STATE_COMMUTE && arrivalFloor === sim.floorAnchor) {
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.stateCode = STATE_AT_WORK;
				if (object) advanceOfficePresenceCounter(object);
				return;
			}
			// Arrived at venue floor from venue trip
			if (
				handleCommercialVenueArrival(sim, arrivalFloor, STATE_AT_WORK, time)
			) {
				return;
			}
			// Arrived at lobby from evening departure
			if (sim.stateCode === STATE_DEPARTURE && arrivalFloor === LOBBY_FLOOR) {
				sim.destinationFloor = -1;
				sim.selectedFloor = sim.floorAnchor;
				sim.stateCode = STATE_PARKED;
			}
			return;
		case FAMILY_CONDO:
			handleCommercialVenueArrival(sim, arrivalFloor, STATE_ACTIVE, time);
			return;
		default:
			// Cathedral guest sims
			if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
				if (
					sim.stateCode === STATE_EVAL_OUTBOUND &&
					arrivalFloor === EVAL_ZONE_FLOOR
				) {
					sim.stateCode = STATE_ARRIVED;
					sim.destinationFloor = -1;
					checkEvalCompletionAndAward(world, time, sim);
				} else if (
					sim.stateCode === STATE_EVAL_RETURN &&
					arrivalFloor === LOBBY_FLOOR
				) {
					sim.stateCode = STATE_PARKED;
					sim.destinationFloor = -1;
				}
			}
			return;
	}
}

export function populateCarrierRequests(
	world: WorldState,
	time?: TimeState,
): void {
	for (const sim of world.sims) {
		if (sim.routeRetryDelay > 0) sim.routeRetryDelay -= 1;
	}

	const activeDemandIds = new Set<string>();
	for (const sim of world.sims) {
		// Sims already in-transit on a carrier or segment are active demand —
		// their pending routes must not be pruned.
		if (sim.route.mode === "carrier" || sim.route.mode === "segment") {
			activeDemandIds.add(simKey(sim));
			continue;
		}
		if (!shouldSeedElevatorDemand(sim)) continue;
		const demand = getElevatorDemand(sim);
		if (!demand) continue;
		activeDemandIds.add(simKey(sim));
		// Returns -1/0/1/2/3 per ROUTING.md. We don't need to branch here yet
		// because each return code already leaves the sim in the correct
		// in-transit / wait / unrouted state.
		resolveSimRouteBetweenFloors(
			world,
			sim,
			demand.sourceFloor,
			demand.destinationFloor,
			demand.directionFlag,
			time,
		);
	}

	for (const carrier of world.carriers) {
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(route) => route.boarded || activeDemandIds.has(route.simId),
		);
		for (const car of carrier.cars) {
			for (const slot of car.activeRouteSlots) {
				if (!slot.active) continue;
				if (
					!carrier.pendingRoutes.some((route) => route.simId === slot.routeId)
				) {
					slot.active = false;
					slot.routeId = "";
					slot.sourceFloor = INVALID_FLOOR;
					slot.destinationFloor = INVALID_FLOOR;
					slot.boarded = false;
				}
			}
			car.pendingRouteIds = car.activeRouteSlots
				.filter((slot) => slot.active)
				.map((slot) => slot.routeId);
		}
	}

	for (const sim of world.sims) {
		if (!activeDemandIds.has(simKey(sim))) {
			sim.route = ROUTE_IDLE;
		}
	}
}

/**
 * Invoked synchronously by `tickAllCarriers` (via the `onArrival` callback)
 * when a carrier unloads an sim at its destination, mirroring the binary's
 * `dispatch_destination_queue_entries` path which calls the family state
 * handler directly inside the carrier tick. The post-tick
 * `reconcileSimTransport` sweep is still consulted for any arrivals that
 * were not delivered through this callback (e.g. tests that drive the
 * carrier state by hand).
 */
export function onCarrierArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	routeId: string,
	arrivalFloor: number,
): void {
	const sim = world.sims.find((candidate) => simKey(candidate) === routeId);
	if (!sim) return;
	dispatchSimArrival(world, ledger, time, sim, arrivalFloor);
}

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
		dispatchSimArrival(world, ledger, time, sim, sim.destinationFloor);
	}
}
