import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
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
	[FAMILY_HOTEL_SINGLE]: 1,
	[FAMILY_HOTEL_TWIN]: 2,
	[FAMILY_HOTEL_SUITE]: 3,
	[FAMILY_OFFICE]: 6,
	[FAMILY_CONDO]: 3,
	// Cathedral guest sims: 5 floor types x 8 slots = 40 guests.
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

// Sentinel used by carrier car slot cleanup and unset cathedral owner indices.
export const INVALID_FLOOR = 0xff;
export const COMMERCIAL_VENUE_DWELL_TICKS = 60;
// The binary encodes this as 0x62, which also has the transit bit set.
export const COMMERCIAL_DWELL_STATE = STATE_VENUE_HOME_TRANSIT;
export const CONDO_SELECTOR_RESTAURANT = new Set([FAMILY_RESTAURANT]);
export const CONDO_SELECTOR_FAST_FOOD = new Set([FAMILY_FAST_FOOD]);
