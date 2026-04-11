import { init_carrier_state } from "./carriers";
import { rebuild_runtime_entities } from "./entities";
import type { LedgerState } from "./ledger";
import { createLedgerState } from "./ledger";
import { LEGACY_TILE_ALIASES, LEGACY_VIP_TILE_TO_STANDARD } from "./resources";
import { RingBuffer } from "./ring-buffer";
import {
	rebuild_special_links,
	rebuild_transfer_group_cache,
	rebuild_walkability_flags,
} from "./routing";
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
			parkingDemandLog: [],
			eventState: createEventState(),
			pendingNotifications: [],
			pendingPrompts: [],
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

function normalizeLegacyTileNames(snapshot: SimSnapshot): void {
	for (const key of Object.keys(snapshot.world.cells)) {
		const tileType = snapshot.world.cells[key];
		snapshot.world.cells[key] = LEGACY_TILE_ALIASES[tileType] ?? tileType;
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
			parkingDemandLog: [],
			eventState: createEventState(),
			pendingNotifications: [],
			pendingPrompts: [],
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
	normalizeLegacyTileNames(snapshot);

	const legacyLedger = snapshot.ledger as unknown as Record<string, unknown>;
	if (
		!("populationLedger" in legacyLedger) &&
		"primaryLedger" in legacyLedger
	) {
		legacyLedger.populationLedger = legacyLedger.primaryLedger;
	}
	if (!("incomeLedger" in legacyLedger) && "secondaryLedger" in legacyLedger) {
		legacyLedger.incomeLedger = legacyLedger.secondaryLedger;
	}
	if (!("expenseLedger" in legacyLedger) && "tertiaryLedger" in legacyLedger) {
		legacyLedger.expenseLedger = legacyLedger.tertiaryLedger;
	}

	for (const record of Object.values(snapshot.world.placedObjects)) {
		const legacyRecord = record as unknown as Record<string, unknown>;
		if (!("unitStatus" in legacyRecord) && "stayPhase" in legacyRecord) {
			legacyRecord.unitStatus = legacyRecord.stayPhase;
		}
		if (
			!("evalActiveFlag" in legacyRecord) &&
			"pairingActiveFlag" in legacyRecord
		) {
			legacyRecord.evalActiveFlag = legacyRecord.pairingActiveFlag;
		}
		if (!("evalLevel" in legacyRecord) && "pairingStatus" in legacyRecord) {
			legacyRecord.evalLevel = legacyRecord.pairingStatus;
		}
		if (!("rentLevel" in legacyRecord) && "variantIndex" in legacyRecord) {
			legacyRecord.rentLevel = legacyRecord.variantIndex;
		}
	}

	if (snapshot.world.height < GRID_HEIGHT) snapshot.world.height = GRID_HEIGHT;
	if (!snapshot.world.width || snapshot.world.width < GRID_WIDTH)
		snapshot.world.width = GRID_WIDTH;
	snapshot.world.placedObjects ??= {};
	snapshot.world.sidecars ??= [];
	snapshot.world.entities ??= [];
	snapshot.world.gateFlags ??= createGateFlags();
	const gateFlags = snapshot.world.gateFlags as unknown as Record<
		string,
		unknown
	>;
	if (!("recyclingAdequate" in gateFlags) && "securityAdequate" in gateFlags) {
		gateFlags.recyclingAdequate = gateFlags.securityAdequate;
	}
	if (
		!("recyclingCenterCount" in gateFlags) &&
		"securityLedgerScale" in gateFlags
	) {
		gateFlags.recyclingCenterCount = gateFlags.securityLedgerScale;
	}
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
	snapshot.world.eventState.bombSearchLowerBound ??= -1;
	snapshot.world.eventState.bombSearchUpperBound ??= -1;
	snapshot.world.eventState.bombSearchCurrentFloor ??= -1;
	snapshot.world.eventState.bombSearchScanTile ??= -1;
	snapshot.world.eventState.pendingCarrierEditColumn ??= -1;
	snapshot.ledger.populationLedger ??= new Array(256).fill(0);
	snapshot.ledger.incomeLedger ??= new Array(256).fill(0);
	snapshot.ledger.expenseLedger ??= new Array(256).fill(0);
	snapshot.world.gateFlags.family345SaleCount ??= 0;
	snapshot.world.gateFlags.newspaperTrigger ??= 0;

	for (const sidecar of snapshot.world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		sidecar.familySelectorOrSingleLinkFlag ??= 0xff;
		sidecar.linkPhaseState ??= 0;
		sidecar.pendingTransitionFlag ??= 0;
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

	// Migrate carrier floorQueues from old flat format to RingBuffer instances
	for (const carrier of snapshot.world.carriers) {
		for (let i = 0; i < carrier.floorQueues.length; i++) {
			const q = carrier.floorQueues[i] as unknown as Record<string, unknown>;
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

export function hydrateSnapshot(raw: SimSnapshot): SimSnapshot {
	const snapshot = normalizeSnapshot(raw);

	if (snapshot.world.height < GRID_HEIGHT) snapshot.world.height = GRID_HEIGHT;
	snapshot.world.placedObjects ??= {};
	snapshot.world.sidecars ??= [];
	snapshot.world.entities ??= [];

	if (!snapshot.ledger) {
		const legacyWorld = snapshot.world as unknown as Record<string, unknown>;
		const cash = (legacyWorld.cash as number) ?? 2_000_000;
		snapshot.ledger = createLedgerState(cash);
		delete (snapshot.world as unknown as Record<string, unknown>).cash;
	}

	init_carrier_state(snapshot.world);
	for (const carrier of snapshot.world.carriers) {
		carrier.completedRouteIds ??= [];
		if (
			!Array.isArray(carrier.dwellMultiplierFlags) ||
			carrier.dwellMultiplierFlags.length !== 14
		) {
			carrier.dwellMultiplierFlags = new Array(14).fill(1);
		}
		for (const route of carrier.pendingRoutes ?? []) {
			route.assignedCarIndex ??= -1;
		}
		for (const car of carrier.cars ?? []) {
			car.active ??= true;
			car.pendingAssignmentCount ??= 0;
			car.homeFloor ??= car.currentFloor ?? carrier.bottomServedFloor;
			car.destinationCountByFloor ??= new Array(
				Math.max(0, carrier.topServedFloor - carrier.bottomServedFloor + 1),
			).fill(0);
			car.activeRouteSlots ??= [];
		}
	}

	snapshot.world.specialLinks ??= createEmptySpecialLinks();
	snapshot.world.specialLinkRecords ??= createEmptySpecialLinkRecords();
	snapshot.world.transferGroupEntries ??= createEmptyTransferGroupEntries();
	snapshot.world.parkingDemandLog ??= [];
	for (const entity of snapshot.world.entities) {
		entity.routeRetryDelay ??= 0;
	}
	snapshot.world.eventState ??= createEventState();

	rebuild_special_links(snapshot.world);
	rebuild_walkability_flags(snapshot.world);
	rebuild_transfer_group_cache(snapshot.world);
	rebuild_runtime_entities(snapshot.world);

	return snapshot;
}

export function serializeSimState(
	time: TimeState,
	world: WorldState,
	ledger: LedgerState,
): SimSnapshot {
	return {
		time: { ...time },
		world: {
			towerId: world.towerId,
			name: world.name,
			width: world.width,
			height: world.height,
			gateFlags: { ...world.gateFlags },
			cells: { ...world.cells },
			cellToAnchor: { ...world.cellToAnchor },
			overlays: { ...world.overlays },
			overlayToAnchor: { ...world.overlayToAnchor },
			placedObjects: JSON.parse(
				JSON.stringify(world.placedObjects),
			) as WorldState["placedObjects"],
			sidecars: JSON.parse(
				JSON.stringify(world.sidecars),
			) as WorldState["sidecars"],
			entities: JSON.parse(
				JSON.stringify(world.entities),
			) as WorldState["entities"],
			carriers: JSON.parse(
				JSON.stringify(world.carriers),
			) as WorldState["carriers"],
			specialLinks: JSON.parse(
				JSON.stringify(world.specialLinks),
			) as WorldState["specialLinks"],
			specialLinkRecords: JSON.parse(
				JSON.stringify(world.specialLinkRecords),
			) as WorldState["specialLinkRecords"],
			floorWalkabilityFlags: [...world.floorWalkabilityFlags],
			transferGroupEntries: JSON.parse(
				JSON.stringify(world.transferGroupEntries),
			) as WorldState["transferGroupEntries"],
			transferGroupCache: [...world.transferGroupCache],
			parkingDemandLog: [...world.parkingDemandLog],
			eventState: JSON.parse(
				JSON.stringify(world.eventState),
			) as WorldState["eventState"],
			pendingNotifications: [],
			pendingPrompts: [],
		},
		ledger: {
			cashBalance: ledger.cashBalance,
			populationLedger: [...ledger.populationLedger],
			incomeLedger: [...ledger.incomeLedger],
			expenseLedger: [...ledger.expenseLedger],
			cashBalanceCycleBase: ledger.cashBalanceCycleBase,
		},
	};
}
