import type { LedgerState } from "./ledger";
import { createLedgerState } from "./ledger";
import { LEGACY_VIP_TILE_TO_STANDARD } from "./resources";
import { RingBuffer } from "./ring-buffer";
import { createNewGameTimeState, type TimeState } from "./time";
import {
	createEventState,
	createGateFlags,
	GRID_HEIGHT,
	GRID_WIDTH,
	MAX_SPECIAL_LINK_RECORDS,
	MAX_SPECIAL_LINKS,
	MAX_TRANSFER_GROUPS,
	type WorldState,
} from "./world";

export interface SimSnapshot {
	time: TimeState;
	world: WorldState;
	ledger: LedgerState;
}

function createEmptySpecialLinks(): WorldState["specialLinks"] {
	return Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
		active: false,
		flags: 0,
		heightMetric: 0,
		entryFloor: 0,
		reservedByte: 0,
		descendingLoadCounter: 0,
		ascendingLoadCounter: 0,
	}));
}

function createEmptySpecialLinkRecords(): WorldState["specialLinkRecords"] {
	return Array.from({ length: MAX_SPECIAL_LINK_RECORDS }, () => ({
		active: false,
		lowerFloor: 0,
		upperFloor: 0,
		reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
	}));
}

function createEmptyTransferGroupEntries(): WorldState["transferGroupEntries"] {
	return Array.from({ length: MAX_TRANSFER_GROUPS }, () => ({
		active: false,
		taggedFloor: -1,
		carrierMask: 0,
	}));
}

export function createInitialSnapshot(
	towerId: string,
	name: string,
	startingCash: number,
): SimSnapshot {
	return {
		time: createNewGameTimeState(),
		world: {
			towerId,
			name,
			width: GRID_WIDTH,
			height: GRID_HEIGHT,
			gateFlags: createGateFlags(),
			cells: {},
			cellToAnchor: {},
			overlays: {},
			overlayToAnchor: {},
			placedObjects: {},
			sidecars: [],
			entities: [],
			carriers: [],
			specialLinks: createEmptySpecialLinks(),
			specialLinkRecords: createEmptySpecialLinkRecords(),
			floorWalkabilityFlags: new Array(GRID_HEIGHT).fill(0),
			transferGroupEntries: createEmptyTransferGroupEntries(),
			transferGroupCache: new Array(GRID_HEIGHT).fill(0),
			eventState: createEventState(),
		},
		ledger: createLedgerState(startingCash),
	};
}

function snakeToCamel(s: string): string {
	return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function renameKeysShallow(obj: unknown): void {
	if (!obj || typeof obj !== "object") return;
	const record = obj as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!key.includes("_")) continue;
		const camelKey = snakeToCamel(key);
		if (!(camelKey in record)) record[camelKey] = record[key];
		delete record[key];
	}
}

function renameKeysDeep(obj: unknown): void {
	if (!obj || typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (const item of obj) renameKeysDeep(item);
		return;
	}
	const record = obj as Record<string, unknown>;
	renameKeysShallow(record);
	for (const value of Object.values(record)) renameKeysDeep(value);
}

function migrateSnakeToCamel(snapshot: SimSnapshot): void {
	if (snapshot.time) renameKeysShallow(snapshot.time);
	if (snapshot.ledger) renameKeysShallow(snapshot.ledger);
	if (!snapshot.world) return;

	const world = snapshot.world as unknown as Record<string, unknown>;
	const skipKeys = new Set([
		"cells",
		"overlays",
		"cellToAnchor",
		"overlayToAnchor",
	]);
	renameKeysShallow(world);
	for (const [key, value] of Object.entries(world)) {
		if (!skipKeys.has(key)) renameKeysDeep(value);
	}
}

export function normalizeSnapshot(raw: SimSnapshot): SimSnapshot {
	const snapshot = raw;
	const old = snapshot as unknown as Record<string, unknown>;

	if (!snapshot.world) {
		snapshot.world = {
			towerId: old.towerId as string,
			name: old.name as string,
			width: (old.width as number) ?? GRID_WIDTH,
			height: (old.height as number) ?? GRID_HEIGHT,
			gateFlags: createGateFlags(),
			cells: (old.cells as Record<string, string>) ?? {},
			cellToAnchor: (old.cellToAnchor as Record<string, string>) ?? {},
			overlays: (old.overlays as Record<string, string>) ?? {},
			overlayToAnchor: (old.overlayToAnchor as Record<string, string>) ?? {},
			placedObjects: {},
			sidecars: [],
			entities: [],
			carriers: [],
			specialLinks: [],
			specialLinkRecords: [],
			floorWalkabilityFlags: [],
			transferGroupEntries: [],
			transferGroupCache: [],
			eventState: createEventState(),
		};
	}

	if (!snapshot.ledger) {
		snapshot.ledger = createLedgerState((old.cash as number) ?? 2_000_000);
	}

	if (!snapshot.time) {
		snapshot.time = {
			dayTick: 0,
			daypartIndex: 0,
			dayCounter: 0,
			calendarPhaseFlag: 0,
			starCount: 1,
			totalTicks: (old.simTime as number) ?? 0,
		};
	}

	migrateSnakeToCamel(snapshot);

	if (snapshot.world.height < GRID_HEIGHT) snapshot.world.height = GRID_HEIGHT;
	if (!snapshot.world.width || snapshot.world.width < GRID_WIDTH)
		snapshot.world.width = GRID_WIDTH;
	snapshot.world.placedObjects ??= {};
	snapshot.world.sidecars ??= [];
	snapshot.world.entities ??= [];
	snapshot.world.gateFlags ??= createGateFlags();
	snapshot.world.carriers ??= [];
	if (snapshot.world.specialLinks.length === 0) {
		snapshot.world.specialLinks = createEmptySpecialLinks();
	}
	if (snapshot.world.specialLinkRecords.length === 0) {
		snapshot.world.specialLinkRecords = createEmptySpecialLinkRecords();
	}
	if (snapshot.world.floorWalkabilityFlags.length !== GRID_HEIGHT) {
		snapshot.world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);
	}
	if (snapshot.world.transferGroupEntries.length === 0) {
		snapshot.world.transferGroupEntries = createEmptyTransferGroupEntries();
	}
	if (snapshot.world.transferGroupCache.length !== GRID_HEIGHT) {
		snapshot.world.transferGroupCache = new Array(GRID_HEIGHT).fill(0);
	}
	snapshot.world.eventState ??= createEventState();

	const vipAnchors = new Set<string>();
	for (const [key, tileType] of Object.entries(snapshot.world.cells)) {
		const standardTile = LEGACY_VIP_TILE_TO_STANDARD[tileType];
		if (!standardTile) continue;
		snapshot.world.cells[key] = standardTile;
		const anchorKey = snapshot.world.cellToAnchor[key] ?? key;
		vipAnchors.add(anchorKey);
	}

	for (const [anchorKey, record] of Object.entries(
		snapshot.world.placedObjects,
	)) {
		if (record.objectTypeCode === 31) record.objectTypeCode = 3;
		if (record.objectTypeCode === 32) record.objectTypeCode = 4;
		if (record.objectTypeCode === 33) record.objectTypeCode = 5;
		if (vipAnchors.has(anchorKey)) record.vipFlag = true;
	}

	// Migrate carrier floorQueues from old flat format to RingBuffer instances
	for (const carrier of snapshot.world.carriers) {
		for (let i = 0; i < carrier.floorQueues.length; i++) {
			const q = carrier.floorQueues[i] as Record<string, unknown>;
			if (q && !(q.up instanceof RingBuffer)) {
				// Old format: {upCount, upHeadIndex, downCount, downHeadIndex, upQueueRouteIds, downQueueRouteIds}
				// New format: {up: RingBuffer, down: RingBuffer}
				if ("upQueueRouteIds" in q) {
					const upBuf = RingBuffer.from({
						items: q.upQueueRouteIds as string[],
						head: (q.upHeadIndex as number) ?? 0,
						count: (q.upCount as number) ?? 0,
					});
					const downBuf = RingBuffer.from({
						items: q.downQueueRouteIds as string[],
						head: (q.downHeadIndex as number) ?? 0,
						count: (q.downCount as number) ?? 0,
					});
					carrier.floorQueues[i] = { up: upBuf, down: downBuf };
				} else if ("up" in q && "down" in q) {
					// Already new shape but plain objects from JSON deserialization
					carrier.floorQueues[i] = {
						up: RingBuffer.from(
							q.up as { items: string[]; head: number; count: number },
						),
						down: RingBuffer.from(
							q.down as { items: string[]; head: number; count: number },
						),
					};
				}
			}
		}
	}

	return snapshot;
}
