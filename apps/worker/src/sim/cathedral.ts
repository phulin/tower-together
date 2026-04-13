import {
	clearSimRoute,
	findObjectForSim,
	resolveSimRouteBetweenFloors,
} from "./sims";
import {
	CATHEDRAL_FAMILIES,
	EVAL_ZONE_FLOOR,
	LOBBY_FLOOR,
	NO_EVAL_ENTITY,
	STATE_ARRIVED,
	STATE_DEPARTURE,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_MORNING_GATE,
	STATE_PARKED,
} from "./sims/states";
import type { TimeState } from "./time";
import { type SimRecord, sampleRng, type WorldState } from "./world";

// 5 floor types × 8 slots
const EVAL_SIM_COUNT = 40;

/**
 * Activate cathedral guest sims at the day-start checkpoint.
 * Forces all cathedral sim slots into the morning-gate state
 * if a cathedral is placed and the tower is above 2 stars.
 */
export function activateEvalSims(world: WorldState, time: TimeState): void {
	if (
		world.gateFlags.evalSimIndex < 0 ||
		world.gateFlags.evalSimIndex === NO_EVAL_ENTITY
	) {
		return;
	}
	if (time.starCount <= 2) return;

	for (const sim of world.sims) {
		if (!CATHEDRAL_FAMILIES.has(sim.familyCode)) continue;
		sim.stateCode = STATE_MORNING_GATE;
		sim.selectedFloor = LOBBY_FLOOR;
		sim.originFloor = sim.floorAnchor;
		clearSimRoute(sim);
		sim.destinationFloor = -1;
		sim.venueReturnState = 0;
	}
}

/**
 * Dispatch midday return for cathedral guest sims at the hotel-sale checkpoint.
 * Sims in the arrived state are advanced to the return state.
 */
export function dispatchEvalMiddayReturn(world: WorldState): void {
	for (const sim of world.sims) {
		if (!CATHEDRAL_FAMILIES.has(sim.familyCode)) continue;
		if (sim.stateCode === STATE_ARRIVED) {
			sim.stateCode = STATE_DEPARTURE;
			sim.selectedFloor = EVAL_ZONE_FLOOR;
			sim.destinationFloor = LOBBY_FLOOR;
		}
	}
}

export function processCathedralSim(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	switch (sim.stateCode) {
		case STATE_MORNING_GATE: {
			// Gate: calendar_phase_flag must be 1
			if (time.calendarPhaseFlag !== 1) {
				if (time.daypartIndex >= 1) {
					sim.stateCode = STATE_PARKED; // missed dispatch window
				}
				return;
			}
			// Stagger: daypart 0 has probabilistic dispatch
			if (time.daypartIndex === 0) {
				if (time.dayTick <= 0x50) return;
				if (time.dayTick <= 0xf0) {
					// 1/12 chance per tick
					if (sampleRng(world) % 12 !== 0) return;
				}
				// After tick 0xf0, guaranteed dispatch
			} else if (time.daypartIndex >= 1) {
				sim.stateCode = STATE_PARKED; // missed
				return;
			}

			// Dispatch: route from lobby to eval zone
			sim.selectedFloor = LOBBY_FLOOR;
			sim.destinationFloor = EVAL_ZONE_FLOOR;
			const result = resolveSimRouteBetweenFloors(
				world,
				sim,
				LOBBY_FLOOR,
				EVAL_ZONE_FLOOR,
				0,
				time,
			);
			if (result === 3) {
				sim.stateCode = STATE_ARRIVED;
				checkEvalCompletionAndAward(world, time, sim);
			} else if (result >= 0) {
				sim.stateCode = STATE_EVAL_OUTBOUND; // in transit to eval zone
			} else {
				sim.stateCode = STATE_PARKED; // route failure → parked
			}
			return;
		}

		case STATE_EVAL_OUTBOUND:
			// In transit to eval zone; arrival handled by dispatchSimArrival
			return;

		case STATE_ARRIVED:
			// Arrived at eval zone; waiting for midday return dispatch
			return;

		case STATE_DEPARTURE: {
			// Midday return: route from eval zone to lobby
			if (sim.route.mode !== "idle") return; // already routed
			sim.selectedFloor = EVAL_ZONE_FLOOR;
			sim.destinationFloor = LOBBY_FLOOR;
			const returnResult = resolveSimRouteBetweenFloors(
				world,
				sim,
				EVAL_ZONE_FLOOR,
				LOBBY_FLOOR,
				1,
				time,
			);
			if (returnResult === 3) {
				sim.stateCode = STATE_PARKED;
			} else if (returnResult >= 0) {
				sim.stateCode = STATE_EVAL_RETURN; // in transit back to lobby
			} else {
				sim.stateCode = STATE_PARKED;
			}
			return;
		}

		case STATE_EVAL_RETURN:
			// In transit back to lobby; arrival handled by dispatchSimArrival
			return;

		case STATE_PARKED:
			// Parked; will be reset at next day-start
			return;

		default:
			return;
	}
}

export function checkEvalCompletionAndAward(
	world: WorldState,
	time: TimeState,
	arrivedSim: SimRecord,
): void {
	if (
		world.gateFlags.evalSimIndex < 0 ||
		world.gateFlags.evalSimIndex === NO_EVAL_ENTITY
	) {
		return;
	}
	if (time.dayTick >= 800) return;

	// Count sims that arrived at eval zone
	let arrivedCount = 0;
	for (const sim of world.sims) {
		if (!CATHEDRAL_FAMILIES.has(sim.familyCode)) continue;
		if (sim.stateCode === STATE_ARRIVED) arrivedCount++;
	}

	if (arrivedCount < EVAL_SIM_COUNT) {
		// Not all arrived yet — stamp the arrived sim's placed object
		const object = findObjectForSim(world, arrivedSim);
		if (object) {
			object.auxValueOrTimer = 3;
			object.needsRefreshFlag = 1;
		}
		return;
	}

	// All 40 arrived — check ledger tier > star_count for tower promotion
	const tierThresholds = [300, 1000, 5000, 10_000, 15_000];
	const ledgerTotal = Object.values(world.placedObjects).reduce(
		(sum, obj) => sum + (obj.activationTickCount ?? 0),
		0,
	);
	let tier = 1;
	for (let index = 0; index < tierThresholds.length; index++) {
		if (ledgerTotal > tierThresholds[index]) tier = index + 2;
	}

	if (tier > time.starCount) {
		// Tower promotion: star_count := 6
		(time as { starCount: number }).starCount = 6;
	}
}

export function handleCathedralSimArrival(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	arrivalFloor: number,
): void {
	if (
		sim.stateCode === STATE_EVAL_OUTBOUND &&
		arrivalFloor === EVAL_ZONE_FLOOR
	) {
		sim.stateCode = STATE_ARRIVED;
		sim.destinationFloor = -1;
		checkEvalCompletionAndAward(world, time, sim);
		return;
	}

	if (sim.stateCode === STATE_EVAL_RETURN && arrivalFloor === LOBBY_FLOOR) {
		sim.stateCode = STATE_PARKED;
		sim.destinationFloor = -1;
	}
}
