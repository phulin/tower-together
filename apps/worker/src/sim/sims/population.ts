import { FAMILY_CONDO, FAMILY_OFFICE } from "../resources";
import type { CarrierRecord } from "../world";
import {
	GRID_HEIGHT,
	type PlacedObjectRecord,
	type SimRecord,
	type WorldState,
	yToFloor,
} from "../world";
import {
	CATHEDRAL_FAMILIES,
	ENTITY_POPULATION_BY_TYPE,
	HOTEL_FAMILIES,
	ROUTE_IDLE,
	STATE_ACTIVE,
	STATE_HOTEL_PARKED,
	STATE_MORNING_GATE,
	STATE_PARKED,
	UNIT_STATUS_CONDO_VACANT,
} from "./states";

function makeSim(
	floorAnchor: number,
	homeColumn: number,
	baseOffset: number,
	familyCode: number,
): SimRecord {
	return {
		floorAnchor,
		homeColumn,
		baseOffset,
		familyCode,
		stateCode: initialStateForFamily(familyCode),
		route: ROUTE_IDLE,
		selectedFloor: floorAnchor,
		originFloor: floorAnchor,
		destinationFloor: -1,
		venueReturnState: 0,
		queueTick: 0,
		elapsedTicks: 0,
		routeRetryDelay: 0,
		transitTicksRemaining: 0,
		lastDemandTick: 0,
		tripCount: 0,
		accumulatedTicks: 0,
	};
}

function initialStateForFamily(familyCode: number): number {
	if (HOTEL_FAMILIES.has(familyCode)) return STATE_HOTEL_PARKED;
	if (CATHEDRAL_FAMILIES.has(familyCode)) return STATE_PARKED;
	if (familyCode === FAMILY_OFFICE) return STATE_MORNING_GATE;
	return STATE_PARKED;
}

export function simKey(sim: SimRecord): string {
	return `${sim.floorAnchor}:${sim.homeColumn}:${sim.familyCode}:${sim.baseOffset}`;
}

function objectKey(sim: SimRecord): string {
	const y = GRID_HEIGHT - 1 - sim.floorAnchor;
	return `${sim.homeColumn},${y}`;
}

export function findObjectForSim(
	world: WorldState,
	sim: SimRecord,
): PlacedObjectRecord | undefined {
	return world.placedObjects[objectKey(sim)];
}

export function findSiblingSims(
	world: WorldState,
	sim: SimRecord,
): SimRecord[] {
	return world.sims.filter(
		(candidate) =>
			candidate.floorAnchor === sim.floorAnchor &&
			candidate.homeColumn === sim.homeColumn &&
			candidate.familyCode === sim.familyCode,
	);
}

export function clearSimRoute(sim: SimRecord): void {
	sim.route = ROUTE_IDLE;
}

function clearCarrierSlotsForRemovedSims(
	carrier: CarrierRecord,
	removedIds: Set<string>,
): void {
	carrier.pendingRoutes = carrier.pendingRoutes.filter(
		(route) => !removedIds.has(route.simId),
	);
	for (const car of carrier.cars) {
		for (const slot of car.activeRouteSlots) {
			if (!slot.active) continue;
			if (!removedIds.has(slot.routeId)) continue;
			slot.active = false;
			slot.routeId = "";
			slot.sourceFloor = 0xff;
			slot.destinationFloor = 0xff;
			slot.boarded = false;
		}
		car.pendingRouteIds = car.pendingRouteIds.filter(
			(id) => !removedIds.has(id),
		);
	}
}

export function rebuildRuntimeSims(world: WorldState): void {
	const previous = new Map(
		world.sims.map((sim) => [simKey(sim), sim] as const),
	);
	const next: SimRecord[] = [];

	for (const [key, object] of Object.entries(world.placedObjects)) {
		const population = ENTITY_POPULATION_BY_TYPE[object.objectTypeCode] ?? 0;
		if (population === 0) continue;
		const [x, y] = key.split(",").map(Number);
		const floorAnchor = yToFloor(y);

		for (let baseOffset = 0; baseOffset < population; baseOffset++) {
			const fresh = makeSim(floorAnchor, x, baseOffset, object.objectTypeCode);
			const prior = previous.get(simKey(fresh));
			if (prior) {
				next.push({ ...fresh, ...prior, floorAnchor, homeColumn: x });
			} else {
				fresh.tripCount = 0;
				fresh.accumulatedTicks = 0;
				next.push(fresh);
			}
		}
	}

	world.sims = next;
}

export function cleanupSimsForRemovedTile(
	world: WorldState,
	anchorX: number,
	y: number,
): void {
	const floorAnchor = yToFloor(y);
	const removedIds = new Set<string>();

	for (const sim of world.sims) {
		if (sim.homeColumn !== anchorX || sim.floorAnchor !== floorAnchor) {
			continue;
		}
		clearSimRoute(sim);
		sim.destinationFloor = -1;
		removedIds.add(simKey(sim));
	}

	if (removedIds.size === 0) return;

	for (const carrier of world.carriers) {
		clearCarrierSlotsForRemovedSims(carrier, removedIds);
	}
}

export function resetSimRuntimeState(world: WorldState): void {
	for (const sim of world.sims) {
		const object = findObjectForSim(world, sim);
		if (!object) continue;

		if (HOTEL_FAMILIES.has(sim.familyCode)) {
			sim.stateCode = STATE_HOTEL_PARKED;
		} else if (sim.familyCode === FAMILY_CONDO) {
			sim.stateCode =
				object.unitStatus >= UNIT_STATUS_CONDO_VACANT
					? STATE_PARKED
					: STATE_ACTIVE;
		} else {
			sim.stateCode = STATE_PARKED;
		}

		sim.selectedFloor = sim.floorAnchor;
		sim.originFloor = sim.floorAnchor;
		sim.route = ROUTE_IDLE;
		sim.destinationFloor = -1;
		sim.venueReturnState = 0;
		sim.queueTick = 0;
		sim.elapsedTicks = 0;
		sim.transitTicksRemaining = 0;
	}
}
