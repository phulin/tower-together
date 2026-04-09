import { enqueue_carrier_route } from "./carriers";
import { add_cashflow_from_family_resource, type LedgerState } from "./ledger";
import { OP_SCORE_THRESHOLDS, YEN_1001 } from "./resources";
import { type RouteCandidate, select_best_route_candidate } from "./routing";
import type { TimeState } from "./time";
import {
	type CommercialVenueRecord,
	type EntityRecord,
	type PlacedObjectRecord,
	type WorldState,
	yToFloor,
} from "./world";

export interface EntityStateRecord {
	id: string;
	floorAnchor: number;
	subtypeIndex: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	stressLevel: "low" | "medium" | "high";
}

const ENTITY_POPULATION_BY_TYPE: Record<number, number> = {
	3: 1,
	4: 2,
	5: 3,
	7: 6,
	9: 3,
};

const HOTEL_FAMILIES = new Set([3, 4, 5]);
const COMMERCIAL_FAMILIES = new Set([6, 10, 12]);
const ELEVATOR_DEMAND_STATES = new Set([0x01, 0x04, 0x05, 0x22]);
const ROUTE_MODE_NONE = 0;
const ROUTE_MODE_SEGMENT = 1;
const ROUTE_MODE_CARRIER = 2;

function makeEntity(
	floorAnchor: number,
	subtypeIndex: number,
	baseOffset: number,
	familyCode: number,
): EntityRecord {
	return {
		floorAnchor,
		subtypeIndex,
		baseOffset,
		familyCode,
		stateCode: initialStateForFamily(familyCode),
		routeMode: ROUTE_MODE_NONE,
		routeSourceFloor: 0xff,
		routeCarrierOrSegment: 0xff,
		selectedFloor: floorAnchor,
		originFloor: floorAnchor,
		encodedRouteTarget: -1,
		auxState: 0,
		queueTick: 0,
		accumulatedDelay: 0,
		routeRetryDelay: 0,
		auxCounter: 0,
		word0a: 0,
		word0c: 0,
		word0e: 0,
		byte09: 0,
	};
}

function initialStateForFamily(familyCode: number): number {
	if (HOTEL_FAMILIES.has(familyCode)) return 0x24;
	return 0x27;
}

function entityKey(entity: EntityRecord): string {
	return `${entity.floorAnchor}:${entity.subtypeIndex}:${entity.familyCode}:${entity.baseOffset}`;
}

function objectKey(entity: EntityRecord): string {
	const y = 119 - entity.floorAnchor;
	return `${entity.subtypeIndex},${y}`;
}

function findObjectForEntity(
	world: WorldState,
	entity: EntityRecord,
): PlacedObjectRecord | undefined {
	return world.placedObjects[objectKey(entity)];
}

function findSiblingEntities(
	world: WorldState,
	entity: EntityRecord,
): EntityRecord[] {
	return world.entities.filter(
		(candidate) =>
			candidate.floorAnchor === entity.floorAnchor &&
			candidate.subtypeIndex === entity.subtypeIndex &&
			candidate.familyCode === entity.familyCode,
	);
}

function hasViableRouteBetweenFloors(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	return (
		fromFloor === toFloor ||
		select_best_route_candidate(world, fromFloor, toFloor) !== null
	);
}

function supportsFamily(
	originFamilyCode: number,
	targetFamilyCode: number,
): boolean {
	if (originFamilyCode === 7) {
		return (
			targetFamilyCode === 3 ||
			targetFamilyCode === 4 ||
			targetFamilyCode === 5 ||
			targetFamilyCode === 6 ||
			targetFamilyCode === 10 ||
			targetFamilyCode === 12
		);
	}

	if (originFamilyCode === 9) {
		return targetFamilyCode === 6 || targetFamilyCode === 10;
	}

	return COMMERCIAL_FAMILIES.has(targetFamilyCode);
}

function hasNearbySupport(
	world: WorldState,
	object: PlacedObjectRecord,
	floorAnchor: number,
	radius: number,
): boolean {
	for (const [key, candidate] of Object.entries(world.placedObjects)) {
		if (candidate === object) continue;
		const [_x, y] = key.split(",").map(Number);
		if (yToFloor(y) !== floorAnchor) continue;
		if (!supportsFamily(object.objectTypeCode, candidate.objectTypeCode))
			continue;
		const leftDelta = Math.abs(candidate.leftTileIndex - object.rightTileIndex);
		const rightDelta = Math.abs(
			object.leftTileIndex - candidate.rightTileIndex,
		);
		if (Math.min(leftDelta, rightDelta) <= radius) return true;
	}

	return false;
}

function recomputeObjectOperationalStatus(
	world: WorldState,
	time: TimeState,
	entity: EntityRecord,
	object: PlacedObjectRecord,
): void {
	if (object.objectTypeCode !== 7 && object.objectTypeCode !== 9) return;

	const siblings = findSiblingEntities(world, entity);
	const sampleTotal = siblings.reduce(
		(sum, sibling) => sum + sibling.byte09,
		0,
	);
	const sampleCount = Math.max(1, siblings.length);
	let score = Math.trunc(
		4096 / Math.max(1, Math.trunc(sampleTotal / sampleCount)),
	);

	switch (object.variantIndex) {
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

	const supportRadius = object.objectTypeCode === 7 ? 10 : 30;
	if (hasNearbySupport(world, object, entity.floorAnchor, supportRadius)) {
		score += 60;
	}

	const [lower, upper] = OP_SCORE_THRESHOLDS[Math.min(time.starCount, 5)] ?? [
		80, 200,
	];
	object.pairingStatus = score < lower ? 2 : score < upper ? 1 : 0;
	if (object.pairingActiveFlag === 0 && object.pairingStatus > 0) {
		object.pairingActiveFlag = 1;
	}
	object.needsRefreshFlag = 1;
}

function recomputeRoutesViableFlag(world: WorldState, time: TimeState): void {
	if (time.starCount <= 2) {
		world.gateFlags.routesViable = 0;
		return;
	}

	world.gateFlags.routesViable = Object.entries(world.placedObjects).some(
		([key, object]) => {
			if (
				object.objectTypeCode !== 3 &&
				object.objectTypeCode !== 4 &&
				object.objectTypeCode !== 5 &&
				object.objectTypeCode !== 7 &&
				object.objectTypeCode !== 9
			) {
				return false;
			}

			const [, y] = key.split(",").map(Number);
			return hasViableRouteBetweenFloors(world, 10, yToFloor(y));
		},
	)
		? 1
		: 0;
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
		if (record.ownerSubtypeIndex === 0xff) continue;
		if (record.availabilityState === 3) continue;
		if (record.todayVisitCount >= record.capacity) continue;

		const [, y] = key.split(",").map(Number);
		if (!hasViableRouteBetweenFloors(world, fromFloor, yToFloor(y))) {
			continue;
		}

		return { record, floor: yToFloor(y) };
	}

	return null;
}

function recordDemandSample(entity: EntityRecord, time: TimeState): void {
	entity.word0a = time.dayTick;
	entity.word0c = Math.min(300, entity.word0c + 1);
	entity.word0e += entity.word0c;
	entity.byte09 = Math.min(255, entity.byte09 + 1);
}

function reserveVenue(record: CommercialVenueRecord): void {
	record.todayVisitCount += 1;
	record.visitCount = record.todayVisitCount;
}

function raiseStress(entity: EntityRecord, amount = 20): void {
	entity.accumulatedDelay = Math.min(255, entity.accumulatedDelay + amount);
}

function lowerStress(entity: EntityRecord, amount = 12): void {
	entity.accumulatedDelay = Math.max(0, entity.accumulatedDelay - amount);
}

function complete_same_floor_trip(entity: EntityRecord): void {
	entity.encodedRouteTarget = -1;
	entity.selectedFloor = entity.floorAnchor;
	clear_entity_route(entity);
	entity.stateCode = 0x01;
}

function activateHotelStay(
	world: WorldState,
	entity: EntityRecord,
	time: TimeState,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;
	if (!hasViableRouteBetweenFloors(world, 10, entity.floorAnchor)) {
		raiseStress(entity, 30);
		return;
	}
	entity.stateCode = 0x01;
	entity.originFloor = 10;
	entity.selectedFloor = entity.floorAnchor;
	object.stayPhase = time.daypartIndex < 4 ? 0 : 8;
	object.needsRefreshFlag = 1;
	lowerStress(entity, 8);
}

function checkoutHotelStay(
	world: WorldState,
	ledger: LedgerState,
	entity: EntityRecord,
	object: PlacedObjectRecord,
): void {
	const siblings = findSiblingEntities(world, entity);
	const lastSibling = siblings.reduce(
		(max, sibling) => Math.max(max, sibling.baseOffset),
		0,
	);
	if (entity.baseOffset !== lastSibling) {
		entity.stateCode = 0x04;
		return;
	}

	const tileName =
		object.objectTypeCode === 3
			? "hotelSingle"
			: object.objectTypeCode === 4
				? "hotelTwin"
				: "hotelSuite";
	add_cashflow_from_family_resource(
		ledger,
		tileName,
		object.variantIndex,
		object.objectTypeCode,
	);
	for (const sibling of siblings) sibling.stateCode = 0x24;
	object.stayPhase = 0x28;
	object.needsRefreshFlag = 1;
}

function processHotelEntity(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;
	if (time.starCount <= 2) {
		entity.stateCode = 0x24;
		return;
	}

	switch (entity.stateCode) {
		case 0x24:
			if (time.daypartIndex < 4) activateHotelStay(world, entity, time);
			return;
		case 0x01: {
			if (time.daypartIndex >= 4) {
				entity.encodedRouteTarget = 10;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x05;
				return;
			}
			const venue = pickAvailableVenue(
				world,
				entity.floorAnchor,
				COMMERCIAL_FAMILIES,
			);
			if (venue) {
				reserveVenue(venue.record);
				recordDemandSample(entity, time);
				object.activationTickCount = Math.min(
					0x78,
					object.activationTickCount + 1,
				);
				if (venue.floor === entity.floorAnchor) {
					complete_same_floor_trip(entity);
					lowerStress(entity, 16);
					return;
				}
				entity.encodedRouteTarget = venue.floor;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x22;
				lowerStress(entity, 16);
			} else {
				raiseStress(entity, 8);
			}
			return;
		}
		case 0x22:
			if (entity.selectedFloor !== entity.encodedRouteTarget) return;
			entity.encodedRouteTarget = -1;
			entity.selectedFloor = entity.floorAnchor;
			entity.stateCode = 0x01;
			return;
		case 0x05:
		case 0x04:
			if (entity.selectedFloor !== 10) return;
			checkoutHotelStay(world, ledger, entity, object);
			return;
		default:
			entity.stateCode = 0x24;
	}
}

function processOfficeEntity(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;

	const activeDay = time.dayCounter % 3 === 0 && time.daypartIndex < 4;
	if (!activeDay) {
		entity.stateCode = 0x27;
		return;
	}

	if (entity.stateCode === 0x27) {
		entity.stateCode = 0x01;
		if (
			entity.baseOffset === 0 &&
			object.auxValueOrTimer !== time.dayCounter + 1
		) {
			object.auxValueOrTimer = time.dayCounter + 1;
			add_cashflow_from_family_resource(
				ledger,
				"office",
				object.variantIndex,
				object.objectTypeCode,
			);
		}
	}

	if (entity.stateCode === 0x01) {
		const venue = pickAvailableVenue(
			world,
			entity.floorAnchor,
			new Set([6, 10, 12]),
		);
		if (venue) {
			reserveVenue(venue.record);
			recordDemandSample(entity, time);
			if (venue.floor === entity.floorAnchor) {
				complete_same_floor_trip(entity);
				lowerStress(entity, 12);
				recomputeObjectOperationalStatus(world, time, entity, object);
				return;
			}
			entity.encodedRouteTarget = venue.floor;
			entity.selectedFloor = entity.floorAnchor;
			entity.stateCode = 0x22;
			lowerStress(entity, 12);
		} else {
			raiseStress(entity, 8);
		}
	}

	if (entity.stateCode === 0x22) {
		if (entity.selectedFloor !== entity.encodedRouteTarget) return;
		entity.encodedRouteTarget = -1;
		entity.selectedFloor = entity.floorAnchor;
		entity.stateCode = 0x01;
	}
	recomputeObjectOperationalStatus(world, time, entity, object);
}

function processCondoEntity(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;

	if (object.stayPhase >= 0x18) {
		if (hasViableRouteBetweenFloors(world, 10, entity.floorAnchor)) {
			object.stayPhase = time.daypartIndex < 4 ? 0 : 8;
			if (entity.baseOffset === 0) {
				add_cashflow_from_family_resource(
					ledger,
					"condo",
					object.variantIndex,
					object.objectTypeCode,
				);
			}
			for (const sibling of findSiblingEntities(world, entity))
				sibling.stateCode = 0x01;
			object.needsRefreshFlag = 1;
			lowerStress(entity, 10);
		} else {
			raiseStress(entity, 24);
		}
		return;
	}

	if (entity.stateCode === 0x27) entity.stateCode = 0x01;
	if (entity.stateCode === 0x01) {
		const venue = pickAvailableVenue(
			world,
			entity.floorAnchor,
			new Set([6, 10]),
		);
		if (venue) {
			reserveVenue(venue.record);
			recordDemandSample(entity, time);
			if (venue.floor === entity.floorAnchor) {
				complete_same_floor_trip(entity);
				lowerStress(entity, 10);
				recomputeObjectOperationalStatus(world, time, entity, object);
				return;
			}
			entity.encodedRouteTarget = venue.floor;
			entity.selectedFloor = entity.floorAnchor;
			entity.stateCode = 0x22;
			lowerStress(entity, 10);
		} else {
			raiseStress(entity, 7);
		}
	} else if (entity.stateCode === 0x22) {
		if (entity.selectedFloor !== entity.encodedRouteTarget) return;
		entity.encodedRouteTarget = -1;
		entity.selectedFloor = entity.floorAnchor;
		entity.stateCode = 0x01;
	}

	recomputeObjectOperationalStatus(world, time, entity, object);
}

export function rebuild_runtime_entities(world: WorldState): void {
	const previous = new Map(
		world.entities.map((entity) => [entityKey(entity), entity] as const),
	);
	const next: EntityRecord[] = [];

	for (const [key, object] of Object.entries(world.placedObjects)) {
		const population = ENTITY_POPULATION_BY_TYPE[object.objectTypeCode] ?? 0;
		if (population === 0) continue;
		const [x, y] = key.split(",").map(Number);
		const floorAnchor = yToFloor(y);
		if (
			object.objectTypeCode === 9 &&
			object.activationTickCount === 0 &&
			object.stayPhase === 0
		) {
			object.stayPhase = 0x18;
		}

		for (let baseOffset = 0; baseOffset < population; baseOffset++) {
			const fresh = makeEntity(
				floorAnchor,
				x,
				baseOffset,
				object.objectTypeCode,
			);
			const prior = previous.get(entityKey(fresh));
			next.push(
				prior ? { ...fresh, ...prior, floorAnchor, subtypeIndex: x } : fresh,
			);
		}
	}

	world.entities = next;
}

export function reset_entity_runtime_state(world: WorldState): void {
	for (const entity of world.entities) {
		const object = findObjectForEntity(world, entity);
		if (!object) continue;

		if (HOTEL_FAMILIES.has(entity.familyCode)) {
			entity.stateCode = 0x24;
		} else if (entity.familyCode === 9) {
			entity.stateCode = object.stayPhase >= 0x18 ? 0x27 : 0x01;
		} else {
			entity.stateCode = 0x27;
		}

		entity.selectedFloor = entity.floorAnchor;
		entity.originFloor = entity.floorAnchor;
		entity.routeMode = ROUTE_MODE_NONE;
		entity.routeSourceFloor = 0xff;
		entity.routeCarrierOrSegment = 0xff;
		entity.encodedRouteTarget = -1;
		entity.auxState = 0;
		entity.queueTick = 0;
		entity.accumulatedDelay = 0;
		entity.auxCounter = 0;
	}
}

export function advance_entity_refresh_stride(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	if (world.entities.length === 0) return;

	const stride = time.dayTick % 16;
	for (let index = 0; index < world.entities.length; index++) {
		if (index % 16 !== stride) continue;
		const entity = world.entities[index];
		finalize_pending_route_leg(entity);
		switch (entity.familyCode) {
			case 3:
			case 4:
			case 5:
				processHotelEntity(world, ledger, time, entity);
				break;
			case 7:
				processOfficeEntity(world, ledger, time, entity);
				break;
			case 9:
				processCondoEntity(world, ledger, time, entity);
				break;
			default:
				break;
		}
	}

	recomputeRoutesViableFlag(world, time);
}

function shouldSeedElevatorDemand(entity: EntityRecord): boolean {
	if (entity.routeRetryDelay > 0) return false;
	if (entity.routeMode !== ROUTE_MODE_NONE) return false;
	if (!ELEVATOR_DEMAND_STATES.has(entity.stateCode)) return false;
	if (
		entity.familyCode !== 3 &&
		entity.familyCode !== 4 &&
		entity.familyCode !== 5 &&
		entity.familyCode !== 7 &&
		entity.familyCode !== 9
	) {
		return false;
	}
	return true;
}

function getElevatorDemand(entity: EntityRecord): {
	sourceFloor: number;
	destinationFloor: number;
	directionFlag: number;
} | null {
	if (entity.stateCode === 0x04 || entity.stateCode === 0x05) {
		return {
			sourceFloor: entity.floorAnchor,
			destinationFloor: 10,
			directionFlag: 1,
		};
	}

	if (entity.stateCode === 0x22 && entity.encodedRouteTarget >= 0) {
		return {
			sourceFloor: entity.floorAnchor,
			destinationFloor: entity.encodedRouteTarget,
			directionFlag: entity.encodedRouteTarget > entity.floorAnchor ? 0 : 1,
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
	3, 4, 5, 6, 7, 9, 10, 0x0c,
]);
const CUSTOM_ROUTE_SELECTOR_FAMILIES = new Set<number>([
	0x0f, 0x12, 0x1d, 0x21, 0x24,
]);

function select_route_for_family(
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
		return select_best_route_candidate(
			world,
			fromFloor,
			toFloor,
			preferLocalMode,
		);
	}
	return null;
}

/**
 * Return codes mirror `resolve_entity_route_between_floors` from
 * ROUTING.md / SPEC.md:
 *
 *  -1 = no viable route (entity remains unrouted)
 *   0 = carrier queue full; entity[+8] = 0xff and entity[+7] = source floor,
 *       so the entity stays parked on the source floor and retries next tick
 *   1 = direct special-link leg accepted; entity[+8] = segment index,
 *       entity[+7] = post-link floor (the leg's destination)
 *   2 = queued onto a carrier; entity[+8] = 0x40 + id (up) or 0x58 + id (down),
 *       entity[+7] = source floor
 *   3 = same-floor success (treated as immediate arrival by the caller)
 */
export type RouteResolution = -1 | 0 | 1 | 2 | 3;

function resolve_entity_route_between_floors(
	world: WorldState,
	entity: EntityRecord,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
	time: TimeState | undefined,
): RouteResolution {
	if (sourceFloor === destinationFloor) {
		return 3;
	}

	// spec: route_mode comes from anchoring object[+6] (= leftTileIndex word).
	// 0 → express/escalator mode, non-zero → local/stair mode.
	// TODO: the exact semantics are ambiguous (spec reconciliation note for
	// +0x06); wire up once confirmed from binary analysis.
	const preferLocalMode = true;

	const route = select_route_for_family(
		world,
		entity.familyCode,
		sourceFloor,
		destinationFloor,
		preferLocalMode,
	);
	if (!route) {
		clear_entity_route(entity);
		entity.routeRetryDelay = 300;
		return -1;
	}

	if (route.kind === "segment") {
		entity.routeMode = ROUTE_MODE_SEGMENT;
		entity.routeSourceFloor = destinationFloor;
		entity.routeCarrierOrSegment = route.id;
		entity.queueTick = time?.dayTick ?? entity.queueTick;
		entity.encodedRouteTarget = destinationFloor;
		return 1;
	}

	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === route.id,
	);
	if (!carrier) {
		clear_entity_route(entity);
		return -1;
	}

	const queued = enqueue_carrier_route(
		carrier,
		entityKey(entity),
		sourceFloor,
		destinationFloor,
		directionFlag,
	);
	if (!queued) {
		// Queue full: stamp the 0xff sentinel and source floor so the entity
		// remains parked here and retries after the waiting-state delay.
		entity.routeMode = ROUTE_MODE_NONE;
		entity.routeSourceFloor = sourceFloor;
		entity.routeCarrierOrSegment = 0xff;
		entity.encodedRouteTarget = destinationFloor;
		entity.routeRetryDelay = 5;
		return 0;
	}

	entity.routeMode = ROUTE_MODE_CARRIER;
	entity.routeSourceFloor = sourceFloor;
	entity.routeCarrierOrSegment =
		directionFlag === 0 ? route.id + 0x40 : route.id + 0x58;
	entity.queueTick = time?.dayTick ?? entity.queueTick;
	entity.encodedRouteTarget = destinationFloor;
	return 2;
}

function clear_entity_route(entity: EntityRecord): void {
	entity.routeMode = ROUTE_MODE_NONE;
	entity.routeSourceFloor = 0xff;
	entity.routeCarrierOrSegment = 0xff;
}

function should_finalize_segment_trip(entity: EntityRecord): boolean {
	return (
		entity.stateCode === 0x22 ||
		entity.stateCode === 0x04 ||
		entity.stateCode === 0x05
	);
}

function finalize_pending_route_leg(entity: EntityRecord): void {
	if (entity.routeMode !== ROUTE_MODE_SEGMENT) return;
	if (entity.routeSourceFloor === 0xff) return;
	entity.selectedFloor = entity.routeSourceFloor;
	clear_entity_route(entity);
}

function dispatch_entity_arrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
	arrivalFloor: number,
): void {
	entity.selectedFloor = arrivalFloor;
	clear_entity_route(entity);

	const object = findObjectForEntity(world, entity);
	switch (entity.familyCode) {
		case 3:
		case 4:
		case 5:
			if (
				entity.stateCode === 0x22 &&
				entity.encodedRouteTarget === arrivalFloor
			) {
				entity.encodedRouteTarget = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x01;
				return;
			}
			if (
				(entity.stateCode === 0x04 || entity.stateCode === 0x05) &&
				arrivalFloor === 10
			) {
				entity.encodedRouteTarget = -1;
				if (object) checkoutHotelStay(world, ledger, entity, object);
			}
			return;
		case 7:
			if (
				entity.stateCode === 0x22 &&
				entity.encodedRouteTarget === arrivalFloor
			) {
				entity.encodedRouteTarget = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x01;
				if (object)
					recomputeObjectOperationalStatus(world, time, entity, object);
			}
			return;
		case 9:
			if (
				entity.stateCode === 0x22 &&
				entity.encodedRouteTarget === arrivalFloor
			) {
				entity.encodedRouteTarget = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x01;
				if (object)
					recomputeObjectOperationalStatus(world, time, entity, object);
			}
			return;
		default:
			return;
	}
}

export function populate_carrier_requests(
	world: WorldState,
	time?: TimeState,
): void {
	for (const entity of world.entities) {
		if (entity.routeRetryDelay > 0) entity.routeRetryDelay -= 1;
	}

	const activeDemandIds = new Set<string>();
	for (const entity of world.entities) {
		if (!shouldSeedElevatorDemand(entity)) continue;
		const demand = getElevatorDemand(entity);
		if (!demand) continue;
		activeDemandIds.add(entityKey(entity));
		// Returns -1/0/1/2/3 per ROUTING.md. We don't need to branch here yet
		// because each return code already leaves the entity in the correct
		// in-transit / wait / unrouted state.
		resolve_entity_route_between_floors(
			world,
			entity,
			demand.sourceFloor,
			demand.destinationFloor,
			demand.directionFlag,
			time,
		);
	}

	for (const carrier of world.carriers) {
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(route) => route.boarded || activeDemandIds.has(route.entityId),
		);
		for (const car of carrier.cars) {
			for (const slot of car.activeRouteSlots) {
				if (!slot.active) continue;
				if (
					!carrier.pendingRoutes.some(
						(route) => route.entityId === slot.routeId,
					)
				) {
					slot.active = false;
					slot.routeId = "";
					slot.sourceFloor = 0xff;
					slot.destinationFloor = 0xff;
					slot.boarded = false;
				}
			}
			car.pendingRouteIds = car.activeRouteSlots
				.filter((slot) => slot.active)
				.map((slot) => slot.routeId);
		}
	}

	for (const entity of world.entities) {
		if (!activeDemandIds.has(entityKey(entity))) {
			entity.routeCarrierOrSegment = 0xff;
		}
	}
}

/**
 * Invoked synchronously by `tick_all_carriers` (via the `onArrival` callback)
 * when a carrier unloads an entity at its destination, mirroring the binary's
 * `dispatch_destination_queue_entries` path which calls the family state
 * handler directly inside the carrier tick. The post-tick
 * `reconcile_entity_transport` sweep is still consulted for any arrivals that
 * were not delivered through this callback (e.g. tests that drive the
 * carrier state by hand).
 */
export function on_carrier_arrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	routeId: string,
	arrivalFloor: number,
): void {
	const entity = world.entities.find(
		(candidate) => entityKey(candidate) === routeId,
	);
	if (!entity) return;
	dispatch_entity_arrival(world, ledger, time, entity, arrivalFloor);
}

export function reconcile_entity_transport(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const entity of world.entities) {
		if (entity.routeMode !== ROUTE_MODE_SEGMENT) continue;
		if (entity.routeSourceFloor === 0xff) continue;
		if (!should_finalize_segment_trip(entity)) continue;
		dispatch_entity_arrival(
			world,
			ledger,
			time,
			entity,
			entity.routeSourceFloor,
		);
	}

	const completed = new Set<string>();
	for (const carrier of world.carriers) {
		for (const routeId of carrier.completedRouteIds) completed.add(routeId);
		carrier.completedRouteIds = [];
	}

	for (const entity of world.entities) {
		if (entity.encodedRouteTarget < 0) continue;
		if (!completed.has(entityKey(entity))) continue;
		dispatch_entity_arrival(
			world,
			ledger,
			time,
			entity,
			entity.encodedRouteTarget,
		);
	}
}

export function resetCommercialVenueCycle(world: WorldState): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.yesterdayVisitCount = record.todayVisitCount;
		record.todayVisitCount = 0;
		record.visitCount = 0;
		record.availabilityState = 1;
	}
}

export function closeCommercialVenues(world: WorldState): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.availabilityState = 3;
	}
}

export function resetHousekeepingDutyTier(world: WorldState): void {
	for (const object of Object.values(world.placedObjects)) {
		if (object.objectTypeCode === 21 && object.stayPhase === 6) {
			object.stayPhase = 0;
			object.needsRefreshFlag = 1;
		}
	}
}

export function update_security_housekeeping_state(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	param: number,
): void {
	if (time.starCount <= 2) {
		world.gateFlags.securityAdequate = 0;
		return;
	}

	if (param === 0) {
		world.gateFlags.securityAdequate = 0;
		for (const object of Object.values(world.placedObjects)) {
			if (object.objectTypeCode === 20 || object.objectTypeCode === 21) {
				object.stayPhase = 0;
				object.needsRefreshFlag = 1;
			}
		}
		return;
	}

	const scale = Math.max(0, world.gateFlags.securityLedgerScale);
	if (scale === 0) {
		world.gateFlags.securityAdequate = 0;
		return;
	}

	const primaryTotal = ledger.primaryLedger.reduce(
		(sum, value) => sum + value,
		0,
	);
	const scaled = Math.trunc(primaryTotal / scale);
	const requiredTier =
		scaled < 500
			? 1
			: scaled < 1000
				? 2
				: scaled < 1500
					? 3
					: scaled < 2000
						? 4
						: scaled < 2500
							? 5
							: 6;
	const adequate = param >= requiredTier ? 1 : 0;
	const dutyTier = adequate ? Math.min(requiredTier, param) : param;

	world.gateFlags.securityAdequate = adequate;
	for (const object of Object.values(world.placedObjects)) {
		if (object.objectTypeCode === 20 || object.objectTypeCode === 21) {
			object.stayPhase = dutyTier;
			object.needsRefreshFlag = 1;
		}
	}
}

export function runOfficeServiceEvaluation(
	world: WorldState,
	time: TimeState,
): void {
	if (time.starCount !== 3 || time.dayCounter % 9 !== 3) return;

	let passed = false;
	for (const entity of world.entities) {
		if (entity.familyCode !== 7 || entity.stateCode !== 0x01) continue;
		const object = findObjectForEntity(world, entity);
		if (!object) continue;
		passed ||= object.pairingStatus > 0;
	}

	world.gateFlags.officeServiceOk = passed ? 1 : 0;
}

export function refund_unhappy_condos(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode !== 9) continue;
		if (object.pairingStatus !== 0) continue;
		if (object.stayPhase >= 0x18) continue;
		const tileName = "condo";
		const payout = YEN_1001[tileName]?.[Math.min(object.variantIndex, 3)] ?? 0;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - payout * 1000);
		object.stayPhase = 0x18;
		object.needsRefreshFlag = 1;
		const [x, y] = key.split(",").map(Number);
		for (const entity of world.entities) {
			if (entity.subtypeIndex === x && entity.floorAnchor === yToFloor(y)) {
				entity.stateCode = 0x27;
			}
		}
	}
}

function entityStressLevel(
	entity: EntityRecord,
	object: PlacedObjectRecord | undefined,
): "low" | "medium" | "high" {
	if (object?.pairingStatus === 0 || entity.accumulatedDelay >= 120) {
		return "high";
	}
	if (object?.pairingStatus === 1 || entity.accumulatedDelay >= 40) {
		return "medium";
	}
	return "low";
}

export function create_entity_state_records(
	world: WorldState,
): EntityStateRecord[] {
	return world.entities
		.map((entity) => {
			const object = findObjectForEntity(world, entity);
			if (!object) return null;

			return {
				id: entityKey(entity),
				floorAnchor: entity.floorAnchor,
				subtypeIndex: entity.subtypeIndex,
				baseOffset: entity.baseOffset,
				familyCode: entity.familyCode,
				stateCode: entity.stateCode,
				stressLevel: entityStressLevel(entity, object),
			} satisfies EntityStateRecord;
		})
		.filter((entity): entity is EntityStateRecord => entity !== null);
}
