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
	FAMILY_OFFICE,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
	OP_SCORE_THRESHOLDS,
} from "../resources";
import { addDelayToCurrentSim } from "../stress/add-delay";
import { reduceElapsedForLobbyBoarding } from "../stress/lobby-reduction";
import { DAY_TICK_MAX, type TimeState } from "../time";
import {
	type CarrierPendingRoute,
	GRID_HEIGHT,
	type PlacedObjectRecord,
	type SimRecord,
	type WorldState,
	yToFloor,
} from "../world";
import { findObjectForSim, findSiblingSims, simKey } from "./population";
import {
	ENTITY_POPULATION_BY_TYPE,
	EVALUATABLE_FAMILIES,
	HOTEL_FAMILIES,
	UNIT_STATUS_CONDO_OCCUPIED,
	UNIT_STATUS_HOTEL_SOLD_OUT,
	UNIT_STATUS_OFFICE_OCCUPIED,
} from "./states";
import { resetFacilitySimTripCounters } from "./trip-counters";

const ENTERTAINMENT_NOISE_FAMILIES = new Set([
	FAMILY_CINEMA,
	FAMILY_CINEMA_LOWER,
	FAMILY_CINEMA_STAIRS_UPPER,
	FAMILY_CINEMA_STAIRS_LOWER,
	FAMILY_PARTY_HALL,
	FAMILY_PARTY_HALL_LOWER,
]);

// Binary compute_object_operational_score (1138:040f) divisor per family. For
// hotels the binary loops bo=1..N (skipping bo=0) and divides by the loop
// count: single=1, twin=2, suite=2. Office and condo do a full sweep.
const OPERATIONAL_SCORE_DIVISOR: Record<number, number> = {
	[FAMILY_HOTEL_SINGLE]: 1,
	[FAMILY_HOTEL_TWIN]: 2,
	[FAMILY_HOTEL_SUITE]: 2,
	[FAMILY_OFFICE]: 6,
	[FAMILY_CONDO]: 3,
};

export interface SimStateRecord {
	id: string;
	floorAnchor: number;
	selectedFloor: number;
	destinationFloor: number;
	homeColumn: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	currentTripStressTicks: number;
	currentTripStressLevel: "low" | "medium" | "high";
	averageTripStressTicks: number;
	stressLevel: "low" | "medium" | "high";
	tripCount: number;
	accumulatedTicks: number;
	elapsedTicks: number;
}

function isNoiseSource(
	originFamilyCode: number,
	targetFamilyCode: number,
): boolean {
	if (ENTERTAINMENT_NOISE_FAMILIES.has(targetFamilyCode)) {
		return EVALUATABLE_FAMILIES.has(originFamilyCode);
	}

	if (HOTEL_FAMILIES.has(originFamilyCode)) {
		return (
			targetFamilyCode === FAMILY_RESTAURANT ||
			targetFamilyCode === FAMILY_OFFICE ||
			targetFamilyCode === FAMILY_FAST_FOOD ||
			targetFamilyCode === FAMILY_RETAIL
		);
	}

	if (originFamilyCode === FAMILY_OFFICE) {
		return (
			targetFamilyCode === FAMILY_RESTAURANT ||
			targetFamilyCode === FAMILY_FAST_FOOD ||
			targetFamilyCode === FAMILY_RETAIL
		);
	}

	if (originFamilyCode === FAMILY_CONDO) {
		return (
			targetFamilyCode === FAMILY_HOTEL_SINGLE ||
			targetFamilyCode === FAMILY_HOTEL_TWIN ||
			targetFamilyCode === FAMILY_HOTEL_SUITE ||
			targetFamilyCode === FAMILY_RESTAURANT ||
			targetFamilyCode === FAMILY_OFFICE ||
			targetFamilyCode === FAMILY_FAST_FOOD ||
			targetFamilyCode === FAMILY_RETAIL
		);
	}

	return (
		targetFamilyCode === FAMILY_RESTAURANT ||
		targetFamilyCode === FAMILY_FAST_FOOD ||
		targetFamilyCode === FAMILY_RETAIL
	);
}

function hasNearbyNoise(
	world: WorldState,
	object: PlacedObjectRecord,
	floorAnchor: number,
	radius: number,
): boolean {
	for (const [key, candidate] of Object.entries(world.placedObjects)) {
		if (candidate === object) continue;
		const [_x, y] = key.split(",").map(Number);
		if (yToFloor(y) !== floorAnchor) continue;
		if (!isNoiseSource(object.objectTypeCode, candidate.objectTypeCode))
			continue;
		const leftDelta = Math.abs(candidate.leftTileIndex - object.rightTileIndex);
		const rightDelta = Math.abs(
			object.leftTileIndex - candidate.rightTileIndex,
		);
		if (Math.min(leftDelta, rightDelta) <= radius) return true;
	}

	return false;
}

export function recomputeObjectOperationalStatus(
	world: WorldState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (!EVALUATABLE_FAMILIES.has(object.objectTypeCode)) return;

	// Always compute the raw average stress so the debug badge stays useful
	// for sold-out hotels and other states the binary skips for evalLevel.
	// Binary compute_object_operational_score (1138:040f) sums stress over the
	// non-primary occupants only (loop starts at occupant index 1) and divides
	// by the loop iteration count: single (3) → 1 non-primary occupant, twin/
	// suite (4/5) → 2, office (7) → 6 (full sweep), condo (9) → 3 (full sweep).
	// ENTITY_POPULATION_BY_TYPE counts ALL occupants including bo=0, so it
	// overestimates the divisor for hotels by 1 — using it would lower scores
	// and force eval=1/2 → midday-reset more rooms than the binary does.
	const siblings = findSiblingSims(world, sim);
	const populationCount =
		OPERATIONAL_SCORE_DIVISOR[object.objectTypeCode] ??
		ENTITY_POPULATION_BY_TYPE[object.objectTypeCode] ??
		1;
	let stressSum = 0;
	let hasTripData = false;
	for (const sibling of siblings) {
		if (sibling.baseOffset === 0 && HOTEL_FAMILIES.has(object.objectTypeCode)) {
			// Binary skips bo=0 in the hotel loop (occupant index starts at 1).
			continue;
		}
		if (sibling.tripCount > 0) {
			stressSum += Math.trunc(sibling.accumulatedTicks / sibling.tripCount);
			hasTripData = true;
		}
	}
	const rawAverageStress = hasTripData
		? Math.trunc(stressSum / populationCount)
		: -1;
	object.evalScore = rawAverageStress;

	if (
		HOTEL_FAMILIES.has(object.objectTypeCode) &&
		object.unitStatus > UNIT_STATUS_HOTEL_SOLD_OUT
	) {
		object.evalLevel = 0xff;
		return;
	}
	if (
		object.objectTypeCode === FAMILY_OFFICE &&
		object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED &&
		object.occupiedFlag !== 0
	) {
		object.evalLevel = 0xff;
		return;
	}
	if (
		object.objectTypeCode === FAMILY_CONDO &&
		object.unitStatus > UNIT_STATUS_CONDO_OCCUPIED &&
		object.occupiedFlag !== 0
	) {
		object.evalLevel = 0xff;
		return;
	}

	if (rawAverageStress < 0) {
		object.evalLevel = 0xff;
		return;
	}

	let score = hasTripData ? rawAverageStress : 0;
	switch (object.rentLevel) {
		case 0:
			score += 30;
			break;
		case 2:
			score = Math.max(0, score - 30);
			break;
		case 3:
			score = 0;
			break;
		default:
			break;
	}

	const noiseRadius =
		object.objectTypeCode === FAMILY_OFFICE
			? 10
			: object.objectTypeCode === FAMILY_CONDO
				? 30
				: 20;
	if (hasNearbyNoise(world, object, sim.floorAnchor, noiseRadius)) {
		score += 60;
	}

	const [lower, upper] = OP_SCORE_THRESHOLDS[Math.min(world.starCount, 5)] ?? [
		80, 200,
	];
	object.evalLevel = score < lower ? 2 : score < upper ? 1 : 0;
	// Binary recompute_object_operational_status tail (1138:093c CMP +0x14,
	// 1138:09d6 MOV byte ptr ES:[BX+0x14],1):
	//   if (occupiedFlag == 0 && evalLevel != 0) occupiedFlag = 1
	// Hotels (families 3/4/5) gate the set on unitStatus <= 0x27 — above that
	// band the room must stay unoccupied until the dormant phase clears.
	// No call to refresh_occupied_flag_and_trip_counters here for any family.
	if (object.occupiedFlag === 0 && object.evalLevel > 0) {
		if (
			!HOTEL_FAMILIES.has(object.objectTypeCode) ||
			object.unitStatus <= 0x27
		) {
			object.occupiedFlag = 1;
		}
	}
}

export function recomputeAllObjectOperationalStatus(world: WorldState): void {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (!EVALUATABLE_FAMILIES.has(object.objectTypeCode)) continue;
		const [x, y] = key.split(",").map(Number);
		const floorAnchor = yToFloor(y);
		const sim = world.sims.find(
			(candidate) =>
				candidate.familyCode === object.objectTypeCode &&
				candidate.floorAnchor === floorAnchor &&
				candidate.homeColumn === x,
		);
		if (!sim) continue;
		recomputeObjectOperationalStatus(world, sim, object);
	}
}

export function activeStressThresholds(world: WorldState): {
	medium: number;
	high: number;
} {
	const [medium, high] = OP_SCORE_THRESHOLDS[Math.min(world.starCount, 5)] ?? [
		80, 200,
	];
	return { medium, high };
}

export function averageTripStressTicks(sim: SimRecord): number {
	return sim.tripCount > 0
		? Math.trunc(sim.accumulatedTicks / sim.tripCount)
		: 0;
}

export function currentTripStressTicks(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): number {
	let liveElapsed = 0;
	if (sim.lastDemandTick >= 0) {
		liveElapsed =
			(time.dayTick - sim.lastDemandTick + DAY_TICK_MAX) % DAY_TICK_MAX;
		const reduced = { elapsedTicks: liveElapsed };
		reduceElapsedForLobbyBoarding(reduced, sim.originFloor, world);
		liveElapsed = reduced.elapsedTicks;
	}
	return Math.min(300, sim.elapsedTicks + liveElapsed);
}

export function currentTripStressLevel(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): "low" | "medium" | "high" {
	const elapsed = currentTripStressTicks(world, time, sim);
	const { medium, high } = activeStressThresholds(world);
	if (elapsed >= high) return "high";
	if (elapsed >= medium) return "medium";
	return "low";
}

export function refreshOccupiedFlagAndTripCounters(
	world: WorldState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	// Binary refresh_occupied_flag_and_trip_counters @ 1138:0f79:
	//   Branch A: evalLevel >= 1 (not 0xff) → occupiedFlag(+0x14)=1, reset trip counters
	//   Branch B: evalLevel == 0 with A-rated sibling on same floor+family
	//             → downgrade both to 1, occupiedFlag=1 both, reset trip counters
	//   Branch C: evalLevel == 0 with no donor → occupiedFlag=0, NO reset
	// 1138:1072: MOV byte ptr ES:[BX+0x14],1; 1138:10ab: MOV byte ptr ES:[BX+0x14],0
	if (object.evalLevel !== 0xff && object.evalLevel >= 1) {
		object.occupiedFlag = 1;
		resetFacilitySimTripCounters(world, sim);
		return;
	}
	if (object.evalLevel === 0) {
		const y = GRID_HEIGHT - 1 - sim.floorAnchor;
		for (const [key, candidate] of Object.entries(world.placedObjects)) {
			if (candidate === object) continue;
			if (candidate.objectTypeCode !== object.objectTypeCode) continue;
			const [, cy] = key.split(",").map(Number);
			if (cy !== y) continue;
			if (candidate.evalLevel !== 2) continue;
			candidate.evalLevel = 1;
			candidate.occupiedFlag = 1;
			object.evalLevel = 1;
			object.occupiedFlag = 1;
			resetFacilitySimTripCounters(world, sim);
			return;
		}
		object.occupiedFlag = 0;
	}
}

function simStressLevel(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	_object: PlacedObjectRecord | undefined,
): "low" | "medium" | "high" {
	return currentTripStressLevel(world, time, sim);
}

function distanceFeedbackPenalty(
	routeHeightMetric: number,
	targetHeightMetric: number,
): number {
	const delta = Math.abs(routeHeightMetric - targetHeightMetric);
	if (delta >= 125) return 60;
	if (delta > 79) return 30;
	return 0;
}

export function maybeApplyDistanceFeedback(
	_world: WorldState,
	sim: SimRecord,
	routeHeightMetric: number,
	targetHeightMetric: number,
	canApplyForRouteKind: boolean,
): void {
	if (!canApplyForRouteKind) return;
	const penalty = distanceFeedbackPenalty(
		routeHeightMetric,
		targetHeightMetric,
	);
	if (penalty === 0) return;
	addDelayToCurrentSim(sim, penalty);
}

export function createSimStateRecord(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
	pendingBySimId: Map<
		string,
		{ carrier: (typeof world.carriers)[number]; route: CarrierPendingRoute }
	>,
): SimStateRecord | null {
	const object = findObjectForSim(world, sim);
	if (!object) return null;
	const id = simKey(sim);
	const pending = pendingBySimId.get(id);
	const pendingRoute = pending?.route;
	const carrierId =
		pendingRoute || sim.route.mode === "carrier"
			? (pending?.carrier.carrierId ??
				(sim.route.mode === "carrier" ? sim.route.carrierId : null))
			: null;
	const routeModeNum =
		sim.route.mode === "carrier" ? 2 : sim.route.mode === "segment" ? 1 : 0;
	const currentTicks = currentTripStressTicks(world, time, sim);
	const currentLevel = simStressLevel(world, time, sim, object);
	return {
		id,
		floorAnchor: sim.floorAnchor,
		selectedFloor: sim.selectedFloor,
		homeColumn: sim.homeColumn,
		baseOffset: sim.baseOffset,
		familyCode: sim.familyCode,
		stateCode: sim.stateCode,
		routeMode: routeModeNum,
		destinationFloor: sim.destinationFloor,
		carrierId,
		assignedCarIndex: pendingRoute?.assignedCarIndex ?? -1,
		boardedOnCarrier: pendingRoute?.boarded ?? false,
		currentTripStressTicks: currentTicks,
		currentTripStressLevel: currentLevel,
		averageTripStressTicks: averageTripStressTicks(sim),
		stressLevel: currentLevel,
		tripCount: sim.tripCount,
		accumulatedTicks: sim.accumulatedTicks,
		elapsedTicks: sim.elapsedTicks,
	} satisfies SimStateRecord;
}

export function createSimStateRecords(
	world: WorldState,
	time: TimeState,
): SimStateRecord[] {
	// Pre-index pending routes by simId to avoid O(sims × carriers × routes).
	const pendingBySimId = new Map<
		string,
		{ carrier: (typeof world.carriers)[number]; route: CarrierPendingRoute }
	>();
	for (const carrier of world.carriers) {
		for (const route of carrier.pendingRoutes) {
			pendingBySimId.set(route.simId, { carrier, route });
		}
	}

	const result: SimStateRecord[] = [];
	for (const sim of world.sims) {
		const record = createSimStateRecord(world, time, sim, pendingBySimId);
		if (record) result.push(record);
	}
	return result;
}
