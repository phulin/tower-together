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

function isEvalPlaced(world: WorldState): boolean {
	return (
		world.gateFlags.evalSimIndex >= 0 &&
		world.gateFlags.evalSimIndex !== NO_EVAL_ENTITY
	);
}

/**
 * Activate cathedral guest sims at the day-start checkpoint.
 * Forces all cathedral sim slots into the morning-gate state if a cathedral is
 * placed. The binary does not apply a star-count gate here.
 */
export function activateEvalSims(world: WorldState): void {
	if (!isEvalPlaced(world)) return;

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
	if (!isEvalPlaced(world)) return;
	for (const object of Object.values(world.placedObjects)) {
		if (!CATHEDRAL_FAMILIES.has(object.objectTypeCode)) continue;
		object.auxValueOrTimer = 0;
		object.dirtyFlag = 1;
	}
	for (const sim of world.sims) {
		if (!CATHEDRAL_FAMILIES.has(sim.familyCode)) continue;
		if (sim.stateCode === STATE_ARRIVED) {
			sim.stateCode = STATE_DEPARTURE;
			sim.selectedFloor = EVAL_ZONE_FLOOR;
			sim.destinationFloor = LOBBY_FLOOR;
		}
	}
}

function dispatchOutbound(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const isFreshDispatch = sim.stateCode === STATE_MORNING_GATE;
	const sourceFloor = isFreshDispatch ? LOBBY_FLOOR : sim.originFloor;
	const directionFlag = isFreshDispatch ? 1 : 0;
	sim.selectedFloor = sourceFloor;
	sim.destinationFloor = EVAL_ZONE_FLOOR;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		EVAL_ZONE_FLOOR,
		directionFlag,
		time,
		{ emitDistanceFeedback: isFreshDispatch },
	);
	if (result === 3) {
		sim.stateCode = STATE_ARRIVED;
		checkEvalCompletionAndAward(world, time, sim);
	} else if (result >= 0) {
		sim.stateCode = STATE_EVAL_OUTBOUND;
	} else {
		sim.stateCode = STATE_PARKED;
	}
}

function dispatchReturn(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	const isFreshDispatch = sim.stateCode === STATE_DEPARTURE;
	const sourceFloor = isFreshDispatch ? EVAL_ZONE_FLOOR : sim.originFloor;
	const directionFlag = isFreshDispatch ? 1 : 0;
	sim.selectedFloor = sourceFloor;
	sim.destinationFloor = LOBBY_FLOOR;
	const result = resolveSimRouteBetweenFloors(
		world,
		sim,
		sourceFloor,
		LOBBY_FLOOR,
		directionFlag,
		time,
		{ emitDistanceFeedback: isFreshDispatch },
	);
	if (result === 0 || result === 1 || result === 2) {
		sim.stateCode = STATE_EVAL_RETURN;
	} else {
		sim.stateCode = STATE_PARKED;
	}
}

export function processCathedralSim(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): void {
	switch (sim.stateCode) {
		case STATE_MORNING_GATE: {
			// Gate: weekendFlag must be 1
			if (time.weekendFlag !== 1) {
				return;
			}
			if (time.daypartIndex === 0) {
				if (time.dayTick > 0x50 && sampleRng(world) % 12 === 0) {
					dispatchOutbound(world, time, sim);
				}
				if (time.dayTick > 0xf0) {
					dispatchOutbound(world, time, sim);
				}
				return;
			}
			if (time.daypartIndex >= 1) {
				sim.stateCode = STATE_PARKED;
			}
			return;
		}

		case STATE_EVAL_OUTBOUND:
			if (sim.route.mode !== "carrier") dispatchOutbound(world, time, sim);
			return;

		case STATE_ARRIVED:
			// Arrived at eval zone; waiting for midday return dispatch
			return;

		case STATE_DEPARTURE: {
			dispatchReturn(world, time, sim);
			return;
		}

		case STATE_EVAL_RETURN:
			if (sim.route.mode !== "carrier") dispatchReturn(world, time, sim);
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
	if (!isEvalPlaced(world)) return;
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
		}
		return;
	}

	// All 40 arrived — check ledger tier > star_count for tower promotion.
	const tierThresholds = [300, 1000, 5000, 10_000, 15_000];
	const ledgerTotal = world.currentPopulation;
	let tier = 1;
	for (let index = 0; index < tierThresholds.length; index++) {
		if (ledgerTotal >= tierThresholds[index]) tier = index + 2;
	}

	if (tier > world.starCount) {
		// Tower promotion: star_count := 6
		world.starCount = 6;
		for (const object of Object.values(world.placedObjects)) {
			if (!CATHEDRAL_FAMILIES.has(object.objectTypeCode)) continue;
			object.auxValueOrTimer = 2;
			object.dirtyFlag = 1;
		}
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
