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
	selectedFloor: number;
	subtypeIndex: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	stressLevel: "low" | "medium" | "high";
}

const ENTITY_POPULATION_BY_TYPE: Record<number, number> = {
	3: 1,
	4: 2,
	5: 3,
	7: 6,
	9: 3,
	// Cathedral evaluation entities: 5 floor types × 8 slots = 40 visitors
	36: 8, // 0x24
	37: 8, // 0x25
	38: 8, // 0x26
	39: 8, // 0x27
	40: 8, // 0x28
};

const HOTEL_FAMILIES = new Set([3, 4, 5]);
const COMMERCIAL_FAMILIES = new Set([6, 10, 12]);
const CATHEDRAL_FAMILIES = new Set([0x24, 0x25, 0x26, 0x27, 0x28]);
const ELEVATOR_DEMAND_STATES = new Set([
	0x00, 0x01, 0x04, 0x05, 0x22, 0x60, 0x45,
]);
const ROUTE_MODE_NONE = 0;
const ROUTE_MODE_SEGMENT = 1;
const ROUTE_MODE_CARRIER = 2;
const COMMERCIAL_VENUE_DWELL_TICKS = 60;
const COMMERCIAL_DWELL_STATE = 0x62;
const CONDO_COMMERCIAL_FAMILIES = new Set([6, 10]);

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
	if (CATHEDRAL_FAMILIES.has(familyCode)) return 0x27; // parked; activated at day-start
	if (familyCode === 7) return 0x20; // morning activation; allows same-day commute
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
	if (targetFamilyCode === 18 || targetFamilyCode === 29) {
		return (
			originFamilyCode === 3 ||
			originFamilyCode === 4 ||
			originFamilyCode === 5 ||
			originFamilyCode === 7 ||
			originFamilyCode === 9
		);
	}

	if (
		originFamilyCode === 3 ||
		originFamilyCode === 4 ||
		originFamilyCode === 5
	) {
		return (
			targetFamilyCode === 6 ||
			targetFamilyCode === 7 ||
			targetFamilyCode === 10 ||
			targetFamilyCode === 12
		);
	}

	if (originFamilyCode === 7) {
		return (
			targetFamilyCode === 6 ||
			targetFamilyCode === 10 ||
			targetFamilyCode === 12
		);
	}

	if (originFamilyCode === 9) {
		return (
			targetFamilyCode === 3 ||
			targetFamilyCode === 4 ||
			targetFamilyCode === 5 ||
			targetFamilyCode === 6 ||
			targetFamilyCode === 7 ||
			targetFamilyCode === 10 ||
			targetFamilyCode === 12
		);
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
	if (
		object.objectTypeCode !== 3 &&
		object.objectTypeCode !== 4 &&
		object.objectTypeCode !== 5 &&
		object.objectTypeCode !== 7 &&
		object.objectTypeCode !== 9
	)
		return;

	if (object.objectTypeCode <= 5 && object.unitStatus > 0x37) {
		object.evalLevel = 0xff;
		object.needsRefreshFlag = 1;
		return;
	}
	if (
		object.objectTypeCode === 7 &&
		object.unitStatus > 0x0f &&
		object.evalActiveFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.needsRefreshFlag = 1;
		return;
	}
	if (
		object.objectTypeCode === 9 &&
		object.unitStatus > 0x17 &&
		object.evalActiveFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.needsRefreshFlag = 1;
		return;
	}

	const siblings = findSiblingEntities(world, entity);
	const sampleTotal = siblings.reduce(
		(sum, sibling) => sum + sibling.byte09,
		0,
	);
	const sampleDivisor =
		object.objectTypeCode === 3
			? 1
			: object.objectTypeCode === 4
				? 2
				: object.objectTypeCode === 5
					? 2
					: object.objectTypeCode === 7
						? 6
						: 3;
	let score = Math.trunc(
		4096 / Math.max(1, Math.trunc(sampleTotal / sampleDivisor)),
	);

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

	const supportRadius =
		object.objectTypeCode === 7 ? 10 : object.objectTypeCode === 9 ? 30 : 20;
	if (hasNearbySupport(world, object, entity.floorAnchor, supportRadius)) {
		score += 60;
	}

	const [lower, upper] = OP_SCORE_THRESHOLDS[Math.min(time.starCount, 5)] ?? [
		80, 200,
	];
	object.evalLevel = score < lower ? 2 : score < upper ? 1 : 0;
	if (object.evalActiveFlag === 0 && object.evalLevel > 0) {
		object.evalActiveFlag = 1;
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

function beginCommercialVenueDwell(
	entity: EntityRecord,
	arrivalFloor: number,
	returnState: number,
): void {
	entity.encodedRouteTarget = -1;
	entity.selectedFloor = arrivalFloor;
	clear_entity_route(entity);
	entity.auxState = returnState;
	entity.stateCode = COMMERCIAL_DWELL_STATE;
}

function beginCommercialVenueTrip(
	entity: EntityRecord,
	destinationFloor: number,
): void {
	entity.encodedRouteTarget = destinationFloor;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = 0x22;
}

function finishCommercialVenueDwell(
	entity: EntityRecord,
	time: TimeState,
	defaultState: number,
): boolean {
	if (entity.stateCode !== COMMERCIAL_DWELL_STATE) return false;
	if (time.dayTick - entity.word0a < COMMERCIAL_VENUE_DWELL_TICKS) return true;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = entity.auxState || defaultState;
	entity.auxState = 0;
	return true;
}

function finishCommercialVenueTrip(
	entity: EntityRecord,
	returnState: number,
): boolean {
	if (entity.stateCode !== 0x22) return false;
	if (entity.selectedFloor !== entity.encodedRouteTarget) return true;
	entity.encodedRouteTarget = -1;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = returnState;
	return true;
}

function dispatchCommercialVenueVisit(
	world: WorldState,
	time: TimeState,
	entity: EntityRecord,
	options: {
		venueFamilies: Set<number>;
		returnState: number;
		successStressDelta: number;
		failureStressDelta: number;
		unavailableState?: number;
		onVenueReserved?: () => void;
	},
): boolean {
	const venue = pickAvailableVenue(
		world,
		entity.floorAnchor,
		options.venueFamilies,
	);
	if (!venue) {
		raiseStress(entity, options.failureStressDelta);
		if (options.unavailableState !== undefined) {
			entity.stateCode = options.unavailableState;
		}
		return false;
	}

	reserveVenue(venue.record);
	recordDemandSample(entity, time);
	options.onVenueReserved?.();
	if (venue.floor === entity.floorAnchor) {
		beginCommercialVenueDwell(entity, venue.floor, options.returnState);
	} else {
		beginCommercialVenueTrip(entity, venue.floor);
	}
	lowerStress(entity, options.successStressDelta);
	return true;
}

function handleCommercialVenueArrival(
	entity: EntityRecord,
	arrivalFloor: number,
	returnState: number,
): boolean {
	if (entity.stateCode !== 0x22 || entity.encodedRouteTarget !== arrivalFloor) {
		return false;
	}
	beginCommercialVenueDwell(entity, arrivalFloor, returnState);
	return true;
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
	object.unitStatus = time.daypartIndex < 4 ? 0 : 8;
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
		object.rentLevel,
		object.objectTypeCode,
	);
	world.gateFlags.family345SaleCount += 1;
	const saleCount = world.gateFlags.family345SaleCount;
	if (
		(saleCount < 20 && saleCount % 2 === 0) ||
		(saleCount >= 20 && saleCount % 8 === 0)
	) {
		world.gateFlags.newspaperTrigger = 1;
	}
	for (const sibling of siblings) sibling.stateCode = 0x24;
	object.unitStatus = 0x28;
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

	switch (entity.stateCode) {
		case 0x24:
			activateHotelStay(world, entity, time);
			return;
		case 0x01: {
			if (time.daypartIndex >= 4) {
				if (object.unitStatus === 0 || object.unitStatus === 8) {
					object.unitStatus = 0x10;
				}
				entity.encodedRouteTarget = 10;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x05;
				return;
			}
			dispatchCommercialVenueVisit(world, time, entity, {
				venueFamilies: COMMERCIAL_FAMILIES,
				returnState: 0x01,
				successStressDelta: 16,
				failureStressDelta: 8,
				onVenueReserved: () => {
					object.activationTickCount = Math.min(
						0x78,
						object.activationTickCount + 1,
					);
				},
			});
			return;
		}
		case 0x22:
			finishCommercialVenueTrip(entity, 0x01);
			return;
		case 0x05:
		case 0x04:
			if (entity.selectedFloor !== 10) return;
			if (object.unitStatus === 0 || object.unitStatus === 8) {
				object.unitStatus = 0x10;
				object.needsRefreshFlag = 1;
				return;
			}
			if (object.unitStatus === 0x10) {
				object.unitStatus = object.objectTypeCode === 3 ? 1 : 2;
				object.needsRefreshFlag = 1;
				return;
			}
			if ((object.unitStatus & 0x07) > 1) {
				object.unitStatus -= 1;
				object.needsRefreshFlag = 1;
				return;
			}
			checkoutHotelStay(world, ledger, entity, object);
			return;
		case COMMERCIAL_DWELL_STATE:
			finishCommercialVenueDwell(entity, time, 0x01);
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

	const state = entity.stateCode;

	// --- Night / failure park states (0x25, 0x26, 0x27) ---
	// Gate: day_tick > 2300 → transition to morning activation (0x20)
	if (state === 0x25 || state === 0x26 || state === 0x27) {
		if (time.dayTick > 2300) {
			entity.stateCode = 0x20;
		}
		return;
	}

	// --- Morning activation (0x20) ---
	if (state === 0x20) {
		// Weekday-only: calendar_phase_flag must be 0
		if (time.calendarPhaseFlag !== 0) return;
		// Needs operational pairing
		if (object.evalActiveFlag === 0) return;

		// Daypart gate: daypart 0 → 1/12 stagger; daypart 1–2 → dispatch; daypart ≥ 3 → dispatch
		if (time.daypartIndex === 0) {
			if (Math.random() * 12 >= 1) return;
		}

		// 3-day cashflow (first entity triggers income once per 3-day cycle)
		if (
			entity.baseOffset === 0 &&
			object.auxValueOrTimer !== time.dayCounter + 1 &&
			time.dayCounter % 3 === 0
		) {
			object.auxValueOrTimer = time.dayCounter + 1;
			add_cashflow_from_family_resource(
				ledger,
				"office",
				object.rentLevel,
				object.objectTypeCode,
			);
		}

		// Dispatch: route from lobby (floor 10) to office floor
		if (entity.floorAnchor !== 10) {
			entity.encodedRouteTarget = entity.floorAnchor;
			entity.selectedFloor = 10;
			entity.stateCode = 0x00;
		} else {
			// Office is on lobby floor — skip commute
			entity.stateCode = 0x21;
		}
		return;
	}

	// --- Commuting to office (0x00) — in transit, handled by carrier system ---
	if (state === 0x00) {
		// Waiting for carrier pickup / in transit; arrival handled by dispatch_entity_arrival
		return;
	}

	// --- At office, ready for venue visits (0x21) ---
	if (state === 0x21) {
		// Gate: daypart ≥ 4 → evening departure
		if (time.daypartIndex >= 4) {
			entity.stateCode = 0x05;
			entity.encodedRouteTarget = 10;
			entity.selectedFloor = entity.floorAnchor;
			return;
		}
		// Gate: daypart 3 → 1/12 chance; daypart < 3 → wait
		if (time.daypartIndex === 3) {
			if (Math.random() * 12 >= 1) return;
		} else if (time.daypartIndex < 3) {
			return;
		}

		// Dispatch: try to visit a commercial venue
		entity.stateCode = 0x01;
		return;
	}

	if (state === COMMERCIAL_DWELL_STATE) {
		finishCommercialVenueDwell(entity, time, 0x21);
		return;
	}

	// --- Venue selection (0x01) ---
	if (state === 0x01) {
		runOfficeServiceEvaluation(world, time, entity, object);
		// Gate: daypart ≥ 4 → evening departure
		if (time.daypartIndex >= 4) {
			entity.stateCode = 0x05;
			entity.encodedRouteTarget = 10;
			entity.selectedFloor = entity.floorAnchor;
			return;
		}

		dispatchCommercialVenueVisit(world, time, entity, {
			venueFamilies: COMMERCIAL_FAMILIES,
			returnState: 0x21,
			successStressDelta: 12,
			failureStressDelta: 8,
			unavailableState: 0x26,
		});
		return;
	}

	// --- In transit to venue (0x22) — arrival handled by dispatch_entity_arrival ---
	if (state === 0x22) {
		return;
	}

	// --- Evening departure (0x05) — in transit to lobby, handled by carrier system ---
	if (state === 0x05) {
		// Waiting for carrier pickup / in transit; arrival handled by dispatch_entity_arrival
		return;
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

	if (object.unitStatus >= 0x18) {
		if (hasViableRouteBetweenFloors(world, 10, entity.floorAnchor)) {
			object.unitStatus = time.daypartIndex < 4 ? 0 : 8;
			if (entity.baseOffset === 0) {
				add_cashflow_from_family_resource(
					ledger,
					"condo",
					object.rentLevel,
					object.objectTypeCode,
				);
			}
			for (const sibling of findSiblingEntities(world, entity)) {
				if (sibling.floorAnchor === 10) {
					sibling.stateCode = 0x01;
					continue;
				}
				sibling.encodedRouteTarget = sibling.floorAnchor;
				sibling.selectedFloor = 10;
				sibling.stateCode = 0x22;
			}
			object.needsRefreshFlag = 1;
			lowerStress(entity, 10);
		} else {
			raiseStress(entity, 24);
		}
		return;
	}

	if (entity.stateCode === 0x27) entity.stateCode = 0x01;
	if (finishCommercialVenueDwell(entity, time, 0x01)) return;
	if (entity.stateCode === 0x01) {
		dispatchCommercialVenueVisit(world, time, entity, {
			venueFamilies: CONDO_COMMERCIAL_FAMILIES,
			returnState: 0x01,
			successStressDelta: 10,
			failureStressDelta: 7,
		});
	} else if (entity.stateCode === 0x22) {
		finishCommercialVenueTrip(entity, 0x01);
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
			object.unitStatus === 0
		) {
			object.unitStatus = 0x18;
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
			entity.stateCode = object.unitStatus >= 0x18 ? 0x27 : 0x01;
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
				if (CATHEDRAL_FAMILIES.has(entity.familyCode)) {
					processCathedralEntity(world, time, entity);
				}
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
		entity.familyCode !== 9 &&
		!CATHEDRAL_FAMILIES.has(entity.familyCode)
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
	// Office commute: route from lobby (floor 10) to office floor
	if (entity.stateCode === 0x00 && entity.encodedRouteTarget >= 0) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: entity.encodedRouteTarget,
			directionFlag: entity.encodedRouteTarget > entity.selectedFloor ? 0 : 1,
		};
	}

	if (entity.stateCode === 0x04 || entity.stateCode === 0x05) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: 10,
			directionFlag: 1,
		};
	}

	if (entity.stateCode === 0x22 && entity.encodedRouteTarget >= 0) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: entity.encodedRouteTarget,
			directionFlag: entity.encodedRouteTarget > entity.selectedFloor ? 0 : 1,
		};
	}

	// Cathedral evaluation: outbound (state 0x60) routes to eval zone (floor 109)
	if (CATHEDRAL_FAMILIES.has(entity.familyCode) && entity.stateCode === 0x60) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: 109,
			directionFlag: 0,
		};
	}
	// Cathedral evaluation: return (state 0x45) routes to lobby (floor 10)
	if (CATHEDRAL_FAMILIES.has(entity.familyCode) && entity.stateCode === 0x45) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: 10,
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
	3, 4, 5, 6, 7, 9, 10, 0x0c,
]);
const CUSTOM_ROUTE_SELECTOR_FAMILIES = new Set<number>([
	0x0f, 0x12, 0x1d, 0x21, 0x24, 0x25, 0x26, 0x27, 0x28,
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
		// Per-stop transit delay: local stair branch = 16 ticks/floor,
		// express escalator branch = 35 ticks/floor.
		const segment = world.specialLinks[route.id];
		const isExpressBranch = segment ? (segment.flags & 1) !== 0 : false;
		const perStopDelay = isExpressBranch ? 35 : 16;
		entity.auxCounter = Math.abs(destinationFloor - sourceFloor) * perStopDelay;
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
		entity.stateCode === 0x00 ||
		entity.stateCode === 0x22 ||
		entity.stateCode === 0x04 ||
		entity.stateCode === 0x05
	);
}

function finalize_pending_route_leg(entity: EntityRecord): void {
	if (entity.routeMode !== ROUTE_MODE_SEGMENT) return;
	if (entity.routeSourceFloor === 0xff) return;
	if (entity.auxCounter > 0) {
		entity.auxCounter -= 1;
		return;
	}
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
			if (handleCommercialVenueArrival(entity, arrivalFloor, 0x01)) {
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
			// Arrived at office floor from morning commute (0x00)
			if (entity.stateCode === 0x00 && arrivalFloor === entity.floorAnchor) {
				entity.encodedRouteTarget = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x21;
				if (object)
					recomputeObjectOperationalStatus(world, time, entity, object);
				return;
			}
			// Arrived at venue floor from venue trip (0x22)
			if (handleCommercialVenueArrival(entity, arrivalFloor, 0x21)) {
				return;
			}
			// Arrived at lobby from evening departure (0x05)
			if (entity.stateCode === 0x05 && arrivalFloor === 10) {
				entity.encodedRouteTarget = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = 0x27;
			}
			return;
		case 9:
			handleCommercialVenueArrival(entity, arrivalFloor, 0x01);
			return;
		default:
			// Cathedral evaluation entities
			if (CATHEDRAL_FAMILIES.has(entity.familyCode)) {
				if (entity.stateCode === 0x60 && arrivalFloor === EVAL_ZONE_FLOOR) {
					entity.stateCode = 0x03;
					entity.encodedRouteTarget = -1;
					checkEvalCompletionAndAward(world, time, entity);
				} else if (entity.stateCode === 0x45 && arrivalFloor === LOBBY_FLOOR) {
					entity.stateCode = 0x27;
					entity.encodedRouteTarget = -1;
				}
			}
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
		// Entities already in-transit on a carrier or segment are active demand —
		// their pending routes must not be pruned.
		if (
			entity.routeMode === ROUTE_MODE_CARRIER ||
			entity.routeMode === ROUTE_MODE_SEGMENT
		) {
			activeDemandIds.add(entityKey(entity));
			continue;
		}
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
		if (entity.auxCounter > 0) {
			entity.auxCounter -= 1;
			continue;
		}
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
		if (object.objectTypeCode === 21 && object.unitStatus === 6) {
			object.unitStatus = 0;
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
		if (world.gateFlags.securityLedgerScale === 0) return;
		for (const object of Object.values(world.placedObjects)) {
			if (object.objectTypeCode === 20 || object.objectTypeCode === 21) {
				if (object.unitStatus === 5) continue;
				object.unitStatus = 0;
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

	const primaryTotal = ledger.populationLedger.reduce(
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
			if (!adequate && object.unitStatus === 5) continue;
			object.unitStatus = dutyTier;
			object.needsRefreshFlag = 1;
		}
	}
}

export function runOfficeServiceEvaluation(
	world: WorldState,
	time: TimeState,
	entity?: EntityRecord,
	object?: PlacedObjectRecord,
): void {
	if (time.starCount !== 3 || time.dayCounter % 9 !== 3) return;
	if (world.gateFlags.officeServiceOk !== 0) return;
	if (
		world.gateFlags.evalEntityIndex >= 0 &&
		world.gateFlags.evalEntityIndex !== 0xffff
	) {
		return;
	}
	if (!entity || !object) return;
	if (entity.familyCode !== 7 || entity.stateCode !== 0x01) return;
	if (object.evalLevel <= 0) return;
	world.gateFlags.officeServiceOk = 1;
}

export function refund_unhappy_condos(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode !== 9) continue;
		if (object.evalLevel !== 0) continue;
		if (object.unitStatus >= 0x18) continue;
		const tileName = "condo";
		const payout = YEN_1001[tileName]?.[Math.min(object.rentLevel, 3)] ?? 0;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - payout * 1000);
		object.unitStatus = 0x18;
		object.needsRefreshFlag = 1;
		const [x, y] = key.split(",").map(Number);
		for (const entity of world.entities) {
			if (entity.subtypeIndex === x && entity.floorAnchor === yToFloor(y)) {
				entity.stateCode = 0x27;
			}
		}
	}
}

// ─── Cathedral evaluation entities (families 0x24–0x28) ──────────────────────

const EVAL_ZONE_FLOOR = 109; // floor 0x6d
const LOBBY_FLOOR = 10;
const EVAL_ENTITY_COUNT = 40; // 5 floors × 8 slots

/**
 * Activate evaluation entities at day-start checkpoint (0x000).
 * Forces all cathedral entity slots into state 0x20 if cathedral is placed
 * and star > 2.
 */
export function activateEvalEntities(world: WorldState, time: TimeState): void {
	if (
		world.gateFlags.evalEntityIndex < 0 ||
		world.gateFlags.evalEntityIndex === 0xffff
	) {
		return;
	}
	if (time.starCount <= 2) return;

	for (const entity of world.entities) {
		if (!CATHEDRAL_FAMILIES.has(entity.familyCode)) continue;
		entity.stateCode = 0x20;
		entity.selectedFloor = LOBBY_FLOOR;
		entity.originFloor = entity.floorAnchor;
		clear_entity_route(entity);
		entity.encodedRouteTarget = -1;
		entity.auxState = 0;
	}
}

/**
 * Dispatch midday return for evaluation entities at checkpoint 0x4b0.
 * Entities in state 0x03 (arrived) are advanced to 0x05 (return).
 */
export function dispatchEvalMiddayReturn(world: WorldState): void {
	for (const entity of world.entities) {
		if (!CATHEDRAL_FAMILIES.has(entity.familyCode)) continue;
		if (entity.stateCode === 0x03) {
			entity.stateCode = 0x05;
			entity.selectedFloor = EVAL_ZONE_FLOOR;
			entity.encodedRouteTarget = LOBBY_FLOOR;
		}
	}
}

function processCathedralEntity(
	world: WorldState,
	time: TimeState,
	entity: EntityRecord,
): void {
	switch (entity.stateCode) {
		case 0x20: {
			// Gate: calendar_phase_flag must be 1
			if (time.calendarPhaseFlag !== 1) {
				if (time.daypartIndex >= 1) {
					entity.stateCode = 0x27; // missed dispatch window
				}
				return;
			}
			// Stagger: daypart 0 has probabilistic dispatch
			if (time.daypartIndex === 0) {
				if (time.dayTick <= 0x50) return;
				if (time.dayTick <= 0xf0) {
					// 1/12 chance per tick
					if (Math.floor(Math.random() * 12) !== 0) return;
				}
				// After tick 0xf0, guaranteed dispatch
			} else if (time.daypartIndex >= 1) {
				entity.stateCode = 0x27; // missed
				return;
			}

			// Dispatch: route from lobby to eval zone
			entity.selectedFloor = LOBBY_FLOOR;
			entity.encodedRouteTarget = EVAL_ZONE_FLOOR;
			const result = resolve_entity_route_between_floors(
				world,
				entity,
				LOBBY_FLOOR,
				EVAL_ZONE_FLOOR,
				0,
				time,
			);
			if (result === 3) {
				entity.stateCode = 0x03;
				checkEvalCompletionAndAward(world, time, entity);
			} else if (result >= 0) {
				entity.stateCode = 0x60; // in transit to eval zone
			} else {
				entity.stateCode = 0x27; // route failure → parked
			}
			return;
		}

		case 0x60:
			// In transit to eval zone; arrival handled by dispatch_entity_arrival
			return;

		case 0x03:
			// Arrived at eval zone; waiting for midday return dispatch
			return;

		case 0x05: {
			// Midday return: route from eval zone to lobby
			if (entity.routeMode !== ROUTE_MODE_NONE) return; // already routed
			entity.selectedFloor = EVAL_ZONE_FLOOR;
			entity.encodedRouteTarget = LOBBY_FLOOR;
			const returnResult = resolve_entity_route_between_floors(
				world,
				entity,
				EVAL_ZONE_FLOOR,
				LOBBY_FLOOR,
				1,
				time,
			);
			if (returnResult === 3) {
				entity.stateCode = 0x27;
			} else if (returnResult >= 0) {
				entity.stateCode = 0x45; // in transit back to lobby
			} else {
				entity.stateCode = 0x27;
			}
			return;
		}

		case 0x45:
			// In transit back to lobby; arrival handled by dispatch_entity_arrival
			return;

		case 0x27:
			// Parked; will be reset to 0x20 at next day-start
			return;

		default:
			return;
	}
}

function checkEvalCompletionAndAward(
	world: WorldState,
	time: TimeState,
	_arrivedEntity: EntityRecord,
): void {
	if (
		world.gateFlags.evalEntityIndex < 0 ||
		world.gateFlags.evalEntityIndex === 0xffff
	) {
		return;
	}
	if (time.dayTick >= 800) return;

	// Count entities in state 0x03 (arrived at eval zone)
	let arrivedCount = 0;
	for (const entity of world.entities) {
		if (!CATHEDRAL_FAMILIES.has(entity.familyCode)) continue;
		if (entity.stateCode === 0x03) arrivedCount++;
	}

	if (arrivedCount < EVAL_ENTITY_COUNT) {
		// Not all arrived yet — stamp the arrived entity's placed object
		const object = findObjectForEntity(world, _arrivedEntity);
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

// ─── Entertainment phase logic (families 0x12 / 0x1d) ────────────────────────

const ENTERTAINMENT_FAMILY_PAIRED = 0x12;
const ENTERTAINMENT_FAMILY_SINGLE = 0x1d;

/**
 * Paired-link budget tiers indexed by `linkAgeCounter / 3`.
 * Selectors 0..6 → [40, 40, 40, 20], selectors 7..13 → [60, 60, 40, 20].
 */
function pairedBudget(linkAgeCounter: number, selector: number): number {
	const ageTier = Math.min(3, Math.trunc(linkAgeCounter / 3));
	const lowSelectorTable = [40, 40, 40, 20];
	const highSelectorTable = [60, 60, 40, 20];
	const table =
		selector >= 0 && selector < 7 ? lowSelectorTable : highSelectorTable;
	return table[ageTier] ?? table[table.length - 1] ?? 20;
}

/**
 * Seed entertainment link budgets and increment link age.
 * Called as part of checkpoint 0x0f0 (facility ledger rebuild).
 */
export function seedEntertainmentBudgets(world: WorldState): void {
	for (const object of Object.values(world.placedObjects)) {
		if (
			object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED &&
			object.objectTypeCode !== ENTERTAINMENT_FAMILY_SINGLE
		)
			continue;
		if (object.linkedRecordIndex < 0) continue;
		const sidecar = world.sidecars[object.linkedRecordIndex];
		if (!sidecar || sidecar.kind !== "entertainment_link") continue;

		sidecar.attendanceCounter = 0;
		sidecar.activeRuntimeCount = 0;
		sidecar.linkPhaseState = 0;
		sidecar.pendingTransitionFlag = 0;
		sidecar.linkAgeCounter = Math.min(0x7f, sidecar.linkAgeCounter + 1);

		if (object.objectTypeCode === ENTERTAINMENT_FAMILY_PAIRED) {
			const budget = pairedBudget(
				sidecar.linkAgeCounter,
				sidecar.familySelectorOrSingleLinkFlag,
			);
			sidecar.forwardBudget = budget;
			sidecar.reverseBudget = budget;
		} else {
			sidecar.forwardBudget = 0;
			sidecar.reverseBudget = 50;
		}
	}
}

/**
 * Activate paired-link forward-half entities (checkpoint 0x3e8).
 * Sets forwardPhase to 1 for all paired entertainment links that are idle.
 */
export function activateEntertainmentForwardHalf(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object || object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED)
			continue;
		if (sidecar.linkPhaseState === 0) {
			sidecar.linkPhaseState = 1;
		}
	}
}

/**
 * Promote paired links to ready phase; activate single-link reverse-half
 * (checkpoint 0x4b0).
 */
export function promoteAndActivateSingleReverse(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object) continue;

		if (object.objectTypeCode === ENTERTAINMENT_FAMILY_PAIRED) {
			if (sidecar.linkPhaseState === 2) {
				sidecar.linkPhaseState = 3;
			}
		} else if (object.objectTypeCode === ENTERTAINMENT_FAMILY_SINGLE) {
			if (sidecar.linkPhaseState === 0) {
				sidecar.linkPhaseState = 1;
			}
		}
	}
}

/**
 * Activate paired-link reverse-half entities still in phase 1 (checkpoint 0x578).
 */
export function activateEntertainmentReverseHalf(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object || object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED)
			continue;
		if (sidecar.linkPhaseState === 1) {
			sidecar.linkPhaseState = 2;
		}
	}
}

/**
 * Movie-theater (paired) attendance-tiered payout.
 */
function movieTheaterPayout(attendance: number): number {
	if (attendance >= 100) return 15_000;
	if (attendance >= 80) return 10_000;
	if (attendance >= 40) return 2_000;
	return 0;
}

/**
 * Advance paired-link forward phase (checkpoint 0x5dc).
 * Decrements active runtime count and accrues income for completed forward phases.
 */
export function advanceEntertainmentForwardPhase(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object || object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED)
			continue;
		if (sidecar.linkPhaseState < 1) continue;

		sidecar.activeRuntimeCount = Math.max(
			0,
			sidecar.activeRuntimeCount - sidecar.forwardBudget,
		);
		sidecar.linkPhaseState = sidecar.activeRuntimeCount === 0 ? 1 : 2;

		// Park forward-half entities for this entertainment record
		for (const entity of world.entities) {
			if (entity.familyCode !== ENTERTAINMENT_FAMILY_PAIRED) continue;
			if (entity.subtypeIndex !== sidecar.ownerSubtypeIndex) continue;
			if (entity.stateCode >= 0x01 && entity.stateCode <= 0x03) {
				entity.stateCode = 0x27; // park
			}
		}
	}
}

/**
 * Advance reverse phase for both families, accrue cash income, reset phases
 * (checkpoint 0x640).
 */
export function advanceEntertainmentReversePhaseAndAccrue(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object) continue;

		if (object.objectTypeCode === ENTERTAINMENT_FAMILY_PAIRED) {
			if (sidecar.linkPhaseState >= 1) {
				sidecar.activeRuntimeCount = Math.max(
					0,
					sidecar.activeRuntimeCount - sidecar.reverseBudget,
				);
				const payout = movieTheaterPayout(sidecar.attendanceCounter);
				if (payout > 0) {
					ledger.cashBalance = Math.min(
						99_999_999,
						ledger.cashBalance + payout,
					);
					ledger.incomeLedger[ENTERTAINMENT_FAMILY_PAIRED] =
						(ledger.incomeLedger[ENTERTAINMENT_FAMILY_PAIRED] ?? 0) + payout;
				}
			}
		} else if (object.objectTypeCode === ENTERTAINMENT_FAMILY_SINGLE) {
			if (sidecar.linkPhaseState >= 1) {
				sidecar.activeRuntimeCount = Math.max(
					0,
					sidecar.activeRuntimeCount - sidecar.reverseBudget,
				);
				if (sidecar.attendanceCounter > 0) {
					const payout = 20_000;
					ledger.cashBalance = Math.min(
						99_999_999,
						ledger.cashBalance + payout,
					);
					ledger.incomeLedger[ENTERTAINMENT_FAMILY_SINGLE] =
						(ledger.incomeLedger[ENTERTAINMENT_FAMILY_SINGLE] ?? 0) + payout;
				}
			}
		}

		// Reset phases
		sidecar.linkPhaseState = 0;

		// Park all entertainment entities for this record
		for (const entity of world.entities) {
			if (
				entity.familyCode !== object.objectTypeCode ||
				entity.subtypeIndex !== sidecar.ownerSubtypeIndex
			)
				continue;
			if (entity.stateCode !== 0x27) {
				entity.stateCode = 0x27;
			}
		}
	}
}

function findObjectBySidecarOwner(
	world: WorldState,
	sidecar: { ownerSubtypeIndex: number },
): PlacedObjectRecord | undefined {
	for (const object of Object.values(world.placedObjects)) {
		if (
			object.linkedRecordIndex >= 0 &&
			world.sidecars[object.linkedRecordIndex] === sidecar
		) {
			return object;
		}
	}
	return undefined;
}

function entityStressLevel(
	entity: EntityRecord,
	object: PlacedObjectRecord | undefined,
): "low" | "medium" | "high" {
	if (object?.evalLevel === 0 || entity.accumulatedDelay >= 120) {
		return "high";
	}
	if (object?.evalLevel === 1 || entity.accumulatedDelay >= 40) {
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
			const carrierRoute = world.carriers.find((carrier) =>
				carrier.pendingRoutes.some(
					(route) => route.entityId === entityKey(entity),
				),
			);
			const pendingRoute = carrierRoute?.pendingRoutes.find(
				(route) => route.entityId === entityKey(entity),
			);
			const carrierId =
				pendingRoute || entity.routeMode === ROUTE_MODE_CARRIER
					? (carrierRoute?.carrierId ??
						(entity.routeCarrierOrSegment >= 0x58
							? entity.routeCarrierOrSegment - 0x58
							: entity.routeCarrierOrSegment >= 0x40
								? entity.routeCarrierOrSegment - 0x40
								: null))
					: null;

			return {
				id: entityKey(entity),
				floorAnchor: entity.floorAnchor,
				selectedFloor: entity.selectedFloor,
				subtypeIndex: entity.subtypeIndex,
				baseOffset: entity.baseOffset,
				familyCode: entity.familyCode,
				stateCode: entity.stateCode,
				routeMode: entity.routeMode,
				carrierId,
				assignedCarIndex: pendingRoute?.assignedCarIndex ?? -1,
				boardedOnCarrier: pendingRoute?.boarded ?? false,
				stressLevel: entityStressLevel(entity, object),
			} satisfies EntityStateRecord;
		})
		.filter((entity): entity is EntityStateRecord => entity !== null);
}
