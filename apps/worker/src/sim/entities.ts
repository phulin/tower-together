import { enqueueCarrierRoute } from "./carriers";
import {
	checkEvalCompletionAndAward,
	processCathedralEntity,
} from "./cathedral";
import {
	addCashflowFromFamilyResource,
	type LedgerState,
	removeCashflowFromFamilyResource,
} from "./ledger";
import {
	FAMILY_CINEMA,
	FAMILY_CONDO,
	FAMILY_ENTERTAINMENT,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_PARKING,
	FAMILY_RECYCLING_CENTER_LOWER,
	FAMILY_RECYCLING_CENTER_UPPER,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
	OP_SCORE_THRESHOLDS,
} from "./resources";
import { type RouteCandidate, selectBestRouteCandidate } from "./routing";
import type { TimeState } from "./time";
import {
	type CommercialVenueRecord,
	type EntityRecord,
	GRID_HEIGHT,
	type PlacedObjectRecord,
	type RouteState,
	type ServiceRequestEntry,
	VENUE_CLOSED,
	VENUE_PARTIAL,
	type WorldState,
	yToFloor,
} from "./world";

// ─── Floor constants ─────────────────────────────────────────────────────────

/** Internal floor-slot index for the lobby (world floor 0 + UNDERGROUND_FLOORS). */
export const LOBBY_FLOOR = 10;
export const EVAL_ZONE_FLOOR = 109; // floor 0x6d

// ─── Entity state codes (from spec state machines) ──────────────────────────

const STATE_COMMUTE = 0x00; // commuting to destination
export const STATE_ACTIVE = 0x01; // active / in-stay / venue selection
export const STATE_ARRIVED = 0x03; // arrived at destination
const STATE_CHECKOUT_QUEUE = 0x04; // hotel checkout queue (non-last sibling)
export const STATE_DEPARTURE = 0x05; // departing / returning
const STATE_TRANSITION = 0x10; // unit status transition (hotel checking out)
export const STATE_MORNING_GATE = 0x20; // morning activation gate
const STATE_AT_WORK = 0x21; // at work (office, post-commute)
const STATE_VENUE_TRIP = 0x22; // commercial venue trip in transit
const STATE_HOTEL_PARKED = 0x24; // hotel parked (awaiting guest)
const STATE_NIGHT_A = 0x25; // night park variant A
const STATE_NIGHT_B = 0x26; // night park / venue unavailable
export const STATE_PARKED = 0x27; // parked / idle
export const STATE_EVAL_RETURN = 0x45; // cathedral eval return transit
export const STATE_EVAL_OUTBOUND = 0x60; // cathedral eval outbound transit

// ─── Unit status thresholds ─────────────────────────────────────────────────

const UNIT_STATUS_OFFICE_OCCUPIED = 0x0f;
const UNIT_STATUS_CONDO_OCCUPIED = 0x17;
const UNIT_STATUS_CONDO_VACANT = 0x18;
const UNIT_STATUS_CONDO_VACANT_EVENING = 0x20;
const UNIT_STATUS_HOTEL_CHECKOUT = 0x28;
const UNIT_STATUS_HOTEL_SOLD_OUT = 0x37;

// ─── Route helpers ──────────────────────────────────────────────────────────

const ROUTE_IDLE: RouteState = { mode: "idle" };

// ─── Sentinel values ────────────────────────────────────────────────────────

export const NO_EVAL_ENTITY = 0xffff;

// ─── Misc tuning constants ──────────────────────────────────────────────────

const SCORING_DIVISOR = 4096;
const ENTITY_REFRESH_STRIDE = 16;
const ACTIVATION_TICK_CAP = 0x78;

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
	[FAMILY_HOTEL_SINGLE]: 1,
	[FAMILY_HOTEL_TWIN]: 2,
	[FAMILY_HOTEL_SUITE]: 3,
	[FAMILY_OFFICE]: 6,
	[FAMILY_CONDO]: 3,
	// Cathedral evaluation entities: 5 floor types × 8 slots = 40 visitors
	36: 8, // 0x24
	37: 8, // 0x25
	38: 8, // 0x26
	39: 8, // 0x27
	40: 8, // 0x28
};

const HOTEL_FAMILIES = new Set([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
]);
/** Families whose placed objects carry an evaluation score (rentable occupancy). */
const EVALUATABLE_FAMILIES = new Set([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_OFFICE,
	FAMILY_CONDO,
]);
const COMMERCIAL_FAMILIES = new Set([
	FAMILY_RESTAURANT,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
]);
export const CATHEDRAL_FAMILIES = new Set([0x24, 0x25, 0x26, 0x27, 0x28]);
const ELEVATOR_DEMAND_STATES = new Set([
	STATE_COMMUTE,
	STATE_ACTIVE,
	STATE_CHECKOUT_QUEUE,
	STATE_DEPARTURE,
	STATE_VENUE_TRIP,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
]);
// Sentinel used by carrier car slot cleanup and unset cathedral owner indices.
const INVALID_FLOOR = 0xff;
const COMMERCIAL_VENUE_DWELL_TICKS = 60;
const COMMERCIAL_DWELL_STATE = 0x62;
const CONDO_SELECTOR_RESTAURANT = new Set([FAMILY_RESTAURANT]);
const CONDO_SELECTOR_FAST_FOOD = new Set([FAMILY_FAST_FOOD]);

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
		route: ROUTE_IDLE,
		selectedFloor: floorAnchor,
		originFloor: floorAnchor,
		destinationFloor: -1,
		venueReturnState: 0,
		queueTick: 0,
		stressCounter: 0,
		routeRetryDelay: 0,
		transitTicksRemaining: 0,
		lastDemandTick: 0,
		demandSampleCount: 0,
		demandAccumulator: 0,
		visitCounter: 0,
	};
}

function initialStateForFamily(familyCode: number): number {
	if (HOTEL_FAMILIES.has(familyCode)) return STATE_HOTEL_PARKED;
	if (CATHEDRAL_FAMILIES.has(familyCode)) return STATE_PARKED; // activated at day-start
	if (familyCode === FAMILY_OFFICE) return STATE_MORNING_GATE; // allows same-day commute
	return STATE_PARKED;
}

function entityKey(entity: EntityRecord): string {
	return `${entity.floorAnchor}:${entity.subtypeIndex}:${entity.familyCode}:${entity.baseOffset}`;
}

function objectKey(entity: EntityRecord): string {
	const y = GRID_HEIGHT - 1 - entity.floorAnchor;
	return `${entity.subtypeIndex},${y}`;
}

export function findObjectForEntity(
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
		selectBestRouteCandidate(world, fromFloor, toFloor) !== null
	);
}

function supportsFamily(
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
	if (!EVALUATABLE_FAMILIES.has(object.objectTypeCode)) return;

	if (
		HOTEL_FAMILIES.has(object.objectTypeCode) &&
		object.unitStatus > UNIT_STATUS_HOTEL_SOLD_OUT
	) {
		object.evalLevel = 0xff;
		object.needsRefreshFlag = 1;
		return;
	}
	if (
		object.objectTypeCode === FAMILY_OFFICE &&
		object.unitStatus > UNIT_STATUS_OFFICE_OCCUPIED &&
		object.evalActiveFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.needsRefreshFlag = 1;
		return;
	}
	if (
		object.objectTypeCode === FAMILY_CONDO &&
		object.unitStatus > UNIT_STATUS_CONDO_OCCUPIED &&
		object.evalActiveFlag !== 0
	) {
		object.evalLevel = 0xff;
		object.needsRefreshFlag = 1;
		return;
	}

	const siblings = findSiblingEntities(world, entity);
	const sampleTotal = siblings.reduce(
		(sum, sibling) => sum + sibling.visitCounter,
		0,
	);
	const sampleDivisor =
		object.objectTypeCode === FAMILY_HOTEL_SINGLE
			? 1
			: object.objectTypeCode === FAMILY_HOTEL_TWIN
				? 2
				: object.objectTypeCode === FAMILY_HOTEL_SUITE
					? 2
					: object.objectTypeCode === FAMILY_OFFICE
						? 6
						: 3;
	let score = Math.trunc(
		SCORING_DIVISOR / Math.max(1, Math.trunc(sampleTotal / sampleDivisor)),
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
		object.objectTypeCode === FAMILY_OFFICE
			? 10
			: object.objectTypeCode === FAMILY_CONDO
				? 30
				: 20;
	if (hasNearbySupport(world, object, entity.floorAnchor, supportRadius)) {
		score += 60;
	}

	const [lower, upper] = OP_SCORE_THRESHOLDS[Math.min(time.starCount, 5)] ?? [
		80, 200,
	];
	object.evalLevel = score < lower ? 2 : score < upper ? 1 : 0;
	if (object.objectTypeCode === FAMILY_OFFICE) {
		if (object.evalLevel >= 1) {
			object.evalActiveFlag = 1;
		} else {
			object.evalActiveFlag = 0;
			attemptPairingWithFloorNeighbor(world, entity, object);
		}
	} else if (object.evalActiveFlag === 0 && object.evalLevel > 0) {
		object.evalActiveFlag = 1;
	}
	object.needsRefreshFlag = 1;
}

function attemptPairingWithFloorNeighbor(
	world: WorldState,
	entity: EntityRecord,
	object: PlacedObjectRecord,
): void {
	const y = GRID_HEIGHT - 1 - entity.floorAnchor;
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
		if (record.availabilityState === VENUE_CLOSED) continue;
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
	entity.lastDemandTick = time.dayTick;
	entity.demandSampleCount = Math.min(300, entity.demandSampleCount + 1);
	entity.demandAccumulator += entity.demandSampleCount;
	entity.visitCounter = Math.min(255, entity.visitCounter + 1);
}

function reserveVenue(record: CommercialVenueRecord): void {
	record.todayVisitCount += 1;
	record.visitCount = record.todayVisitCount;
}

function raiseStress(entity: EntityRecord, amount = 20): void {
	entity.stressCounter = Math.min(255, entity.stressCounter + amount);
}

function lowerStress(entity: EntityRecord, amount = 12): void {
	entity.stressCounter = Math.max(0, entity.stressCounter - amount);
}

function beginCommercialVenueDwell(
	entity: EntityRecord,
	arrivalFloor: number,
	returnState: number,
): void {
	entity.destinationFloor = -1;
	entity.selectedFloor = arrivalFloor;
	clearEntityRoute(entity);
	entity.venueReturnState = returnState;
	entity.stateCode = COMMERCIAL_DWELL_STATE;
}

function beginCommercialVenueTrip(
	entity: EntityRecord,
	destinationFloor: number,
): void {
	entity.destinationFloor = destinationFloor;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = STATE_VENUE_TRIP;
}

function finishCommercialVenueDwell(
	entity: EntityRecord,
	time: TimeState,
	defaultState: number,
): boolean {
	if (entity.stateCode !== COMMERCIAL_DWELL_STATE) return false;
	if (time.dayTick - entity.lastDemandTick < COMMERCIAL_VENUE_DWELL_TICKS)
		return true;
	entity.selectedFloor = entity.floorAnchor;
	entity.stateCode = entity.venueReturnState || defaultState;
	entity.venueReturnState = 0;
	return true;
}

function finishCommercialVenueTrip(
	entity: EntityRecord,
	returnState: number,
): boolean {
	if (entity.stateCode !== STATE_VENUE_TRIP) return false;
	if (entity.selectedFloor !== entity.destinationFloor) return true;
	entity.destinationFloor = -1;
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
	if (
		entity.stateCode !== STATE_VENUE_TRIP ||
		entity.destinationFloor !== arrivalFloor
	) {
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
	if (!hasViableRouteBetweenFloors(world, LOBBY_FLOOR, entity.floorAnchor)) {
		raiseStress(entity, 30);
		return;
	}
	entity.stateCode = STATE_ACTIVE;
	entity.originFloor = LOBBY_FLOOR;
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
		entity.stateCode = STATE_CHECKOUT_QUEUE;
		return;
	}

	const tileName =
		object.objectTypeCode === FAMILY_HOTEL_SINGLE
			? "hotelSingle"
			: object.objectTypeCode === FAMILY_HOTEL_TWIN
				? "hotelTwin"
				: "hotelSuite";
	addCashflowFromFamilyResource(
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
	} else {
		world.gateFlags.newspaperTrigger = 0;
	}
	for (const sibling of siblings) sibling.stateCode = STATE_HOTEL_PARKED;
	object.unitStatus = UNIT_STATUS_HOTEL_CHECKOUT;
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
		case STATE_HOTEL_PARKED:
			activateHotelStay(world, entity, time);
			return;
		case STATE_ACTIVE: {
			if (time.daypartIndex >= 4) {
				if (object.unitStatus === 0 || object.unitStatus === 8) {
					object.unitStatus = STATE_TRANSITION;
				}
				entity.destinationFloor = LOBBY_FLOOR;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_DEPARTURE;
				return;
			}
			// Hotel suite parking demand: eligible when occupied (unitStatus != 0)
			if (
				entity.familyCode === FAMILY_HOTEL_SUITE &&
				time.starCount > 2 &&
				object.unitStatus !== 0
			) {
				tryAssignParkingService(world, time, entity);
			}
			dispatchCommercialVenueVisit(world, time, entity, {
				venueFamilies: COMMERCIAL_FAMILIES,
				returnState: STATE_ACTIVE,
				successStressDelta: 16,
				failureStressDelta: 8,
				onVenueReserved: () => {
					object.activationTickCount = Math.min(
						ACTIVATION_TICK_CAP,
						object.activationTickCount + 1,
					);
				},
			});
			return;
		}
		case STATE_VENUE_TRIP:
			finishCommercialVenueTrip(entity, STATE_ACTIVE);
			return;
		case STATE_DEPARTURE:
		case STATE_CHECKOUT_QUEUE:
			if (entity.selectedFloor !== LOBBY_FLOOR) return;
			if (object.unitStatus === 0 || object.unitStatus === 8) {
				object.unitStatus = STATE_TRANSITION;
				object.needsRefreshFlag = 1;
				return;
			}
			if (object.unitStatus === STATE_TRANSITION) {
				object.unitStatus =
					object.objectTypeCode === FAMILY_HOTEL_SINGLE ? 1 : 2;
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
			finishCommercialVenueDwell(entity, time, STATE_ACTIVE);
			return;
		default:
			entity.stateCode = STATE_HOTEL_PARKED;
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

	// --- Night / failure park states ---
	// Gate: day_tick > 2300 → transition to morning activation
	if (
		state === STATE_NIGHT_A ||
		state === STATE_NIGHT_B ||
		state === STATE_PARKED
	) {
		if (time.dayTick > 2300) {
			entity.stateCode = STATE_MORNING_GATE;
		}
		return;
	}

	// --- Morning activation ---
	if (state === STATE_MORNING_GATE) {
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
			addCashflowFromFamilyResource(
				ledger,
				"office",
				object.rentLevel,
				object.objectTypeCode,
			);
		}

		// Office parking demand: (floorAnchor + subtypeIndex) % 4 === 1, unitStatus === 2
		if (
			time.starCount > 2 &&
			(entity.floorAnchor + entity.subtypeIndex) % 4 === 1 &&
			object.unitStatus === 2
		) {
			if (!tryAssignParkingService(world, time, entity)) {
				world.pendingNotifications.push({
					kind: "route_failure",
					message: "Office workers demand Parking",
				});
			}
		}

		// Dispatch: route from lobby to office floor
		if (entity.floorAnchor !== LOBBY_FLOOR) {
			entity.destinationFloor = entity.floorAnchor;
			entity.selectedFloor = LOBBY_FLOOR;
			entity.stateCode = STATE_COMMUTE;
		} else {
			// Office is on lobby floor — skip commute
			entity.stateCode = STATE_AT_WORK;
		}
		return;
	}

	// --- Commuting to office — in transit, handled by carrier system ---
	if (state === STATE_COMMUTE) {
		// Waiting for carrier pickup / in transit; arrival handled by dispatchEntityArrival
		return;
	}

	// --- At office, ready for venue visits ---
	if (state === STATE_AT_WORK) {
		// Gate: daypart ≥ 4 → evening departure
		if (time.daypartIndex >= 4) {
			entity.stateCode = STATE_DEPARTURE;
			entity.destinationFloor = LOBBY_FLOOR;
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
		entity.stateCode = STATE_ACTIVE;
		return;
	}

	if (state === COMMERCIAL_DWELL_STATE) {
		finishCommercialVenueDwell(entity, time, STATE_AT_WORK);
		return;
	}

	// --- Venue selection ---
	if (state === STATE_ACTIVE) {
		runOfficeServiceEvaluation(world, time, entity, object);
		// Gate: daypart ≥ 4 → evening departure
		if (time.daypartIndex >= 4) {
			entity.stateCode = STATE_DEPARTURE;
			entity.destinationFloor = LOBBY_FLOOR;
			entity.selectedFloor = entity.floorAnchor;
			return;
		}

		dispatchCommercialVenueVisit(world, time, entity, {
			venueFamilies: COMMERCIAL_FAMILIES,
			returnState: STATE_AT_WORK,
			successStressDelta: 12,
			failureStressDelta: 8,
			unavailableState: STATE_NIGHT_B,
		});
		return;
	}

	// --- In transit to venue — arrival handled by dispatchEntityArrival ---
	if (state === STATE_VENUE_TRIP) {
		return;
	}

	// --- Evening departure — in transit to lobby, handled by carrier system ---
	if (state === STATE_DEPARTURE) {
		// Waiting for carrier pickup / in transit; arrival handled by dispatchEntityArrival
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

	if (entity.stateCode === STATE_PARKED) entity.stateCode = STATE_ACTIVE;
	if (finishCommercialVenueDwell(entity, time, STATE_ACTIVE)) return;
	if (entity.stateCode === STATE_ACTIVE) {
		dispatchCommercialVenueVisit(world, time, entity, {
			venueFamilies:
				entity.baseOffset % 4 === 0
					? CONDO_SELECTOR_RESTAURANT
					: CONDO_SELECTOR_FAST_FOOD,
			returnState: STATE_ACTIVE,
			successStressDelta: 10,
			failureStressDelta: 7,
			onVenueReserved: () => {
				if (object.unitStatus < UNIT_STATUS_CONDO_VACANT) return;
				object.unitStatus = time.daypartIndex < 4 ? 0x08 : 0x00;
				object.needsRefreshFlag = 1;
				if (entity.baseOffset !== 0) return;
				addCashflowFromFamilyResource(
					ledger,
					"condo",
					object.rentLevel,
					object.objectTypeCode,
				);
			},
		});
	} else if (entity.stateCode === STATE_VENUE_TRIP) {
		finishCommercialVenueTrip(entity, STATE_ACTIVE);
	}

	recomputeObjectOperationalStatus(world, time, entity, object);
}

export function rebuildRuntimeEntities(world: WorldState): void {
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
			object.objectTypeCode === FAMILY_CONDO &&
			object.activationTickCount === 0 &&
			object.unitStatus === 0
		) {
			object.unitStatus = UNIT_STATUS_CONDO_VACANT;
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

export function cleanupEntitiesForRemovedTile(
	world: WorldState,
	anchorX: number,
	y: number,
): void {
	const floorAnchor = yToFloor(y);
	const removedIds = new Set<string>();

	for (const entity of world.entities) {
		if (entity.subtypeIndex !== anchorX || entity.floorAnchor !== floorAnchor) {
			continue;
		}
		clearEntityRoute(entity);
		entity.destinationFloor = -1;
		removedIds.add(entityKey(entity));
	}

	if (removedIds.size === 0) return;

	for (const carrier of world.carriers) {
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(route) => !removedIds.has(route.entityId),
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
}

// ─── Parking demand ──────────────────────────────────────────────────────────

export function rebuildParkingDemandLog(world: WorldState): void {
	world.parkingDemandLog = [];
	for (let i = 0; i < world.sidecars.length; i++) {
		const rec = world.sidecars[i];
		if (rec.kind !== "service_request") continue;
		if (rec.ownerSubtypeIndex === 0xff) continue;
		if (rec.floorIndex === undefined) continue;
		if (rec.coverageFlag === 1) continue;
		// Verify the owning object is still a parking space
		let isParking = false;
		for (const obj of Object.values(world.placedObjects)) {
			if (
				obj.objectTypeCode === FAMILY_PARKING &&
				obj.linkedRecordIndex === i
			) {
				isParking = true;
				break;
			}
		}
		if (isParking) {
			world.parkingDemandLog.push(i);
		}
	}
}

function tryAssignParkingService(
	world: WorldState,
	time: TimeState,
	entity: EntityRecord,
): boolean {
	if (world.parkingDemandLog.length === 0) return false;
	const idx =
		world.parkingDemandLog[
			Math.floor(Math.random() * world.parkingDemandLog.length)
		];
	const rec = world.sidecars[idx] as ServiceRequestEntry | undefined;
	if (!rec || rec.kind !== "service_request") return false;
	recordDemandSample(entity, time);
	return true;
}

export function resetEntityRuntimeState(world: WorldState): void {
	for (const entity of world.entities) {
		const object = findObjectForEntity(world, entity);
		if (!object) continue;

		if (HOTEL_FAMILIES.has(entity.familyCode)) {
			entity.stateCode = STATE_HOTEL_PARKED;
		} else if (entity.familyCode === FAMILY_CONDO) {
			entity.stateCode =
				object.unitStatus >= UNIT_STATUS_CONDO_VACANT
					? STATE_PARKED
					: STATE_ACTIVE;
		} else {
			entity.stateCode = STATE_PARKED;
		}

		entity.selectedFloor = entity.floorAnchor;
		entity.originFloor = entity.floorAnchor;
		entity.route = ROUTE_IDLE;
		entity.destinationFloor = -1;
		entity.venueReturnState = 0;
		entity.queueTick = 0;
		entity.stressCounter = 0;
		entity.transitTicksRemaining = 0;
	}
}

export function advanceEntityRefreshStride(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	if (world.entities.length === 0) return;

	const stride = time.dayTick % ENTITY_REFRESH_STRIDE;
	for (let index = 0; index < world.entities.length; index++) {
		if (index % ENTITY_REFRESH_STRIDE !== stride) continue;
		const entity = world.entities[index];
		finalizePendingRouteLeg(entity);
		switch (entity.familyCode) {
			case FAMILY_HOTEL_SINGLE:
			case FAMILY_HOTEL_TWIN:
			case FAMILY_HOTEL_SUITE:
				processHotelEntity(world, ledger, time, entity);
				break;
			case FAMILY_OFFICE:
				processOfficeEntity(world, ledger, time, entity);
				break;
			case FAMILY_CONDO:
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
	if (entity.route.mode !== "idle") return false;
	if (!ELEVATOR_DEMAND_STATES.has(entity.stateCode)) return false;
	if (
		!EVALUATABLE_FAMILIES.has(entity.familyCode) &&
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
	// Office commute: route from lobby to office floor
	if (entity.stateCode === STATE_COMMUTE && entity.destinationFloor >= 0) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: entity.destinationFloor,
			directionFlag: entity.destinationFloor > entity.selectedFloor ? 0 : 1,
		};
	}

	if (
		entity.stateCode === STATE_CHECKOUT_QUEUE ||
		entity.stateCode === STATE_DEPARTURE
	) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: LOBBY_FLOOR,
			directionFlag: 1,
		};
	}

	if (entity.stateCode === STATE_VENUE_TRIP && entity.destinationFloor >= 0) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: entity.destinationFloor,
			directionFlag: entity.destinationFloor > entity.selectedFloor ? 0 : 1,
		};
	}

	// Cathedral evaluation: outbound routes to eval zone
	if (
		CATHEDRAL_FAMILIES.has(entity.familyCode) &&
		entity.stateCode === STATE_EVAL_OUTBOUND
	) {
		return {
			sourceFloor: entity.selectedFloor,
			destinationFloor: EVAL_ZONE_FLOOR,
			directionFlag: 0,
		};
	}
	// Cathedral evaluation: return routes to lobby
	if (
		CATHEDRAL_FAMILIES.has(entity.familyCode) &&
		entity.stateCode === STATE_EVAL_RETURN
	) {
		return {
			sourceFloor: entity.selectedFloor,
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
 * Return codes mirror `resolveEntityRouteBetweenFloors` from
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

export function resolveEntityRouteBetweenFloors(
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

	// Always prefer Escalator-branch (local) routing for now; the original
	// game used a per-object flag to switch to express mode, but the exact
	// semantics remain unresolved so we hard-code the local-mode branch.
	const preferLocalMode = true;

	const route = selectRouteForFamily(
		world,
		entity.familyCode,
		sourceFloor,
		destinationFloor,
		preferLocalMode,
	);
	if (!route) {
		clearEntityRoute(entity);
		entity.routeRetryDelay = 300;
		return -1;
	}

	if (route.kind === "segment") {
		entity.route = {
			mode: "segment",
			segmentId: route.id,
			destination: destinationFloor,
		};
		entity.queueTick = time?.dayTick ?? entity.queueTick;
		entity.destinationFloor = destinationFloor;
		// Per-stop transit delay: Escalator branch = 16 ticks/floor,
		// Stairs branch = 35 ticks/floor.
		const segment = world.specialLinks[route.id];
		const isStairsBranch = segment ? (segment.flags & 1) !== 0 : false;
		const perStopDelay = isStairsBranch ? 35 : 16;
		entity.transitTicksRemaining =
			Math.abs(destinationFloor - sourceFloor) * perStopDelay;
		return 1;
	}

	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === route.id,
	);
	if (!carrier) {
		clearEntityRoute(entity);
		return -1;
	}

	const queued = enqueueCarrierRoute(
		carrier,
		entityKey(entity),
		sourceFloor,
		destinationFloor,
		directionFlag,
	);
	if (!queued) {
		// Queue full: entity remains parked here and retries after a short delay.
		entity.route = { mode: "queued", source: sourceFloor };
		entity.destinationFloor = destinationFloor;
		entity.routeRetryDelay = 5;
		return 0;
	}

	entity.route = {
		mode: "carrier",
		carrierId: route.id,
		direction: directionFlag === 0 ? "up" : "down",
		source: sourceFloor,
	};
	entity.queueTick = time?.dayTick ?? entity.queueTick;
	entity.destinationFloor = destinationFloor;
	return 2;
}

export function clearEntityRoute(entity: EntityRecord): void {
	entity.route = ROUTE_IDLE;
}

function shouldFinalizeSegmentTrip(entity: EntityRecord): boolean {
	return (
		entity.stateCode === STATE_COMMUTE ||
		entity.stateCode === STATE_VENUE_TRIP ||
		entity.stateCode === STATE_CHECKOUT_QUEUE ||
		entity.stateCode === STATE_DEPARTURE
	);
}

function finalizePendingRouteLeg(entity: EntityRecord): void {
	if (entity.route.mode !== "segment") return;
	if (entity.transitTicksRemaining > 0) {
		entity.transitTicksRemaining -= 1;
		return;
	}
	entity.selectedFloor = entity.route.destination;
	clearEntityRoute(entity);
}

function dispatchEntityArrival(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	entity: EntityRecord,
	arrivalFloor: number,
): void {
	entity.selectedFloor = arrivalFloor;
	clearEntityRoute(entity);

	const object = findObjectForEntity(world, entity);
	switch (entity.familyCode) {
		case FAMILY_HOTEL_SINGLE:
		case FAMILY_HOTEL_TWIN:
		case FAMILY_HOTEL_SUITE:
			if (handleCommercialVenueArrival(entity, arrivalFloor, STATE_ACTIVE)) {
				return;
			}
			if (
				(entity.stateCode === STATE_CHECKOUT_QUEUE ||
					entity.stateCode === STATE_DEPARTURE) &&
				arrivalFloor === LOBBY_FLOOR
			) {
				entity.destinationFloor = -1;
				if (object) checkoutHotelStay(world, ledger, entity, object);
			}
			return;
		case FAMILY_OFFICE:
			// Arrived at office floor from morning commute
			if (
				entity.stateCode === STATE_COMMUTE &&
				arrivalFloor === entity.floorAnchor
			) {
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_AT_WORK;
				if (object)
					recomputeObjectOperationalStatus(world, time, entity, object);
				return;
			}
			// Arrived at venue floor from venue trip
			if (handleCommercialVenueArrival(entity, arrivalFloor, STATE_AT_WORK)) {
				return;
			}
			// Arrived at lobby from evening departure
			if (
				entity.stateCode === STATE_DEPARTURE &&
				arrivalFloor === LOBBY_FLOOR
			) {
				entity.destinationFloor = -1;
				entity.selectedFloor = entity.floorAnchor;
				entity.stateCode = STATE_PARKED;
			}
			return;
		case FAMILY_CONDO:
			handleCommercialVenueArrival(entity, arrivalFloor, STATE_ACTIVE);
			return;
		default:
			// Cathedral evaluation entities
			if (CATHEDRAL_FAMILIES.has(entity.familyCode)) {
				if (
					entity.stateCode === STATE_EVAL_OUTBOUND &&
					arrivalFloor === EVAL_ZONE_FLOOR
				) {
					entity.stateCode = STATE_ARRIVED;
					entity.destinationFloor = -1;
					checkEvalCompletionAndAward(world, time, entity);
				} else if (
					entity.stateCode === STATE_EVAL_RETURN &&
					arrivalFloor === LOBBY_FLOOR
				) {
					entity.stateCode = STATE_PARKED;
					entity.destinationFloor = -1;
				}
			}
			return;
	}
}

export function populateCarrierRequests(
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
		if (entity.route.mode === "carrier" || entity.route.mode === "segment") {
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
		resolveEntityRouteBetweenFloors(
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

	for (const entity of world.entities) {
		if (!activeDemandIds.has(entityKey(entity))) {
			entity.route = ROUTE_IDLE;
		}
	}
}

/**
 * Invoked synchronously by `tickAllCarriers` (via the `onArrival` callback)
 * when a carrier unloads an entity at its destination, mirroring the binary's
 * `dispatch_destination_queue_entries` path which calls the family state
 * handler directly inside the carrier tick. The post-tick
 * `reconcileEntityTransport` sweep is still consulted for any arrivals that
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
	const entity = world.entities.find(
		(candidate) => entityKey(candidate) === routeId,
	);
	if (!entity) return;
	dispatchEntityArrival(world, ledger, time, entity, arrivalFloor);
}

export function reconcileEntityTransport(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const entity of world.entities) {
		if (entity.route.mode !== "segment") continue;
		if (!shouldFinalizeSegmentTrip(entity)) continue;
		if (entity.transitTicksRemaining > 0) {
			entity.transitTicksRemaining -= 1;
			continue;
		}
		dispatchEntityArrival(
			world,
			ledger,
			time,
			entity,
			entity.route.destination,
		);
	}

	const completed = new Set<string>();
	for (const carrier of world.carriers) {
		for (const routeId of carrier.completedRouteIds) completed.add(routeId);
		carrier.completedRouteIds = [];
	}

	for (const entity of world.entities) {
		if (entity.destinationFloor < 0) continue;
		if (!completed.has(entityKey(entity))) continue;
		dispatchEntityArrival(world, ledger, time, entity, entity.destinationFloor);
	}
}

export function resetCommercialVenueCycle(world: WorldState): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.yesterdayVisitCount = record.todayVisitCount;
		record.todayVisitCount = 0;
		record.visitCount = 0;
		record.availabilityState = VENUE_PARTIAL;
	}
}

export function closeCommercialVenues(world: WorldState): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.availabilityState = VENUE_CLOSED;
	}
}

export function resetRecyclingCenterDutyTier(world: WorldState): void {
	for (const object of Object.values(world.placedObjects)) {
		if (
			object.objectTypeCode === FAMILY_RECYCLING_CENTER_LOWER &&
			object.unitStatus === 6
		) {
			object.unitStatus = 0;
			object.needsRefreshFlag = 1;
		}
	}
}

export function updateRecyclingCenterState(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	param: number,
): void {
	if (time.starCount <= 2) {
		world.gateFlags.recyclingAdequate = 0;
		return;
	}

	if (param === 0) {
		world.gateFlags.recyclingAdequate = 0;
		if (world.gateFlags.recyclingCenterCount === 0) return;
		for (const object of Object.values(world.placedObjects)) {
			if (
				object.objectTypeCode === FAMILY_RECYCLING_CENTER_UPPER ||
				object.objectTypeCode === FAMILY_RECYCLING_CENTER_LOWER
			) {
				if (object.unitStatus === 5) continue;
				object.unitStatus = 0;
				object.needsRefreshFlag = 1;
			}
		}
		return;
	}

	const scale = Math.max(0, world.gateFlags.recyclingCenterCount);
	if (scale === 0) {
		world.gateFlags.recyclingAdequate = 0;
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

	world.gateFlags.recyclingAdequate = adequate;
	for (const object of Object.values(world.placedObjects)) {
		if (
			object.objectTypeCode === FAMILY_RECYCLING_CENTER_UPPER ||
			object.objectTypeCode === FAMILY_RECYCLING_CENTER_LOWER
		) {
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
		world.gateFlags.evalEntityIndex !== NO_EVAL_ENTITY
	) {
		return;
	}
	if (!entity || !object) return;
	if (entity.familyCode !== FAMILY_OFFICE || entity.stateCode !== STATE_ACTIVE)
		return;
	if (object.evalLevel <= 0) return;
	world.gateFlags.officeServiceOk = 1;
}

export function refundUnhappyCondos(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode !== FAMILY_CONDO) continue;
		if (object.evalLevel !== 0) continue;
		if (object.unitStatus >= UNIT_STATUS_CONDO_VACANT) continue;
		removeCashflowFromFamilyResource(
			ledger,
			"condo",
			object.rentLevel,
			object.objectTypeCode,
		);
		object.unitStatus =
			time.daypartIndex < 4
				? UNIT_STATUS_CONDO_VACANT
				: UNIT_STATUS_CONDO_VACANT_EVENING;
		object.evalActiveFlag = 0;
		object.activationTickCount = 0;
		object.needsRefreshFlag = 1;
		const [x, y] = key.split(",").map(Number);
		for (const entity of world.entities) {
			if (entity.subtypeIndex === x && entity.floorAnchor === yToFloor(y)) {
				entity.stateCode = STATE_PARKED;
				entity.selectedFloor = entity.floorAnchor;
				entity.destinationFloor = -1;
				entity.venueReturnState = 0;
				clearEntityRoute(entity);
			}
		}
	}
}

function entityStressLevel(
	entity: EntityRecord,
	object: PlacedObjectRecord | undefined,
): "low" | "medium" | "high" {
	if (object?.evalLevel === 0 || entity.stressCounter >= 120) {
		return "high";
	}
	if (object?.evalLevel === 1 || entity.stressCounter >= 40) {
		return "medium";
	}
	return "low";
}

export function createEntityStateRecords(
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
				pendingRoute || entity.route.mode === "carrier"
					? (carrierRoute?.carrierId ??
						(entity.route.mode === "carrier" ? entity.route.carrierId : null))
					: null;

			const routeModeNum =
				entity.route.mode === "carrier"
					? 2
					: entity.route.mode === "segment"
						? 1
						: 0;

			return {
				id: entityKey(entity),
				floorAnchor: entity.floorAnchor,
				selectedFloor: entity.selectedFloor,
				subtypeIndex: entity.subtypeIndex,
				baseOffset: entity.baseOffset,
				familyCode: entity.familyCode,
				stateCode: entity.stateCode,
				routeMode: routeModeNum,
				carrierId,
				assignedCarIndex: pendingRoute?.assignedCarIndex ?? -1,
				boardedOnCarrier: pendingRoute?.boarded ?? false,
				stressLevel: entityStressLevel(entity, object),
			} satisfies EntityStateRecord;
		})
		.filter((entity): entity is EntityStateRecord => entity !== null);
}
