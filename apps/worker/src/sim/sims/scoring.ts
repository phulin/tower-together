import {
	FAMILY_CINEMA,
	FAMILY_CONDO,
	FAMILY_ENTERTAINMENT,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
	OP_SCORE_THRESHOLDS,
} from "../resources";
import type { TimeState } from "../time";
import {
	GRID_HEIGHT,
	type PlacedObjectRecord,
	type SimRecord,
	type WorldState,
	yToFloor,
} from "../world";
import { findObjectForSim, findSiblingSims, simKey } from "./population";
import {
	CATHEDRAL_FAMILIES,
	EVALUATABLE_FAMILIES,
	HOTEL_FAMILIES,
	STATE_ACTIVE,
	STATE_COMMUTE,
	STATE_DEPARTURE,
	STATE_EVAL_OUTBOUND,
	STATE_PARKED,
	STATE_VENUE_TRIP,
	UNIT_STATUS_CONDO_OCCUPIED,
	UNIT_STATUS_HOTEL_SOLD_OUT,
	UNIT_STATUS_OFFICE_OCCUPIED,
} from "./states";
import {
	addDelayToCurrentSim,
	resetFacilitySimTripCounters,
} from "./trip-counters";

export interface SimStateRecord {
	id: string;
	floorAnchor: number;
	selectedFloor: number;
	homeColumn: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	stressLevel: "low" | "medium" | "high";
	tripCount: number;
	accumulatedTicks: number;
	elapsedTicks: number;
}

function isNoiseSource(
	originFamilyCode: number,
	targetFamilyCode: number,
): boolean {
	if (
		targetFamilyCode === FAMILY_CINEMA ||
		targetFamilyCode === FAMILY_ENTERTAINMENT
	) {
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
	time: TimeState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	if (!EVALUATABLE_FAMILIES.has(object.objectTypeCode)) return;

	if (
		HOTEL_FAMILIES.has(object.objectTypeCode) &&
		object.unitStatus > UNIT_STATUS_HOTEL_SOLD_OUT
	) {
		object.evalLevel = 0xff;
		object.evalScore = -1;
		object.needsRefreshFlag = 1;
		return;
	}
	if (
		object.objectTypeCode === FAMILY_OFFICE &&
		object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED &&
		object.evalActiveFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.evalScore = -1;
		object.needsRefreshFlag = 1;
		return;
	}
	if (
		object.objectTypeCode === FAMILY_CONDO &&
		object.unitStatus > UNIT_STATUS_CONDO_OCCUPIED &&
		object.evalActiveFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.evalScore = -1;
		object.needsRefreshFlag = 1;
		return;
	}

	const siblings = findSiblingSims(world, sim);
	const populationCount =
		object.objectTypeCode === FAMILY_HOTEL_SINGLE
			? 1
			: object.objectTypeCode === FAMILY_HOTEL_TWIN
				? 2
				: object.objectTypeCode === FAMILY_HOTEL_SUITE
					? 2
					: object.objectTypeCode === FAMILY_OFFICE
						? 6
						: 3;
	let stressSum = 0;
	for (const sibling of siblings) {
		if (sibling.tripCount > 0) {
			stressSum += Math.trunc(sibling.accumulatedTicks / sibling.tripCount);
		}
	}
	let score = Math.trunc(stressSum / populationCount);

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

	const [lower, upper] = OP_SCORE_THRESHOLDS[Math.min(time.starCount, 5)] ?? [
		80, 200,
	];
	object.evalScore = score;
	object.evalLevel = score < lower ? 2 : score < upper ? 1 : 0;
	if (object.objectTypeCode === FAMILY_OFFICE) {
		if (object.evalLevel >= 1) {
			object.evalActiveFlag = 1;
		} else {
			refreshOccupiedFlagAndTripCounters(world, sim, object);
		}
	} else if (object.evalActiveFlag === 0 && object.evalLevel > 0) {
		object.evalActiveFlag = 1;
	} else if (object.objectTypeCode === FAMILY_CONDO && object.evalLevel === 0) {
		refreshOccupiedFlagAndTripCounters(world, sim, object);
	}
	object.needsRefreshFlag = 1;
}

export function refreshOccupiedFlagAndTripCounters(
	world: WorldState,
	sim: SimRecord,
	object: PlacedObjectRecord,
): void {
	const y = GRID_HEIGHT - 1 - sim.floorAnchor;
	for (const [key, candidate] of Object.entries(world.placedObjects)) {
		if (candidate === object) continue;
		if (candidate.objectTypeCode !== object.objectTypeCode) continue;
		const [, cy] = key.split(",").map(Number);
		if (cy !== y) continue;
		if (candidate.evalLevel !== 2) continue;
		object.evalLevel = 1;
		object.evalActiveFlag = 1;
		candidate.evalLevel = 1;
		candidate.evalActiveFlag = 1;
		object.needsRefreshFlag = 1;
		candidate.needsRefreshFlag = 1;
		return;
	}

	object.evalActiveFlag = 0;
	resetFacilitySimTripCounters(world, sim);
	object.needsRefreshFlag = 1;
}

function simStressLevel(
	sim: SimRecord,
	_object: PlacedObjectRecord | undefined,
): "low" | "medium" | "high" {
	const elapsed = sim.elapsedTicks;
	if (elapsed >= 120) return "high";
	if (elapsed >= 80) return "medium";
	return "low";
}

function shouldEmitDistanceFeedback(sim: SimRecord): boolean {
	switch (sim.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			return sim.stateCode !== STATE_VENUE_TRIP;
		case FAMILY_OFFICE:
			return (
				sim.stateCode === STATE_COMMUTE || sim.stateCode === STATE_DEPARTURE
			);
		case FAMILY_CONDO:
			return sim.stateCode === STATE_ACTIVE || sim.stateCode === STATE_PARKED;
		default:
			if (CATHEDRAL_FAMILIES.has(sim.familyCode)) {
				return sim.stateCode === STATE_EVAL_OUTBOUND;
			}
			return false;
	}
}

function distanceFeedbackPenalty(
	sourceFloor: number,
	destinationFloor: number,
): number {
	const delta = Math.abs(destinationFloor - sourceFloor);
	if (delta >= 125) return 60;
	if (delta > 79) return 30;
	return 0;
}

export function maybeApplyDistanceFeedback(
	_world: WorldState,
	sim: SimRecord,
	sourceFloor: number,
	destinationFloor: number,
	canApplyForRouteKind: boolean,
): void {
	if (!canApplyForRouteKind) return;
	if (!shouldEmitDistanceFeedback(sim)) return;
	const penalty = distanceFeedbackPenalty(sourceFloor, destinationFloor);
	if (penalty === 0) return;
	addDelayToCurrentSim(sim, penalty);
}

export function createSimStateRecords(world: WorldState): SimStateRecord[] {
	return world.sims
		.map((sim) => {
			const object = findObjectForSim(world, sim);
			if (!object) return null;
			const carrierRoute = world.carriers.find((carrier) =>
				carrier.pendingRoutes.some((route) => route.simId === simKey(sim)),
			);
			const pendingRoute = carrierRoute?.pendingRoutes.find(
				(route) => route.simId === simKey(sim),
			);
			const carrierId =
				pendingRoute || sim.route.mode === "carrier"
					? (carrierRoute?.carrierId ??
						(sim.route.mode === "carrier" ? sim.route.carrierId : null))
					: null;

			const routeModeNum =
				sim.route.mode === "carrier" ? 2 : sim.route.mode === "segment" ? 1 : 0;

			return {
				id: simKey(sim),
				floorAnchor: sim.floorAnchor,
				selectedFloor: sim.selectedFloor,
				homeColumn: sim.homeColumn,
				baseOffset: sim.baseOffset,
				familyCode: sim.familyCode,
				stateCode: sim.stateCode,
				routeMode: routeModeNum,
				carrierId,
				assignedCarIndex: pendingRoute?.assignedCarIndex ?? -1,
				boardedOnCarrier: pendingRoute?.boarded ?? false,
				stressLevel: simStressLevel(sim, object),
				tripCount: sim.tripCount,
				accumulatedTicks: sim.accumulatedTicks,
				elapsedTicks: sim.elapsedTicks,
			} satisfies SimStateRecord;
		})
		.filter((sim): sim is SimStateRecord => sim !== null);
}
