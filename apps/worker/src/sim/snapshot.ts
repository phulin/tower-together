import { initCarrierState } from "./carriers";
import type { LedgerState } from "./ledger";
import { createLedgerState } from "./ledger";
import { RouteRequestRing } from "./queue/route-record";
import {
	rebuildRouteReachabilityTables,
	rebuildTransferGroupCache,
} from "./reachability/rebuild-tables";
import { rebuildSpecialLinkRouteRecords } from "./reachability/special-link-records";
import {
	FAMILY_METRO_TOP,
	LEGACY_TILE_ALIASES,
	LEGACY_VIP_TILE_TO_STANDARD,
} from "./resources";
import { rebuildRuntimeSims } from "./sims";
import { createNewGameTimeState, type TimeState } from "./time";
import {
	createCommercialVenueBuckets,
	createEventState,
	createGateFlags,
	createMedicalServiceSlots,
	DEFAULT_LOBBY_MODE,
	GRID_HEIGHT,
	GRID_WIDTH,
	type LobbyMode,
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
	lobbyMode: LobbyMode = DEFAULT_LOBBY_MODE,
): SimSnapshot {
	return {
		time: createNewGameTimeState(),
		world: {
			towerId,
			name,
			width: GRID_WIDTH,
			height: GRID_HEIGHT,
			lobbyHeight: 1,
			lobbyMode,
			gateFlags: createGateFlags(),
			cells: {},
			cellToAnchor: {},
			overlays: {},
			overlayToAnchor: {},
			placedObjects: {},
			sidecars: [],
			sims: [],
			carriers: [],
			specialLinks: createEmptySpecialLinks(),
			specialLinkRecords: createEmptySpecialLinkRecords(),
			floorWalkabilityFlags: new Array(GRID_HEIGHT).fill(0),
			transferGroupEntries: createEmptyTransferGroupEntries(),
			transferGroupCache: new Array(GRID_HEIGHT).fill(0),
			parkingDemandLog: [],
			medicalServiceSlots: createMedicalServiceSlots(),
			starCount: 1,
			currentPopulation: 0,
			currentPopulationBuckets: {},
			commercialVenueBuckets: createCommercialVenueBuckets(),
			rngState: 1,
			rngCallCount: 0,
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
			lobbyHeight: (old.lobbyHeight as number) ?? 1,
			lobbyMode: (old.lobbyMode as LobbyMode) ?? "perfect-parity",
			gateFlags: createGateFlags(),
			cells: (old.cells as Record<string, string>) ?? {},
			cellToAnchor: (old.cellToAnchor as Record<string, string>) ?? {},
			overlays: (old.overlays as Record<string, string>) ?? {},
			overlayToAnchor: (old.overlayToAnchor as Record<string, string>) ?? {},
			placedObjects: {},
			sidecars: [],
			sims: [],
			carriers: [],
			specialLinks: [],
			specialLinkRecords: [],
			floorWalkabilityFlags: [],
			transferGroupEntries: [],
			transferGroupCache: [],
			parkingDemandLog: [],
			medicalServiceSlots: createMedicalServiceSlots(),
			starCount: 1,
			currentPopulation: 0,
			currentPopulationBuckets: {},
			commercialVenueBuckets: createCommercialVenueBuckets(),
			rngState: 1,
			rngCallCount: 0,
			eventState: createEventState(),
			pendingNotifications: [],
			pendingPrompts: [],
		};
	}
	if (!snapshot.world.commercialVenueBuckets) {
		snapshot.world.commercialVenueBuckets = createCommercialVenueBuckets();
	}

	if (!snapshot.ledger) {
		snapshot.ledger = createLedgerState((old.cash as number) ?? 2_000_000);
	}

	if (!snapshot.time) {
		snapshot.time = {
			dayTick: 0,
			daypartIndex: 0,
			dayCounter: 0,
			weekendFlag: 0,
			totalTicks: (old.simTime as number) ?? 0,
		};
	}

	migrateSnakeToCamel(snapshot);

	// Migrate starCount from time → world (legacy snapshots stored it in time)
	const legacyTime = snapshot.time as unknown as Record<string, unknown>;
	if ("starCount" in legacyTime) {
		snapshot.world.starCount ??= legacyTime.starCount as number;
		delete legacyTime.starCount;
	}

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
			!("occupiableFlag" in legacyRecord) &&
			"pairingActiveFlag" in legacyRecord
		) {
			legacyRecord.occupiableFlag = legacyRecord.pairingActiveFlag;
		}
		if (
			!("occupiableFlag" in legacyRecord) &&
			"evalActiveFlag" in legacyRecord
		) {
			legacyRecord.occupiableFlag = legacyRecord.evalActiveFlag;
		}
		if ("occupiableFlag" in legacyRecord) {
			// Legacy snapshots used a single occupiableFlag that conflated
			// binary +0x13 (dirty / cashflow) and +0x14 (occupied / scored).
			// Default both to the legacy value so existing saves keep behavior.
			if (!("dirtyFlag" in legacyRecord)) {
				legacyRecord.dirtyFlag = legacyRecord.occupiableFlag;
			}
			if (!("occupiedFlag" in legacyRecord)) {
				legacyRecord.occupiedFlag = legacyRecord.occupiableFlag;
			}
			delete legacyRecord.occupiableFlag;
		}
		if (!("dirtyFlag" in legacyRecord)) {
			legacyRecord.dirtyFlag = 1;
		}
		if (!("occupiedFlag" in legacyRecord)) {
			legacyRecord.occupiedFlag = 1;
		}
		if (!("evalLevel" in legacyRecord) && "pairingStatus" in legacyRecord) {
			legacyRecord.evalLevel = legacyRecord.pairingStatus;
		}
		if (!("rentLevel" in legacyRecord) && "variantIndex" in legacyRecord) {
			legacyRecord.rentLevel = legacyRecord.variantIndex;
		}
		if (!("evalScore" in legacyRecord)) {
			legacyRecord.evalScore = -1;
		}
	}

	if (snapshot.world.height < GRID_HEIGHT) snapshot.world.height = GRID_HEIGHT;
	if (!snapshot.world.width || snapshot.world.width < GRID_WIDTH)
		snapshot.world.width = GRID_WIDTH;
	snapshot.world.lobbyHeight ??= 1;
	// Pre-existing snapshots predate the lobbyMode flag; preserve their
	// floor-14 sky-lobby positions by defaulting to perfect-parity.
	snapshot.world.lobbyMode ??= "perfect-parity";
	snapshot.world.placedObjects ??= {};
	snapshot.world.sidecars ??= [];
	const legacyWorld = snapshot.world as unknown as Record<string, unknown>;
	if (!("sims" in legacyWorld) && Array.isArray(legacyWorld.entities)) {
		legacyWorld.sims = legacyWorld.entities;
	}
	snapshot.world.sims ??= [];
	snapshot.world.gateFlags ??= createGateFlags();
	const gateFlags = snapshot.world.gateFlags as unknown as Record<
		string,
		unknown
	>;
	gateFlags.metroStationFloorIndex ??= -1;
	if (!("evalSimIndex" in gateFlags) && "evalEntityIndex" in gateFlags) {
		gateFlags.evalSimIndex = gateFlags.evalEntityIndex;
	}
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
	snapshot.world.starCount ??= 1;
	snapshot.world.currentPopulation ??= 0;
	snapshot.world.currentPopulationBuckets ??= {};
	snapshot.world.rngState ??= 1;
	snapshot.world.rngCallCount ??= 0;
	snapshot.world.eventState ??= createEventState();
	snapshot.world.eventState.bombSearchLowerBound ??= -1;
	snapshot.world.eventState.bombSearchUpperBound ??= -1;
	snapshot.world.eventState.bombSearchCurrentFloor ??= -1;
	snapshot.world.eventState.bombSearchScanTile ??= -1;
	snapshot.world.eventState.pendingCarrierEditColumn ??= -1;
	snapshot.world.eventState.pendingCarrierEditY ??= -1;
	snapshot.world.eventState.fireRescueHelpers ??= [];
	snapshot.ledger.populationLedger ??= new Array(256).fill(0);
	snapshot.ledger.incomeLedger ??= new Array(256).fill(0);
	snapshot.ledger.expenseLedger ??= new Array(256).fill(0);
	snapshot.world.gateFlags.family345SaleCount ??= 0;
	snapshot.world.gateFlags.newspaperTrigger ??= 0;
	snapshot.world.gateFlags.officeServiceOkMedical ??= 0;
	snapshot.world.gateFlags.securityPlaced ??= 0;
	if (
		!Array.isArray(snapshot.world.medicalServiceSlots) ||
		snapshot.world.medicalServiceSlots.length === 0
	) {
		snapshot.world.medicalServiceSlots = createMedicalServiceSlots();
	}

	for (const sidecar of snapshot.world.sidecars) {
		if (sidecar.kind === "commercial_venue") {
			sidecar.currentPopulation ??= 0;
			sidecar.lastAcquireTick ??= 0;
			sidecar.eligibilityThreshold ??= 0;
			sidecar.remainingCapacity ??= 0;
			sidecar.phaseASeed ??= 0;
			sidecar.phaseBSeed ??= 0;
			sidecar.overrideSeed ??= 0;
			sidecar.acquireCount ??= 0;
			continue;
		}
		if (sidecar.kind === "medical_center") {
			sidecar.pendingVisitorsCount ??= 0;
			continue;
		}
		if (sidecar.kind !== "entertainment_link") continue;
		sidecar.familySelectorOrSingleLinkFlag ??= 0xff;
		sidecar.linkPhaseState ??= 0;
		sidecar.pendingTransitionFlag ??= 0;
		// Migrate forwardBudget/reverseBudget → upperBudget/lowerBudget
		const legacy = sidecar as unknown as Record<string, unknown>;
		if ("forwardBudget" in legacy) {
			sidecar.upperBudget = legacy.forwardBudget as number;
			delete legacy.forwardBudget;
		}
		if ("reverseBudget" in legacy) {
			sidecar.lowerBudget = legacy.reverseBudget as number;
			delete legacy.reverseBudget;
		}
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
		if (vipAnchors.has(anchorKey)) {
			if (record.objectTypeCode === 31) record.objectTypeCode = 3;
			if (record.objectTypeCode === 32) record.objectTypeCode = 4;
			if (record.objectTypeCode === 33) record.objectTypeCode = 5;
			record.vipFlag = true;
		}
	}
	snapshot.world.gateFlags.metroPlaced = 0;
	snapshot.world.gateFlags.metroStationFloorIndex = -1;
	for (const [key, record] of Object.entries(snapshot.world.placedObjects)) {
		if (record.objectTypeCode !== FAMILY_METRO_TOP) continue;
		const [, y] = key.split(",").map(Number);
		snapshot.world.gateFlags.metroPlaced = 1;
		snapshot.world.gateFlags.metroStationFloorIndex = GRID_HEIGHT - 1 - y;
		break;
	}

	// Migrate carrier floorQueues from old flat format to RouteRequestRing instances
	for (const carrier of snapshot.world.carriers) {
		for (const car of carrier.cars) {
			car.dwellStartPendingAssignmentCount ??= 0;
			car.arrivalDispatchThisTick ??= false;
			car.arrivalDispatchStartingAssignedCount ??= 0;
			car.suppressDwellOppositeDirectionFlip ??= false;
		}
		for (let i = 0; i < carrier.floorQueues.length; i++) {
			const q = carrier.floorQueues[i] as unknown as Record<string, unknown>;
			if (q && !(q.up instanceof RouteRequestRing)) {
				// Old format: {upCount, upHeadIndex, downCount, downHeadIndex, upQueueRouteIds, downQueueRouteIds}
				// New format: {up: RouteRequestRing, down: RouteRequestRing}
				if ("upQueueRouteIds" in q) {
					const upBuf = RouteRequestRing.from({
						items: q.upQueueRouteIds as string[],
						head: (q.upHeadIndex as number) ?? 0,
						count: (q.upCount as number) ?? 0,
					});
					const downBuf = RouteRequestRing.from({
						items: q.downQueueRouteIds as string[],
						head: (q.downHeadIndex as number) ?? 0,
						count: (q.downCount as number) ?? 0,
					});
					carrier.floorQueues[i] = { up: upBuf, down: downBuf };
				} else if ("up" in q && "down" in q) {
					// Already new shape but plain objects from JSON deserialization
					carrier.floorQueues[i] = {
						up: RouteRequestRing.from(
							q.up as { items: string[]; head: number; count: number },
						),
						down: RouteRequestRing.from(
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
	snapshot.world.sims ??= [];

	if (!snapshot.ledger) {
		const legacyWorld = snapshot.world as unknown as Record<string, unknown>;
		const cash = (legacyWorld.cash as number) ?? 2_000_000;
		snapshot.ledger = createLedgerState(cash);
		delete (snapshot.world as unknown as Record<string, unknown>).cash;
	}

	initCarrierState(snapshot.world);
	for (const carrier of snapshot.world.carriers) {
		carrier.completedRouteIds ??= [];
		carrier.suppressedFloorAssignments ??= [];
		const numSlots = Math.max(
			0,
			carrier.topServedFloor - carrier.bottomServedFloor + 1,
		);
		if (
			!Array.isArray(carrier.stopFloorEnabled) ||
			carrier.stopFloorEnabled.length !== numSlots
		) {
			carrier.stopFloorEnabled = new Array(numSlots).fill(1);
		}
		if (
			!Array.isArray(carrier.dwellDelay) ||
			carrier.dwellDelay.length !== 14
		) {
			carrier.dwellDelay = new Array(14).fill(0);
		}
		for (const route of carrier.pendingRoutes ?? []) {
			route.assignedCarIndex ??= -1;
		}
		for (const car of carrier.cars ?? []) {
			car.active ??= true;
			car.pendingAssignmentCount ??= 0;
			car.homeFloor ??= car.currentFloor ?? carrier.bottomServedFloor;
			car.nearestWorkFloor ??= car.homeFloor;
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
	for (const sim of snapshot.world.sims) {
		sim.elapsedTicks ??= 0;
		sim.targetRoomFloor ??= -1;
		sim.targetRoomColumn ??= -1;
		sim.spawnFloor ??= sim.floorAnchor;
		sim.postClaimCountdown ??= 0;
		sim.encodedTargetFloor ??= 0;
		// Migrate old fields away
		const raw = sim as unknown as Record<string, unknown>;
		delete raw.stressCounter;
		delete raw.visitCounter;
	}
	for (const obj of Object.values(snapshot.world.placedObjects)) {
		const raw = obj as unknown as Record<string, unknown>;
		if ("pairingPendingFlag" in raw) {
			raw.housekeepingClaimedFlag ??= raw.pairingPendingFlag;
			delete raw.pairingPendingFlag;
		}
		raw.housekeepingClaimedFlag ??= 0;
		raw.evalScore ??= -1;
	}
	snapshot.world.starCount ??= 1;
	snapshot.world.currentPopulation ??= 0;
	snapshot.world.currentPopulationBuckets ??= {};
	snapshot.world.rngState ??= 1;
	snapshot.world.rngCallCount ??= 0;
	snapshot.world.eventState ??= createEventState();

	rebuildSpecialLinkRouteRecords(snapshot.world);
	rebuildRouteReachabilityTables(snapshot.world);
	rebuildTransferGroupCache(snapshot.world);
	rebuildRuntimeSims(snapshot.world);

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
			lobbyHeight: world.lobbyHeight,
			lobbyMode: world.lobbyMode,
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
			sims: JSON.parse(JSON.stringify(world.sims)) as WorldState["sims"],
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
			medicalServiceSlots: JSON.parse(
				JSON.stringify(world.medicalServiceSlots),
			) as WorldState["medicalServiceSlots"],
			starCount: world.starCount,
			currentPopulation: world.currentPopulation,
			currentPopulationBuckets: { ...world.currentPopulationBuckets },
			commercialVenueBuckets: JSON.parse(
				JSON.stringify(world.commercialVenueBuckets),
			) as WorldState["commercialVenueBuckets"],
			rngState: world.rngState,
			rngCallCount: world.rngCallCount,
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
