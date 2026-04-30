// 1228:3548 refresh_object_family_condo_state_handler (family 9)
// 1228:3870 dispatch_object_family_condo_state_handler (family 9)
//
// Condo-family state machine (family 9). The refresh handler is the binary's
// two-tier entry point (gate + dispatch), driving the per-state handlers
// through the cs:1c2d family-9 dispatch table (see families/state-tables/condo.ts).
//
// For in-transit states (0x40+), the binary runs decrementRouteQueueDirectionLoad
// as a prologue (cs:1c2d maps {0x40, 0x41, 0x60, 0x61, 0x62} all to handler
// 1228:1aba which calls it), then dispatches through the same handler as the base state.

import type { LedgerState } from "../ledger";
import { decrementRouteQueueDirectionLoad } from "../queue/cancel";
import { isSimInTransit } from "../sim-access/state-bits";
import {
	handleCondoSimArrival as _handleCondoSimArrival,
	processCondoSim as _processCondoSim,
} from "../sims/condo";
import type { TimeState } from "../time";
import type { CarrierRecord, SimRecord, WorldState } from "../world";
import { maybeDispatchQueuedRouteAfterWait } from "./maybe-dispatch-after-wait";

export { handleCondoSimArrival, processCondoSim } from "../sims/condo";

/**
 * 1228:3548 refresh_object_family_condo_state_handler — two-tier entry:
 *   - `state_code < 0x40`: run the gate + dispatch body (processCondoSim).
 *   - `state_code >= 0x40`: call decrementRouteQueueDirectionLoad prologue
 *     (1218:0fc4) then dispatch through the same handler as the base state.
 *     Binary quirk: family-9 cs:1c2d table maps {0x40, 0x41, 0x60, 0x61, 0x62}
 *     all to handler 1228:1aba — same aliasing mechanism as office/hotel.
 */
export function refreshObjectFamilyCondoStateHandler(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	sim: SimRecord,
): void {
	if (isSimInTransit(sim.stateCode)) {
		const carrier =
			world.carriers.find(
				(c) =>
					c.carrierId ===
					(sim.route.mode === "carrier" ? sim.route.carrierId : undefined),
			) ?? (world.carriers[0] as CarrierRecord | undefined);
		if (carrier) {
			decrementRouteQueueDirectionLoad(carrier, sim.originFloor, 0);
		}
		maybeDispatchQueuedRouteAfterWait(world, ledger, time, sim);
		if (!isSimInTransit(sim.stateCode)) return;
	}
	_processCondoSim(world, ledger, time, sim);
}

/** 1228:3870 dispatch_object_family_condo_state_handler — arrival dispatch. */
export function dispatchObjectFamilyCondoStateHandler(
	sim: SimRecord,
	arrivalFloor: number,
	time: TimeState,
	arrivedViaCarrier: boolean,
): void {
	_handleCondoSimArrival(sim, arrivalFloor, time, arrivedViaCarrier);
}
