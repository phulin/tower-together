import {
	FAMILY_CINEMA,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOUSEKEEPING,
	FAMILY_OFFICE,
	FAMILY_PARTY_HALL_LOWER,
	FAMILY_RECYCLING_CENTER_UPPER,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
	FAMILY_SECURITY,
} from "../resources";
import type { RouteState } from "../world";

/** Internal floor-slot index for the lobby (world floor 0 + UNDERGROUND_FLOORS). */
export const LOBBY_FLOOR = 10;
export const EVAL_ZONE_FLOOR = 109; // floor 0x6d

export const STATE_TRANSIT_FLAG = 0x40;
export const STATE_BASE_MASK = 0x3f;

export function withTransitFlag(baseStateCode: number): number {
	return STATE_TRANSIT_FLAG | baseStateCode;
}

export function stateBaseCode(stateCode: number): number {
	return stateCode & STATE_BASE_MASK;
}

export function hasTransitFlag(stateCode: number): boolean {
	return (stateCode & STATE_TRANSIT_FLAG) !== 0;
}

export const STATE_COMMUTE = 0x00; // commuting to destination
export const STATE_ACTIVE = 0x01; // active / in-stay / venue selection
export const STATE_ACTIVE_ALT = 0x02; // office alternate lunch/venue-selection state
export const STATE_ARRIVED = 0x03; // arrived at destination
export const STATE_CHECKOUT_QUEUE = 0x04; // hotel checkout queue (non-last sibling)
export const STATE_DEPARTURE = 0x05; // departing / returning
export const STATE_TRANSITION = 0x10; // unit status transition (hotel checking out)
export const STATE_MORNING_GATE = 0x20; // morning activation gate
export const STATE_AT_WORK = 0x21; // at work (office, post-commute)
export const STATE_VENUE_TRIP = 0x22; // commercial venue trip in transit
const STATE_DWELL_RETURN = 0x23;
export const STATE_HOTEL_PARKED = 0x24; // hotel parked (awaiting guest)
export const STATE_NIGHT_A = 0x25; // night park variant A
export const STATE_NIGHT_B = 0x26; // night park / venue unavailable
export const STATE_PARKED = 0x27; // parked / idle

export const STATE_COMMUTE_TRANSIT = withTransitFlag(STATE_COMMUTE);
export const STATE_ACTIVE_TRANSIT = withTransitFlag(STATE_ACTIVE);
export const STATE_VENUE_TRIP_TRANSIT = withTransitFlag(STATE_VENUE_TRIP);
export const STATE_DEPARTURE_TRANSIT = withTransitFlag(STATE_DEPARTURE);
export const STATE_EVAL_RETURN = STATE_DEPARTURE_TRANSIT;
export const STATE_EVAL_OUTBOUND = withTransitFlag(STATE_MORNING_GATE);
export const STATE_MORNING_TRANSIT = STATE_EVAL_OUTBOUND;
export const STATE_AT_WORK_TRANSIT = withTransitFlag(STATE_AT_WORK);
export const STATE_VENUE_HOME_TRANSIT = withTransitFlag(STATE_VENUE_TRIP);
export const STATE_DWELL_RETURN_TRANSIT = withTransitFlag(STATE_DWELL_RETURN);

export const UNIT_STATUS_OFFICE_OCCUPIED = 0x0f;
export const UNIT_STATUS_CONDO_OCCUPIED = 0x17;
export const UNIT_STATUS_CONDO_VACANT = 0x18;
export const UNIT_STATUS_CONDO_VACANT_EVENING = 0x20;
export const UNIT_STATUS_HOTEL_SOLD_OUT = 0x37;

export const ROUTE_IDLE: RouteState = { mode: "idle" };

export const NO_EVAL_ENTITY = 0xffff;
export const ENTITY_REFRESH_STRIDE = 16;
export const ACTIVATION_TICK_CAP = 0x78;

export const ENTITY_POPULATION_BY_TYPE: Record<number, number> = {
	[FAMILY_HOTEL_SINGLE]: 2,
	[FAMILY_HOTEL_TWIN]: 3,
	[FAMILY_HOTEL_SUITE]: 3,
	[FAMILY_RESTAURANT]: 48,
	[FAMILY_OFFICE]: 6,
	[FAMILY_CONDO]: 3,
	[FAMILY_RETAIL]: 48,
	[FAMILY_FAST_FOOD]: 48,
	// Cinema primary (0x12) — binary allocates 56 guest sims for the theater
	// span; sidecar phase handling drives attendance/payout state.
	[FAMILY_CINEMA]: 56,
	[FAMILY_RECYCLING_CENTER_UPPER]: 6,
	[FAMILY_SECURITY]: 6,
	// Housekeeping helpers (family 0x0f).
	[FAMILY_HOUSEKEEPING]: 6,
	// Party hall lower (0x1e) — 40-slot occupant span; upper half (0x1d) is
	// never activated and gets no sims. Binary `get_span_size_for_family` = 0x28.
	[FAMILY_PARTY_HALL_LOWER]: 40,
	// Cathedral object slices: 5 floor types x 8 slots = 40 guests. Runtime
	// family is normalized to 0x24 when sims are rebuilt.
	36: 8, // 0x24
	37: 8, // 0x25
	38: 8, // 0x26
	39: 8, // 0x27
	40: 8, // 0x28
};

export const HOTEL_FAMILIES = new Set([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
]);

/** Families whose placed objects carry an evaluation score (rentable occupancy). */
export const EVALUATABLE_FAMILIES = new Set([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_OFFICE,
	FAMILY_CONDO,
]);

export const COMMERCIAL_FAMILIES = new Set([
	FAMILY_RESTAURANT,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
]);

export const CATHEDRAL_FAMILIES = new Set([0x24, 0x25, 0x26, 0x27, 0x28]);

/**
 * Binary entity-table allocation order, derived from reference trace hex codes.
 * Sims must be sorted by this priority so stride residues match the binary.
 */
export const BINARY_ALLOC_ORDER: Record<number, number> = {
	[FAMILY_RECYCLING_CENTER_UPPER]: 0, // 0xf2
	[FAMILY_RESTAURANT]: 1, // 0xf4
	[FAMILY_FAST_FOOD]: 2, // 0xf6
	[FAMILY_CONDO]: 3, // 0xf7
	[FAMILY_OFFICE]: 4, // 0xf9
	[FAMILY_RETAIL]: 5, // 0xfa
	[FAMILY_HOTEL_TWIN]: 6, // 0xfb
	[FAMILY_HOTEL_SUITE]: 7, // 0xfc
	[FAMILY_HOTEL_SINGLE]: 8, // 0xfd
	[FAMILY_HOUSEKEEPING]: 14,
	// Cathedral families (36–40) come after all main families.
	36: 9,
	37: 10,
	38: 11,
	39: 12,
	40: 13,
};

export const ELEVATOR_DEMAND_STATES = new Set([
	STATE_COMMUTE,
	STATE_ACTIVE,
	STATE_ACTIVE_ALT,
	STATE_CHECKOUT_QUEUE,
	STATE_DEPARTURE,
	STATE_VENUE_TRIP,
	STATE_COMMUTE_TRANSIT,
	STATE_ACTIVE_TRANSIT,
	STATE_VENUE_TRIP_TRANSIT,
	STATE_DEPARTURE_TRANSIT,
	STATE_EVAL_OUTBOUND,
	STATE_EVAL_RETURN,
	STATE_AT_WORK_TRANSIT,
	STATE_VENUE_HOME_TRANSIT,
	STATE_DWELL_RETURN_TRANSIT,
]);

// Housekeeping helper (family 0x0f) state codes.
export const HK_STATE_SEARCH = 0;
export const HK_STATE_ROUTE_TO_CANDIDATE = 1;
export const HK_STATE_COUNTDOWN = 2;
export const HK_STATE_ROUTE_TO_TARGET = 3;
export const HK_STATE_ROUTE_TO_CANDIDATE_TRANSIT = 4;
export const HK_SEARCHING_SENTINEL = -1;
export const HK_POST_CLAIM_COUNTDOWN = 3;
export const HK_CLAIM_DAY_TICK_CUTOFF = 1500;
export const HK_FLOOR_CLASS_MOD = 6;

// Sentinel used by carrier car slot cleanup and unset cathedral owner indices.
export const INVALID_FLOOR = 0xff;
export const COMMERCIAL_VENUE_DWELL_TICKS = 60;
// The binary encodes this as 0x62, which also has the transit bit set.
export const COMMERCIAL_DWELL_STATE = STATE_VENUE_HOME_TRANSIT;
/** Binary `select_random_commercial_venue_record_from_bucket` (11b0:1361)
 * service_family_selector mapping: 0 = retail, 1 = restaurant, 2 = fast-food.
 * The condo state-0x01/0x41 handler (1228:3b34–3b54) selects:
 *   weekend_flag == 0               → 0 (retail)
 *   weekend_flag != 0, slot % 4 == 0 → 1 (restaurant)
 *   weekend_flag != 0, slot % 4 != 0 → 2 (fast-food) */
export const CONDO_SELECTOR_RETAIL = new Set([FAMILY_RETAIL]);
export const CONDO_SELECTOR_RESTAURANT = new Set([FAMILY_RESTAURANT]);
export const CONDO_SELECTOR_FAST_FOOD = new Set([FAMILY_FAST_FOOD]);
/** Binary hotel state-0x01 handler (1228:3126) pushes selector=1 (restaurant)
 * into route_sim_to_commercial_venue, so hotel rooms only ever visit
 * restaurants. Retail/fast-food buckets are reserved for the hotel-guest
 * (family 0x21) path via `select_random_venue_bucket_for_hotel_guest`. */
export const HOTEL_ROOM_SELECTOR = new Set([FAMILY_RESTAURANT]);
