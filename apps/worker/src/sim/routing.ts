import { carrierServesFloor } from "./carriers";
import { FAMILY_PARKING } from "./resources";
import {
	GRID_HEIGHT,
	MAX_SPECIAL_LINK_RECORDS,
	MAX_SPECIAL_LINKS,
	MAX_TRANSFER_GROUPS,
	type WorldState,
	yToFloor,
} from "./world";

const ROUTE_COST_INFINITE = 0x7fff;
const EXPRESS_ROUTE_BASE_COST = 0x280; // 640

const DERIVED_RECORD_CENTERS = [10, 25, 40, 55, 70, 85, 100];

export function rebuildSpecialLinks(world: WorldState): void {
	world.specialLinks = Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
		active: false,
		flags: 0,
		heightMetric: 0,
		entryFloor: 0,
		reservedByte: 0,
		descendingLoadCounter: 0,
		ascendingLoadCounter: 0,
	}));
	world.specialLinkRecords = Array.from(
		{ length: MAX_SPECIAL_LINK_RECORDS },
		() => ({
			active: false,
			lowerFloor: 0,
			upperFloor: 0,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		}),
	);

	const rawSegments: Array<{
		column: number;
		type: "stairs" | "escalator";
		floors: Set<number>;
	}> = [];
	const grouped = new Map<
		string,
		{ column: number; type: "stairs" | "escalator"; floors: Set<number> }
	>();

	for (const [key, type] of Object.entries(world.overlays)) {
		if (type !== "stairs" && type !== "escalator") continue;
		const [xStr, yStr] = key.split(",");
		const column = Number(xStr);
		const floor = yToFloor(Number(yStr));
		const groupKey = `${type}:${column}`;
		if (!grouped.has(groupKey)) {
			grouped.set(groupKey, { column, type, floors: new Set<number>() });
		}
		grouped.get(groupKey)?.floors.add(floor);
	}

	for (const group of grouped.values()) rawSegments.push(group);

	let segmentIndex = 0;
	for (const group of rawSegments) {
		if (segmentIndex >= MAX_SPECIAL_LINKS) break;
		const sortedFloors = [...group.floors].sort((a, b) => a - b);
		if (sortedFloors.length === 0) continue;
		const entryFloor = sortedFloors[0];
		const topFloor = sortedFloors[sortedFloors.length - 1];
		const span = topFloor - entryFloor + 1;
		world.specialLinks[segmentIndex++] = {
			active: true,
			flags: (span << 1) | (group.type === "stairs" ? 1 : 0),
			heightMetric: span,
			entryFloor,
			reservedByte: 0,
			descendingLoadCounter: 0,
			ascendingLoadCounter: 0,
		};
	}

	for (const [recordIndex, center] of DERIVED_RECORD_CENTERS.entries()) {
		if (recordIndex >= MAX_SPECIAL_LINK_RECORDS) break;
		const lowerFloor = scanSpecialLinkSpanBound(world, center, 0);
		const upperFloor = scanSpecialLinkSpanBound(world, center, 1);
		if (lowerFloor >= upperFloor) continue;
		world.specialLinkRecords[recordIndex] = {
			active: true,
			lowerFloor,
			upperFloor,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		};
	}
}

export function rebuildWalkabilityFlags(world: WorldState): void {
	world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);

	for (const segment of world.specialLinks) {
		if (!segment.active) continue;
		const bit = (segment.flags & 1) !== 0 ? 2 : 1;
		const topFloor = getSegmentTopFloor(segment);
		for (let floor = segment.entryFloor; floor <= topFloor; floor++) {
			if (floor >= 0 && floor < GRID_HEIGHT) {
				world.floorWalkabilityFlags[floor] |= bit;
			}
		}
	}
}

export function rebuildTransferGroupCache(world: WorldState): void {
	world.transferGroupCache = new Array(GRID_HEIGHT).fill(0);
	world.transferGroupEntries = Array.from(
		{ length: MAX_TRANSFER_GROUPS },
		() => ({
			active: false,
			taggedFloor: 0xff,
			carrierMask: 0,
		}),
	);
	for (const record of world.specialLinkRecords) {
		record.reachabilityMasksByFloor.fill(0);
	}

	const candidates = Object.entries(world.placedObjects)
		.filter(([, object]) => object.objectTypeCode === FAMILY_PARKING)
		.map(([key, object]) => {
			const [x, y] = key.split(",").map(Number);
			const floor = yToFloor(y);
			let membershipMask = 0;
			for (const carrier of world.carriers) {
				if (carrier.carrierId >= 24) continue;
				if (
					carrier.column < object.leftTileIndex ||
					carrier.column > object.rightTileIndex
				) {
					continue;
				}
				if (!carrierReachesTransferFloor(carrier, floor)) continue;
				membershipMask |= 1 << carrier.carrierId;
			}
			return {
				floor,
				x,
				membershipMask,
				object,
			};
		})
		.filter((candidate) => candidate.membershipMask !== 0)
		.sort((a, b) => (a.floor === b.floor ? a.x - b.x : a.floor - b.floor));

	// Append+collapse: append each candidate, then collapse into the
	// immediately preceding entry if it has the same tagged floor and an
	// overlapping carrier mask.
	let entryCount = 0;
	for (const candidate of candidates) {
		if (entryCount > 0) {
			const prev = world.transferGroupEntries[entryCount - 1];
			if (
				prev?.active &&
				prev.taggedFloor === candidate.floor &&
				(prev.carrierMask & candidate.membershipMask) !== 0
			) {
				prev.carrierMask |= candidate.membershipMask;
				continue;
			}
		}
		if (entryCount >= MAX_TRANSFER_GROUPS) return;
		world.transferGroupEntries[entryCount++] = {
			active: true,
			taggedFloor: candidate.floor,
			carrierMask: candidate.membershipMask,
		};
	}

	for (const [recordIndex, record] of world.specialLinkRecords.entries()) {
		if (!record.active) continue;
		for (const entry of world.transferGroupEntries) {
			if (!entry.active) continue;
			if (
				entry.taggedFloor >= record.lowerFloor &&
				entry.taggedFloor <= record.upperFloor
			) {
				entry.carrierMask |= 1 << (24 + recordIndex);
			}
		}
	}

	for (let index = 0; index < world.transferGroupEntries.length; index++) {
		const entry = world.transferGroupEntries[index];
		if (!entry?.active) continue;
		world.transferGroupCache[entry.taggedFloor] |= entry.carrierMask;
	}

	for (const [recordIndex, record] of world.specialLinkRecords.entries()) {
		if (!record.active) continue;
		rebuildSpecialLinkRecordReachability(world, recordIndex, record);
	}
}

export function isFloorSpanWalkableForLocalRoute(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	const lower = Math.min(fromFloor, toFloor);
	const upper = Math.max(fromFloor, toFloor);
	if (upper - lower >= 7) return false;
	let seenGap = false;
	for (let floor = lower; floor <= upper; floor++) {
		const flags = world.floorWalkabilityFlags[floor] ?? 0;
		if (flags === 0) return false;
		if ((flags & 1) === 0) {
			seenGap = true;
		}
		if (seenGap && floor - lower > 2) return false;
	}
	return true;
}

export function isFloorSpanWalkableForExpressRoute(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	const lower = Math.min(fromFloor, toFloor);
	const upper = Math.max(fromFloor, toFloor);
	if (upper - lower >= 7) return false;
	for (let floor = lower; floor <= upper; floor++) {
		if ((world.floorWalkabilityFlags[floor] & 2) === 0) return false;
	}
	return true;
}

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
): RouteCandidate | null {
	if (fromFloor === toFloor) return null;

	const delta = Math.abs(fromFloor - toFloor);
	let bestSegment: RouteCandidate | null = null;
	let bestCarrier: RouteCandidate | null = null;

	function tryCandidate(
		current: RouteCandidate | null,
		kind: "segment" | "carrier",
		id: number,
		cost: number,
	): RouteCandidate {
		if (!current || cost < current.cost) return { kind, id, cost };
		return current;
	}

	if (preferLocalMode) {
		if (
			delta === 1 ||
			isFloorSpanWalkableForLocalRoute(world, fromFloor, toFloor)
		) {
			for (const [segmentIndex, segment] of world.specialLinks.entries()) {
				const cost = scoreLocalRouteSegment(segment, fromFloor, toFloor);
				if (cost >= ROUTE_COST_INFINITE) continue;
				bestSegment = tryCandidate(bestSegment, "segment", segmentIndex, cost);
			}
			// Immediately accept a cheap direct local segment
			if (bestSegment && bestSegment.cost < EXPRESS_ROUTE_BASE_COST)
				return bestSegment;
		}

		// Scan derived transfer zones only when no cheap direct segment exists
		if (!bestSegment || bestSegment.cost >= EXPRESS_ROUTE_BASE_COST) {
			for (const record of world.specialLinkRecords) {
				if (!record.active) continue;
				if (fromFloor < record.lowerFloor || fromFloor > record.upperFloor)
					continue;
				if (!derivedRecordReachesFloor(record, toFloor)) continue;
				const candidateEntryFloors = getDerivedRecordEntryFloors(
					record,
					toFloor,
				);
				for (const adjacentFloor of candidateEntryFloors) {
					for (const [segmentIndex, segment] of world.specialLinks.entries()) {
						const cost = scoreLocalRouteSegment(
							segment,
							fromFloor,
							adjacentFloor,
						);
						if (cost >= EXPRESS_ROUTE_BASE_COST) continue;
						bestSegment = tryCandidate(
							bestSegment,
							"segment",
							segmentIndex,
							cost,
						);
					}
				}
			}
			// If a transfer zone produced a cheap segment, accept it
			if (bestSegment && bestSegment.cost < EXPRESS_ROUTE_BASE_COST)
				return bestSegment;
		}
	} else if (
		delta === 1 ||
		isFloorSpanWalkableForExpressRoute(world, fromFloor, toFloor)
	) {
		for (const [segmentIndex, segment] of world.specialLinks.entries()) {
			const cost = scoreExpressRouteSegment(segment, fromFloor, toFloor);
			if (cost >= ROUTE_COST_INFINITE) continue;
			bestSegment = tryCandidate(bestSegment, "segment", segmentIndex, cost);
		}
		if (bestSegment) return bestSegment;
	}

	// Carrier fallback: scan all eligible carriers
	for (const carrier of world.carriers) {
		if (
			preferLocalMode ? carrier.carrierMode === 2 : carrier.carrierMode !== 2
		) {
			continue;
		}
		const directCost = scoreCarrierDirectRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
		);
		if (directCost < ROUTE_COST_INFINITE) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				directCost,
			);
		}

		const transferCost = scoreCarrierTransferRoute(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			preferLocalMode,
		);
		if (transferCost < ROUTE_COST_INFINITE) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				transferCost,
			);
		}
	}

	// Compare preserved segment candidate against best carrier
	if (bestSegment && bestCarrier) {
		return bestSegment.cost < bestCarrier.cost ? bestSegment : bestCarrier;
	}
	return bestSegment ?? bestCarrier;
}

function scoreLocalRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, fromFloor)) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, toFloor)) return ROUTE_COST_INFINITE;
	if (!canEnterSegmentFromFloor(segment, fromFloor, toFloor))
		return ROUTE_COST_INFINITE;
	const delta = Math.abs(toFloor - fromFloor);
	return (segment.flags & 1) !== 0 ? ROUTE_COST_INFINITE : delta * 8;
}

function scoreExpressRouteSegment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): number {
	if (!segment.active) return ROUTE_COST_INFINITE;
	if ((segment.flags & 1) === 0) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, fromFloor)) return ROUTE_COST_INFINITE;
	if (!segmentCoversFloor(segment, toFloor)) return ROUTE_COST_INFINITE;
	if (!canEnterSegmentFromFloor(segment, fromFloor, toFloor))
		return ROUTE_COST_INFINITE;
	return Math.abs(toFloor - fromFloor) * 8 + EXPRESS_ROUTE_BASE_COST;
}

function distanceMismatchPenalty(heightMetricDelta: number): number {
	const absDelta = Math.abs(heightMetricDelta);
	if (absDelta >= 125) return 0x3c;
	if (absDelta > 79) return 0x1e;
	return 0;
}

function scoreCarrierDirectRoute(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return ROUTE_COST_INFINITE;
	if (!carrierServesFloor(carrier, fromFloor)) return ROUTE_COST_INFINITE;
	if (!carrierServesFloor(carrier, toFloor)) return ROUTE_COST_INFINITE;
	const status = getFloorSlotStatus(
		carrier,
		fromFloor,
		toFloor > fromFloor ? 0 : 1,
	);
	const delta = Math.abs(toFloor - fromFloor);
	// Distance penalty only applies to standard/service carriers (mode != 0)
	const penalty =
		carrier.carrierMode !== 0 ? distanceMismatchPenalty(delta) : 0;
	return status === 0x28
		? 1000 + delta * 8 + penalty
		: delta * 8 + EXPRESS_ROUTE_BASE_COST + penalty;
}

function scoreCarrierTransferRoute(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
	preferLocalMode: boolean,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return ROUTE_COST_INFINITE;
	if (!carrierServesFloor(carrier, fromFloor)) return ROUTE_COST_INFINITE;
	const reachable = world.transferGroupEntries.some((entry) => {
		if (!entry.active) return false;
		if ((entry.carrierMask & (1 << carrierId)) === 0) return false;
		return entryReachesDestinationFloor(world, entry, toFloor, preferLocalMode);
	});
	if (!reachable) return ROUTE_COST_INFINITE;
	const status = getFloorSlotStatus(
		carrier,
		fromFloor,
		toFloor > fromFloor ? 0 : 1,
	);
	const delta = Math.abs(toFloor - fromFloor);
	// Distance penalty only applies to standard/service carriers (mode != 0)
	const penalty =
		carrier.carrierMode !== 0 ? distanceMismatchPenalty(delta) : 0;
	return status === 0x28
		? 6000 + delta * 8 + penalty
		: delta * 8 + 3000 + penalty;
}

/**
 * Resolve a transfer floor for a carrier route where the carrier doesn't
 * directly serve the target floor. Scans transfer-group entries 0..15 to find
 * the first valid transfer floor in the travel direction.
 *
 * Returns the transfer floor, or -1 if no valid transfer found.
 */
export function resolveTransferFloor(
	world: WorldState,
	carrierId: number,
	currentFloor: number,
	targetFloor: number,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return -1;

	// If the carrier directly serves the target floor, use it directly
	if (carrierServesFloor(carrier, targetFloor)) return targetFloor;

	// Find the special-link record whose reachability covers this carrier
	for (const record of world.specialLinkRecords) {
		if (!record.active) continue;
		const mask = record.reachabilityMasksByFloor[targetFloor] ?? 0;
		if (mask === 0) continue;

		// Scan transfer-group entries in ascending order
		for (const entry of world.transferGroupEntries) {
			if (!entry.active) continue;
			// Skip same floor
			if (entry.taggedFloor === currentFloor) continue;
			// Check carrier mask overlap with target-floor reachability
			if ((entry.carrierMask & (1 << carrierId)) === 0) continue;
			if ((entry.carrierMask & mask) === 0) continue;
			// Direction check: transfer floor must lie in travel direction
			if (targetFloor > currentFloor && entry.taggedFloor <= currentFloor)
				continue;
			if (targetFloor < currentFloor && entry.taggedFloor >= currentFloor)
				continue;
			return entry.taggedFloor;
		}
	}

	return -1;
}

function scanSpecialLinkSpanBound(
	world: WorldState,
	centerFloor: number,
	dir: 0 | 1,
): number {
	let seenGap = false;

	if (dir !== 0) {
		for (let floor = centerFloor; floor < centerFloor + 6; floor++) {
			const flags = world.floorWalkabilityFlags[floor] ?? 0;
			if (flags === 0) return floor;
			if ((flags & 1) === 0) seenGap = true;
			if (seenGap && floor >= centerFloor + 3) return floor;
		}
		return centerFloor + 6;
	}

	for (let floor = centerFloor; floor > centerFloor - 6; floor--) {
		const flags = world.floorWalkabilityFlags[floor] ?? 0;
		if (flags === 0) return floor;
		if ((flags & 1) === 0) seenGap = true;
		if (seenGap && floor <= centerFloor - 3) return floor;
	}
	return centerFloor - 6;
}

function rebuildSpecialLinkRecordReachability(
	world: WorldState,
	recordIndex: number,
	record: WorldState["specialLinkRecords"][number],
): void {
	const recordBit = 1 << (24 + recordIndex);
	let aggregateMask = 0;
	for (const entry of world.transferGroupEntries) {
		if (!entry.active) continue;
		if ((entry.carrierMask & recordBit) === 0) continue;
		aggregateMask |= entry.carrierMask;
	}
	aggregateMask &= ~recordBit;

	for (let floor = 0; floor < GRID_HEIGHT; floor++) {
		const insideSpan = floor >= record.lowerFloor && floor <= record.upperFloor;
		const localEntryIndex = world.transferGroupEntries.findIndex(
			(entry) =>
				entry.active &&
				entry.taggedFloor === floor &&
				(entry.carrierMask & recordBit) !== 0,
		);
		if (insideSpan && localEntryIndex >= 0) {
			record.reachabilityMasksByFloor[floor] = localEntryIndex + 1;
			continue;
		}

		let projectedMask = 0;
		for (let carrierIndex = 0; carrierIndex < 24; carrierIndex++) {
			if ((aggregateMask & (1 << carrierIndex)) === 0) continue;
			const carrier = world.carriers.find(
				(candidate) => candidate.carrierId === carrierIndex,
			);
			if (!carrier) continue;
			if (carrierServesFloor(carrier, floor)) {
				projectedMask |= 1 << carrierIndex;
			}
		}
		for (let peerIndex = 0; peerIndex < MAX_SPECIAL_LINK_RECORDS; peerIndex++) {
			if ((aggregateMask & (1 << (24 + peerIndex))) === 0) continue;
			const peer = world.specialLinkRecords[peerIndex];
			if (!peer?.active) continue;
			if (floor >= peer.lowerFloor && floor <= peer.upperFloor) {
				projectedMask |= 1 << (24 + peerIndex);
			}
		}
		record.reachabilityMasksByFloor[floor] = projectedMask;
	}
}

function derivedRecordReachesFloor(
	record: WorldState["specialLinkRecords"][number],
	targetFloor: number,
): boolean {
	if (targetFloor >= record.lowerFloor && targetFloor <= record.upperFloor)
		return true;
	return (record.reachabilityMasksByFloor[targetFloor] ?? 0) !== 0;
}

function getDerivedRecordEntryFloors(
	record: WorldState["specialLinkRecords"][number],
	targetFloor: number,
): number[] {
	if (targetFloor >= record.lowerFloor && targetFloor <= record.upperFloor) {
		return [targetFloor];
	}

	let bestEntryFloor = -1;
	for (let floor = record.lowerFloor; floor <= record.upperFloor; floor++) {
		const reachability = record.reachabilityMasksByFloor[floor] ?? 0;
		if (reachability <= 0 || reachability > MAX_TRANSFER_GROUPS) continue;
		if (bestEntryFloor < 0) {
			bestEntryFloor = floor;
			continue;
		}
		if (targetFloor < record.lowerFloor) {
			if (floor < bestEntryFloor) bestEntryFloor = floor;
			continue;
		}
		if (targetFloor > record.upperFloor && floor > bestEntryFloor) {
			bestEntryFloor = floor;
		}
	}

	if (bestEntryFloor >= 0) return [bestEntryFloor];
	return [
		targetFloor < record.lowerFloor ? record.lowerFloor : record.upperFloor,
	];
}

function entryReachesDestinationFloor(
	world: WorldState,
	entry: WorldState["transferGroupEntries"][number],
	toFloor: number,
	preferLocalMode: boolean,
): boolean {
	for (let carrierIndex = 0; carrierIndex < 24; carrierIndex++) {
		if ((entry.carrierMask & (1 << carrierIndex)) === 0) continue;
		const carrier = world.carriers.find(
			(candidate) => candidate.carrierId === carrierIndex,
		);
		if (!carrier) continue;
		if (
			preferLocalMode ? carrier.carrierMode === 2 : carrier.carrierMode !== 2
		) {
			continue;
		}
		if (carrierServesFloor(carrier, toFloor)) return true;
	}
	for (
		let recordIndex = 0;
		recordIndex < MAX_SPECIAL_LINK_RECORDS;
		recordIndex++
	) {
		if ((entry.carrierMask & (1 << (24 + recordIndex))) === 0) continue;
		const record = world.specialLinkRecords[recordIndex];
		if (!record?.active) continue;
		if (derivedRecordReachesFloor(record, toFloor)) return true;
	}
	return false;
}

function getSegmentSpan(segment: WorldState["specialLinks"][number]): number {
	return segment.flags >> 1;
}

function getSegmentTopFloor(
	segment: WorldState["specialLinks"][number],
): number {
	return segment.entryFloor + getSegmentSpan(segment) - 1;
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
	if (toFloor > fromFloor) return fromFloor === segment.entryFloor;
	return fromFloor === getSegmentTopFloor(segment);
}

function carrierReachesTransferFloor(
	carrier: WorldState["carriers"][number],
	floor: number,
): boolean {
	if (carrierCoversFloor(carrier, floor)) return true;
	const distance =
		floor < carrier.bottomServedFloor
			? carrier.bottomServedFloor - floor
			: floor - carrier.topServedFloor;
	return distance <= (carrier.carrierMode === 2 ? 4 : 6);
}

function getFloorSlotStatus(
	carrier: WorldState["carriers"][number],
	floor: number,
	directionFlag: number,
): number {
	const slot = floor - carrier.bottomServedFloor;
	const table =
		directionFlag === 0
			? carrier.primaryRouteStatusByFloor
			: carrier.secondaryRouteStatusByFloor;
	if (slot < 0 || slot >= table.length) return 0;
	return table[slot] ?? 0;
}

function carrierCoversFloor(
	carrier: WorldState["carriers"][number],
	floor: number,
): boolean {
	return floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
}
