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

// ─── PRNG ────────────────────────────────────────────────────────────────────

/** Sample a 15-bit LCG value from the world RNG and advance its state. */
export function sampleRng(world: WorldState): number {
	world.rngState = (world.rngState * 0x15a4e35 + 1) & 0x7fff;
	return world.rngState;
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
	/** Waiting sim count indexed by floor slot. */
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
	simId: string;
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
	 * The route scorer treats modes 0/1 as local-mode and mode 2 as the
	 * express long-hop carrier. Escalators are NOT carriers — they are
	 * special-link segments.
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
	 * 14 entries: 7 dayparts × 2 calendar phases. Holds the per-daypart
	 * departure-dwell multiplier; the actual dwell is `multiplier * 30` ticks.
	 * Distinct from `serviceScheduleFlags` which is the schedule-enable byte.
	 * Default = 1.
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

// ─── Runtime sims ────────────────────────────────────────────────────────

export type RouteState =
	| { mode: "idle" }
	| { mode: "segment"; segmentId: number; destination: number }
	| {
			mode: "carrier";
			carrierId: number;
			direction: "up" | "down";
			source: number;
	  }
	| { mode: "queued"; source: number };

export interface SimRecord {
	floorAnchor: number;
	homeColumn: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	route: RouteState;
	selectedFloor: number;
	originFloor: number;
	destinationFloor: number;
	venueReturnState: number;
	queueTick: number;
	/** Current elapsed ticks for the in-progress service visit (maps to low 10 bits of elapsed_packed). */
	elapsedTicks: number;
	/** Ticks remaining before the sim may retry routing (route-failure / wait-state delay). */
	routeRetryDelay: number;
	transitTicksRemaining: number;
	lastDemandTick: number;
	tripCount: number;
	accumulatedTicks: number;
}

// ─── Routing types ────────────────────────────────────────────────────────────

export const MAX_SPECIAL_LINKS = 64;
export const MAX_SPECIAL_LINK_RECORDS = 8;
export const MAX_TRANSFER_GROUPS = 16;

export interface SpecialLinkSegment {
	active: boolean;
	/** bit 0 = stairs cost bit (0 = Escalator branch, 1 = Stairs branch); bits 7:1 = inclusive span length in floors. */
	flags: number;
	/** Height-based cost metric used by the routing pathfinder. */
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
 * Per-object simulation record for every placed non-infrastructure tile.
 * Keyed in WorldState.placedObjects by "anchorX,y".
 */
export interface PlacedObjectRecord {
	/** Leftmost tile x (anchor column). */
	leftTileIndex: number;
	/** Rightmost tile x (anchor x + width − 1). */
	rightTileIndex: number;
	/** SimTower family code (e.g. FAMILY_HOTEL_SINGLE, FAMILY_RESTAURANT). */
	objectTypeCode: number;
	/** Per-family lifecycle byte (unit status / open-close state). */
	unitStatus: number;
	/** Runtime cycle counter for the per-family refresh rotation. */
	auxValueOrTimer: number;
	/** Index into WorldState.sidecars; −1 when no sidecar is attached. */
	linkedRecordIndex: number;
	/** Dirty bit set to 1 on placement so the first refresh sweep picks it up. */
	needsRefreshFlag: number;
	/** Occupancy flag: 1 while the facility has active tenants. */
	evalActiveFlag: number;
	/** Operational rating: 0 = bad/refund-eligible, 1 = ok, 2 = good. −1 until first scoring sweep. */
	evalLevel: number;
	/** Raw average stress score before threshold bucketing. -1 until first scoring sweep. */
	evalScore: number;
	/** Pricing tier 0–3 (0 = best payout, 3 = worst); 4 = no payout. */
	rentLevel: number;
	/** Cumulative activation count, capped. */
	activationTickCount: number;
	/** Housekeeping has claimed this room for turnover service. */
	pairingPendingFlag: number;
	/** VIP suite flag normalized onto standard hotel room types. */
	vipFlag?: boolean;
}

// ─── Gate flags ───────────────────────────────────────────────────────────────

/**
 * Global simulation gate flags. These drive the per-star qualitative
 * advancement conditions and recycling-center adequacy state.
 */
export interface GateFlags {
	/** Purpose unresolved; initialized to all-ones. */
	unknownC198: number;
	/** Set when a metro object is placed. */
	metroPlaced: number;
	/** Set when an office object is placed. */
	officePlaced: number;
	/** Updated by office-service evaluation every 9th day. */
	officeServiceOk: number;
	/** Set by update_recycling_center_state. */
	recyclingAdequate: number;
	/** Set by the facility rebuild pipeline once enough routes exist. */
	routesViable: number;
	/** Floor index of placed VIP suite; 0xffff = none. */
	vipSuiteFloor: number;
	/** Runtime index of cathedral sim; 0xffff = none. */
	evalSimIndex: number;
	/** Number of placed recycling-center upper slices. */
	recyclingCenterCount: number;
	/** Set every 8 days while the tower is below 5-star rank. */
	facilityProgressOverride: number;
	/** Daily hotel sale counter, reset at the morning sale checkpoint. */
	family345SaleCount: number;
	/** Display/news trigger latch used by hotel checkout milestones. */
	newspaperTrigger: number;
}

export function createGateFlags(): GateFlags {
	return {
		unknownC198: 0xffffffff,
		metroPlaced: 0,
		officePlaced: 0,
		officeServiceOk: 0,
		recyclingAdequate: 0,
		routesViable: 0,
		vipSuiteFloor: 0xffff, // −1: no VIP suite
		evalSimIndex: 0xffff, // −1: no cathedral placed
		recyclingCenterCount: 0,
		facilityProgressOverride: 0,
		family345SaleCount: 0,
		newspaperTrigger: 0,
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

// CommercialVenueRecord.availabilityState values
export const VENUE_AVAILABLE = 0;
export const VENUE_PARTIAL = 1; // active_assignment_count 1..9
export const VENUE_NEAR_FULL = 2; // active_assignment_count >= 10
export const VENUE_CLOSED = 3; // daily off-hours closure
export const VENUE_DORMANT = 0xff; // inactive

export interface ServiceRequestEntry {
	kind: "service_request";
	ownerSubtypeIndex: number;
	/** Floor index of the service provider (used by parking demand log). */
	floorIndex?: number;
	/** 0 = uncovered / active, 1 = covered / suppressed by ramp. */
	coverageFlag?: number;
}

export interface EntertainmentLinkRecord {
	kind: "entertainment_link";
	ownerSubtypeIndex: number;
	/** 0xff = no pair yet. */
	pairedSubtypeIndex: number;
	/** 0xff for single-venue records; 0..13 paired selector bucket. */
	familySelectorOrSingleLinkFlag: number;
	/** Incremented at 0x0f0 each day; saturates at 0x7f. */
	linkAgeCounter: number;
	/** Upper-half attendance budget (seeded at 0x0f0). */
	upperBudget: number;
	/** Lower-half attendance budget (seeded at 0x0f0). */
	lowerBudget: number;
	/** 0=idle, 1=activated, 2=attendance started, 3=ready. */
	linkPhaseState: number;
	/** Reserved flag used by the placement/runtime pipeline. */
	pendingTransitionFlag: number;
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

export interface EventState {
	/**
	 * Active-event bitfield:
	 * bit 0 = bomb active search, bit 3 = fire active,
	 * bit 5 = bomb found, bit 6 = bomb detonated.
	 */
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
	/** Rescue countdown (with emergency coverage); 0 = no countdown active. */
	rescueCountdown: number;
	/** Helicopter extinguish position; 0 = not active. */
	helicopterExtinguishPos: number;
	/** LCG15 state for event randomness. */
	lcgState: number;
	/** Deterministic bomb-search helper floor bounds / cursor state. */
	bombSearchLowerBound: number;
	bombSearchUpperBound: number;
	bombSearchCurrentFloor: number;
	bombSearchScanTile: number;
	/** Pending carrier-edit prompt target column, -1 when idle. */
	pendingCarrierEditColumn: number;
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
		bombSearchLowerBound: -1,
		bombSearchUpperBound: -1,
		bombSearchCurrentFloor: -1,
		bombSearchScanTile: -1,
		pendingCarrierEditColumn: -1,
	};
}

// ─── WorldState ───────────────────────────────────────────────────────────────

/** All placed tile data for one tower. */
export interface WorldState {
	towerId: string;
	name: string;
	width: number;
	height: number;
	/** Lobby slice height in floors; defaults to 1 until expanded-lobby support exists. */
	lobbyHeight: number;
	/** Global simulation gate flags (star advancement, recycling adequacy, etc.). */
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
	/** Runtime sim population rebuilt from placed objects. */
	sims: SimRecord[];
	/** One CarrierRecord per elevator/escalator shaft. Rebuilt from cells on mutation. */
	carriers: CarrierRecord[];
	/** Special-link segment table (max MAX_SPECIAL_LINKS entries). Rebuilt from carriers. */
	specialLinks: SpecialLinkSegment[];
	/** Special-link record table (max MAX_SPECIAL_LINK_RECORDS entries). */
	specialLinkRecords: SpecialLinkRecord[];
	/** Per-floor walkability bitmask (bit 0 = Escalator-branch, bit 1 = Stairs-branch). Size = GRID_HEIGHT. */
	floorWalkabilityFlags: number[];
	/** Tagged transfer-concourse entries (max MAX_TRANSFER_GROUPS entries). */
	transferGroupEntries: TransferGroupEntry[];
	/** Per-floor bitmask of carrier IDs that serve each floor. Size = GRID_HEIGHT. */
	transferGroupCache: number[];
	/** Sidecar indices of uncovered parking spaces feeding the demand log. */
	parkingDemandLog: number[];
	/** LCG state for general-purpose simulation randomness. */
	rngState: number;
	/** Bomb/fire/VIP event state. */
	eventState: EventState;
	/** Pending notifications emitted during the current tick (drained by the transport layer). */
	pendingNotifications: SimNotification[];
	/** Pending prompts requiring player response (drained by the transport layer). */
	pendingPrompts: SimPrompt[];
}

export type SimNotification = {
	kind:
		| "morning"
		| "afternoon"
		| "end_of_day"
		| "route_failure"
		| "event"
		| "news";
	message?: string;
};

export type SimPrompt = {
	promptId: string;
	promptKind: "bomb_ransom" | "fire_rescue" | "carrier_edit_confirmation";
	message: string;
	cost?: number;
};
