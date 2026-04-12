import { addCashflowFromFamilyResource, type LedgerState } from "../ledger";
import type { TimeState } from "../time";
import type { SimRecord, WorldState } from "../world";
import {
	dispatchCommercialVenueVisit,
	findObjectForSim,
	finishCommercialVenueDwell,
	finishCommercialVenueTrip,
	recomputeObjectOperationalStatus,
} from "./index";
import {
	CONDO_SELECTOR_FAST_FOOD,
	CONDO_SELECTOR_RESTAURANT,
	STATE_ACTIVE,
	STATE_PARKED,
	STATE_VENUE_TRIP,
	UNIT_STATUS_CONDO_VACANT,
} from "./states";

export function processCondoSim(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	const object = findObjectForSim(world, sim);
	if (!object) return;

	if (sim.stateCode === STATE_PARKED) sim.stateCode = STATE_ACTIVE;
	if (finishCommercialVenueDwell(sim, time, STATE_ACTIVE)) return;
	if (sim.stateCode === STATE_ACTIVE) {
		dispatchCommercialVenueVisit(world, time, sim, {
			venueFamilies:
				sim.baseOffset % 4 === 0
					? CONDO_SELECTOR_RESTAURANT
					: CONDO_SELECTOR_FAST_FOOD,
			returnState: STATE_ACTIVE,
			unavailableState: STATE_PARKED,
			skipPenaltyOnUnavailable: true,
			onVenueReserved: () => {
				if (object.unitStatus < UNIT_STATUS_CONDO_VACANT) return;
				object.unitStatus = time.daypartIndex < 4 ? 0x08 : 0x00;
				object.needsRefreshFlag = 1;
				if (sim.baseOffset !== 0) return;
				addCashflowFromFamilyResource(
					ledger,
					"condo",
					object.rentLevel,
					object.objectTypeCode,
				);
			},
		});
	} else if (sim.stateCode === STATE_VENUE_TRIP) {
		finishCommercialVenueTrip(sim, STATE_ACTIVE);
	}

	recomputeObjectOperationalStatus(world, time, sim, object);
}
