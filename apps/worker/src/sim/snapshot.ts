import type { LedgerState } from "./ledger";
import { createLedgerState } from "./ledger";
import { LEGACY_VIP_TILE_TO_STANDARD } from "./resources";
import { createNewGameTimeState, type TimeState } from "./time";
import {
	createGateFlags,
	GRID_HEIGHT,
	GRID_WIDTH,
	MAX_SPECIAL_LINKS,
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
		startFloor: 0,
		heightMetric: 0,
		carrierId: -1,
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
			floorWalkabilityFlags: new Array(GRID_HEIGHT).fill(0),
			transferGroupCache: new Array(GRID_HEIGHT).fill(0),
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
			floorWalkabilityFlags: [],
			transferGroupCache: [],
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
	snapshot.world.width ??= GRID_WIDTH;
	snapshot.world.placedObjects ??= {};
	snapshot.world.sidecars ??= [];
	snapshot.world.entities ??= [];
	snapshot.world.gateFlags ??= createGateFlags();
	snapshot.world.carriers ??= [];
	if (snapshot.world.specialLinks.length === 0) {
		snapshot.world.specialLinks = createEmptySpecialLinks();
	}
	if (snapshot.world.floorWalkabilityFlags.length !== GRID_HEIGHT) {
		snapshot.world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);
	}
	if (snapshot.world.transferGroupCache.length !== GRID_HEIGHT) {
		snapshot.world.transferGroupCache = new Array(GRID_HEIGHT).fill(0);
	}

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

	return snapshot;
}
