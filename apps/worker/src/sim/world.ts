import type { RingBuffer } from "./ring-buffer";

// Grid and floor model constants
export const GRID_WIDTH = 375;
export const GRID_HEIGHT = 120; // floor indices 0–119; floor 10 = ground ("0"), floor 119 = top

/** Convert grid Y coordinate to floor index (0=bottom underground, 119=top). */
export function yToFloor(y: number): number {
	return GRID_HEIGHT - 1 - y;
}

/** Convert floor index to grid Y coordinate. */
export function floorToY(floor: number): number {
	return GRID_HEIGHT - 1 - floor;
}
export const UNDERGROUND_FLOORS = 10; // floors 0–9 underground; floor 10 = ground ("0")
export const UNDERGROUND_Y = GRID_HEIGHT - UNDERGROUND_FLOORS; // Y=110: first underground row
export const GROUND_Y = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS; // Y=109: ground lobby row

/** True iff the given Y is a valid lobby row (ground or every 15 floors above). */
export function isValidLobbyY(y: number): boolean {
	const floorsAboveGround = GROUND_Y - y;
	return floorsAboveGround >= 0 && floorsAboveGround % 15 === 0;
}

// ─── Carrier types ────────────────────────────────────────────────────────────

export interface CarrierCar {
	active: boolean;
	currentFloor: number;
	doorWaitCounter: number;
	speedCounter: number;
	assignedCount: number;
	pendingAssignmentCount: number;
	/** 0 = upward (floor increases), 1 = downward. */
	directionFlag: number;
	targetFloor: number;
	prevFloor: number;
	homeFloor: number;
	departureFlag: number;
	departureTimestamp: number;
	scheduleFlag: number;
	/** Waiting entity count indexed by floor slot. */
	waitingCount: number[];
	destinationCountByFloor: number[];
	nonemptyDestinationCount: number;
	activeRouteSlots: CarrierRouteSlot[];
	pendingRouteIds: string[];
}

export interface CarrierRouteSlot {
	routeId: string;
	sourceFloor: number;
	destinationFloor: number;
	boarded: boolean;
	active: boolean;
}

export interface CarrierFloorQueue {
	up: RingBuffer<string>;
	down: RingBuffer<string>;
}

export interface CarrierPendingRoute {
	entityId: string;
	sourceFloor: number;
	destinationFloor: number;
	boarded: boolean;
	directionFlag: number;
	assignedCarIndex: number;
}

export interface CarrierRecord {
	carrierId: number;
	/** X column of the shaft. */
	column: number;
	/**
	 * 0 = Express Elevator, 1 = Standard Elevator, 2 = Service Elevator.
	 * (From placement dispatcher FUN_1200_082c.)
	 * Route scorer treats modes 0/1 as "local-mode" (carrierMode != 2) and
	 * mode 2 as "express-mode" long-hop carrier (carrierMode == 2).
	 * Escalators are NOT carriers — they are special-link segments.
	 */
	carrierMode: 0 | 1 | 2;
	topServedFloor: number;
	bottomServedFloor: number;
	/** 14 entries: 7 dayparts × 2 calendar phases. 1 = floor served, 0 = skipped. */
	servedFloorFlags: number[];
	primaryRouteStatusByFloor: number[];
	secondaryRouteStatusByFloor: number[];
	serviceScheduleFlags: number[];
	/**
	 * 14 entries: 7 dayparts × 2 calendar phases. Indexed identically to
	 * `serviceScheduleFlags` but holds the dwell multiplier from
	 * carrier_header[+0x20 + phase*7 + daypart]. The departure dwell timeout is
	 * `dwellMultiplierFlags[idx] * 30` ticks. Distinct from the schedule-enable
	 * byte at `serviceScheduleFlags` (+0x2e + phase*7 + daypart). Default = 1.
	 */
	dwellMultiplierFlags: number[];
	/**
	 * 14 entries: 7 dayparts × 2 calendar phases. Controls alternate-direction
	 * queue drain behavior per daypart. 0 = normal (both directions),
	 * 1 = express to top (prefer upward, skip alternate downward drain),
	 * 2 = express to bottom (prefer downward, skip alternate upward drain).
	 */
	expressDirectionFlags: number[];
	waitingCarResponseThreshold: number;
	assignmentCapacity: number;
	floorQueues: CarrierFloorQueue[];
	pendingRoutes: CarrierPendingRoute[];
	completedRouteIds: string[];
	cars: CarrierCar[];
}

// ─── Runtime entities ────────────────────────────────────────────────────────

export interface EntityRecord {
	floorAnchor: number;
	subtypeIndex: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	routeSourceFloor: number;
	routeCarrierOrSegment: number;
	selectedFloor: number;
	originFloor: number;
	encodedRouteTarget: number;
	auxState: number;
	queueTick: number;
	accumulatedDelay: number;
	/** Ticks remaining before the entity may retry routing (route-failure / wait-state delay). */
	routeRetryDelay: number;
	auxCounter: number;
	word0a: number;
	word0c: number;
	word0e: number;
	byte09: number;
}

// ─── Routing types ────────────────────────────────────────────────────────────

export const MAX_SPECIAL_LINKS = 64;
export const MAX_SPECIAL_LINK_RECORDS = 8;
export const MAX_TRANSFER_GROUPS = 16;

export interface SpecialLinkSegment {
	active: boolean;
	/** bit 0 = express/escalator flag; bits 7:1 = inclusive span length in floors. */
	flags: number;
	/** Raw binary field preserved as recovered `height_metric`. */
	heightMetric: number;
	entryFloor: number;
	reservedByte: number;
	descendingLoadCounter: number;
	ascendingLoadCounter: number;
}

export interface SpecialLinkRecord {
	active: boolean;
	lowerFloor: number;
	upperFloor: number;
	reachabilityMasksByFloor: number[];
}

export interface TransferGroupEntry {
	active: boolean;
	taggedFloor: number;
	carrierMask: number;
}

// ─── PlacedObjectRecord ───────────────────────────────────────────────────────

/**
 * 18-byte (0x12) per-object simulation record for every placed non-infrastructure tile.
 * Offset layout confirmed via FUN_1200_1847 and FUN_1200_293e placer initialization.
 * Keyed in WorldState.placedObjects by "anchorX,y".
 *
 * Offsets +0x00..+0x05 hold family-specific runtime bytes (used by entity records in
 * Phase 4); they are not named fields here.
 */
export interface PlacedObjectRecord {
	/** +0x06 word: leftmost tile x (anchor column). */
	leftTileIndex: number;
	/** +0x08 word: rightmost tile x (anchor x + width − 1). */
	rightTileIndex: number;
	/** +0x0a byte: placement-time SimTower object-type code (e.g. 3 = hotelSingle, 6 = restaurant). */
	objectTypeCode: number;
	/** +0x0b byte: per-family lifecycle byte (unit_status / open-close state). Init = 0. */
	unitStatus: number;
	/** +0x0c word: tool-counter rotation index at init; runtime cycle counter. Init = 0. */
	auxValueOrTimer: number;
	/** +0x12 byte: index into WorldState.sidecars; init = −1 (no sidecar). */
	linkedRecordIndex: number;
	/** +0x13 byte: dirty bit; init = 1 so the first refresh sweep picks it up. */
	needsRefreshFlag: number;
	/** +0x14 byte: first-activation latch; init = 1. */
	evalActiveFlag: number;
	/**
	 * +0x15 byte: operational rating — 0 = bad/refund-eligible, 1 = ok, 2 = good.
	 * Init = −1 (invalid); first scoring sweep populates.
	 */
	evalLevel: number;
	/**
	 * +0x16 byte: pricing tier 0–3 (0 = best payout, 3 = worst).
	 * Init = 1 for families 3/4/5/7/9/10; init = 4 (no payout) for all others.
	 */
	rentLevel: number;
	/** +0x17 byte: cumulative activation count; init = 0, capped at 0x78. */
	activationTickCount: number;
	/** Clean-room metadata: VIP suite flag normalized onto standard hotel room types. */
	vipFlag?: boolean;
}

// ─── Gate flags ───────────────────────────────────────────────────────────────

/**
 * Global simulation gate flags, initialized by new_game_initializer.
 * These drive the per-star qualitative advancement conditions and security state.
 */
export interface GateFlags {
	/** [0xc198..0xc19b] — purpose unresolved; init = 0xffffffff (all-ones). */
	unknownC198: number;
	/** metroPlaced [0xc19e] — set when a type-0x0e (metro) object is placed. */
	metroPlaced: number;
	/** officePlaced [0xc19f] — set when a type-0x07 (office) object is placed. */
	officePlaced: number;
	/** officeServiceOk [0xc197] — updated by office-service evaluation every 9th day. */
	officeServiceOk: number;
	/** securityAdequate [0xc1a0] — set by update_security_housekeeping_state. */
	securityAdequate: number;
	/** routesViable [0xc1a1] — set by rebuild_path_seed_bucket_table when star > 2. */
	routesViable: number;
	/** g_vip_system_eligibility [0xbc5c] — floor index of placed VIP suite; 0xffff = none. */
	vipSuiteFloor: number;
	/** g_eval_entity_index [0xbc60] — runtime index of evaluation entity; 0xffff = none. */
	evalEntityIndex: number;
	/** g_security_ledger_scale [0xbc68] — incremented each time a security guard is placed. */
	securityLedgerScale: number;
	/** g_facility_progress_override — set every 8 days when star < 5. */
	facilityProgressOverride: number;
}

export function createGateFlags(): GateFlags {
	return {
		unknownC198: 0xffffffff,
		metroPlaced: 0,
		officePlaced: 0,
		officeServiceOk: 0,
		securityAdequate: 0,
		routesViable: 0,
		vipSuiteFloor: 0xffff, // −1: no VIP suite
		evalEntityIndex: 0xffff, // −1: no evaluation in progress
		securityLedgerScale: 0,
		facilityProgressOverride: 0,
	};
}

// ─── Sidecar records ──────────────────────────────────────────────────────────

export interface CommercialVenueRecord {
	kind: "commercial_venue";
	/** 0xff = invalid / demolished. */
	ownerSubtypeIndex: number;
	capacity: number;
	visitCount: number;
	todayVisitCount: number;
	yesterdayVisitCount: number;
	availabilityState: number;
}

export interface ServiceRequestEntry {
	kind: "service_request";
	ownerSubtypeIndex: number;
}

export interface EntertainmentLinkRecord {
	kind: "entertainment_link";
	ownerSubtypeIndex: number;
	/** 0xff = no pair yet. */
	pairedSubtypeIndex: number;
	/** Incremented at 0x0f0 each day; used to derive paired-link budget tier. */
	linkAgeCounter: number;
	/** Forward-half attendance budget (seeded at 0x0f0). */
	forwardBudget: number;
	/** Reverse-half attendance budget (seeded at 0x0f0). */
	reverseBudget: number;
	/** Forward phase: 0=idle, 1=activated, 2=first-guest-arrived, 3=ready. */
	forwardPhase: number;
	/** Reverse phase: 0=idle, 1=activated, 2=first-guest-arrived, 3=ready. */
	reversePhase: number;
	/** Cumulative attendance this cycle. */
	attendanceCounter: number;
	/** Active runtime attendee count (decremented on phase advance). */
	activeRuntimeCount: number;
}

export type SidecarRecord =
	| CommercialVenueRecord
	| ServiceRequestEntry
	| EntertainmentLinkRecord;

// ─── Event state ─────────────────────────────────────────────────────────────

/**
 * Bitfield for game_state_flags at [0xbc7a]:
 * bit 0 = bomb active, bit 3 = fire active, bit 5 = bomb found, bit 6 = bomb detonated.
 */
export interface EventState {
	/** Bitfield: bit 0 = bomb active search, bit 3 = fire active,
	 *  bit 5 = bomb found, bit 6 = bomb detonated. */
	gameStateFlags: number;
	/** Floor where the bomb was placed. */
	bombFloor: number;
	/** Tile where the bomb was placed. */
	bombTile: number;
	/** Day tick deadline for bomb detonation / post-resolution cleanup. */
	bombDeadline: number;
	/** Floor where the fire started. */
	fireFloor: number;
	/** Tile column where fire starts (right_tile - 0x20). */
	fireTile: number;
	/** Day tick when fire started. */
	fireStartTick: number;
	/** Per-floor left-spreading fire front position (120 entries, 0xffff = inactive). */
	fireLeftPos: number[];
	/** Per-floor right-spreading fire front position (120 entries, 0xffff = inactive). */
	fireRightPos: number[];
	/** Rescue countdown (with security); 0 = no countdown active. */
	rescueCountdown: number;
	/** Helicopter extinguish position; 0 = not active. */
	helicopterExtinguishPos: number;
	/** LCG15 state for event randomness. */
	lcgState: number;
}

export function createEventState(): EventState {
	return {
		gameStateFlags: 0,
		bombFloor: 0,
		bombTile: 0,
		bombDeadline: 0,
		fireFloor: 0,
		fireTile: 0,
		fireStartTick: 0,
		fireLeftPos: new Array(GRID_HEIGHT).fill(0xffff),
		fireRightPos: new Array(GRID_HEIGHT).fill(0xffff),
		rescueCountdown: 0,
		helicopterExtinguishPos: 0,
		lcgState: 1,
	};
}

// ─── WorldState ───────────────────────────────────────────────────────────────

/** All placed tile data for one tower. */
export interface WorldState {
	towerId: string;
	name: string;
	width: number;
	height: number;
	/** Global simulation gate flags (star advancement, security, etc.). */
	gateFlags: GateFlags;
	/** "x,y" → tileType for every occupied cell (anchors and extensions alike). */
	cells: Record<string, string>;
	/** Extension cell key → anchor cell key. */
	cellToAnchor: Record<string, string>;
	/** Anchor cell key → overlay tileType (e.g. "stairs"). */
	overlays: Record<string, string>;
	/** Extension cell key → anchor cell key for overlays. */
	overlayToAnchor: Record<string, string>;
	/**
	 * "anchorX,y" → PlacedObjectRecord for every simulated (non-infrastructure)
	 * placed tile. Infrastructure tiles (floor, lobby, stairs) do not have records.
	 */
	placedObjects: Record<string, PlacedObjectRecord>;
	/** Sidecar records, indexed by PlacedObjectRecord.linkedRecordIndex. */
	sidecars: SidecarRecord[];
	/** Runtime entity population rebuilt from placed objects. */
	entities: EntityRecord[];
	/** One CarrierRecord per elevator/escalator shaft. Rebuilt from cells on mutation. */
	carriers: CarrierRecord[];
	/** Special-link segment table (max MAX_SPECIAL_LINKS entries). Rebuilt from carriers. */
	specialLinks: SpecialLinkSegment[];
	/** Special-link record table (max MAX_SPECIAL_LINK_RECORDS entries). */
	specialLinkRecords: SpecialLinkRecord[];
	/** Per-floor walkability bitmask (bit 0 = local, bit 1 = express). Size = GRID_HEIGHT. */
	floorWalkabilityFlags: number[];
	/** Tagged transfer-concourse entries (max MAX_TRANSFER_GROUPS entries). */
	transferGroupEntries: TransferGroupEntry[];
	/** Per-floor bitmask of carrier IDs that serve each floor. Size = GRID_HEIGHT. */
	transferGroupCache: number[];
	/** Bomb/fire/VIP event state. */
	eventState: EventState;
	/** Pending notifications emitted during the current tick (drained by the transport layer). */
	pendingNotifications: SimNotification[];
	/** Pending prompts requiring player response (drained by the transport layer). */
	pendingPrompts: SimPrompt[];
}

export type SimNotification = {
	kind: "morning" | "afternoon" | "end_of_day" | "route_failure" | "event";
	message?: string;
};

export type SimPrompt = {
	promptId: string;
	promptKind: "bomb_ransom" | "fire_rescue";
	message: string;
	cost?: number;
};
