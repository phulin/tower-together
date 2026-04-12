import {
	addCashflowFromFamilyResource,
	type LedgerState,
	removeCashflowFromFamilyResource,
} from "../ledger";
import { FAMILY_CONDO, FAMILY_RETAIL } from "../resources";
import type { TimeState } from "../time";
import {
	type CommercialVenueRecord,
	type PlacedObjectRecord,
	VENUE_CLOSED,
	VENUE_DORMANT,
	VENUE_PARTIAL,
	type WorldState,
	yToFloor,
} from "../world";
import { clearSimRoute } from "./population";
import {
	STATE_PARKED,
	UNIT_STATUS_CONDO_VACANT,
	UNIT_STATUS_CONDO_VACANT_EVENING,
} from "./states";

export function resetCommercialVenueCycle(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.yesterdayVisitCount = record.todayVisitCount;
		record.todayVisitCount = 0;
		record.visitCount = 0;
		if (record.availabilityState !== VENUE_DORMANT) {
			record.availabilityState = VENUE_PARTIAL;
		}
	}

	for (const object of Object.values(world.placedObjects)) {
		if (object.objectTypeCode !== FAMILY_RETAIL) continue;
		if (object.evalActiveFlag === 0) continue;
		if (object.linkedRecordIndex < 0) continue;
		const record = world.sidecars[object.linkedRecordIndex] as
			| CommercialVenueRecord
			| undefined;
		if (!record || record.kind !== "commercial_venue") continue;
		if (record.availabilityState !== VENUE_DORMANT) continue;
		activateRetailShop(object, record, ledger);
	}
}

export function closeCommercialVenues(world: WorldState): void {
	for (const record of world.sidecars) {
		if (record.kind !== "commercial_venue") continue;
		record.availabilityState = VENUE_CLOSED;
	}
}

function activateRetailShop(
	object: PlacedObjectRecord,
	record: CommercialVenueRecord,
	ledger: LedgerState,
): void {
	record.availabilityState = VENUE_PARTIAL;
	object.needsRefreshFlag = 1;
	addCashflowFromFamilyResource(
		ledger,
		"retail",
		object.rentLevel,
		object.objectTypeCode,
	);
	ledger.populationLedger[FAMILY_RETAIL] =
		(ledger.populationLedger[FAMILY_RETAIL] ?? 0) + 10;
}

function deactivateRetailShop(
	object: PlacedObjectRecord,
	record: CommercialVenueRecord,
	ledger: LedgerState,
): void {
	record.availabilityState = VENUE_DORMANT;
	object.evalActiveFlag = 0;
	object.activationTickCount = 0;
	object.needsRefreshFlag = 1;
	removeCashflowFromFamilyResource(
		ledger,
		"retail",
		object.rentLevel,
		object.objectTypeCode,
	);
}

export function refundUnhappyFacilities(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	for (const [key, object] of Object.entries(world.placedObjects)) {
		if (object.objectTypeCode === FAMILY_CONDO) {
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
			for (const sim of world.sims) {
				if (sim.homeColumn === x && sim.floorAnchor === yToFloor(y)) {
					sim.stateCode = STATE_PARKED;
					sim.selectedFloor = sim.floorAnchor;
					sim.destinationFloor = -1;
					sim.venueReturnState = 0;
					clearSimRoute(sim);
				}
			}
			continue;
		}

		if (object.objectTypeCode === FAMILY_RETAIL) {
			if (object.evalLevel !== 0) continue;
			if (object.linkedRecordIndex < 0) continue;
			const record = world.sidecars[object.linkedRecordIndex] as
				| CommercialVenueRecord
				| undefined;
			if (!record || record.kind !== "commercial_venue") continue;
			if (record.availabilityState === VENUE_DORMANT) continue;
			deactivateRetailShop(object, record, ledger);
		}
	}
}
