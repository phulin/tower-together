// 11b8:18fb scoreLocalRouteSegment
// 11b8:19a8 scoreHousekeepingRouteSegment
//
// Cost for a direct stairs/escalator segment, plus the stairs-only
// housekeeping variant (called from the !is_passenger_route branch in
// select_best_route_candidate).

import type { WorldState } from "../world";
import { ROUTE_COST_INFINITE, STAIRS_ROUTE_EXTRA_COST } from "./constants";

export function scoreLocalRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	// Binary 11b8:18fb only validates the source landing — the destination
	// (toFloor) is not range-checked against the segment span.
	if (!segmentCoversFloor(segment, fromFloor)) return ROUTE_COST_INFINITE;
	if (!canEnterSegmentFromFloor(segment, fromFloor, toFloor))
		return ROUTE_COST_INFINITE;
	const isStairs = (segment.flags & 1) !== 0;
	const distance = Math.abs(segment.heightMetric - targetHeightMetric) * 8;
	return isStairs ? distance + STAIRS_ROUTE_EXTRA_COST : distance;
}

export function scoreHousekeepingRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
	targetHeightMetric: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	if ((segment.flags & 1) === 0) return ROUTE_COST_INFINITE;
	// Binary only validates the source landing — destination is not checked.
	if (!segmentCoversFloor(segment, fromFloor)) return ROUTE_COST_INFINITE;
	if (!canEnterSegmentFromFloor(segment, fromFloor, toFloor))
		return ROUTE_COST_INFINITE;
	return (
		Math.abs(segment.heightMetric - targetHeightMetric) * 8 +
		STAIRS_ROUTE_EXTRA_COST
	);
}

function getSegmentExtentMinusOne(
	segment: WorldState["specialLinks"][number],
): number {
	return segment.flags >> 1;
}

function getSegmentTopFloor(
	segment: WorldState["specialLinks"][number],
): number {
	// Binary encoding: top_floor = entry_floor + (flags >> 1) + 1.
	return segment.entryFloor + getSegmentExtentMinusOne(segment) + 1;
}

function segmentCoversFloor(
	segment: WorldState["specialLinks"][number],
	floor: number,
): boolean {
	return floor >= segment.entryFloor && floor <= getSegmentTopFloor(segment);
}

function canEnterSegmentFromFloor(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): boolean {
	// Binary score_local_route_segment: terminal-landing entry gate, applied
	// uniformly to stairs and escalators. Going up: source must equal entry
	// floor. Going down: source must equal top floor (entry + (flags>>1) + 1).
	if (toFloor > fromFloor) return fromFloor === segment.entryFloor;
	return fromFloor === getSegmentTopFloor(segment);
}
