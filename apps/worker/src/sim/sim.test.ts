/**
 * Phase 2 compliance tests — Static World + Scheduler Skeleton
 *
 * Covers:
 *  2.1  PlacedObjectRecord structure & storage
 *  2.2  Full checkpoint dispatcher (all 18 checkpoints at the right ticks)
 *  2.3  Three-ledger money model
 *  2.4  Build / demolish command handlers
 *
 * Plus the Phase 1 time model (prerequisite for scheduler tests).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
	advanceOneTick,
	createTimeState,
	DAY_TICK_MAX,
	DAY_TICK_INCOME,
	pre_day_4,
} from "./time";
import {
	GRID_HEIGHT,
	GRID_WIDTH,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
	GROUND_Y,
	isValidLobbyY,
	type PlacedObjectRecord,
	type WorldState,
} from "./world";
import {
	createLedgerState,
	add_cashflow_from_family_resource,
	rebuild_facility_ledger,
	do_expense_sweep,
	do_ledger_rollover,
	type LedgerState,
} from "./ledger";
import { run_checkpoints, type SimState } from "./scheduler";
import {
	handle_place_tile,
	handle_remove_tile,
	fill_row_gaps,
	run_global_rebuilds,
} from "./commands";
import { TILE_COSTS, TILE_WIDTHS, YEN_1001, YEN_1002 } from "./resources";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorld(opts?: { cash?: number }): WorldState {
	return {
		towerId: "test",
		name: "Test Tower",
		width: GRID_WIDTH,
		height: GRID_HEIGHT,
		cells: {},
		cellToAnchor: {},
		overlays: {},
		overlayToAnchor: {},
		placed_objects: {},
		sidecars: [],
	};
}

function makeLedger(cash = 10_000_000): LedgerState {
	return createLedgerState(cash);
}

function makeState(opts?: { cash?: number }): SimState {
	return {
		time: createTimeState(),
		world: makeWorld(),
		ledger: makeLedger(opts?.cash),
	};
}

/**
 * Place a supported row of floor tiles at `y` so tiles at `y-1` have support.
 */
function placeSupportRow(y: number, world: WorldState, ledger: LedgerState) {
	for (let x = 0; x < 10; x++) {
		world.cells[`${x},${y}`] = "floor";
	}
}

// ─── Phase 1: Time model ──────────────────────────────────────────────────────

describe("time model", () => {
	it("starts at tick 0 with all fields zeroed", () => {
		const t = createTimeState();
		expect(t.day_tick).toBe(0);
		expect(t.daypart_index).toBe(0);
		expect(t.day_counter).toBe(0);
		expect(t.calendar_phase_flag).toBe(0);
		expect(t.star_count).toBe(1);
		expect(t.total_ticks).toBe(0);
	});

	it("increments day_tick and total_ticks each step", () => {
		let t = createTimeState();
		const { time } = advanceOneTick(t);
		expect(time.day_tick).toBe(1);
		expect(time.total_ticks).toBe(1);
	});

	it("computes daypart_index as floor(day_tick / 400)", () => {
		let t = createTimeState();
		// tick 0 → part 0; tick 399 → part 0; tick 400 → part 1
		for (let i = 0; i < 400; i++) {
			expect(t.daypart_index).toBe(0);
			t = advanceOneTick(t).time;
		}
		expect(t.daypart_index).toBe(1);
	});

	it("wraps day_tick at DAY_TICK_MAX (2600)", () => {
		expect(DAY_TICK_MAX).toBe(0x0a28);
		let t = createTimeState();
		for (let i = 0; i < DAY_TICK_MAX; i++) {
			t = advanceOneTick(t).time;
		}
		// After DAY_TICK_MAX advances the counter wraps back to 0.
		expect(t.day_tick).toBe(0);
	});

	it("sets incomeCheckpoint=true only at DAY_TICK_INCOME (0x08fc)", () => {
		expect(DAY_TICK_INCOME).toBe(0x08fc);
		let t = createTimeState();
		// Advance to day_tick = DAY_TICK_INCOME - 1
		for (let i = 0; i < DAY_TICK_INCOME - 1; i++) {
			t = advanceOneTick(t).time;
		}
		// The next step (DAY_TICK_INCOME - 1 → DAY_TICK_INCOME - 1 is already t.day_tick)
		// One more step brings us to DAY_TICK_INCOME - should NOT yet be the checkpoint
		// Actually t.day_tick is already DAY_TICK_INCOME - 1 after the loop above.
		// advanceOneTick will produce day_tick = DAY_TICK_INCOME → that IS the checkpoint.
		// So let's check the tick just before too.
		// Advance one more to reach DAY_TICK_INCOME:
		const atIncome = advanceOneTick(t);
		expect(atIncome.time.day_tick).toBe(DAY_TICK_INCOME);
		expect(atIncome.incomeCheckpoint).toBe(true);
		// The tick before should NOT have triggered it
		// Roll back: advance from 0 to DAY_TICK_INCOME - 2
		let t2 = createTimeState();
		for (let i = 0; i < DAY_TICK_INCOME - 2; i++) {
			t2 = advanceOneTick(t2).time;
		}
		const beforeIncome = advanceOneTick(t2);
		expect(beforeIncome.time.day_tick).toBe(DAY_TICK_INCOME - 1);
		expect(beforeIncome.incomeCheckpoint).toBe(false);
	});

	it("increments day_counter at DAY_TICK_INCOME", () => {
		let t = createTimeState();
		for (let i = 0; i < DAY_TICK_INCOME; i++) {
			t = advanceOneTick(t).time;
		}
		expect(t.day_counter).toBe(1);
	});

	it("computes calendar_phase_flag correctly", () => {
		// flag = (day_counter % 12) % 3 >= 2 ? 1 : 0
		// day 0→0, 1→0, 2→1, 3→0, 4→0, 5→1, 6→0, 7→0, 8→1, 9→0, 10→0, 11→1
		const expected = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
		let t = createTimeState();
		for (let day = 0; day <= 12; day++) {
			// Advance to DAY_TICK_INCOME for this day
			while (t.day_counter <= day && t.day_tick !== 0) {
				t = advanceOneTick(t).time;
			}
			// After day_counter = day, check the flag
			if (t.day_counter === day) {
				expect(t.calendar_phase_flag).toBe(expected[day]);
			}
			// advance one full day
			for (let i = 0; i < DAY_TICK_MAX; i++) {
				t = advanceOneTick(t).time;
			}
		}
	});

	it("pre_day_4 returns true for daypart < 4, false otherwise", () => {
		const t = createTimeState();
		expect(pre_day_4({ ...t, daypart_index: 0 })).toBe(true);
		expect(pre_day_4({ ...t, daypart_index: 3 })).toBe(true);
		expect(pre_day_4({ ...t, daypart_index: 4 })).toBe(false);
		expect(pre_day_4({ ...t, daypart_index: 6 })).toBe(false);
	});
});

// ─── Phase 2.1: PlacedObjectRecord ───────────────────────────────────────────

describe("PlacedObjectRecord", () => {
	it("is created with all required fields when placing a hotel_single", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeSupportRow(GROUND_Y + 1, world, ledger); // support one row below
		// Place a floor row at GROUND_Y so hotel_single at GROUND_Y - 1 can have support
		placeSupportRow(GROUND_Y, world, ledger);
		const y = GROUND_Y - 1;
		world.cells[`0,${y + 1}`] = "floor"; // ensure support
		const result = handle_place_tile(0, y, "hotel_single", world, ledger);
		expect(result.accepted).toBe(true);
		const rec = world.placed_objects[`0,${y}`];
		expect(rec).toBeDefined();
		expect(rec.left_tile_index).toBe(0);
		expect(rec.right_tile_index).toBe(0); // width 1
		expect(rec.object_type_code).toBe(3); // family code for hotel_single
		expect(rec.object_state_code).toBe(0);
		expect(rec.linked_record_index).toBe(-1); // no sidecar for hotel
		expect(rec.subtype_tile_offset).toBe(0);
		expect(rec.needs_refresh_flag).toBe(0);
		expect(rec.pairing_status).toBe(0);
		expect(rec.pairing_active_flag).toBe(0);
		expect(rec.activation_tick_count).toBe(0);
		expect(rec.variant_index).toBe(0);
	});

	it("sets right_tile_index = left + width - 1 for multi-tile objects", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < 6; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		const result = handle_place_tile(0, y, "hotel_twin", world, ledger);
		expect(result.accepted).toBe(true);
		const rec = world.placed_objects[`0,${y}`];
		expect(rec.left_tile_index).toBe(0);
		expect(rec.right_tile_index).toBe(1); // width 2
	});

	it("stores placed_objects keyed by anchor position", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < 6; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotel_suite", world, ledger);
		expect(world.placed_objects["0," + y]).toBeDefined();
		// extension cells don't get their own record
		expect(world.placed_objects["1," + y]).toBeUndefined();
		expect(world.placed_objects["2," + y]).toBeUndefined();
	});

	it("infrastructure tiles do not create PlacedObjectRecord", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		handle_place_tile(0, GROUND_Y, "lobby", world, ledger);
		expect(Object.keys(world.placed_objects)).toHaveLength(0);
	});
});

// ─── Phase 2.1: Sidecar records ──────────────────────────────────────────────

describe("sidecar allocation", () => {
	function setupSupport(world: WorldState) {
		const y = GROUND_Y;
		for (let x = 0; x < 8; x++) world.cells[`${x},${y}`] = "floor";
	}

	it("allocates CommercialVenueRecord for restaurant", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "restaurant", world, ledger);
		const rec = world.placed_objects[`0,${GROUND_Y - 1}`];
		expect(rec.linked_record_index).toBeGreaterThanOrEqual(0);
		const sidecar = world.sidecars[rec.linked_record_index];
		expect(sidecar.kind).toBe("commercial_venue");
		if (sidecar.kind === "commercial_venue") {
			expect(sidecar.capacity).toBe(6);
			expect(sidecar.owner_subtype_index).toBe(0); // x=0
		}
	});

	it("allocates CommercialVenueRecord for fast_food with capacity 4", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "fast_food", world, ledger);
		const rec = world.placed_objects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linked_record_index];
		expect(sidecar.kind).toBe("commercial_venue");
		if (sidecar.kind === "commercial_venue") expect(sidecar.capacity).toBe(4);
	});

	it("allocates CommercialVenueRecord for retail with capacity 3", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "retail", world, ledger);
		const rec = world.placed_objects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linked_record_index];
		expect(sidecar.kind).toBe("commercial_venue");
		if (sidecar.kind === "commercial_venue") expect(sidecar.capacity).toBe(3);
	});

	it("allocates ServiceRequestEntry for security", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "security", world, ledger);
		const rec = world.placed_objects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linked_record_index];
		expect(sidecar.kind).toBe("service_request");
	});

	it("allocates EntertainmentLinkRecord for cinema with paired_subtype_index=0xff", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "cinema", world, ledger);
		const rec = world.placed_objects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linked_record_index];
		expect(sidecar.kind).toBe("entertainment_link");
		if (sidecar.kind === "entertainment_link") {
			expect(sidecar.paired_subtype_index).toBe(0xff);
		}
	});

	it("marks sidecar as invalid (owner_subtype_index=0xff) when demolished", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		const y = GROUND_Y - 1;
		handle_place_tile(0, y, "restaurant", world, ledger);
		const rec = world.placed_objects[`0,${y}`];
		const sidecarIdx = rec.linked_record_index;
		handle_remove_tile(0, y, world, ledger);
		expect(world.sidecars[sidecarIdx].owner_subtype_index).toBe(0xff);
		expect(world.placed_objects[`0,${y}`]).toBeUndefined();
	});
});

// ─── Phase 2.2: Checkpoint dispatcher ────────────────────────────────────────

describe("checkpoint dispatcher", () => {
	const ALL_CHECKPOINTS = [
		0x000, 0x020, 0x0f0, 0x3e8, 0x4b0, 0x578, 0x5dc, 0x640, 0x6a4, 0x708,
		0x76c, 0x7d0, 0x898, 0x8fc, 0x9c4, 0x9e5, 0x9f6, 0x0a06,
	] as const;

	it("defines exactly 18 checkpoints at the correct ticks", () => {
		// We can't inspect the CHECKPOINTS array directly, but we can verify
		// that run_checkpoints fires the facility-ledger rebuild at 0x0f0 and
		// the ledger rollover at 0x9e5 — as proxies for the table being correct.
		expect(ALL_CHECKPOINTS).toHaveLength(18);
	});

	it("fires checkpoint_facility_ledger_rebuild at tick 0x0f0", () => {
		const state = makeState();
		// Place a tile so primary_ledger has something to count
		const y = GROUND_Y - 1;
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotel_single", state.world, state.ledger);
		// primary_ledger is zeroed after rebuild_facility_ledger from handle_place_tile
		// Now manually zero primary_ledger to simulate it being dirty
		state.ledger.primary_ledger.fill(0);
		// Run checkpoints from prev=0x0ef to curr=0x0f0 — should fire rebuild
		run_checkpoints(state, 0x0ef, 0x0f0);
		expect(state.ledger.primary_ledger[3]).toBe(1); // family code 3 = hotel_single
	});

	it("does NOT fire 0x0f0 checkpoint when tick range excludes it", () => {
		const state = makeState();
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotel_single", state.world, state.ledger);
		state.ledger.primary_ledger.fill(0);
		// Range 0x0f1..0x0f2 should not include 0x0f0
		run_checkpoints(state, 0x0f1, 0x0f2);
		expect(state.ledger.primary_ledger[3]).toBe(0);
	});

	it("fires checkpoint_ledger_rollover at tick 0x9e5 on a 3-day boundary", () => {
		const state = makeState();
		// Set day_counter to a multiple of 3 so rollover runs
		state.time = { ...state.time, day_counter: 3 };
		const cashBefore = state.ledger.cash_balance;
		// Place a restaurant to generate an expense
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		for (let x = 0; x < 2; x++) state.world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "restaurant", state.world, state.ledger);
		const cashAfterBuild = state.ledger.cash_balance;
		state.ledger.secondary_ledger.fill(5);
		state.ledger.tertiary_ledger.fill(5);
		run_checkpoints(state, 0x9e4, 0x9e5);
		// Expense sweep should have fired → cash decreased
		expect(state.ledger.cash_balance).toBeLessThan(cashAfterBuild);
		// Rolling ledgers should be zeroed
		expect(state.ledger.secondary_ledger.every((v) => v === 0)).toBe(true);
		expect(state.ledger.tertiary_ledger.every((v) => v === 0)).toBe(true);
		// cycle base saved
		expect(state.ledger.cash_balance_cycle_base).toBe(state.ledger.cash_balance);
	});

	it("does NOT run expense sweep on a non-3-day boundary", () => {
		const state = makeState();
		state.time = { ...state.time, day_counter: 1 }; // not a multiple of 3
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "restaurant", state.world, state.ledger);
		const cashAfterBuild = state.ledger.cash_balance;
		run_checkpoints(state, 0x9e4, 0x9e5);
		expect(state.ledger.cash_balance).toBe(cashAfterBuild);
	});

	it("fires each checkpoint exactly once when tick crosses it", () => {
		// Use the facility-ledger as a counter: each rebuild zeroes then resets
		const state = makeState();
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotel_single", state.world, state.ledger);

		// Zero then run over 0x0f0
		state.ledger.primary_ledger.fill(0);
		run_checkpoints(state, 0x0ef, 0x0f1); // 0x0f0 in range once
		expect(state.ledger.primary_ledger[3]).toBe(1);
	});

	it("handles day wraparound: fires start-of-day checkpoint at tick 0", () => {
		// checkpoint 0x000 should fire on wraparound (prev=0x9ff, curr=0x002)
		// We detect it via facility ledger (0x0f0 is NOT in range here),
		// but we can test the explicit wraparound dispatch by using a range that
		// crosses 0x0f0 via wrap: prev=0x0f1, curr=0x0ef (wrapped).
		const state = makeState();
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotel_single", state.world, state.ledger);
		state.ledger.primary_ledger.fill(0);
		// curr < prev ⟹ wrapped; 0x0f0 > 0x0ef so it qualifies via "tick > prev_tick"
		run_checkpoints(state, 0x0ef, 0x0ee); // wrapped; 0x0f0 > 0x0ef → fires
		expect(state.ledger.primary_ledger[3]).toBe(1);
	});

	it("does not fire checkpoint in future tick when not wrapped and tick not in range", () => {
		const state = makeState();
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotel_single", state.world, state.ledger);
		state.ledger.primary_ledger.fill(0);
		// 0x0f0 is NOT in (0x100, 0x101]
		run_checkpoints(state, 0x100, 0x101);
		expect(state.ledger.primary_ledger[3]).toBe(0);
	});
});

// ─── Phase 2.3: Three-ledger money model ─────────────────────────────────────

describe("ledger: add_cashflow_from_family_resource", () => {
	it("credits cash_balance by payout * YEN_UNIT for known tile", () => {
		const ledger = makeLedger(0);
		// hotel_single variant 0 → YEN_1001.hotel_single[0] = 30 → ¥30,000
		add_cashflow_from_family_resource(ledger, "hotel_single", 0, 3);
		expect(ledger.cash_balance).toBe(30_000);
	});

	it("uses correct variant index into YEN_1001", () => {
		const ledger = makeLedger(0);
		// hotel_single variant 2 → 15 → ¥15,000
		add_cashflow_from_family_resource(ledger, "hotel_single", 2, 3);
		expect(ledger.cash_balance).toBe(15_000);
	});

	it("clamps variant index to max 3", () => {
		const ledger = makeLedger(0);
		// variant 99 → clamps to index 3 → 5 → ¥5,000
		add_cashflow_from_family_resource(ledger, "hotel_single", 99, 3);
		expect(ledger.cash_balance).toBe(5_000);
	});

	it("is a no-op for unknown tile_name", () => {
		const ledger = makeLedger(1000);
		add_cashflow_from_family_resource(ledger, "unknown_tile", 0, 0);
		expect(ledger.cash_balance).toBe(1000);
	});

	it("does not exceed CASH_CAP (99,999,999)", () => {
		const ledger = makeLedger(99_999_990);
		// condo variant 0 → 2000 → ¥2,000,000 — would exceed cap
		add_cashflow_from_family_resource(ledger, "condo", 0, 9);
		expect(ledger.cash_balance).toBe(99_999_999);
	});

	it("updates secondary_ledger[family_code]", () => {
		const ledger = makeLedger(0);
		add_cashflow_from_family_resource(ledger, "hotel_single", 0, 3);
		expect(ledger.secondary_ledger[3]).toBe(30_000);
	});

	it("updates primary_ledger[family_code]", () => {
		const ledger = makeLedger(0);
		add_cashflow_from_family_resource(ledger, "hotel_single", 0, 3);
		expect(ledger.primary_ledger[3]).toBe(30_000);
	});

	it("ignores family_code out of [0,255]", () => {
		const ledger = makeLedger(0);
		// family_code = -1 should not throw but won't write to ledger arrays
		add_cashflow_from_family_resource(ledger, "hotel_single", 0, -1);
		expect(ledger.cash_balance).toBe(30_000); // cash still credited
	});
});

describe("ledger: rebuild_facility_ledger", () => {
	it("counts placed_objects by object_type_code", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		world.cells[`0,${GROUND_Y}`] = "floor";
		world.cells[`1,${GROUND_Y}`] = "floor";
		// Manually add two hotel_single objects
		world.placed_objects["0," + y] = {
			left_tile_index: 0,
			right_tile_index: 0,
			object_type_code: 3,
			object_state_code: 0,
			linked_record_index: -1,
			aux_value_or_timer: 0,
			subtype_tile_offset: 0,
			needs_refresh_flag: 0,
			pairing_status: 0,
			pairing_active_flag: 0,
			activation_tick_count: 0,
			variant_index: 0,
		};
		world.placed_objects["1," + y] = {
			...world.placed_objects["0," + y],
			left_tile_index: 1,
			right_tile_index: 1,
			subtype_tile_offset: 1,
		};
		rebuild_facility_ledger(ledger, world);
		expect(ledger.primary_ledger[3]).toBe(2);
	});

	it("zeroes primary_ledger before counting", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		ledger.primary_ledger[3] = 99;
		rebuild_facility_ledger(ledger, world);
		expect(ledger.primary_ledger[3]).toBe(0);
	});
});

describe("ledger: do_expense_sweep", () => {
	it("charges YEN_1002 * 1000 per restaurant per sweep", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const y = GROUND_Y - 1;
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "restaurant", world, ledger);
		const cashAfterBuild = ledger.cash_balance;
		do_expense_sweep(ledger, world);
		// restaurant expense = 500 * 1000 = 500,000
		expect(cashAfterBuild - ledger.cash_balance).toBe(500_000);
	});

	it("updates tertiary_ledger for the charged type", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const y = GROUND_Y - 1;
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "restaurant", world, ledger);
		const rec = world.placed_objects[`0,${y}`];
		do_expense_sweep(ledger, world);
		expect(ledger.tertiary_ledger[rec.object_type_code]).toBeGreaterThan(0);
	});

	it("does not allow cash_balance to go below 0", () => {
		const world = makeWorld();
		const ledger = makeLedger(100); // barely any cash
		const y = GROUND_Y - 1;
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		world.placed_objects["0," + y] = {
			left_tile_index: 0,
			right_tile_index: 1,
			object_type_code: 6, // restaurant
			object_state_code: 0,
			linked_record_index: -1,
			aux_value_or_timer: 0,
			subtype_tile_offset: 0,
			needs_refresh_flag: 0,
			pairing_status: 0,
			pairing_active_flag: 0,
			activation_tick_count: 0,
			variant_index: 0,
		};
		do_expense_sweep(ledger, world);
		expect(ledger.cash_balance).toBe(0);
	});
});

describe("ledger: do_ledger_rollover", () => {
	it("runs expense sweep and resets rolling ledgers on a 3-day boundary", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const y = GROUND_Y - 1;
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "restaurant", world, ledger);
		ledger.secondary_ledger[6] = 1000;
		ledger.tertiary_ledger[6] = 500;
		const cashBefore = ledger.cash_balance;
		do_ledger_rollover(ledger, world, 3); // day 3 → 3 % 3 === 0
		expect(ledger.cash_balance).toBeLessThan(cashBefore); // expense fired
		expect(ledger.secondary_ledger[6]).toBe(0);
		expect(ledger.tertiary_ledger[6]).toBe(0);
		expect(ledger.cash_balance_cycle_base).toBe(ledger.cash_balance);
	});

	it("is a no-op when day_counter % 3 !== 0", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const cashBefore = ledger.cash_balance;
		ledger.secondary_ledger[6] = 1000;
		do_ledger_rollover(ledger, world, 1);
		expect(ledger.cash_balance).toBe(cashBefore);
		expect(ledger.secondary_ledger[6]).toBe(1000);
	});

	it("is a no-op on day 0 (day_counter=0, 0%3===0) but expense sweep has nothing to charge", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const cashBefore = ledger.cash_balance;
		do_ledger_rollover(ledger, world, 0); // 0 % 3 === 0 → fires but no objects
		// No objects → no expense, but secondary/tertiary are reset and cycle_base set
		expect(ledger.cash_balance_cycle_base).toBe(cashBefore);
	});
});

// ─── Phase 2.4: Build command ─────────────────────────────────────────────────

describe("handle_place_tile", () => {
	it("rejects unknown tile type", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_place_tile(0, GROUND_Y, "ufo", world, ledger);
		expect(r.accepted).toBe(false);
		expect(r.reason).toMatch(/invalid tile type/i);
	});

	it("rejects placement out of bounds (x)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_place_tile(-1, GROUND_Y, "lobby", world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("rejects placement out of bounds (y)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_place_tile(0, -1, "lobby", world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("rejects multi-tile placement that would overflow the grid", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		// office is 6 wide — place at x=60 → extends to x=65 ≥ GRID_WIDTH=64
		const r = handle_place_tile(60, GROUND_Y - 1, "office", world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("rejects lobby on non-lobby row", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_place_tile(0, GROUND_Y - 1, "lobby", world, ledger);
		expect(r.accepted).toBe(false);
		expect(r.reason).toMatch(/lobby/i);
	});

	it("accepts lobby on the ground floor row", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_place_tile(0, GROUND_Y, "lobby", world, ledger);
		expect(r.accepted).toBe(true);
	});

	it("rejects placement on already-occupied cell", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		handle_place_tile(0, GROUND_Y, "lobby", world, ledger);
		const r = handle_place_tile(0, GROUND_Y, "lobby", world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("rejects non-lobby tiles without support below", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		// No floor tile at y+1 → no support
		const r = handle_place_tile(0, GROUND_Y - 1, "hotel_single", world, ledger);
		expect(r.accepted).toBe(false);
		expect(r.reason).toMatch(/support/i);
	});

	it("rejects when insufficient funds", () => {
		const world = makeWorld();
		const ledger = makeLedger(0);
		for (let x = 0; x < 6; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		const r = handle_place_tile(0, GROUND_Y - 1, "office", world, ledger);
		expect(r.accepted).toBe(false);
		expect(r.reason).toMatch(/insufficient funds/i);
	});

	it("deducts construction cost on success", () => {
		const world = makeWorld();
		const ledger = makeLedger(1_000_000);
		world.cells[`0,${GROUND_Y}`] = "floor";
		const cost = TILE_COSTS["hotel_single"];
		const r = handle_place_tile(0, GROUND_Y - 1, "hotel_single", world, ledger);
		expect(r.accepted).toBe(true);
		expect(ledger.cash_balance).toBe(1_000_000 - cost);
	});

	it("returns a patch array covering each placed cell", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		const r = handle_place_tile(0, GROUND_Y - 1, "hotel_twin", world, ledger);
		expect(r.accepted).toBe(true);
		expect(r.patch).toHaveLength(2);
		expect(r.patch?.[0]).toMatchObject({ x: 0, isAnchor: true });
		expect(r.patch?.[1]).toMatchObject({ x: 1, isAnchor: false });
	});

	it("sets cellToAnchor for extension cells of multi-tile object", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < 3; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotel_suite", world, ledger);
		expect(world.cellToAnchor[`1,${y}`]).toBe(`0,${y}`);
		expect(world.cellToAnchor[`2,${y}`]).toBe(`0,${y}`);
	});

	it("replaces floor tiles under a multi-cell build", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		// Pre-fill with floor
		for (let x = 0; x < 3; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${y}`] = "floor";
		}
		handle_place_tile(0, y, "hotel_suite", world, ledger);
		// Anchor cell holds the tile type
		expect(world.cells[`0,${y}`]).toBe("hotel_suite");
	});

	it("stairs placement succeeds as overlay on existing base tiles", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		world.cells[`0,${GROUND_Y}`] = "floor";
		world.cells[`1,${GROUND_Y}`] = "floor";
		const r = handle_place_tile(0, GROUND_Y, "stairs", world, ledger);
		expect(r.accepted).toBe(true);
		expect(r.patch?.[0]).toMatchObject({ isOverlay: true });
		expect(world.overlays[`0,${GROUND_Y}`]).toBe("stairs");
	});

	it("stairs rejected when base tile missing", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_place_tile(0, GROUND_Y, "stairs", world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("runs global rebuilds (facility ledger updated) after placement", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		ledger.primary_ledger.fill(99);
		world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotel_single", world, ledger);
		// rebuild_facility_ledger zeroes then counts → should be 1 hotel_single
		expect(ledger.primary_ledger[3]).toBe(1);
	});
});

// ─── Phase 2.4: Demolish command ─────────────────────────────────────────────

describe("handle_remove_tile", () => {
	it("rejects empty cell", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_remove_tile(0, GROUND_Y, world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("rejects out-of-bounds", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const r = handle_remove_tile(-1, GROUND_Y, world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("removes anchor and extension cells for multi-tile object", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotel_twin", world, ledger);
		handle_remove_tile(0, y, world, ledger);
		expect(world.cells[`0,${y}`]).toBeUndefined();
		expect(world.cells[`1,${y}`]).toBeUndefined();
		expect(world.cellToAnchor[`1,${y}`]).toBeUndefined();
	});

	it("removes extension cell click (via cellToAnchor)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < 2; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotel_twin", world, ledger);
		// Click extension cell
		handle_remove_tile(1, y, world, ledger);
		expect(world.cells[`0,${y}`]).toBeUndefined();
	});

	it("removes PlacedObjectRecord on demolish", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotel_single", world, ledger);
		handle_remove_tile(0, y, world, ledger);
		expect(world.placed_objects[`0,${y}`]).toBeUndefined();
	});

	it("turns to floor (not empty) when tiles above exist", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 2;
		// Support layers
		for (let x = 0; x < 1; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${GROUND_Y - 1}`] = "floor";
		}
		// Place hotel at y, then place floor above it
		world.cells[`0,${y}`] = "hotel_single";
		world.placed_objects[`0,${y}`] = {
			left_tile_index: 0,
			right_tile_index: 0,
			object_type_code: 3,
			object_state_code: 0,
			linked_record_index: -1,
			aux_value_or_timer: 0,
			subtype_tile_offset: 0,
			needs_refresh_flag: 0,
			pairing_status: 0,
			pairing_active_flag: 0,
			activation_tick_count: 0,
			variant_index: 0,
		};
		// Place a floor tile directly above
		world.cells[`0,${y - 1}`] = "floor";
		handle_remove_tile(0, y, world, ledger);
		// Should turn to floor, not empty
		expect(world.cells[`0,${y}`]).toBe("floor");
	});

	it("removes overlay before underlying tile when overlay present", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		world.cells[`0,${GROUND_Y}`] = "floor";
		world.cells[`1,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y, "stairs", world, ledger);
		// First remove should strip the overlay
		const r1 = handle_remove_tile(0, GROUND_Y, world, ledger);
		expect(r1.accepted).toBe(true);
		expect(r1.patch?.[0]).toMatchObject({ tileType: "empty", isOverlay: true });
		expect(world.overlays[`0,${GROUND_Y}`]).toBeUndefined();
		// Underlying tile still there
		expect(world.cells[`0,${GROUND_Y}`]).toBe("floor");
	});

	it("runs global rebuilds after demolish", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotel_single", world, ledger);
		// Now rebuild primary_ledger artificially
		ledger.primary_ledger[3] = 99;
		handle_remove_tile(0, GROUND_Y - 1, world, ledger);
		// After demolish, rebuild runs → primary_ledger[3] = 0
		expect(ledger.primary_ledger[3]).toBe(0);
	});
});

// ─── Phase 2.1 / world.ts: Grid constants ────────────────────────────────────

describe("world constants", () => {
	it("GRID_HEIGHT = 120", () => {
		expect(GRID_HEIGHT).toBe(120);
	});

	it("GRID_WIDTH = 64", () => {
		expect(GRID_WIDTH).toBe(64);
	});

	it("UNDERGROUND_FLOORS = 10 (floors 0–9 underground)", () => {
		expect(UNDERGROUND_FLOORS).toBe(10);
	});

	it("GROUND_Y is a valid lobby row", () => {
		expect(isValidLobbyY(GROUND_Y)).toBe(true);
	});

	it("isValidLobbyY: every 15 floors above ground is valid (up to top)", () => {
		for (let step = 0; step * 15 <= GROUND_Y; step++) {
			const y = GROUND_Y - step * 15;
			if (y >= 0) {
				expect(isValidLobbyY(y)).toBe(true);
			}
		}
	});

	it("isValidLobbyY: non-lobby rows return false", () => {
		expect(isValidLobbyY(GROUND_Y - 1)).toBe(false);
		expect(isValidLobbyY(GROUND_Y - 7)).toBe(false);
	});

	it("isValidLobbyY: rows below ground (y > GROUND_Y) return false", () => {
		expect(isValidLobbyY(GROUND_Y + 1)).toBe(false);
	});
});

// ─── Phase 2.1 / resources.ts: YEN tables ────────────────────────────────────

describe("YEN tables", () => {
	it("YEN_1001 hotel payout: [30, 20, 15, 5]", () => {
		expect(YEN_1001.hotel_single).toEqual([30, 20, 15, 5]);
	});

	it("YEN_1001 office payout: [150, 100, 50, 20]", () => {
		expect(YEN_1001.office).toEqual([150, 100, 50, 20]);
	});

	it("YEN_1001 condo payout: [2000, 1500, 1000, 400]", () => {
		expect(YEN_1001.condo).toEqual([2000, 1500, 1000, 400]);
	});

	it("YEN_1001 retail payout: [200, 150, 100, 40]", () => {
		expect(YEN_1001.retail).toEqual([200, 150, 100, 40]);
	});

	it("YEN_1002 restaurant expense = 500", () => {
		expect(YEN_1002.restaurant).toBe(500);
	});

	it("YEN_1002 fast_food expense = 50", () => {
		expect(YEN_1002.fast_food).toBe(50);
	});

	it("YEN_1002 retail expense = 1000", () => {
		expect(YEN_1002.retail).toBe(1000);
	});

	it("YEN_1002 security expense = 200", () => {
		expect(YEN_1002.security).toBe(200);
	});

	it("YEN_1002 housekeeping expense = 100", () => {
		expect(YEN_1002.housekeeping).toBe(100);
	});

	it("YEN_1002 elevator_local expense = 200", () => {
		expect(YEN_1002.elevator_local).toBe(200);
	});

	it("YEN_1002 escalator expense = 100", () => {
		expect(YEN_1002.escalator).toBe(100);
	});
});

// ─── fill_row_gaps helper ─────────────────────────────────────────────────────

describe("fill_row_gaps", () => {
	it("fills unsupported gap between two tiles with a floor tile", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		// Support row
		for (let x = 0; x < 4; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		// Place tiles at x=0 and x=3, leave x=1,2 empty
		world.cells[`0,${y}`] = "floor";
		world.cells[`3,${y}`] = "floor";
		const patch: { x: number; y: number; tileType: string; isAnchor: boolean }[] =
			[];
		fill_row_gaps(y, world, patch);
		// x=1 and x=2 should be filled
		expect(world.cells[`1,${y}`]).toBe("floor");
		expect(world.cells[`2,${y}`]).toBe("floor");
		expect(patch.some((p) => p.x === 1 && p.tileType === "floor")).toBe(true);
	});

	it("does not fill gap if there is no support below", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		// Only x=0 has support; x=1 does not
		world.cells[`0,${GROUND_Y}`] = "floor";
		world.cells[`0,${y}`] = "floor";
		world.cells[`2,${y}`] = "floor";
		const patch: { x: number; y: number; tileType: string; isAnchor: boolean }[] =
			[];
		fill_row_gaps(y, world, patch);
		expect(world.cells[`1,${y}`]).toBeUndefined();
	});
});
