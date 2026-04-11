export const STARTING_CASH = 2_000_000;

// ─── Tile registry ────────────────────────────────────────────────────────────

/** Width in grid cells for each placeable tile type. */
export const TILE_WIDTHS: Record<string, number> = {
	// Infrastructure
	floor: 1,
	lobby: 1,
	stairs: 8,
	elevator: 4,
	elevatorExpress: 4,
	elevatorService: 4,
	escalator: 8,
	// Hotels (families 3/4/5)
	hotelSingle: 4,
	hotelTwin: 8,
	hotelSuite: 12,
	// Commercial (families 6/0x0a/0x0c)
	restaurant: 24,
	fastFood: 12,
	retail: 16,
	// Office (family 7)
	office: 9,
	// Condo (family 9)
	condo: 16,
	// Entertainment (families 0x12/0x1d)
	cinema: 24,
	entertainment: 24,
	// Services
	security: 2, // family 0x14; SPEC.md marks this as a resource-icon-derived width
	housekeeping: 2, // family 0x15; inherits security width in SPEC.md
	parking: 4, // family 0x18
	metro: 4, // family 0x0e; SPEC.md marks this as a resource-icon-derived width
	fireSuppressor: 28, // family 0x28
};

/** One-time construction cost in dollars. */
export const TILE_COSTS: Record<string, number> = {
	floor: 500,
	lobby: 3_000,
	stairs: 5_000,
	elevator: 200_000,
	elevatorExpress: 200_000,
	elevatorService: 200_000,
	escalator: 20_000,
	hotelSingle: 20_000,
	hotelTwin: 50_000,
	hotelSuite: 100_000,
	restaurant: 200_000,
	fastFood: 100_000,
	retail: 100_000,
	office: 40_000,
	condo: 80_000,
	cinema: 500_000,
	entertainment: 100_000,
	security: 500_000,
	housekeeping: 50_000,
	parking: 5_000,
	metro: 1_000_000,
	fireSuppressor: 500_000,
};

export const VALID_TILE_TYPES = new Set(Object.keys(TILE_WIDTHS));

// ─── Family codes (object-type codes from the spec) ─────────────────────────

export const FAMILY_ELEVATOR = 1;
export const FAMILY_ESCALATOR = 2;
export const FAMILY_HOTEL_SINGLE = 3;
export const FAMILY_HOTEL_TWIN = 4;
export const FAMILY_HOTEL_SUITE = 5;
export const FAMILY_RESTAURANT = 6;
export const FAMILY_OFFICE = 7;
export const FAMILY_CONDO = 9;
export const FAMILY_RETAIL = 10;
export const FAMILY_FAST_FOOD = 12;
export const FAMILY_METRO = 14;
export const FAMILY_CINEMA = 18;
export const FAMILY_SECURITY = 20;
export const FAMILY_HOUSEKEEPING = 21;
export const FAMILY_PARKING = 24;
export const FAMILY_ENTERTAINMENT = 29;
export const FAMILY_FIRE_SUPPRESSOR = 40;

// ─── Family code ↔ tile name mappings ────────────────────────────────────────

/** Maps SimTower family/object-type codes to internal tile name strings. */
export const FAMILY_CODE_TO_TILE: Record<number, string> = {
	[FAMILY_ELEVATOR]: "elevator",
	[FAMILY_ESCALATOR]: "escalator",
	[FAMILY_HOTEL_SINGLE]: "hotelSingle",
	[FAMILY_HOTEL_TWIN]: "hotelTwin",
	[FAMILY_HOTEL_SUITE]: "hotelSuite",
	[FAMILY_RESTAURANT]: "restaurant",
	[FAMILY_OFFICE]: "office",
	[FAMILY_CONDO]: "condo",
	[FAMILY_FAST_FOOD]: "fastFood",
	[FAMILY_RETAIL]: "retail",
	[FAMILY_METRO]: "metro",
	[FAMILY_CINEMA]: "cinema",
	[FAMILY_SECURITY]: "security",
	[FAMILY_HOUSEKEEPING]: "housekeeping",
	[FAMILY_PARKING]: "parking",
	[FAMILY_ENTERTAINMENT]: "entertainment",
	[FAMILY_FIRE_SUPPRESSOR]: "fireSuppressor",
};

export const LEGACY_VIP_TILE_TO_STANDARD: Record<string, string> = {
	vipSingle: "hotelSingle",
	vipTwin: "hotelTwin",
	vipSuite: "hotelSuite",
};

export const TILE_TO_FAMILY_CODE: Record<string, number> = Object.fromEntries(
	Object.entries(FAMILY_CODE_TO_TILE).map(([k, v]) => [v, Number(k)]),
);

// ─── YEN #1001 — payout table ─────────────────────────────────────────────────
// Income per checkout/activation event, indexed by variant tier (0=best, 3=worst).

export const YEN_1001: Record<string, number[]> = {
	hotelSingle: [30, 20, 15, 5],
	hotelTwin: [30, 20, 15, 5],
	hotelSuite: [30, 20, 15, 5],
	office: [150, 100, 50, 20],
	condo: [2000, 1500, 1000, 400],
	retail: [200, 150, 100, 40],
};

// ─── YEN #1002 — expense table ────────────────────────────────────────────────
// Operating expenses charged every 3 days.

export const YEN_1002: Record<string, number> = {
	restaurant: 500,
	fastFood: 50,
	retail: 1000,
	security: 200,
	housekeeping: 100,
	elevatorLocal: 100, // per unit per 3-day period
	elevatorExpress: 200,
	elevatorService: 100,
	escalator: 0,
	stairs: 50,
};

// ─── Operational score thresholds ─────────────────────────────────────────────
// [low_threshold, high_threshold] → pairing_status 0/1/2 (C/B/A)

export const OP_SCORE_THRESHOLDS: Record<number, [number, number]> = {
	1: [80, 150],
	2: [80, 150],
	3: [80, 150],
	4: [80, 200],
	5: [80, 200],
};

// ─── Parking expense rates ──────────────────────────────────────────────────
// Per-star tier rate in $100 units: expense = (width) * rate / 10.
// Stars <3 → 0, star 3 → 30, stars >=4 → 100.

export const PARKING_EXPENSE_RATE_BY_STAR: Record<number, number> = {
	1: 0,
	2: 0,
	3: 30,
	4: 100,
	5: 100,
};

// ─── Activity score star thresholds ──────────────────────────────────────────
// score must exceed STAR_THRESHOLDS[star - 1] to advance from star → star+1

export const STAR_THRESHOLDS = [300, 1000, 5000, 10_000, 15_000];

// ─── Route delay values ───────────────────────────────────────────────────────
// All confirmed from startup tuning resource (type 0xff05, id 1000).

export const DELAY_WAITING = 5; // carrier floor-slot status 0x28 (at-capacity)
export const DELAY_REQUEUE_FAIL = 0; // assign_request_to_runtime_route finds no transfer floor
export const DELAY_ROUTE_FAIL = 300; // select_best_route_candidate returns < 0
export const DELAY_VENUE_UNAVAIL = 0; // target venue slot invalid / no path-seed entry
export const DELAY_STOP_EVEN = 16; // per-stop, even-parity segments
export const DELAY_STOP_ODD = 35; // per-stop, odd-parity segments
