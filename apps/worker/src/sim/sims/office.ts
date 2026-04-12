import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import { FAMILY_OFFICE } from "../resources";
import type { TimeState } from "../time";
import type { PlacedObjectRecord, SimRecord, WorldState } from "../world";
import {
	clearSimRoute,
	dispatchCommercialVenueVisit,
	findObjectForSim,
	recomputeObjectOperationalStatus,
	releaseServiceRequest,
	resetFacilitySimTripCounters,
	resolveSimRouteBetweenFloors,
	tryAssignParkingService,
} from "./index";
import {
	COMMERCIAL_DWELL_STATE,
	COMMERCIAL_FAMILIES,
	COMMERCIAL_VENUE_DWELL_TICKS,
	LOBBY_FLOOR,
	NO_EVAL_ENTITY,
	STATE_ACTIVE,
	STATE_ACTIVE_ALT,
	STATE_ACTIVE_TRANSIT,
	STATE_AT_WORK,
	STATE_AT_WORK_TRANSIT,
	STATE_COMMUTE,
	STATE_COMMUTE_TRANSIT,
	STATE_DEPARTURE,
	STATE_DEPARTURE_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
	STATE_MORNING_GATE,
	STATE_MORNING_TRANSIT,
	STATE_NIGHT_A,
	STATE_NIGHT_B,
	STATE_PARKED,
	STATE_VENUE_HOME_TRANSIT,
	STATE_VENUE_TRIP,
	STATE_VENUE_TRIP_TRANSIT,
	UNIT_STATUS_OFFICE_OCCUPIED,
} from "./states";

export function advanceOfficePresenceCounter(object: PlacedObjectRecord): void {
	if (object.objectTypeCode !== FAMILY_OFFICE) return;
	if (object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = object.unitStatus >= 8 ? 1 : object.unitStatus + 1;
	object.needsRefreshFlag = 1;
}

function decrementOfficePresenceCounter(
	object: PlacedObjectRecord,
	time: TimeState,
): void {
	if (object.objectTypeCode !== FAMILY_OFFICE) return;
	if (object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = Math.max(0, object.unitStatus - 1);
	if (object.unitStatus === 0 && time.daypartIndex >= 4) {
		object.unitStatus = 8;
	}
	object.needsRefreshFlag = 1;
}

function activateOfficeCashflow(
	world: WorldState,
	object: PlacedObjectRecord,
	sim: SimRecord,
): void {
	if (object.unitStatus <= UNIT_STATUS_OFFICE_OCCUPIED) return;
	object.unitStatus = 0;
	object.evalActiveFlag = 1;
	object.needsRefreshFlag = 1;
	resetFacilitySimTripCounters(world, sim);
}

function routeFailureStateForOffice(object: PlacedObjectRecord): number {
	return object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED
		? STATE_MORNING_GATE
		: STATE_NIGHT_A;
}

export function nextOfficeReturnState(sim: SimRecord): number {
	return sim.baseOffset === 1 ? STATE_COMMUTE : STATE_DEPARTURE;
}

function runOfficeServiceEvaluation(
	world: WorldState,
	time: TimeState,
	sim?: SimRecord,
	object?: PlacedObjectRecord,
): void {
	if (time.starCount !== 3 || time.dayCounter % 9 !== 3) return;
	if (world.gateFlags.officeServiceOk !== 0) return;
	if (
		world.gateFlags.evalSimIndex >= 0 &&
		world.gateFlags.evalSimIndex !== NO_EVAL_ENTITY
	) {
		return;
	}
	if (!sim || !object) return;
	if (sim.familyCode !== FAMILY_OFFICE || sim.stateCode !== STATE_ACTIVE)
		return;
	if (object.evalLevel <= 0) return;
	world.gateFlags.officeServiceOk = 1;
}

export function processOfficeSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	const state = sim.stateCode;

	// --- Night / failure park states ---
	// Gate: day_tick > 2300 → transition to morning activation
	if (
		state === STATE_NIGHT_A ||
		state === STATE_NIGHT_B ||
		state === STATE_PARKED
	) {
		if (time.dayTick > 2300) {
			sim.stateCode = STATE_MORNING_GATE;
		}
		return;
	}

	// --- Morning activation (spec state 0x20) ---
	if (state === STATE_MORNING_GATE) {
		// Spec 0x20 gate: calendar_phase_flag must be 0
		if (time.calendarPhaseFlag !== 0) return;
		if (object.evalActiveFlag === 0) return;

		// Spec 0x20 daypart gate: daypart 0 → 1/12 chance; dayparts 1–2 → dispatch;
		// daypart >= 3 → no dispatch
		if (time.daypartIndex >= 3) return;
		if (time.daypartIndex === 0) {
			if (Math.floor(Math.random() * 12) !== 0) return;
		}

		// 3-day cashflow (first sim triggers income once per 3-day cycle)
		if (
			sim.baseOffset === 0 &&
			object.auxValueOrTimer !== time.dayCounter + 1 &&
			time.dayCounter % 3 === 0
		) {
			object.auxValueOrTimer = time.dayCounter + 1;
			object.evalActiveFlag = 1;
			resetFacilitySimTripCounters(world, sim);
			addCashflowFromFamilyResource(
				ledger,
				"office",
				object.rentLevel,
				object.objectTypeCode,
			);
		}

		// Office parking demand: (floorAnchor + homeColumn) % 4 === 1, unitStatus === 2
		if (
			time.starCount > 2 &&
			(sim.floorAnchor + sim.homeColumn) % 4 === 1 &&
			object.unitStatus === 2
		) {
			if (!tryAssignParkingService(world, time, sim)) {
				world.pendingNotifications.push({
					kind: "route_failure",
					message: "Office workers demand Parking",
				});
			}
		}

		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			LOBBY_FLOOR,
			sim.floorAnchor,
			sim.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			sim.stateCode = routeFailureStateForOffice(object);
			return;
		}
		activateOfficeCashflow(world, object, sim);
		sim.selectedFloor = LOBBY_FLOOR;
		sim.destinationFloor = sim.floorAnchor;
		if (routeResult === 0 || routeResult === 1 || routeResult === 2) {
			sim.stateCode = STATE_MORNING_TRANSIT;
			return;
		}
		advanceOfficePresenceCounter(object);
		sim.destinationFloor = -1;
		sim.selectedFloor = sim.floorAnchor;
		sim.stateCode = STATE_DEPARTURE;
		return;
	}

	// --- Normal inbound commute gate (spec state 0x00) ---
	if (state === STATE_COMMUTE) {
		if (time.daypartIndex >= 4) {
			sim.stateCode = STATE_DEPARTURE;
			return;
		}
		if (sim.baseOffset === 0) {
			if (time.daypartIndex === 0 && Math.floor(Math.random() * 12) !== 0)
				return;
		} else {
			if (time.daypartIndex < 3) return;
			if (Math.floor(Math.random() * 12) !== 0) return;
		}
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			LOBBY_FLOOR,
			sim.floorAnchor,
			sim.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			sim.stateCode = STATE_NIGHT_B;
			return;
		}
		sim.selectedFloor = LOBBY_FLOOR;
		sim.destinationFloor = sim.floorAnchor;
		if (routeResult === 3) {
			advanceOfficePresenceCounter(object);
			sim.destinationFloor = -1;
			sim.selectedFloor = sim.floorAnchor;
			sim.stateCode = STATE_AT_WORK;
		} else {
			sim.stateCode = STATE_COMMUTE_TRANSIT;
		}
		return;
	}

	// --- At office, ready for venue visits (spec state 0x21) ---
	if (state === STATE_AT_WORK) {
		// Gate: daypart >= 4 → depart from office back to the lobby.
		if (time.daypartIndex >= 4) {
			sim.stateCode = STATE_PARKED;
			sim.destinationFloor = -1;
			clearSimRoute(sim);
			releaseServiceRequest(world, sim);
			return;
		}
		// Gate: daypart 3 → 1/12 chance; dayparts 0–2 → no dispatch
		if (time.daypartIndex === 3) {
			if (Math.floor(Math.random() * 12) !== 0) return;
		} else {
			return;
		}

		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			LOBBY_FLOOR,
			sim.floorAnchor,
			sim.floorAnchor > LOBBY_FLOOR ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			sim.stateCode = STATE_NIGHT_B;
			releaseServiceRequest(world, sim);
			return;
		}
		sim.selectedFloor = LOBBY_FLOOR;
		sim.destinationFloor = sim.floorAnchor;
		if (routeResult === 3) {
			advanceOfficePresenceCounter(object);
			sim.destinationFloor = -1;
			sim.selectedFloor = sim.floorAnchor;
			sim.stateCode = STATE_DEPARTURE;
		} else {
			sim.stateCode = STATE_AT_WORK_TRANSIT;
		}
		return;
	}

	if (state === COMMERCIAL_DWELL_STATE) {
		if (time.dayTick - sim.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS)
			return;
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.selectedFloor,
			sim.floorAnchor,
			sim.floorAnchor > sim.selectedFloor ? 0 : 1,
			time,
		);
		if (routeResult === -1) {
			sim.stateCode = STATE_NIGHT_B;
			releaseServiceRequest(world, sim);
			return;
		}
		sim.destinationFloor = sim.floorAnchor;
		if (routeResult === 3) {
			advanceOfficePresenceCounter(object);
			sim.destinationFloor = -1;
			sim.selectedFloor = sim.floorAnchor;
			sim.venueReturnState = 0;
			sim.stateCode = nextOfficeReturnState(sim);
		} else {
			sim.stateCode = STATE_DWELL_RETURN_TRANSIT;
		}
		return;
	}

	// --- Venue selection ---
	if (state === STATE_ACTIVE || state === STATE_ACTIVE_ALT) {
		runOfficeServiceEvaluation(world, time, sim, object);
		// Gate: daypart ≥ 4 → evening departure
		if (time.daypartIndex >= 4) {
			sim.stateCode = STATE_DEPARTURE;
			sim.destinationFloor = LOBBY_FLOOR;
			sim.selectedFloor = sim.floorAnchor;
			return;
		}

		dispatchCommercialVenueVisit(world, time, sim, {
			venueFamilies: COMMERCIAL_FAMILIES,
			returnState: STATE_AT_WORK,
			unavailableState: STATE_NIGHT_B,
		});
		return;
	}

	// --- In transit to venue — arrival handled by dispatchSimArrival ---
	if (
		state === STATE_VENUE_TRIP ||
		state === STATE_COMMUTE_TRANSIT ||
		state === STATE_ACTIVE_TRANSIT ||
		state === STATE_VENUE_TRIP_TRANSIT ||
		state === STATE_DEPARTURE_TRANSIT ||
		state === STATE_MORNING_TRANSIT ||
		state === STATE_AT_WORK_TRANSIT ||
		state === STATE_VENUE_HOME_TRANSIT ||
		state === STATE_DWELL_RETURN_TRANSIT
	) {
		return;
	}

	// --- Evening departure — in transit to lobby, handled by carrier system ---
	if (state === STATE_DEPARTURE) {
		if (time.daypartIndex < 4) return;
		if (time.daypartIndex === 4 && Math.floor(Math.random() * 6) !== 0) {
			return;
		}
		decrementOfficePresenceCounter(object, time);
		const routeResult = resolveSimRouteBetweenFloors(
			world,
			sim,
			sim.floorAnchor,
			LOBBY_FLOOR,
			1,
			time,
		);
		if (routeResult === -1) {
			sim.stateCode = STATE_NIGHT_B;
			releaseServiceRequest(world, sim);
			return;
		}
		sim.selectedFloor = sim.floorAnchor;
		sim.destinationFloor = LOBBY_FLOOR;
		if (routeResult === 3) {
			sim.destinationFloor = -1;
			sim.selectedFloor = LOBBY_FLOOR;
			sim.stateCode = STATE_PARKED;
			releaseServiceRequest(world, sim);
		} else {
			sim.stateCode = STATE_DEPARTURE_TRANSIT;
		}
		return;
	}

	recomputeObjectOperationalStatus(world, time, sim, object);
}
