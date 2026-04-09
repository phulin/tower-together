import { carrier_serves_floor } from "./carriers";
import {
	GRID_HEIGHT,
	MAX_SPECIAL_LINK_RECORDS,
	MAX_SPECIAL_LINKS,
	MAX_TRANSFER_GROUPS,
	type WorldState,
	yToFloor,
} from "./world";

const DERIVED_RECORD_CENTERS = [10, 24, 39, 54, 69, 84, 99];

export function rebuild_special_links(world: WorldState): void {
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
			flags: (span << 1) | (group.type === "escalator" ? 1 : 0),
			heightMetric: span,
			entryFloor,
			reservedByte: 0,
			descendingLoadCounter: 0,
			ascendingLoadCounter: 0,
		};
	}

	for (const [recordIndex, center] of DERIVED_RECORD_CENTERS.entries()) {
		if (recordIndex >= MAX_SPECIAL_LINK_RECORDS) break;
		const lowerFloor = scan_special_link_span_bound(world, center, 0);
		const upperFloor = scan_special_link_span_bound(world, center, 1);
		if (lowerFloor >= upperFloor) continue;
		world.specialLinkRecords[recordIndex] = {
			active: true,
			lowerFloor,
			upperFloor,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		};
	}
}

export function rebuild_walkability_flags(world: WorldState): void {
	world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);

	for (const segment of world.specialLinks) {
		if (!segment.active) continue;
		const bit = (segment.flags & 1) !== 0 ? 2 : 1;
		const topFloor = get_segment_top_floor(segment);
		for (let floor = segment.entryFloor; floor <= topFloor; floor++) {
			if (floor >= 0 && floor < GRID_HEIGHT) {
				world.floorWalkabilityFlags[floor] |= bit;
			}
		}
	}
}

export function rebuild_transfer_group_cache(world: WorldState): void {
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
		.filter(([, object]) => object.objectTypeCode === 24)
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
				if (!carrier_reaches_transfer_floor(carrier, floor)) continue;
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

	let entryCount = 0;
	for (const candidate of candidates) {
		let merged = false;
		for (let index = 0; index < entryCount; index++) {
			const entry = world.transferGroupEntries[index];
			if (!entry?.active) continue;
			if (entry.taggedFloor !== candidate.floor) continue;
			if ((entry.carrierMask & candidate.membershipMask) === 0) continue;
			entry.carrierMask |= candidate.membershipMask;
			merged = true;
			break;
		}
		if (merged) continue;
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
		rebuild_special_link_record_reachability(world, recordIndex, record);
	}
}

export function is_floor_span_walkable_for_local_route(
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

export function is_floor_span_walkable_for_express_route(
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

export function select_best_route_candidate(
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
			is_floor_span_walkable_for_local_route(world, fromFloor, toFloor)
		) {
			for (const [segmentIndex, segment] of world.specialLinks.entries()) {
				const cost = score_local_route_segment(segment, fromFloor, toFloor);
				if (cost >= 0x7fff) continue;
				bestSegment = tryCandidate(bestSegment, "segment", segmentIndex, cost);
			}
			if (bestSegment && bestSegment.cost < 0x280) return bestSegment;
		}

		for (const record of world.specialLinkRecords) {
			if (!record.active) continue;
			if (fromFloor < record.lowerFloor || fromFloor > record.upperFloor)
				continue;
			if (!derived_record_reaches_floor(record, toFloor)) continue;
			const candidateEntryFloors = get_derived_record_entry_floors(
				record,
				toFloor,
			);
			for (const adjacentFloor of candidateEntryFloors) {
				for (const [segmentIndex, segment] of world.specialLinks.entries()) {
					const cost = score_local_route_segment(
						segment,
						fromFloor,
						adjacentFloor,
					);
					if (cost >= 0x280) continue;
					bestSegment = tryCandidate(
						bestSegment,
						"segment",
						segmentIndex,
						cost,
					);
				}
			}
		}
		if (bestSegment) return bestSegment;
	} else if (
		delta === 1 ||
		is_floor_span_walkable_for_express_route(world, fromFloor, toFloor)
	) {
		for (const [segmentIndex, segment] of world.specialLinks.entries()) {
			const cost = score_express_route_segment(segment, fromFloor, toFloor);
			if (cost >= 0x7fff) continue;
			bestSegment = tryCandidate(bestSegment, "segment", segmentIndex, cost);
		}
		if (bestSegment) return bestSegment;
	}

	for (const carrier of world.carriers) {
		if (
			preferLocalMode ? carrier.carrierMode === 2 : carrier.carrierMode !== 2
		) {
			continue;
		}
		const directCost = score_carrier_direct_route(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
		);
		if (directCost < 0x7fff) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				directCost,
			);
		}

		const transferCost = score_carrier_transfer_route(
			world,
			carrier.carrierId,
			fromFloor,
			toFloor,
			preferLocalMode,
		);
		if (transferCost < 0x7fff) {
			bestCarrier = tryCandidate(
				bestCarrier,
				"carrier",
				carrier.carrierId,
				transferCost,
			);
		}
	}

	return bestCarrier;
}

function score_local_route_segment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): number {
	if (!segment.active) return 0x7fff;
	if (!segment_covers_floor(segment, fromFloor)) return 0x7fff;
	if (!segment_covers_floor(segment, toFloor)) return 0x7fff;
	if (!can_enter_segment_from_floor(segment, fromFloor, toFloor)) return 0x7fff;
	const delta = Math.abs(toFloor - fromFloor);
	return (segment.flags & 1) !== 0 ? delta * 8 + 0x280 : delta * 8;
}

function score_express_route_segment(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): number {
	if (!segment.active) return 0x7fff;
	if ((segment.flags & 1) === 0) return 0x7fff;
	if (!segment_covers_floor(segment, fromFloor)) return 0x7fff;
	if (!segment_covers_floor(segment, toFloor)) return 0x7fff;
	if (!can_enter_segment_from_floor(segment, fromFloor, toFloor)) return 0x7fff;
	return Math.abs(toFloor - fromFloor) * 8 + 0x280;
}

function score_carrier_direct_route(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return 0x7fff;
	if (!carrier_serves_floor(carrier, fromFloor)) return 0x7fff;
	if (!carrier_serves_floor(carrier, toFloor)) return 0x7fff;
	const status = get_floor_slot_status(
		carrier,
		fromFloor,
		toFloor > fromFloor ? 0 : 1,
	);
	const delta = Math.abs(toFloor - fromFloor);
	return status === 0x28 ? 1000 + delta * 8 : delta * 8 + 0x280;
}

function score_carrier_transfer_route(
	world: WorldState,
	carrierId: number,
	fromFloor: number,
	toFloor: number,
	preferLocalMode: boolean,
): number {
	const carrier = world.carriers.find(
		(candidate) => candidate.carrierId === carrierId,
	);
	if (!carrier) return 0x7fff;
	if (!carrier_serves_floor(carrier, fromFloor)) return 0x7fff;
	const reachable = world.transferGroupEntries.some((entry) => {
		if (!entry.active) return false;
		if ((entry.carrierMask & (1 << carrierId)) === 0) return false;
		return entry_reaches_destination_floor(
			world,
			entry,
			toFloor,
			preferLocalMode,
		);
	});
	if (!reachable) return 0x7fff;
	const status = get_floor_slot_status(
		carrier,
		fromFloor,
		toFloor > fromFloor ? 0 : 1,
	);
	const delta = Math.abs(toFloor - fromFloor);
	return status === 0x28 ? 6000 + delta * 8 : delta * 8 + 3000;
}

function scan_special_link_span_bound(
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

	for (let floor = centerFloor - 1; floor > centerFloor - 6; floor--) {
		const flags = world.floorWalkabilityFlags[floor] ?? 0;
		if (flags === 0) return floor + 1;
		if ((flags & 1) === 0) seenGap = true;
		if (seenGap && floor < centerFloor - 3) return floor + 1;
	}
	return centerFloor - 6;
}

function rebuild_special_link_record_reachability(
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
			if (carrier_serves_floor(carrier, floor)) {
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

function derived_record_reaches_floor(
	record: WorldState["specialLinkRecords"][number],
	targetFloor: number,
): boolean {
	if (targetFloor >= record.lowerFloor && targetFloor <= record.upperFloor)
		return true;
	return (record.reachabilityMasksByFloor[targetFloor] ?? 0) !== 0;
}

function get_derived_record_entry_floors(
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

function entry_reaches_destination_floor(
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
		if (carrier_serves_floor(carrier, toFloor)) return true;
	}
	for (
		let recordIndex = 0;
		recordIndex < MAX_SPECIAL_LINK_RECORDS;
		recordIndex++
	) {
		if ((entry.carrierMask & (1 << (24 + recordIndex))) === 0) continue;
		const record = world.specialLinkRecords[recordIndex];
		if (!record?.active) continue;
		if (derived_record_reaches_floor(record, toFloor)) return true;
	}
	return false;
}

function get_segment_span(segment: WorldState["specialLinks"][number]): number {
	return segment.flags >> 1;
}

function get_segment_top_floor(
	segment: WorldState["specialLinks"][number],
): number {
	return segment.entryFloor + get_segment_span(segment) - 1;
}

function segment_covers_floor(
	segment: WorldState["specialLinks"][number],
	floor: number,
): boolean {
	return floor >= segment.entryFloor && floor <= get_segment_top_floor(segment);
}

function can_enter_segment_from_floor(
	segment: WorldState["specialLinks"][number],
	fromFloor: number,
	toFloor: number,
): boolean {
	if (toFloor > fromFloor) return fromFloor === segment.entryFloor;
	return fromFloor === get_segment_top_floor(segment);
}

function carrier_reaches_transfer_floor(
	carrier: WorldState["carriers"][number],
	floor: number,
): boolean {
	if (carrier_covers_floor(carrier, floor)) return true;
	const distance =
		floor < carrier.bottomServedFloor
			? carrier.bottomServedFloor - floor
			: floor - carrier.topServedFloor;
	return distance <= (carrier.carrierMode === 2 ? 4 : 6);
}

function get_floor_slot_status(
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

function carrier_covers_floor(
	carrier: WorldState["carriers"][number],
	floor: number,
): boolean {
	return floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
}
