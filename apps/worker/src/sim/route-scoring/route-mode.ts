// 11b8:1422 getCurrentSimRouteMode
//
// Binary: reads a pixel-column height metric from the facility subtype record
// for the current sim. The value is passed as `targetHeightMetric` into the
// route scorers (score_carrier_transfer_route, score_local_route_segment,
// score_housekeeping_route_segment) via select_best_route_candidate.
//
// The Ghidra-assigned name "get_current_sim_route_mode" is misleading — the
// return value is not a mode enum but a height reference used for distance
// scoring. In the TS implementation this role is filled by `sim.homeColumn`,
// passed directly to selectBestRouteCandidate. This function is therefore not
// called; it is preserved as a reference mapping to the binary address.
//
// `preferLocalMode` (whether to prefer escalator over stairs segments) is a
// separate boolean derived from sim.familyCode in resolveSimRouteBetweenFloors.

import type { SimRecord } from "../world";

export type SimRouteMode = "passenger" | "service";

const FAMILY_HOUSEKEEPING = 0x0f;

export function getCurrentSimRouteMode(sim: SimRecord): SimRouteMode {
	return sim.familyCode === FAMILY_HOUSEKEEPING ? "service" : "passenger";
}

/**
 * Derived helper: `true` when the scorer should prefer local (escalator)
 * segments, i.e. the sim is a passenger. Housekeeping prefers stairs.
 */
export function simPrefersLocalMode(sim: SimRecord): boolean {
	return getCurrentSimRouteMode(sim) === "passenger";
}
