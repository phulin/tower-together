import { add_cashflow_from_family_resource, type LedgerState } from "./ledger";
import { OP_SCORE_THRESHOLDS, YEN_1001 } from "./resources";
import { select_best_route_candidate } from "./routing";
import type { TimeState } from "./time";
import {
	type CommercialVenueRecord,
	type EntityRecord,
	type PlacedObjectRecord,
	type WorldState,
	yToFloor,
} from "./world";

const ENTITY_POPULATION_BY_TYPE: Record<number, number> = {
	3: 1,
	4: 2,
	5: 3,
	7: 6,
	9: 3,
};

const HOTEL_FAMILIES = new Set([3, 4, 5]);
const COMMERCIAL_FAMILIES = new Set([6, 10, 12]);

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
		selectedFloor: floorAnchor,
		originFloor: floorAnchor,
		encodedRouteTarget: -1,
		auxState: 0,
		queueTick: 0,
		accumulatedDelay: 0,
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
			const route = select_best_route_candidate(world, 10, yToFloor(y));
			return route !== null;
		},
	)
		? 1
		: 0;
}

function pickAvailableVenue(
	world: WorldState,
	fromFloor: number,
	allowedFamilies: Set<number>,
): CommercialVenueRecord | null {
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
		if (select_best_route_candidate(world, fromFloor, yToFloor(y)) === null) {
			continue;
		}

		return record;
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

function activateHotelStay(
	world: WorldState,
	entity: EntityRecord,
	time: TimeState,
): void {
	const object = findObjectForEntity(world, entity);
	if (!object) return;
	if (select_best_route_candidate(world, 10, entity.floorAnchor) === null)
		return;
	entity.stateCode = 0x01;
	entity.originFloor = 10;
	entity.selectedFloor = entity.floorAnchor;
	object.stayPhase = time.daypartIndex < 4 ? 0 : 8;
	object.needsRefreshFlag = 1;
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
				entity.stateCode = 0x05;
				return;
			}
			const venue = pickAvailableVenue(
				world,
				entity.floorAnchor,
				COMMERCIAL_FAMILIES,
			);
			if (venue) {
				reserveVenue(venue);
				recordDemandSample(entity, time);
				object.activationTickCount = Math.min(
					0x78,
					object.activationTickCount + 1,
				);
				entity.stateCode = 0x22;
			}
			return;
		}
		case 0x22:
			entity.stateCode = 0x01;
			return;
		case 0x05:
		case 0x04:
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
			reserveVenue(venue);
			recordDemandSample(entity, time);
			entity.stateCode = 0x22;
		}
	}

	if (entity.stateCode === 0x22) entity.stateCode = 0x01;
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
		if (select_best_route_candidate(world, 10, entity.floorAnchor) !== null) {
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
			reserveVenue(venue);
			recordDemandSample(entity, time);
			entity.stateCode = 0x22;
		}
	} else if (entity.stateCode === 0x22) {
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
