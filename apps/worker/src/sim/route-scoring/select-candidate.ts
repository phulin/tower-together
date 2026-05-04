// 11b8:1484 selectBestRouteCandidate
//
// Family-agnostic route selector. Mirrors the binary's three-stage scan:
// (1) a 64-segment local/express scan gated by direct walkability, (2) when
// passenger-mode AND no direct segment was found, an 8-record special-link
// pass that can trigger a *second* 64-segment local scan against
// `sourceFloor ± 1`, (3) a 24-carrier scan whose threshold is whatever
// `local_e` was preserved from earlier stages (0x7fff if no segment, else
// the segment cost).

import {
	isFloorSpanWalkableForHousekeepingRoute,
	isFloorSpanWalkableForLocalRoute,
} from "../reachability/span-checks";
import { MAX_SPECIAL_LINK_RECORDS, type WorldState } from "../world";
import { ROUTE_COST_INFINITE, STAIRS_ROUTE_EXTRA_COST } from "./constants";
import {
	scoreCarrierDirectRoute,
	scoreCarrierTransferRoute,
} from "./score-carrier";
import {
	scoreHousekeepingRouteSegment,
	scoreLocalRouteSegment,
} from "./score-local";
import { scoreSpecialLinkRoute } from "./score-special-link";

export interface RouteCandidate {
	kind: "segment" | "carrier";
	id: number;
	cost: number;
}

export function selectBestRouteCandidate(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
	preferLocalMode = true,
	targetHeightMetric = 0,
): RouteCandidate | null {
	if (fromFloor === toFloor) return null;

	const delta = Math.abs(fromFloor - toFloor);
	// Binary `local_e` and `local_idx`. `local_e` doubles as the running
	// minimum cost AND the carrier-scan threshold.
	let bestCost = ROUTE_COST_INFINITE;
	let bestIndex = -1;

	if (!preferLocalMode) {
		// Housekeeping path. Single 64-segment scan gated by continuous-stairs
		// walkability; on success it returns immediately, otherwise falls
		// straight through to the carrier scan.
		if (
			delta === 1 ||
			isFloorSpanWalkableForHousekeepingRoute(world, fromFloor, toFloor)
		) {
			for (
				let segmentIndex = 0;
				segmentIndex < world.specialLinks.length;
				segmentIndex++
			) {
				const segment = world.specialLinks[segmentIndex];
				if (!segment) continue;
				const cost = scoreHousekeepingRouteSegment(
					segment,
					fromFloor,
					toFloor,
					targetHeightMetric,
				);
				if (cost < bestCost) {
					bestIndex = segmentIndex;
					bestCost = cost;
				}
			}
			if (bestIndex >= 0) {
				return { kind: "segment", id: bestIndex, cost: bestCost };
			}
		}
	} else {
		// Passenger path. First local scan gated by local walkability.
		if (
			delta === 1 ||
			isFloorSpanWalkableForLocalRoute(world, fromFloor, toFloor)
		) {
			for (
				let segmentIndex = 0;
				segmentIndex < world.specialLinks.length;
				segmentIndex++
			) {
				const segment = world.specialLinks[segmentIndex];
				if (!segment) continue;
				const cost = scoreLocalRouteSegment(
					segment,
					fromFloor,
					toFloor,
					targetHeightMetric,
				);
				if (cost < bestCost) {
					bestIndex = segmentIndex;
					bestCost = cost;
				}
			}
			// 11b8:1510-1515 early return when the cheapest segment is below
			// the stairs cost-extra threshold (escalator hit).
			if (bestIndex >= 0 && bestCost < STAIRS_ROUTE_EXTRA_COST) {
				return { kind: "segment", id: bestIndex, cost: bestCost };
			}
		}

		// 11b8:151d Special-link block. Runs only if the first scan found
		// nothing (`local_idx < 0`). If a winner exists with cost >= 640, the
		// binary skips this block entirely and proceeds to the carrier scan
		// with `local_e` preserved as the threshold.
		if (bestIndex < 0) {
			let direction = 0;
			let foundRecord = false;
			for (
				let recordIndex = 0;
				recordIndex < MAX_SPECIAL_LINK_RECORDS;
				recordIndex++
			) {
				const result = scoreSpecialLinkRoute(
					world,
					recordIndex,
					fromFloor,
					toFloor,
				);
				if (result.cost < bestCost) {
					bestIndex = recordIndex;
					direction = result.direction;
					bestCost = result.cost;
					foundRecord = true;
				}
			}

			if (foundRecord) {
				// Second 64-segment local scan against sourceFloor ± 1.
				// The binary resets `local_e = 0x7fff; local_idx = -1` here.
				const adjacentFloor = direction === 0 ? fromFloor - 1 : fromFloor + 1;
				bestCost = ROUTE_COST_INFINITE;
				bestIndex = -1;
				for (
					let segmentIndex = 0;
					segmentIndex < world.specialLinks.length;
					segmentIndex++
				) {
					const segment = world.specialLinks[segmentIndex];
					if (!segment) continue;
					const cost = scoreLocalRouteSegment(
						segment,
						fromFloor,
						adjacentFloor,
						targetHeightMetric,
					);
					if (cost < bestCost) {
						bestIndex = segmentIndex;
						bestCost = cost;
					}
				}
				// Post-scan early return: winner found with cost < 640.
				if (bestIndex >= 0 && bestCost < STAIRS_ROUTE_EXTRA_COST) {
					return { kind: "segment", id: bestIndex, cost: bestCost };
				}
			}
		}
	}

	// 11b8:1632 Carrier scan. Threshold is the preserved `local_e`. Update
	// `bestIndex`/`bestCost` only when a carrier strictly beats the current
	// minimum. Carrier IDs are encoded as `0x40 + carrierIndex` to disambiguate
	// from segment indices in the binary's single return value.
	for (let carrierIndex = 0; carrierIndex < 24; carrierIndex++) {
		const carrier = world.carriers.find(
			(candidate) => candidate.carrierId === carrierIndex,
		);
		if (!carrier) continue;
		if (
			preferLocalMode ? carrier.carrierMode === 2 : carrier.carrierMode !== 2
		) {
			continue;
		}
		// Binary calls `score_carrier_transfer_route` once per carrier; TS
		// splits direct vs transfer — use the cheaper of the two.
		const directCost = scoreCarrierDirectRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			targetHeightMetric,
		);
		const transferCost = scoreCarrierTransferRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			preferLocalMode,
			targetHeightMetric,
		);
		const carrierCost = Math.min(directCost, transferCost);
		if (carrierCost < bestCost) {
			bestIndex = 0x40 + carrierIndex;
			bestCost = carrierCost;
		}
	}

	if (bestIndex < 0) return null;
	if (bestIndex >= 0x40) {
		return { kind: "carrier", id: bestIndex - 0x40, cost: bestCost };
	}
	return { kind: "segment", id: bestIndex, cost: bestCost };
}
