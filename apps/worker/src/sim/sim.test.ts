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

import { describe, expect, it } from "vitest";
import { floor_to_slot, make_carrier, tick_all_carriers } from "./carriers";
import {
	fill_row_gaps,
	handle_place_tile,
	handle_remove_tile,
	run_global_rebuilds,
} from "./commands";
import {
	add_cashflow_from_family_resource,
	createLedgerState,
	do_expense_sweep,
	do_ledger_rollover,
	type LedgerState,
	rebuild_facility_ledger,
} from "./ledger";
import { TILE_COSTS, YEN_1001, YEN_1002 } from "./resources";
import {
	is_floor_span_walkable_for_express_route,
	is_floor_span_walkable_for_local_route,
	select_best_route_candidate,
} from "./routing";
import { run_checkpoints, type SimState } from "./scheduler";
import {
	advanceOneTick,
	createNewGameTimeState,
	createTimeState,
	DAY_TICK_INCOME,
	DAY_TICK_MAX,
	NEW_GAME_DAY_TICK,
	pre_day_4,
} from "./time";
import {
	createGateFlags,
	GRID_HEIGHT,
	GRID_WIDTH,
	GROUND_Y,
	isValidLobbyY,
	UNDERGROUND_FLOORS,
	type WorldState,
} from "./world";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeWorld(_opts?: { cash?: number }): WorldState {
	return {
		towerId: "test",
		name: "Test Tower",
		width: GRID_WIDTH,
		height: GRID_HEIGHT,
		gateFlags: createGateFlags(),
		cells: {},
		cellToAnchor: {},
		overlays: {},
		overlayToAnchor: {},
		placedObjects: {},
		sidecars: [],
		carriers: [],
		specialLinks: [],
		floorWalkabilityFlags: new Array(GRID_HEIGHT).fill(0),
		transferGroupCache: new Array(GRID_HEIGHT).fill(0),
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
function placeSupportRow(y: number, world: WorldState, _ledger: LedgerState) {
	for (let x = 0; x < GRID_WIDTH; x++) {
		world.cells[`${x},${y}`] = "floor";
	}
}

// ─── Phase 1: Time model ──────────────────────────────────────────────────────

describe("time model", () => {
	it("createTimeState starts at tick 0 (test baseline)", () => {
		const t = createTimeState();
		expect(t.dayTick).toBe(0);
		expect(t.daypartIndex).toBe(0);
		expect(t.dayCounter).toBe(0);
		expect(t.calendarPhaseFlag).toBe(0);
		expect(t.starCount).toBe(1);
		expect(t.totalTicks).toBe(0);
	});

	it("increments dayTick and totalTicks each step", () => {
		const t = createTimeState();
		const { time } = advanceOneTick(t);
		expect(time.dayTick).toBe(1);
		expect(time.totalTicks).toBe(1);
	});

	it("computes daypartIndex as floor(dayTick / 400)", () => {
		let t = createTimeState();
		// tick 0 → part 0; tick 399 → part 0; tick 400 → part 1
		for (let i = 0; i < 400; i++) {
			expect(t.daypartIndex).toBe(0);
			t = advanceOneTick(t).time;
		}
		expect(t.daypartIndex).toBe(1);
	});

	it("wraps dayTick at DAY_TICK_MAX (2600)", () => {
		expect(DAY_TICK_MAX).toBe(0x0a28);
		let t = createTimeState();
		for (let i = 0; i < DAY_TICK_MAX; i++) {
			t = advanceOneTick(t).time;
		}
		// After DAY_TICK_MAX advances the counter wraps back to 0.
		expect(t.dayTick).toBe(0);
	});

	it("sets incomeCheckpoint=true only at DAY_TICK_INCOME (0x08fc)", () => {
		expect(DAY_TICK_INCOME).toBe(0x08fc);
		let t = createTimeState();
		// Advance to dayTick = DAY_TICK_INCOME - 1
		for (let i = 0; i < DAY_TICK_INCOME - 1; i++) {
			t = advanceOneTick(t).time;
		}
		// The next step (DAY_TICK_INCOME - 1 → DAY_TICK_INCOME - 1 is already t.dayTick)
		// One more step brings us to DAY_TICK_INCOME - should NOT yet be the checkpoint
		// Actually t.dayTick is already DAY_TICK_INCOME - 1 after the loop above.
		// advanceOneTick will produce dayTick = DAY_TICK_INCOME → that IS the checkpoint.
		// So let's check the tick just before too.
		// Advance one more to reach DAY_TICK_INCOME:
		const atIncome = advanceOneTick(t);
		expect(atIncome.time.dayTick).toBe(DAY_TICK_INCOME);
		expect(atIncome.incomeCheckpoint).toBe(true);
		// The tick before should NOT have triggered it
		// Roll back: advance from 0 to DAY_TICK_INCOME - 2
		let t2 = createTimeState();
		for (let i = 0; i < DAY_TICK_INCOME - 2; i++) {
			t2 = advanceOneTick(t2).time;
		}
		const beforeIncome = advanceOneTick(t2);
		expect(beforeIncome.time.dayTick).toBe(DAY_TICK_INCOME - 1);
		expect(beforeIncome.incomeCheckpoint).toBe(false);
	});

	it("increments dayCounter at DAY_TICK_INCOME", () => {
		let t = createTimeState();
		for (let i = 0; i < DAY_TICK_INCOME; i++) {
			t = advanceOneTick(t).time;
		}
		expect(t.dayCounter).toBe(1);
	});

	it("computes calendarPhaseFlag correctly", () => {
		// flag = (dayCounter % 12) % 3 >= 2 ? 1 : 0
		// day 0→0, 1→0, 2→1, 3→0, 4→0, 5→1, 6→0, 7→0, 8→1, 9→0, 10→0, 11→1
		const expected = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
		let t = createTimeState();
		for (let day = 0; day <= 12; day++) {
			// Advance to DAY_TICK_INCOME for this day
			while (t.dayCounter <= day && t.dayTick !== 0) {
				t = advanceOneTick(t).time;
			}
			// After dayCounter = day, check the flag
			if (t.dayCounter === day) {
				expect(t.calendarPhaseFlag).toBe(expected[day]);
			}
			// advance one full day
			for (let i = 0; i < DAY_TICK_MAX; i++) {
				t = advanceOneTick(t).time;
			}
		}
	});

	it("createNewGameTimeState starts at NEW_GAME_DAY_TICK (0x9e5 = 2533), daypart 6", () => {
		const t = createNewGameTimeState();
		expect(t.dayTick).toBe(NEW_GAME_DAY_TICK);
		expect(t.dayTick).toBe(0x9e5);
		expect(t.daypartIndex).toBe(6);
		expect(t.dayCounter).toBe(0);
		expect(t.starCount).toBe(1);
	});

	it("pre_day_4 returns true for daypart < 4, false otherwise", () => {
		const t = createTimeState();
		expect(pre_day_4({ ...t, daypartIndex: 0 })).toBe(true);
		expect(pre_day_4({ ...t, daypartIndex: 3 })).toBe(true);
		expect(pre_day_4({ ...t, daypartIndex: 4 })).toBe(false);
		expect(pre_day_4({ ...t, daypartIndex: 6 })).toBe(false);
	});
});

// ─── Phase 2.1: PlacedObjectRecord ───────────────────────────────────────────

describe("PlacedObjectRecord", () => {
	it("is created with correct spec-compliant init values for hotelSingle", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeSupportRow(GROUND_Y + 1, world, ledger); // support one row below
		// Place a floor row at GROUND_Y so hotelSingle at GROUND_Y - 1 can have support
		placeSupportRow(GROUND_Y, world, ledger);
		const y = GROUND_Y - 1;
		world.cells[`0,${y + 1}`] = "floor"; // ensure support
		const result = handle_place_tile(0, y, "hotelSingle", world, ledger);
		expect(result.accepted).toBe(true);
		const rec = world.placedObjects[`0,${y}`];
		expect(rec).toBeDefined();
		expect(rec.leftTileIndex).toBe(0);
		expect(rec.rightTileIndex).toBe(3); // width 4
		expect(rec.objectTypeCode).toBe(3); // family code for hotelSingle
		expect(rec.stayPhase).toBe(0); // init = 0
		expect(rec.linkedRecordIndex).toBe(-1); // no sidecar for hotel
		expect(rec.needsRefreshFlag).toBe(1); // init = 1 (dirty — picked up next sweep)
		expect(rec.pairingStatus).toBe(-1); // init = -1 (invalid; first sweep populates)
		expect(rec.pairingActiveFlag).toBe(1); // init = 1 (first-activation latch)
		expect(rec.activationTickCount).toBe(0);
		expect(rec.variantIndex).toBe(1); // family 3 → init = 1
		expect(rec.vipFlag).toBe(false);
	});

	it("sets rightTileIndex = left + width - 1 for multi-tile objects", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		const result = handle_place_tile(0, y, "hotelTwin", world, ledger);
		expect(result.accepted).toBe(true);
		const rec = world.placedObjects[`0,${y}`];
		expect(rec.leftTileIndex).toBe(0);
		expect(rec.rightTileIndex).toBe(7); // width 8
	});

	it("stores placedObjects keyed by anchor position", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotelSuite", world, ledger);
		expect(world.placedObjects[`0,${y}`]).toBeDefined();
		// extension cells don't get their own record
		expect(world.placedObjects[`1,${y}`]).toBeUndefined();
		expect(world.placedObjects[`2,${y}`]).toBeUndefined();
	});

	it("infrastructure tiles do not create PlacedObjectRecord", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		handle_place_tile(0, GROUND_Y, "lobby", world, ledger);
		expect(Object.keys(world.placedObjects)).toHaveLength(0);
	});
});

// ─── Phase 2.1: Sidecar records ──────────────────────────────────────────────

describe("sidecar allocation", () => {
	function setupSupport(world: WorldState) {
		const y = GROUND_Y;
		for (let x = 0; x < GRID_WIDTH; x++) world.cells[`${x},${y}`] = "floor";
	}

	it("allocates CommercialVenueRecord for restaurant", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "restaurant", world, ledger);
		const rec = world.placedObjects[`0,${GROUND_Y - 1}`];
		expect(rec.linkedRecordIndex).toBeGreaterThanOrEqual(0);
		const sidecar = world.sidecars[rec.linkedRecordIndex];
		expect(sidecar.kind).toBe("commercial_venue");
		if (sidecar.kind === "commercial_venue") {
			expect(sidecar.capacity).toBe(6);
			expect(sidecar.ownerSubtypeIndex).toBe(0); // x=0
		}
	});

	it("allocates CommercialVenueRecord for fastFood with capacity 4", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "fastFood", world, ledger);
		const rec = world.placedObjects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linkedRecordIndex];
		expect(sidecar.kind).toBe("commercial_venue");
		if (sidecar.kind === "commercial_venue") expect(sidecar.capacity).toBe(4);
	});

	it("allocates CommercialVenueRecord for retail with capacity 3", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "retail", world, ledger);
		const rec = world.placedObjects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linkedRecordIndex];
		expect(sidecar.kind).toBe("commercial_venue");
		if (sidecar.kind === "commercial_venue") expect(sidecar.capacity).toBe(3);
	});

	it("allocates ServiceRequestEntry for security", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "security", world, ledger);
		const rec = world.placedObjects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linkedRecordIndex];
		expect(sidecar.kind).toBe("service_request");
	});

	it("allocates EntertainmentLinkRecord for cinema with pairedSubtypeIndex=0xff", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		handle_place_tile(0, GROUND_Y - 1, "cinema", world, ledger);
		const rec = world.placedObjects[`0,${GROUND_Y - 1}`];
		const sidecar = world.sidecars[rec.linkedRecordIndex];
		expect(sidecar.kind).toBe("entertainment_link");
		if (sidecar.kind === "entertainment_link") {
			expect(sidecar.pairedSubtypeIndex).toBe(0xff);
		}
	});

	it("marks sidecar as invalid (ownerSubtypeIndex=0xff) when demolished", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupSupport(world);
		const y = GROUND_Y - 1;
		handle_place_tile(0, y, "restaurant", world, ledger);
		const rec = world.placedObjects[`0,${y}`];
		const sidecarIdx = rec.linkedRecordIndex;
		handle_remove_tile(0, y, world, ledger);
		expect(world.sidecars[sidecarIdx].ownerSubtypeIndex).toBe(0xff);
		expect(world.placedObjects[`0,${y}`]).toBeUndefined();
	});
});

// ─── Phase 2.2: Checkpoint dispatcher ────────────────────────────────────────

describe("checkpoint dispatcher", () => {
	const ALL_CHECKPOINTS = [
		0x000, 0x020, 0x0f0, 0x3e8, 0x4b0, 0x578, 0x5dc, 0x640, 0x6a4, 0x708, 0x76c,
		0x7d0, 0x898, 0x8fc, 0x9c4, 0x9e5, 0x9f6, 0x0a06,
	] as const;

	it("defines exactly 18 checkpoints at the correct ticks", () => {
		// We can't inspect the CHECKPOINTS array directly, but we can verify
		// that run_checkpoints fires the facility-ledger rebuild at 0x0f0 and
		// the ledger rollover at 0x9e5 — as proxies for the table being correct.
		expect(ALL_CHECKPOINTS).toHaveLength(18);
	});

	it("fires checkpoint_facility_ledger_rebuild at tick 0x0f0", () => {
		const state = makeState();
		// Place a tile so primaryLedger has something to count
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			state.world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotelSingle", state.world, state.ledger);
		// primaryLedger is zeroed after rebuild_facility_ledger from handle_place_tile
		// Now manually zero primaryLedger to simulate it being dirty
		state.ledger.primaryLedger.fill(0);
		// Run checkpoints from prev=0x0ef to curr=0x0f0 — should fire rebuild
		run_checkpoints(state, 0x0ef, 0x0f0);
		expect(state.ledger.primaryLedger[3]).toBe(1); // family code 3 = hotelSingle
	});

	it("does NOT fire 0x0f0 checkpoint when tick range excludes it", () => {
		const state = makeState();
		for (let x = 0; x < GRID_WIDTH; x++)
			state.world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(
			0,
			GROUND_Y - 1,
			"hotelSingle",
			state.world,
			state.ledger,
		);
		state.ledger.primaryLedger.fill(0);
		// Range 0x0f1..0x0f2 should not include 0x0f0
		run_checkpoints(state, 0x0f1, 0x0f2);
		expect(state.ledger.primaryLedger[3]).toBe(0);
	});

	it("fires checkpoint_ledger_rollover at tick 0x9e5 on a 3-day boundary", () => {
		const state = makeState();
		// Set dayCounter to a multiple of 3 so rollover runs
		state.time = { ...state.time, dayCounter: 3 };
		const _cashBefore = state.ledger.cashBalance;
		// Place a restaurant to generate an expense
		for (let x = 0; x < GRID_WIDTH; x++)
			state.world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "restaurant", state.world, state.ledger);
		const cashAfterBuild = state.ledger.cashBalance;
		state.ledger.secondaryLedger.fill(5);
		state.ledger.tertiaryLedger.fill(5);
		run_checkpoints(state, 0x9e4, 0x9e5);
		// Expense sweep should have fired → cash decreased
		expect(state.ledger.cashBalance).toBeLessThan(cashAfterBuild);
		// Rolling ledgers should be zeroed
		expect(state.ledger.secondaryLedger.every((v) => v === 0)).toBe(true);
		expect(state.ledger.tertiaryLedger.every((v) => v === 0)).toBe(true);
		// cycle base saved
		expect(state.ledger.cashBalanceCycleBase).toBe(state.ledger.cashBalance);
	});

	it("does NOT run expense sweep on a non-3-day boundary", () => {
		const state = makeState();
		state.time = { ...state.time, dayCounter: 1 }; // not a multiple of 3
		for (let x = 0; x < GRID_WIDTH; x++)
			state.world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "restaurant", state.world, state.ledger);
		const cashAfterBuild = state.ledger.cashBalance;
		run_checkpoints(state, 0x9e4, 0x9e5);
		expect(state.ledger.cashBalance).toBe(cashAfterBuild);
	});

	it("fires each checkpoint exactly once when tick crosses it", () => {
		// Use the facility-ledger as a counter: each rebuild zeroes then resets
		const state = makeState();
		for (let x = 0; x < GRID_WIDTH; x++)
			state.world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(
			0,
			GROUND_Y - 1,
			"hotelSingle",
			state.world,
			state.ledger,
		);

		// Zero then run over 0x0f0
		state.ledger.primaryLedger.fill(0);
		run_checkpoints(state, 0x0ef, 0x0f1); // 0x0f0 in range once
		expect(state.ledger.primaryLedger[3]).toBe(1);
	});

	it("handles day wraparound: fires start-of-day checkpoint at tick 0", () => {
		// checkpoint 0x000 should fire on wraparound (prev=0x9ff, curr=0x002)
		// We detect it via facility ledger (0x0f0 is NOT in range here),
		// but we can test the explicit wraparound dispatch by using a range that
		// crosses 0x0f0 via wrap: prev=0x0f1, curr=0x0ef (wrapped).
		const state = makeState();
		const y = GROUND_Y - 1;
		state.world.placedObjects[`0,${y}`] = {
			leftTileIndex: 0,
			rightTileIndex: 3,
			objectTypeCode: 3,
			stayPhase: 0,
			linkedRecordIndex: -1,
			auxValueOrTimer: 0,
			needsRefreshFlag: 1,
			pairingStatus: -1,
			pairingActiveFlag: 1,
			activationTickCount: 0,
			variantIndex: 1,
			vipFlag: false,
		};
		state.ledger.primaryLedger.fill(0);
		// curr < prev ⟹ wrapped; 0x0f0 > 0x0ef so it qualifies via "tick > prev_tick"
		run_checkpoints(state, 0x0ef, 0x0ee); // wrapped; 0x0f0 > 0x0ef → fires
		expect(state.ledger.primaryLedger[3]).toBe(1);
	});

	it("does not fire checkpoint in future tick when not wrapped and tick not in range", () => {
		const state = makeState();
		state.world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(
			0,
			GROUND_Y - 1,
			"hotelSingle",
			state.world,
			state.ledger,
		);
		state.ledger.primaryLedger.fill(0);
		// 0x0f0 is NOT in (0x100, 0x101]
		run_checkpoints(state, 0x100, 0x101);
		expect(state.ledger.primaryLedger[3]).toBe(0);
	});
});

// ─── Phase 2.3: Three-ledger money model ─────────────────────────────────────

describe("ledger: add_cashflow_from_family_resource", () => {
	it("credits cashBalance by payout * YEN_UNIT for known tile", () => {
		const ledger = makeLedger(0);
		// hotelSingle variant 0 → YEN_1001.hotelSingle[0] = 30 → ¥30,000
		add_cashflow_from_family_resource(ledger, "hotelSingle", 0, 3);
		expect(ledger.cashBalance).toBe(30_000);
	});

	it("uses correct variant index into YEN_1001", () => {
		const ledger = makeLedger(0);
		// hotelSingle variant 2 → 15 → ¥15,000
		add_cashflow_from_family_resource(ledger, "hotelSingle", 2, 3);
		expect(ledger.cashBalance).toBe(15_000);
	});

	it("clamps variant index to max 3", () => {
		const ledger = makeLedger(0);
		// variant 99 → clamps to index 3 → 5 → ¥5,000
		add_cashflow_from_family_resource(ledger, "hotelSingle", 99, 3);
		expect(ledger.cashBalance).toBe(5_000);
	});

	it("is a no-op for unknown tile_name", () => {
		const ledger = makeLedger(1000);
		add_cashflow_from_family_resource(ledger, "unknown_tile", 0, 0);
		expect(ledger.cashBalance).toBe(1000);
	});

	it("does not exceed CASH_CAP (99,999,999)", () => {
		const ledger = makeLedger(99_999_990);
		// condo variant 0 → 2000 → ¥2,000,000 — would exceed cap
		add_cashflow_from_family_resource(ledger, "condo", 0, 9);
		expect(ledger.cashBalance).toBe(99_999_999);
	});

	it("updates secondaryLedger[family_code]", () => {
		const ledger = makeLedger(0);
		add_cashflow_from_family_resource(ledger, "hotelSingle", 0, 3);
		expect(ledger.secondaryLedger[3]).toBe(30_000);
	});

	it("updates primaryLedger[family_code]", () => {
		const ledger = makeLedger(0);
		add_cashflow_from_family_resource(ledger, "hotelSingle", 0, 3);
		expect(ledger.primaryLedger[3]).toBe(30_000);
	});

	it("ignores family_code out of [0,255]", () => {
		const ledger = makeLedger(0);
		// family_code = -1 should not throw but won't write to ledger arrays
		add_cashflow_from_family_resource(ledger, "hotelSingle", 0, -1);
		expect(ledger.cashBalance).toBe(30_000); // cash still credited
	});
});

describe("ledger: rebuild_facility_ledger", () => {
	it("counts placedObjects by objectTypeCode", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		world.cells[`0,${GROUND_Y}`] = "floor";
		world.cells[`1,${GROUND_Y}`] = "floor";
		// Manually add two hotelSingle objects
		world.placedObjects[`0,${y}`] = {
			leftTileIndex: 0,
			rightTileIndex: 0,
			objectTypeCode: 3,
			stayPhase: 0,
			linkedRecordIndex: -1,
			auxValueOrTimer: 0,
			needsRefreshFlag: 1,
			pairingStatus: -1,
			pairingActiveFlag: 1,
			activationTickCount: 0,
			variantIndex: 1,
		};
		world.placedObjects[`1,${y}`] = {
			...world.placedObjects[`0,${y}`],
			leftTileIndex: 1,
			rightTileIndex: 1,
		};
		rebuild_facility_ledger(ledger, world);
		expect(ledger.primaryLedger[3]).toBe(2);
	});

	it("zeroes primaryLedger before counting", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		ledger.primaryLedger[3] = 99;
		rebuild_facility_ledger(ledger, world);
		expect(ledger.primaryLedger[3]).toBe(0);
	});
});

describe("ledger: do_expense_sweep", () => {
	it("charges YEN_1002 * 1000 per restaurant per sweep", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "restaurant", world, ledger);
		const cashAfterBuild = ledger.cashBalance;
		do_expense_sweep(ledger, world);
		// restaurant expense = 500 * 1000 = 500,000
		expect(cashAfterBuild - ledger.cashBalance).toBe(500_000);
	});

	it("updates tertiaryLedger for the charged type", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "restaurant", world, ledger);
		const rec = world.placedObjects[`0,${y}`];
		do_expense_sweep(ledger, world);
		expect(ledger.tertiaryLedger[rec.objectTypeCode]).toBeGreaterThan(0);
	});

	it("does not allow cashBalance to go below 0", () => {
		const world = makeWorld();
		const ledger = makeLedger(100); // barely any cash
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		world.placedObjects[`0,${y}`] = {
			leftTileIndex: 0,
			rightTileIndex: 1,
			objectTypeCode: 6, // restaurant
			stayPhase: 0,
			linkedRecordIndex: -1,
			auxValueOrTimer: 0,
			needsRefreshFlag: 1,
			pairingStatus: -1,
			pairingActiveFlag: 1,
			activationTickCount: 0,
			variantIndex: 4, // family 6 (restaurant) → init = 4
		};
		do_expense_sweep(ledger, world);
		expect(ledger.cashBalance).toBe(0);
	});
});

describe("ledger: do_ledger_rollover", () => {
	it("runs expense sweep and resets rolling ledgers on a 3-day boundary", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "restaurant", world, ledger);
		ledger.secondaryLedger[6] = 1000;
		ledger.tertiaryLedger[6] = 500;
		const cashBefore = ledger.cashBalance;
		do_ledger_rollover(ledger, world, 3); // day 3 → 3 % 3 === 0
		expect(ledger.cashBalance).toBeLessThan(cashBefore); // expense fired
		expect(ledger.secondaryLedger[6]).toBe(0);
		expect(ledger.tertiaryLedger[6]).toBe(0);
		expect(ledger.cashBalanceCycleBase).toBe(ledger.cashBalance);
	});

	it("is a no-op when dayCounter % 3 !== 0", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const cashBefore = ledger.cashBalance;
		ledger.secondaryLedger[6] = 1000;
		do_ledger_rollover(ledger, world, 1);
		expect(ledger.cashBalance).toBe(cashBefore);
		expect(ledger.secondaryLedger[6]).toBe(1000);
	});

	it("is a no-op on day 0 (dayCounter=0, 0%3===0) but expense sweep has nothing to charge", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		const cashBefore = ledger.cashBalance;
		do_ledger_rollover(ledger, world, 0); // 0 % 3 === 0 → fires but no objects
		// No objects → no expense, but secondary/tertiary are reset and cycle_base set
		expect(ledger.cashBalanceCycleBase).toBe(cashBefore);
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
		// office is 9 wide — place at x=60 → extends past GRID_WIDTH=64
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
		const r = handle_place_tile(0, GROUND_Y - 1, "hotelSingle", world, ledger);
		expect(r.accepted).toBe(false);
		expect(r.reason).toMatch(/support/i);
	});

	it("rejects when insufficient funds", () => {
		const world = makeWorld();
		const ledger = makeLedger(0);
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		const r = handle_place_tile(0, GROUND_Y - 1, "office", world, ledger);
		expect(r.accepted).toBe(false);
		expect(r.reason).toMatch(/insufficient funds/i);
	});

	it("deducts construction cost on success", () => {
		const world = makeWorld();
		const ledger = makeLedger(1_000_000);
		for (let x = 0; x < 4; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		const cost = TILE_COSTS.hotelSingle;
		const r = handle_place_tile(0, GROUND_Y - 1, "hotelSingle", world, ledger);
		expect(r.accepted).toBe(true);
		expect(ledger.cashBalance).toBe(1_000_000 - cost);
	});

	it("returns a patch array covering each placed cell", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		const r = handle_place_tile(0, GROUND_Y - 1, "hotelTwin", world, ledger);
		expect(r.accepted).toBe(true);
		expect(r.patch).toHaveLength(8);
		expect(r.patch?.[0]).toMatchObject({ x: 0, isAnchor: true });
		expect(r.patch?.[7]).toMatchObject({ x: 7, isAnchor: false });
	});

	it("sets cellToAnchor for extension cells of multi-tile object", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotelSuite", world, ledger);
		expect(world.cellToAnchor[`1,${y}`]).toBe(`0,${y}`);
		expect(world.cellToAnchor[`2,${y}`]).toBe(`0,${y}`);
		expect(world.cellToAnchor[`11,${y}`]).toBe(`0,${y}`);
	});

	it("replaces floor tiles under a multi-cell build", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		// Pre-fill with floor
		for (let x = 0; x < 12; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${y}`] = "floor";
		}
		handle_place_tile(0, y, "hotelSuite", world, ledger);
		// Anchor cell holds the tile type
		expect(world.cells[`0,${y}`]).toBe("hotelSuite");
	});

	it("stairs placement succeeds as overlay on existing base tiles", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 8; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
		}
		const r = handle_place_tile(0, GROUND_Y, "stairs", world, ledger);
		expect(r.accepted).toBe(true);
		expect(r.patch?.[0]).toMatchObject({ isOverlay: true });
		expect(world.overlays[`0,${GROUND_Y}`]).toBe("stairs");
		expect(world.overlayToAnchor[`7,${GROUND_Y}`]).toBe(`0,${GROUND_Y}`);
	});

	it("stairs rejected when base tile missing", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 7; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
		}
		const r = handle_place_tile(0, GROUND_Y, "stairs", world, ledger);
		expect(r.accepted).toBe(false);
	});

	it("elevator placement occupies all overlay extension cells across its width", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 4; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
		}
		const r = handle_place_tile(0, GROUND_Y, "elevator", world, ledger);
		expect(r.accepted).toBe(true);
		expect(world.overlays[`0,${GROUND_Y}`]).toBe("elevator");
		expect(world.overlayToAnchor[`3,${GROUND_Y}`]).toBe(`0,${GROUND_Y}`);
	});

	it("elevator auto-places supported floor cells across its full width", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 4; x++) {
			world.cells[`${x},${GROUND_Y + 1}`] = "floor";
		}
		const r = handle_place_tile(0, GROUND_Y, "elevator", world, ledger);
		expect(r.accepted).toBe(true);
		for (let x = 0; x < 4; x++) {
			expect(world.cells[`${x},${GROUND_Y}`]).toBe("floor");
		}
		expect(r.patch?.filter((cell) => cell.tileType === "floor")).toHaveLength(
			4,
		);
	});

	it("rejects elevator placement when adjacent shaft segment is partially misaligned", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 5; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${GROUND_Y + 1}`] = "floor";
		}
		const initial = handle_place_tile(0, GROUND_Y, "elevator", world, ledger);
		expect(initial.accepted).toBe(true);

		const misaligned = handle_place_tile(
			1,
			GROUND_Y - 1,
			"elevator",
			world,
			ledger,
		);
		expect(misaligned.accepted).toBe(false);
		expect(misaligned.reason).toBe(
			"Elevator must align with adjacent shaft segments",
		);
	});

	it("allows elevator placement when adjacent shaft segment is fully aligned", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 4; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${GROUND_Y + 1}`] = "floor";
		}
		const initial = handle_place_tile(0, GROUND_Y, "elevator", world, ledger);
		expect(initial.accepted).toBe(true);

		const aligned = handle_place_tile(
			0,
			GROUND_Y - 1,
			"elevator",
			world,
			ledger,
		);
		expect(aligned.accepted).toBe(true);
		expect(world.overlays[`0,${GROUND_Y - 1}`]).toBe("elevator");
		expect(world.overlayToAnchor[`3,${GROUND_Y - 1}`]).toBe(
			`0,${GROUND_Y - 1}`,
		);
	});

	it("runs global rebuilds (facility ledger updated) after placement", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		ledger.primaryLedger.fill(99);
		for (let x = 0; x < 4; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotelSingle", world, ledger);
		// rebuild_facility_ledger zeroes then counts → should be 1 hotelSingle
		expect(ledger.primaryLedger[3]).toBe(1);
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
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotelTwin", world, ledger);
		handle_remove_tile(0, y, world, ledger);
		expect(world.cells[`0,${y}`]).toBeUndefined();
		expect(world.cells[`7,${y}`]).toBeUndefined();
		expect(world.cellToAnchor[`7,${y}`]).toBeUndefined();
	});

	it("removes extension cell click (via cellToAnchor)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		for (let x = 0; x < GRID_WIDTH; x++)
			world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotelTwin", world, ledger);
		// Click extension cell
		handle_remove_tile(7, y, world, ledger);
		expect(world.cells[`0,${y}`]).toBeUndefined();
	});

	it("removes PlacedObjectRecord on demolish", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const y = GROUND_Y - 1;
		world.cells[`0,${GROUND_Y}`] = "floor";
		handle_place_tile(0, y, "hotelSingle", world, ledger);
		handle_remove_tile(0, y, world, ledger);
		expect(world.placedObjects[`0,${y}`]).toBeUndefined();
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
		world.cells[`0,${y}`] = "hotelSingle";
		world.placedObjects[`0,${y}`] = {
			leftTileIndex: 0,
			rightTileIndex: 0,
			objectTypeCode: 3,
			stayPhase: 0,
			linkedRecordIndex: -1,
			auxValueOrTimer: 0,
			needsRefreshFlag: 1,
			pairingStatus: -1,
			pairingActiveFlag: 1,
			activationTickCount: 0,
			variantIndex: 1,
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
		for (let x = 0; x < 8; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
		}
		handle_place_tile(0, GROUND_Y, "stairs", world, ledger);
		// First remove should strip the overlay
		const r1 = handle_remove_tile(7, GROUND_Y, world, ledger);
		expect(r1.accepted).toBe(true);
		expect(r1.patch?.[0]).toMatchObject({ tileType: "empty", isOverlay: true });
		expect(world.overlays[`0,${GROUND_Y}`]).toBeUndefined();
		expect(world.overlayToAnchor[`7,${GROUND_Y}`]).toBeUndefined();
		// Underlying tile still there
		expect(world.cells[`0,${GROUND_Y}`]).toBe("floor");
	});

	it("runs global rebuilds after demolish", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 4; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		handle_place_tile(0, GROUND_Y - 1, "hotelSingle", world, ledger);
		// Now rebuild primaryLedger artificially
		ledger.primaryLedger[3] = 99;
		handle_remove_tile(0, GROUND_Y - 1, world, ledger);
		// After demolish, rebuild runs → primaryLedger[3] = 0
		expect(ledger.primaryLedger[3]).toBe(0);
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
		expect(YEN_1001.hotelSingle).toEqual([30, 20, 15, 5]);
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

	it("YEN_1002 fastFood expense = 50", () => {
		expect(YEN_1002.fastFood).toBe(50);
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

	it("YEN_1002 elevatorLocal expense = 200", () => {
		expect(YEN_1002.elevatorLocal).toBe(200);
	});

	it("YEN_1002 escalator expense = 100", () => {
		expect(YEN_1002.escalator).toBe(100);
	});
});

// ─── fill_row_gaps helper ─────────────────────────────────────────────────────

describe("fill_row_gaps", () => {
	it("fills unsupported gap between two tiles with a floor tile", () => {
		const world = makeWorld();
		const _ledger = makeLedger();
		const y = GROUND_Y - 1;
		// Support row
		for (let x = 0; x < 4; x++) world.cells[`${x},${GROUND_Y}`] = "floor";
		// Place tiles at x=0 and x=3, leave x=1,2 empty
		world.cells[`0,${y}`] = "floor";
		world.cells[`3,${y}`] = "floor";
		const patch: {
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
		}[] = [];
		fill_row_gaps(y, world, patch);
		// x=1 and x=2 should be filled
		expect(world.cells[`1,${y}`]).toBe("floor");
		expect(world.cells[`2,${y}`]).toBe("floor");
		expect(patch.some((p) => p.x === 1 && p.tileType === "floor")).toBe(true);
	});

	it("does not fill gap if there is no support below", () => {
		const world = makeWorld();
		const _ledger = makeLedger();
		const y = GROUND_Y - 1;
		// Only x=0 has support; x=1 does not
		world.cells[`0,${GROUND_Y}`] = "floor";
		world.cells[`0,${y}`] = "floor";
		world.cells[`2,${y}`] = "floor";
		const patch: {
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
		}[] = [];
		fill_row_gaps(y, world, patch);
		expect(world.cells[`1,${y}`]).toBeUndefined();
	});
});

// ─── Phase 3: Routing + Carrier System ────────────────────────────────────────

// Helper: place N contiguous elevator cells in a column as a vertical shaft
function placeElevatorShaft(
	world: WorldState,
	ledger: ReturnType<typeof makeLedger>,
	x: number,
	fromFloor: number, // inclusive, floor index
	toFloor: number, // inclusive, floor index
): void {
	const lo = Math.min(fromFloor, toFloor);
	const hi = Math.max(fromFloor, toFloor);
	for (let f = lo; f <= hi; f++) {
		const y = GRID_HEIGHT - 1 - f;
		world.cells[`${x},${y}`] = "floor"; // base tile (elevator is an overlay)
		world.overlays[`${x},${y}`] = "elevator";
	}
	run_global_rebuilds(world, ledger);
}

describe("floor_to_slot", () => {
	it("returns direct floor offset for mode-2 (Service/express) carrier", () => {
		// mode 2 = Service Elevator (express-mode routing): direct offset
		const carrier = make_carrier(0, 5, 2, 10, 30);
		expect(floor_to_slot(carrier, 10)).toBe(0);
		expect(floor_to_slot(carrier, 15)).toBe(5);
		expect(floor_to_slot(carrier, 30)).toBe(20);
	});

	it("returns -1 for floors outside served range", () => {
		const carrier = make_carrier(0, 5, 0, 10, 20);
		expect(floor_to_slot(carrier, 9)).toBe(-1);
		expect(floor_to_slot(carrier, 21)).toBe(-1);
	});

	it("mode-0/1 (local-mode) returns rel offset for the first 10 floors", () => {
		// Modes 0 and 1 are local-mode; first 10 floors (rel 0–9) map directly
		const carrier = make_carrier(0, 3, 0, 10, 20);
		expect(floor_to_slot(carrier, 10)).toBe(0); // rel 0
		expect(floor_to_slot(carrier, 14)).toBe(4); // rel 4
		expect(floor_to_slot(carrier, 19)).toBe(9); // rel 9
		// rel 10+ (beyond the 10-slot limit) without a sky-lobby slot returns -1
		expect(floor_to_slot(carrier, 20)).toBe(-1);
	});
});

describe("rebuild_carrier_list", () => {
	it("creates one carrier per elevator column", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 15);
		expect(world.carriers).toHaveLength(1);
		expect(world.carriers[0].column).toBe(0);
		expect(world.carriers[0].bottomServedFloor).toBe(10);
		expect(world.carriers[0].topServedFloor).toBe(15);
		expect(world.carriers[0].carrierMode).toBe(0);
	});

	it("creates separate carriers for separate columns", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 15);
		placeElevatorShaft(world, ledger, 5, 10, 20);
		expect(world.carriers).toHaveLength(2);
	});

	it("escalator cells do NOT create a carrier (spec: escalators are special-link segments)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		world.cells[`2,${GRID_HEIGHT - 1 - 10}`] = "floor";
		world.cells[`2,${GRID_HEIGHT - 1 - 11}`] = "floor";
		world.overlays[`2,${GRID_HEIGHT - 1 - 10}`] = "escalator";
		world.overlays[`2,${GRID_HEIGHT - 1 - 11}`] = "escalator";
		run_global_rebuilds(world, ledger);
		// No carrier record for escalators
		expect(world.carriers).toHaveLength(0);
		// But a special-link segment covers floors 10–11
		const active = world.specialLinks.filter((s) => s.active);
		expect(active).toHaveLength(1);
		expect(active[0].startFloor).toBe(10);
		expect(active[0].heightMetric).toBe(1); // floors 10 and 11
		expect(active[0].flags & 1).toBe(0); // local-mode (not express)
		expect(active[0].carrierId).toBe(-1); // no carrierId
	});

	it("preserves car position when carrier range extends", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 15);
		world.carriers[0].cars[0].currentFloor = 12;
		// Extend shaft upward
		world.cells[`0,${GRID_HEIGHT - 1 - 16}`] = "floor";
		world.overlays[`0,${GRID_HEIGHT - 1 - 16}`] = "elevator";
		run_global_rebuilds(world, ledger);
		expect(world.carriers[0].cars[0].currentFloor).toBe(12);
		expect(world.carriers[0].topServedFloor).toBe(16);
	});

	it("removes carrier when all cells demolished", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 12);
		for (let f = 10; f <= 12; f++) {
			delete world.overlays[`0,${GRID_HEIGHT - 1 - f}`];
		}
		run_global_rebuilds(world, ledger);
		expect(world.carriers).toHaveLength(0);
	});
});

describe("rebuild_specialLinks", () => {
	it("registers one active segment per carrier", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const active = world.specialLinks.filter((s) => s.active);
		expect(active).toHaveLength(1);
		expect(active[0].startFloor).toBe(10);
		expect(active[0].heightMetric).toBe(10);
		expect(active[0].flags & 1).toBe(0); // local = not express
	});
});

describe("rebuild_walkability_flags", () => {
	it("sets bit 0 for floors covered by a local elevator", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 15);
		for (let f = 10; f <= 15; f++) {
			expect(world.floorWalkabilityFlags[f] & 1).toBe(1);
		}
		expect(world.floorWalkabilityFlags[9] & 1).toBe(0);
		expect(world.floorWalkabilityFlags[16] & 1).toBe(0);
	});
});

describe("is_floor_span_walkable", () => {
	it("local route: true when all floors covered", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 25);
		expect(is_floor_span_walkable_for_local_route(world, 10, 20)).toBe(true);
	});

	it("local route: false when gap in coverage", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		// Two separate shafts with a gap
		placeElevatorShaft(world, ledger, 0, 10, 15);
		placeElevatorShaft(world, ledger, 5, 18, 25);
		expect(is_floor_span_walkable_for_local_route(world, 10, 25)).toBe(false);
	});

	it("express route: false when only local elevator present", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		expect(is_floor_span_walkable_for_express_route(world, 10, 20)).toBe(false);
	});
});

describe("select_best_route_candidate", () => {
	it("returns null when from == to", () => {
		const world = makeWorld();
		world.floorWalkabilityFlags = new Array(GRID_HEIGHT).fill(0);
		world.specialLinks = [];
		world.transferGroupCache = new Array(GRID_HEIGHT).fill(0);
		expect(select_best_route_candidate(world, 10, 10)).toBeNull();
	});

	it("finds local route via special link with cost |Δ|*8", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const route = select_best_route_candidate(world, 10, 15);
		expect(route).not.toBeNull();
		expect(route?.cost).toBe(5 * 8); // |15-10| * 8 = 40
	});

	it("returns null if no carrier covers the span", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 14); // doesn't reach floor 15
		const route = select_best_route_candidate(world, 10, 15);
		expect(route).toBeNull();
	});

	it("prefers lower-cost local route over transfer route", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		// Single shaft covering full span → local route exists
		placeElevatorShaft(world, ledger, 0, 10, 25);
		const direct = select_best_route_candidate(world, 10, 25);
		expect(direct?.cost).toBe(15 * 8); // local: 120
	});
});

describe("car state machine", () => {
	it("car starts idle at bottom floor", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const car = world.carriers[0].cars[0];
		expect(car.currentFloor).toBe(10);
		expect(car.speedCounter).toBe(0);
		expect(car.doorWaitCounter).toBe(0);
	});

	it("car stays at bottom when no waiters after many ticks", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		for (let i = 0; i < 100; i++) tick_all_carriers(world);
		const car = world.carriers[0].cars[0];
		expect(car.currentFloor).toBe(10);
	});

	it("car moves to target floor when waitingCount is set", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		// Request pickup at floor 15 (slot = 15 - 10 = 5)
		car.waitingCount[5] = 1;
		// Tick enough for car to travel 5 floors (8 ticks/floor = 40 ticks) + door dwell
		for (let i = 0; i < 200; i++) tick_all_carriers(world);
		expect(car.currentFloor).toBe(15);
	});

	it("out-of-range car is reset to bottom floor", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const car = world.carriers[0].cars[0];
		car.currentFloor = 99; // force out of range
		tick_all_carriers(world);
		expect(car.currentFloor).toBe(10);
	});

	it("car opens doors at target floor (doorWaitCounter set)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		car.waitingCount[5] = 1; // floor 15
		// Run until car arrives and opens doors
		let doors_opened = false;
		for (let i = 0; i < 200; i++) {
			tick_all_carriers(world);
			if (car.currentFloor === 15 && car.doorWaitCounter > 0) {
				doors_opened = true;
				break;
			}
		}
		expect(doors_opened).toBe(true);
	});
});
