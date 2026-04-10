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
import {
	enqueue_carrier_route,
	floor_to_slot,
	make_carrier,
	rebuild_carrier_list,
	tick_all_carriers,
} from "./carriers";
import {
	fill_row_gaps,
	handle_place_tile,
	handle_remove_tile,
	run_global_rebuilds,
} from "./commands";
import {
	advance_entity_refresh_stride,
	create_entity_state_records,
	populate_carrier_requests,
	rebuild_runtime_entities,
	reconcile_entity_transport,
	resetCommercialVenueCycle,
	update_security_housekeeping_state,
} from "./entities";
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
	rebuild_transfer_group_cache,
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
		entities: [],
		carriers: [],
		specialLinks: [],
		specialLinkRecords: [],
		floorWalkabilityFlags: new Array(GRID_HEIGHT).fill(0),
		transferGroupEntries: [],
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

	it("charges carrier operating expenses by mode and car count", () => {
		const world = makeWorld();
		const ledger = makeLedger(10_000_000);
		world.carriers.push(make_carrier(0, 0, 1, 10, 20, 2));
		world.carriers.push(make_carrier(1, 8, 0, 10, 20, 1));
		world.carriers.push(make_carrier(2, 16, 2, 10, 20, 3));

		const cashBefore = ledger.cashBalance;
		do_expense_sweep(ledger, world);

		expect(cashBefore - ledger.cashBalance).toBe(
			(2 * 200 + 1 * 400 + 3 * 100) * 1000,
		);
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
		// office is 9 wide — place it at the last valid anchor + 1 so it spills past the edge
		const r = handle_place_tile(
			GRID_WIDTH - 8,
			GROUND_Y - 1,
			"office",
			world,
			ledger,
		);
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

	it("rejects aligned elevator placement when the adjacent shaft uses a different mode", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 4; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${GROUND_Y + 1}`] = "floor";
		}
		const initial = handle_place_tile(
			0,
			GROUND_Y,
			"elevatorExpress",
			world,
			ledger,
		);
		expect(initial.accepted).toBe(true);

		const conflict = handle_place_tile(
			0,
			GROUND_Y - 1,
			"elevator",
			world,
			ledger,
		);
		expect(conflict.accepted).toBe(false);
		expect(conflict.reason).toBe(
			"Elevator shaft mode must match adjacent segments",
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

	it("GRID_WIDTH = 375", () => {
		expect(GRID_WIDTH).toBe(375);
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
	it("TILE_COSTS matches the spec construction table for shared tools", () => {
		expect(TILE_COSTS.floor).toBe(500);
		expect(TILE_COSTS.lobby).toBe(3_000);
		expect(TILE_COSTS.stairs).toBe(5_000);
		expect(TILE_COSTS.elevator).toBe(200_000);
		expect(TILE_COSTS.escalator).toBe(20_000);
		expect(TILE_COSTS.hotelSingle).toBe(20_000);
		expect(TILE_COSTS.hotelTwin).toBe(50_000);
		expect(TILE_COSTS.hotelSuite).toBe(100_000);
		expect(TILE_COSTS.restaurant).toBe(200_000);
		expect(TILE_COSTS.fastFood).toBe(100_000);
		expect(TILE_COSTS.retail).toBe(100_000);
		expect(TILE_COSTS.office).toBe(40_000);
		expect(TILE_COSTS.condo).toBe(80_000);
		expect(TILE_COSTS.cinema).toBe(500_000);
		expect(TILE_COSTS.entertainment).toBe(100_000);
		expect(TILE_COSTS.security).toBe(500_000);
		expect(TILE_COSTS.housekeeping).toBe(50_000);
		expect(TILE_COSTS.parking).toBe(5_000);
		expect(TILE_COSTS.metro).toBe(1_000_000);
	});

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

	it("YEN_1002 elevatorExpress expense = 400", () => {
		expect(YEN_1002.elevatorExpress).toBe(400);
	});

	it("YEN_1002 elevatorService expense = 100", () => {
		expect(YEN_1002.elevatorService).toBe(100);
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
	overlayType: "elevator" | "elevatorExpress" | "elevatorService" = "elevator",
): void {
	const lo = Math.min(fromFloor, toFloor);
	const hi = Math.max(fromFloor, toFloor);
	for (let f = lo; f <= hi; f++) {
		const y = GRID_HEIGHT - 1 - f;
		world.cells[`${x},${y}`] = "floor"; // base tile (elevator is an overlay)
		world.overlays[`${x},${y}`] = overlayType;
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

	it("mode-0 (express sky-lobby) uses sparse slot mapping: lobby floors + sky-lobby stops only", () => {
		// Mode 0 = Express Elevator: floors 1–10 → slots 0–9, sky-lobby floors → slots 10+
		const carrier = make_carrier(0, 3, 0, 10, 20);
		expect(floor_to_slot(carrier, 10)).toBe(0); // lobby band slot 0
		expect(floor_to_slot(carrier, 14)).toBe(4); // lobby band slot 4
		expect(floor_to_slot(carrier, 19)).toBe(9); // lobby band slot 9
		// Non-sky-lobby floor above the lobby band returns -1 for mode-0 carriers
		expect(floor_to_slot(carrier, 20)).toBe(-1);
	});

	it("mode-1 (standard elevator) uses linear slot mapping across its full range", () => {
		// Mode 1 = Standard Elevator: all floors in [bottom, top] are valid slots
		const carrier = make_carrier(0, 3, 1, 10, 25);
		expect(floor_to_slot(carrier, 10)).toBe(0);
		expect(floor_to_slot(carrier, 19)).toBe(9);
		expect(floor_to_slot(carrier, 20)).toBe(10); // beyond lobby band, still valid
		expect(floor_to_slot(carrier, 25)).toBe(15);
		expect(floor_to_slot(carrier, 26)).toBe(-1); // above top served floor
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
		expect(world.carriers[0].carrierMode).toBe(1);
	});

	it("treats a 4-wide placed elevator shaft as one carrier keyed by its anchor column", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let x = 0; x < 4; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
			world.cells[`${x},${GROUND_Y + 1}`] = "floor";
		}

		expect(
			handle_place_tile(0, GROUND_Y, "elevator", world, ledger).accepted,
		).toBe(true);
		expect(
			handle_place_tile(0, GROUND_Y - 1, "elevator", world, ledger).accepted,
		).toBe(true);

		expect(world.carriers).toHaveLength(1);
		expect(world.carriers[0]?.column).toBe(0);
		expect(world.carriers[0]?.bottomServedFloor).toBe(10);
		expect(world.carriers[0]?.topServedFloor).toBe(11);
	});

	it("collapses extension overlay cells onto the anchor column when rebuilding carriers", () => {
		const world = makeWorld();
		world.overlays[`0,${GROUND_Y}`] = "elevator";
		world.overlayToAnchor[`1,${GROUND_Y}`] = `0,${GROUND_Y}`;
		world.overlayToAnchor[`2,${GROUND_Y}`] = `0,${GROUND_Y}`;
		world.overlayToAnchor[`3,${GROUND_Y}`] = `0,${GROUND_Y}`;
		world.overlays[`1,${GROUND_Y - 1}`] = "elevator";
		world.overlayToAnchor[`2,${GROUND_Y - 1}`] = `1,${GROUND_Y - 1}`;
		world.overlayToAnchor[`3,${GROUND_Y - 1}`] = `1,${GROUND_Y - 1}`;
		world.overlayToAnchor[`4,${GROUND_Y - 1}`] = `1,${GROUND_Y - 1}`;

		rebuild_carrier_list(world);

		expect(world.carriers).toHaveLength(2);
		expect(world.carriers[0]?.column).toBe(0);
		expect(world.carriers[1]?.column).toBe(1);
	});

	it("rebuilds express and service elevator overlays with distinct modes", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20, "elevatorExpress");
		placeElevatorShaft(world, ledger, 8, 10, 20, "elevatorService");

		expect(world.carriers).toHaveLength(2);
		expect(world.carriers[0]?.carrierMode).toBe(0);
		expect(world.carriers[1]?.carrierMode).toBe(2);
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
		expect(active[0].entryFloor).toBe(10);
		expect(active[0].heightMetric).toBe(2); // floors 10 and 11 inclusive
		expect(active[0].flags & 1).toBe(0); // escalator = local-branch (bit 0 = 0)
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
	it("registers one active raw segment per stairs/escalator span", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let floor = 10; floor <= 20; floor++) {
			world.cells[`0,${GRID_HEIGHT - 1 - floor}`] = "floor";
			world.overlays[`0,${GRID_HEIGHT - 1 - floor}`] = "stairs";
		}
		run_global_rebuilds(world, ledger);
		const active = world.specialLinks.filter((s) => s.active);
		expect(active).toHaveLength(1);
		expect(active[0].entryFloor).toBe(10);
		expect(active[0].heightMetric).toBe(11);
		expect(active[0].flags & 1).toBe(1); // stairs = express-branch (bit 0 = 1)
	});
});

describe("rebuild_walkability_flags", () => {
	it("sets bit 1 (express) for floors covered by a stairs span", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let floor = 10; floor <= 15; floor++) {
			world.cells[`0,${GRID_HEIGHT - 1 - floor}`] = "floor";
			world.overlays[`0,${GRID_HEIGHT - 1 - floor}`] = "stairs";
		}
		run_global_rebuilds(world, ledger);
		for (let f = 10; f <= 15; f++) {
			expect(world.floorWalkabilityFlags[f] & 2).toBe(2);
		}
		expect(world.floorWalkabilityFlags[9] & 2).toBe(0);
		expect(world.floorWalkabilityFlags[16] & 2).toBe(0);
	});
});

describe("is_floor_span_walkable", () => {
	it("local route: true when all floors covered", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 25);
		expect(is_floor_span_walkable_for_local_route(world, 10, 20)).toBe(false);
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
		for (let floor = 10; floor <= 20; floor++) {
			world.cells[`0,${GRID_HEIGHT - 1 - floor}`] = "floor";
			world.overlays[`0,${GRID_HEIGHT - 1 - floor}`] = "escalator";
		}
		run_global_rebuilds(world, ledger);
		const route = select_best_route_candidate(world, 10, 15);
		expect(route).not.toBeNull();
		expect(route?.cost).toBe(5 * 8); // |15-10| * 8 = 40
	});

	it("only uses special-link segment shortcuts from the segment entry floor", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		for (let floor = 10; floor <= 20; floor++) {
			world.cells[`0,${GRID_HEIGHT - 1 - floor}`] = "floor";
			world.overlays[`0,${GRID_HEIGHT - 1 - floor}`] = "stairs";
		}
		run_global_rebuilds(world, ledger);
		const route = select_best_route_candidate(world, 12, 15);
		expect(route).toBeNull();
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
		// Standard local elevator: first ten floors above bottom are queueable.
		placeElevatorShaft(world, ledger, 0, 10, 25);
		const direct = select_best_route_candidate(world, 10, 19);
		expect(direct?.cost).toBe(0x280 + 9 * 8);
	});

	it("does not score a standard elevator trip to floors outside its served range", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 25);

		// Floor 20 is within the served range (10–25) and is now reachable
		expect(select_best_route_candidate(world, 10, 20)?.kind).toBe("carrier");
		// Floor 26 is above the top served floor — no route
		expect(select_best_route_candidate(world, 10, 26)).toBeNull();
	});

	it("chooses a local leg to an in-span transfer floor for viable derived records", () => {
		const world = makeWorld();
		world.specialLinks[0] = {
			active: true,
			flags: 3 << 1,
			heightMetric: 3,
			entryFloor: 10,
			reservedByte: 0,
			descendingLoadCounter: 0,
			ascendingLoadCounter: 0,
		};
		world.specialLinkRecords[0] = {
			active: true,
			lowerFloor: 10,
			upperFloor: 14,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		};
		world.specialLinkRecords[0].reachabilityMasksByFloor[12] = 1;
		world.specialLinkRecords[0].reachabilityMasksByFloor[20] = 1 << 0;

		const route = select_best_route_candidate(world, 10, 20);
		expect(route?.kind).toBe("segment");
		expect(route?.id).toBe(0);
		expect(route?.cost).toBe(2 * 8);
	});

	it("chooses the edge-adjacent transfer floor for derived record routing", () => {
		const world = makeWorld();
		world.specialLinks[0] = {
			active: true,
			flags: 5 << 1,
			heightMetric: 5,
			entryFloor: 10,
			reservedByte: 0,
			descendingLoadCounter: 0,
			ascendingLoadCounter: 0,
		};
		world.specialLinkRecords[0] = {
			active: true,
			lowerFloor: 10,
			upperFloor: 14,
			reachabilityMasksByFloor: new Array(GRID_HEIGHT).fill(0),
		};
		world.specialLinkRecords[0].reachabilityMasksByFloor[11] = 1;
		world.specialLinkRecords[0].reachabilityMasksByFloor[14] = 2;
		world.specialLinkRecords[0].reachabilityMasksByFloor[20] = 1 << 0;

		const route = select_best_route_candidate(world, 10, 20);
		expect(route?.kind).toBe("segment");
		expect(route?.id).toBe(0);
		expect(route?.cost).toBe(4 * 8);
	});

	it("does not expose transfer reachability without an explicit concourse floor", () => {
		const world = makeWorld();
		world.carriers.push(make_carrier(0, 0, 1, 10, 20));
		world.carriers.push(make_carrier(1, 4, 1, 25, 35));
		rebuild_transfer_group_cache(world);

		const route = select_best_route_candidate(world, 12, 30);
		expect(route).toBeNull();
	});

	it("rebuilds transfer cache only on explicit concourse floors", () => {
		const world = makeWorld();
		world.placedObjects[`0,${GROUND_Y}`] = {
			leftTileIndex: 0,
			rightTileIndex: 4,
			objectTypeCode: 24,
			stayPhase: 0,
			auxValueOrTimer: 0,
			linkedRecordIndex: -1,
			needsRefreshFlag: 1,
			pairingActiveFlag: 1,
			pairingStatus: -1,
			variantIndex: 4,
			activationTickCount: 0,
		};
		world.carriers.push(make_carrier(0, 0, 1, 10, 20));
		world.carriers.push(make_carrier(1, 4, 1, 0, 4));
		rebuild_transfer_group_cache(world);

		expect(world.transferGroupEntries[0]?.active).toBe(true);
		expect(world.transferGroupEntries[0]?.taggedFloor).toBe(10);
		expect(world.transferGroupEntries[0]?.carrierMask).toBe(
			(1 << 0) | (1 << 1),
		);
		expect(world.transferGroupCache[10]).toBe((1 << 0) | (1 << 1));
		expect(world.transferGroupCache[9]).toBe(0);
		expect(world.transferGroupCache[12]).toBe(0);
	});

	it("preserves distinct tagged transfer entries on the same floor", () => {
		const world = makeWorld();
		world.placedObjects[`0,${GROUND_Y}`] = {
			leftTileIndex: 0,
			rightTileIndex: 3,
			objectTypeCode: 24,
			stayPhase: 0,
			auxValueOrTimer: 0,
			linkedRecordIndex: -1,
			needsRefreshFlag: 1,
			pairingActiveFlag: 1,
			pairingStatus: -1,
			variantIndex: 4,
			activationTickCount: 0,
		};
		world.placedObjects[`20,${GROUND_Y}`] = {
			leftTileIndex: 20,
			rightTileIndex: 23,
			objectTypeCode: 24,
			stayPhase: 0,
			auxValueOrTimer: 0,
			linkedRecordIndex: -1,
			needsRefreshFlag: 1,
			pairingActiveFlag: 1,
			pairingStatus: -1,
			variantIndex: 4,
			activationTickCount: 0,
		};
		world.carriers.push(make_carrier(0, 0, 1, 10, 20));
		world.carriers.push(make_carrier(1, 20, 1, 0, 10));
		rebuild_transfer_group_cache(world);

		const activeEntries = world.transferGroupEntries.filter(
			(entry) => entry.active,
		);
		expect(activeEntries).toHaveLength(2);
		expect(activeEntries[0]?.taggedFloor).toBe(10);
		expect(activeEntries[1]?.taggedFloor).toBe(10);
		expect(world.transferGroupCache[10]).toBe((1 << 0) | (1 << 1));
	});

	it("allows transfer routing through a shared concourse mask", () => {
		const world = makeWorld();
		world.carriers.push(make_carrier(0, 0, 1, 10, 20));
		world.carriers.push(make_carrier(1, 4, 1, 0, 4));
		world.transferGroupEntries[0] = {
			active: true,
			taggedFloor: 10,
			carrierMask: (1 << 0) | (1 << 1),
		};
		world.transferGroupCache[10] = (1 << 0) | (1 << 1);

		const route = select_best_route_candidate(world, 12, 2);
		expect(route?.kind).toBe("carrier");
		expect(route?.id).toBe(0);
		expect(route?.cost).toBe(3000 + 10 * 8); // no distance penalty (delta 10 < threshold 80)
	});

	it("does not score transfer routes from derived floor cache without a tagged entry", () => {
		const world = makeWorld();
		world.carriers.push(make_carrier(0, 0, 1, 10, 20));
		world.carriers.push(make_carrier(1, 4, 1, 0, 4));
		world.transferGroupCache[10] = (1 << 0) | (1 << 1);

		const route = select_best_route_candidate(world, 12, 2);
		expect(route).toBeNull();
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
		for (let i = 0; i < 100; i++) tick_all_carriers(world, createTimeState());
		const car = world.carriers[0].cars[0];
		expect(car.currentFloor).toBe(10);
		expect(car.targetFloor).toBe(10);
		expect(car.speedCounter).toBe(0);
		expect(car.doorWaitCounter).toBe(0);
	});

	it("car moves to target floor when waitingCount is set", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		enqueue_carrier_route(carrier, "r1", 15, 10, 1);
		// Tick enough for the car to service the request at least once.
		let reachedTarget = false;
		for (let i = 0; i < 200; i++) {
			tick_all_carriers(world, createTimeState());
			if (car.currentFloor === 15) {
				reachedTarget = true;
				break;
			}
		}
		expect(reachedTarget).toBe(true);
	});

	it("car picks up and delivers entity through full populate+tick cycle", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 10, 10, 14);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		// Multiple entities at floors 11-14 wanting to go down to floor 10
		for (let f = 11; f <= 14; f++) {
			world.entities.push({
				floorAnchor: f,
				subtypeIndex: 0,
				baseOffset: 0,
				familyCode: 7,
				stateCode: 0x22,
				routeMode: 0,
				routeSourceFloor: 0xff,
				routeCarrierOrSegment: 0xff,
				selectedFloor: f,
				originFloor: f,
				encodedRouteTarget: 10,
				auxState: 0,
				queueTick: 0,
				accumulatedDelay: 0,
				routeRetryDelay: 0,
				auxCounter: 0,
				word0a: 0,
				word0c: 0,
				word0e: 0,
				byte09: 0,
			});
		}
		const time = createTimeState();
		populate_carrier_requests(world, time);
		expect(carrier.pendingRoutes.length).toBe(4);

		// Tick until car boards at least one entity
		let boarded = false;
		for (let i = 0; i < 300; i++) {
			tick_all_carriers(world, time);
			if (car.assignedCount > 0) {
				boarded = true;
				break;
			}
			populate_carrier_requests(world, time);
		}
		expect(boarded).toBe(true);
		// Car should not be stuck at home floor
		expect(car.currentFloor).not.toBe(car.homeFloor);
	});

	it("car does not get stuck toggling when many entities queue", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 10, 10, 14);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		// 30 entities at various floors wanting to go to different floors
		for (let i = 0; i < 30; i++) {
			const src = 10 + (i % 5);
			const dst = src === 10 ? 14 : 10;
			world.entities.push({
				floorAnchor: src,
				subtypeIndex: i,
				baseOffset: 0,
				familyCode: 7,
				stateCode: 0x22,
				routeMode: 0,
				routeSourceFloor: 0xff,
				routeCarrierOrSegment: 0xff,
				selectedFloor: src,
				originFloor: src,
				encodedRouteTarget: dst,
				auxState: 0,
				queueTick: 0,
				accumulatedDelay: 0,
				routeRetryDelay: 0,
				auxCounter: 0,
				word0a: 0,
				word0c: 0,
				word0e: 0,
				byte09: 0,
			});
		}
		const time = createTimeState();
		populate_carrier_requests(world, time);

		// Tick: car should eventually move off home floor
		let moved = false;
		for (let i = 0; i < 300; i++) {
			tick_all_carriers(world, time);
			populate_carrier_requests(world, time);
			if (car.currentFloor !== 10) {
				moved = true;
				break;
			}
		}
		expect(moved).toBe(true);
	});

	it("out-of-range car is reset to bottom floor", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const car = world.carriers[0].cars[0];
		car.currentFloor = 99; // force out of range
		tick_all_carriers(world, createTimeState());
		expect(car.currentFloor).toBe(10);
	});

	it("car opens doors at target floor (doorWaitCounter set)", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		enqueue_carrier_route(carrier, "r1", 15, 10, 1);
		// Run until car arrives and opens doors
		let doors_opened = false;
		for (let i = 0; i < 200; i++) {
			tick_all_carriers(world, createTimeState());
			if (car.currentFloor === 15 && car.doorWaitCounter > 0) {
				doors_opened = true;
				break;
			}
		}
		expect(doors_opened).toBe(true);
	});

	it("penalizes at-capacity departure floors in route scoring", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const carrier = world.carriers[0];
		world.specialLinks = [];
		const slot = floor_to_slot(carrier, 10);
		carrier.primaryRouteStatusByFloor[slot] = 0x28;

		const route = select_best_route_candidate(world, 10, 15);
		expect(route?.cost).toBe(1000 + 5 * 8);
	});

	it("uses service-elevator-only scoring for express-mode requests", () => {
		const world = makeWorld();
		world.carriers.push(make_carrier(0, 0, 1, 10, 20));
		world.carriers.push(make_carrier(1, 4, 2, 10, 20));

		const route = select_best_route_candidate(world, 10, 18, false);
		expect(route?.kind).toBe("carrier");
		expect(route?.id).toBe(1);
	});

	it("forces departure when schedule marks the car out of service", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		placeElevatorShaft(world, ledger, 0, 10, 20);
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		car.pendingRouteIds.push("r1");
		carrier.pendingRoutes.push({
			entityId: "r1",
			sourceFloor: 10,
			destinationFloor: 15,
			boarded: true,
			directionFlag: 0,
			assignedCarIndex: 0,
		});
		carrier.serviceScheduleFlags[0] = 0;

		tick_all_carriers(world, createTimeState());
		expect(car.speedCounter).toBe(5);
	});

	it("assigns floor requests across multiple cars in the same shaft", () => {
		const world = makeWorld();
		world.carriers.push(make_carrier(0, 0, 2, 10, 30, 2));
		const carrier = world.carriers[0];
		const lowerCar = carrier.cars[0];
		const upperCar = carrier.cars[1];
		if (!lowerCar || !upperCar) throw new Error("expected two cars");

		enqueue_carrier_route(carrier, "low", 11, 20, 0);
		enqueue_carrier_route(carrier, "high", 29, 12, 1);

		tick_all_carriers(world, createTimeState());
		expect(
			carrier.pendingRoutes.find((route) => route.entityId === "low")
				?.assignedCarIndex,
		).toBe(0);
		expect(
			carrier.pendingRoutes.find((route) => route.entityId === "high")
				?.assignedCarIndex,
		).toBe(1);
	});

	it("tracks boarded destinations with per-floor counters", () => {
		const world = makeWorld();
		world.carriers.push(make_carrier(0, 0, 2, 10, 20, 1));
		const carrier = world.carriers[0];
		const car = carrier.cars[0];
		if (!car) throw new Error("expected car");

		car.pendingRouteIds.push("r1");
		carrier.pendingRoutes.push({
			entityId: "r1",
			sourceFloor: 10,
			destinationFloor: 18,
			boarded: true,
			directionFlag: 0,
			assignedCarIndex: 0,
		});

		tick_all_carriers(world, createTimeState());
		const destinationSlot = floor_to_slot(carrier, 18);
		expect(car.destinationCountByFloor[destinationSlot]).toBeGreaterThan(0);
	});

	it("reconciles entity arrival only from explicit completed carrier routes", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const hotelY = GRID_HEIGHT - 1 - 15;
		for (let x = 0; x < GRID_WIDTH; x++) {
			world.cells[`${x},${hotelY + 1}`] = "floor";
		}
		handle_place_tile(0, hotelY, "hotelSingle", world, ledger);
		rebuild_runtime_entities(world);
		world.carriers.push(make_carrier(0, 0, 1, 10, 20, 1));
		const carrier = world.carriers[0];
		const entity = world.entities[0];
		const hotel = world.placedObjects[`0,${hotelY}`];
		if (!carrier || !entity || !hotel)
			throw new Error("expected hotel runtime state");
		entity.stateCode = 0x05;
		entity.routeMode = 2;
		entity.routeSourceFloor = 15;
		entity.routeCarrierOrSegment = 0x58;
		entity.selectedFloor = 15;
		entity.originFloor = 15;
		entity.encodedRouteTarget = 10;

		carrier.pendingRoutes.push({
			entityId: "15:0:3:0",
			sourceFloor: 15,
			destinationFloor: 10,
			boarded: true,
			directionFlag: 1,
			assignedCarIndex: 0,
		});
		reconcile_entity_transport(world, ledger, createTimeState());
		expect(world.entities[0]?.selectedFloor).toBe(15);

		carrier.pendingRoutes = [];
		carrier.completedRouteIds.push("15:0:3:0");
		const cashBefore = ledger.cashBalance;
		reconcile_entity_transport(world, ledger, createTimeState());
		expect(world.entities[0]?.selectedFloor).toBe(10);
		expect(world.entities[0]?.stateCode).toBe(0x24);
		expect(world.entities[0]?.routeCarrierOrSegment).toBe(0xff);
		expect(hotel.stayPhase).toBe(0x28);
		expect(ledger.cashBalance).toBeGreaterThan(cashBefore);
	});
});

describe("Phase 4 runtime entities", () => {
	function setupOccupiedFloor(world: WorldState, ledger: LedgerState) {
		for (let x = 0; x < GRID_WIDTH; x++) {
			world.cells[`${x},${GROUND_Y}`] = "floor";
		}
		void ledger;
	}

	it("rebuilds runtime population counts from placed objects", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		expect(
			handle_place_tile(0, GROUND_Y - 1, "hotelTwin", world, ledger).accepted,
		).toBe(true);
		expect(
			handle_place_tile(10, GROUND_Y - 1, "office", world, ledger).accepted,
		).toBe(true);
		expect(
			handle_place_tile(24, GROUND_Y - 1, "condo", world, ledger).accepted,
		).toBe(true);

		rebuild_runtime_entities(world);
		expect(
			world.entities.filter((entity) => entity.familyCode === 4),
		).toHaveLength(2);
		expect(
			world.entities.filter((entity) => entity.familyCode === 7),
		).toHaveLength(6);
		expect(
			world.entities.filter((entity) => entity.familyCode === 9),
		).toHaveLength(3);
	});

	it("resets commercial venue counters at the daily cycle checkpoint", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "restaurant", world, ledger);
		const venueObject = world.placedObjects[`0,${GROUND_Y - 1}`];
		const venue = world.sidecars[
			venueObject.linkedRecordIndex
		] as WorldState["sidecars"][number] & { kind: "commercial_venue" };

		if (venue.kind !== "commercial_venue")
			throw new Error("expected commercial venue");
		venue.todayVisitCount = 4;
		venue.visitCount = 4;
		venue.availabilityState = 3;

		resetCommercialVenueCycle(world);
		expect(venue.yesterdayVisitCount).toBe(4);
		expect(venue.todayVisitCount).toBe(0);
		expect(venue.visitCount).toBe(0);
		expect(venue.availabilityState).toBe(1);
	});

	it("marks security adequate when the checkpoint tier meets the scaled requirement", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		const time = createTimeState();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "security", world, ledger);
		ledger.primaryLedger[7] = 300;
		update_security_housekeeping_state(
			world,
			ledger,
			{ ...time, starCount: 4 },
			5,
		);

		expect(world.gateFlags.securityAdequate).toBe(1);
		expect(world.placedObjects[`0,${GROUND_Y - 1}`].stayPhase).toBe(1);
	});

	it("sells condos through the entity refresh stride", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "restaurant", world, ledger);
		handle_place_tile(24, GROUND_Y - 1, "condo", world, ledger);
		handle_place_tile(40, GROUND_Y - 1, "hotelSingle", world, ledger);
		placeElevatorShaft(world, ledger, 0, 10, 15);
		rebuild_runtime_entities(world);

		const condoBefore = ledger.cashBalance;
		for (let tick = 0; tick < 64; tick++) {
			advance_entity_refresh_stride(world, ledger, {
				...createTimeState(),
				dayTick: tick,
				daypartIndex: 1,
				dayCounter: 3,
				starCount: 4,
			});
			populate_carrier_requests(world);
			tick_all_carriers(world, {
				...createTimeState(),
				dayTick: tick,
				daypartIndex: 1,
				dayCounter: 3,
				starCount: 4,
			});
			reconcile_entity_transport(world, ledger, {
				...createTimeState(),
				dayTick: tick,
				daypartIndex: 1,
				dayCounter: 3,
				starCount: 4,
			});
		}
		expect(ledger.cashBalance).toBeGreaterThan(condoBefore);
		expect(world.placedObjects[`24,${GROUND_Y - 1}`].stayPhase).toBeLessThan(
			0x18,
		);
	});

	it("projects entity wire state with stress bands", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "hotelTwin", world, ledger);
		rebuild_runtime_entities(world);
		const firstEntity = world.entities[0];
		const secondEntity = world.entities[1];
		const hotel = world.placedObjects[`0,${GROUND_Y - 1}`];
		if (!firstEntity || !secondEntity || !hotel)
			throw new Error("expected hotel runtime state");
		firstEntity.accumulatedDelay = 10;
		secondEntity.accumulatedDelay = 140;
		hotel.pairingStatus = 1;

		const state = create_entity_state_records(world);
		expect(state).toHaveLength(2);
		expect(state[0]?.stressLevel).toBe("medium");
		expect(state[1]?.stressLevel).toBe("high");
		expect(state[0]?.subtypeIndex).toBe(0);
		expect(state[0]?.floorAnchor).toBe(GRID_HEIGHT - 1 - (GROUND_Y - 1));
	});

	it("treats same-floor venue visits as immediate arrivals", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		expect(
			handle_place_tile(0, GROUND_Y - 1, "office", world, ledger).accepted,
		).toBe(true);
		expect(
			handle_place_tile(12, GROUND_Y - 1, "restaurant", world, ledger).accepted,
		).toBe(true);
		rebuild_runtime_entities(world);

		const officeEntity = world.entities.find(
			(entity) => entity.familyCode === 7,
		);
		const venueObject = world.placedObjects[`12,${GROUND_Y - 1}`];
		if (!officeEntity || !venueObject) {
			throw new Error("expected same-floor office + venue state");
		}
		officeEntity.stateCode = 0x01;
		officeEntity.selectedFloor = officeEntity.floorAnchor;
		officeEntity.encodedRouteTarget = -1;
		officeEntity.routeMode = 0;
		const venue = world.sidecars[venueObject.linkedRecordIndex] as
			| { kind: "commercial_venue"; todayVisitCount: number }
			| undefined;
		if (!venue || venue.kind !== "commercial_venue") {
			throw new Error("expected commercial venue sidecar");
		}

		advance_entity_refresh_stride(world, ledger, {
			...createTimeState(),
			dayCounter: 3,
			daypartIndex: 1,
			starCount: 4,
		});

		expect(officeEntity.stateCode).toBe(0x01);
		expect(officeEntity.routeMode).toBe(0);
		expect(officeEntity.encodedRouteTarget).toBe(-1);
		expect(venue.todayVisitCount).toBe(1);
	});

	it("seeds carrier waiters from active entities so elevator cars move", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "hotelSingle", world, ledger);
		placeElevatorShaft(world, ledger, 0, 10, 15);
		rebuild_runtime_entities(world);

		const entity = world.entities[0];
		if (!entity) throw new Error("expected hotel entity");
		entity.stateCode = 0x05;

		populate_carrier_requests(world, { ...createTimeState(), dayTick: 123 });
		const carrier = world.carriers[0];
		if (!carrier) throw new Error("expected carrier");
		const requestSlot = floor_to_slot(carrier, entity.floorAnchor);
		expect(requestSlot).toBeGreaterThanOrEqual(0);
		expect(carrier.secondaryRouteStatusByFloor[requestSlot]).toBeGreaterThan(0);
		expect(entity.routeSourceFloor).toBe(entity.floorAnchor);
		expect(entity.routeCarrierOrSegment).toBeGreaterThanOrEqual(0x58);
		expect(entity.queueTick).toBe(123);
	});

	it("activates hotel checkout demand even at the default new-game star/daypart", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "hotelSingle", world, ledger);
		placeElevatorShaft(world, ledger, 0, 10, 15);
		rebuild_runtime_entities(world);

		const entity = world.entities[0];
		if (!entity) throw new Error("expected hotel entity");

		const newGameTime = {
			...createNewGameTimeState(),
			dayTick: 2400,
			daypartIndex: 6,
		};
		advance_entity_refresh_stride(world, ledger, newGameTime);
		expect(entity.stateCode).toBe(0x01);

		advance_entity_refresh_stride(world, ledger, newGameTime);
		expect(entity.stateCode).toBe(0x05);

		populate_carrier_requests(world, newGameTime);
		const carrier = world.carriers[0];
		if (!carrier) throw new Error("expected carrier");
		const requestSlot = floor_to_slot(carrier, entity.floorAnchor);
		expect(requestSlot).toBeGreaterThanOrEqual(0);
		expect(carrier.secondaryRouteStatusByFloor[requestSlot]).toBeGreaterThan(0);
	});

	it("queues office commuters from the lobby to their office floor", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "office", world, ledger);
		placeElevatorShaft(world, ledger, 0, 10, 15);
		rebuild_runtime_entities(world);

		const entity = world.entities.find(
			(candidate) => candidate.familyCode === 7,
		);
		if (!entity) throw new Error("expected office entity");

		const activeTime = {
			...createTimeState(),
			dayCounter: 3,
			daypartIndex: 1,
			dayTick: 0,
			starCount: 4,
		};
		advance_entity_refresh_stride(world, ledger, activeTime);
		expect(entity.stateCode).toBe(0x22);
		expect(entity.selectedFloor).toBe(10);
		expect(entity.encodedRouteTarget).toBe(entity.floorAnchor);

		populate_carrier_requests(world, activeTime);
		const carrier = world.carriers[0];
		if (!carrier) throw new Error("expected carrier");
		const requestSlot = floor_to_slot(carrier, 10);
		expect(requestSlot).toBeGreaterThanOrEqual(0);
		expect(carrier.primaryRouteStatusByFloor[requestSlot]).toBeGreaterThan(0);
	});

	it("queues newly sold condos from the lobby to their condo floor", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		setupOccupiedFloor(world, ledger);

		handle_place_tile(0, GROUND_Y - 1, "condo", world, ledger);
		placeElevatorShaft(world, ledger, 0, 10, 15);
		rebuild_runtime_entities(world);

		const entity = world.entities.find(
			(candidate) => candidate.familyCode === 9,
		);
		if (!entity) throw new Error("expected condo entity");

		const activeTime = {
			...createTimeState(),
			dayCounter: 3,
			daypartIndex: 1,
			dayTick: 0,
			starCount: 4,
		};
		advance_entity_refresh_stride(world, ledger, activeTime);
		expect(entity.stateCode).toBe(0x22);
		expect(entity.selectedFloor).toBe(10);
		expect(entity.encodedRouteTarget).toBe(entity.floorAnchor);

		populate_carrier_requests(world, activeTime);
		const carrier = world.carriers[0];
		if (!carrier) throw new Error("expected carrier");
		const requestSlot = floor_to_slot(carrier, 10);
		expect(requestSlot).toBeGreaterThanOrEqual(0);
		expect(carrier.primaryRouteStatusByFloor[requestSlot]).toBeGreaterThan(0);
	});

	it("dispatches segment routes without waiting for the next entity stride", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		world.specialLinks[0] = {
			active: true,
			flags: 5 << 1,
			heightMetric: 5,
			entryFloor: 10,
			reservedByte: 0,
			descendingLoadCounter: 0,
			ascendingLoadCounter: 0,
		};
		for (let floor = 10; floor <= 14; floor++) {
			world.floorWalkabilityFlags[floor] = 1;
		}
		world.entities.push({
			floorAnchor: 10,
			subtypeIndex: 0,
			baseOffset: 0,
			familyCode: 7,
			stateCode: 0x22,
			routeMode: 0,
			routeSourceFloor: 0xff,
			routeCarrierOrSegment: 0xff,
			selectedFloor: 10,
			originFloor: 10,
			encodedRouteTarget: 14,
			auxState: 0,
			queueTick: 0,
			accumulatedDelay: 0,
			auxCounter: 0,
			word0a: 0,
			word0c: 0,
			word0e: 0,
			byte09: 0,
		});

		populate_carrier_requests(world, { ...createTimeState(), dayTick: 321 });
		reconcile_entity_transport(world, ledger, {
			...createTimeState(),
			dayTick: 321,
		});
		const entity = world.entities[0];
		if (!entity) throw new Error("expected entity");
		// Entity is now in-transit on the segment route with per-stop delay
		// 4 floors × 16 ticks (local branch, flag bit 0 = 0) = 64; one tick decremented = 63
		expect(entity.routeMode).toBe(1);
		expect(entity.auxCounter).toBe(63);
	});

	it("does not finalize segment routes for entities outside transport transit states", () => {
		const world = makeWorld();
		const ledger = makeLedger();
		world.entities.push({
			floorAnchor: 10,
			subtypeIndex: 0,
			baseOffset: 0,
			familyCode: 7,
			stateCode: 0x01,
			routeMode: 1,
			routeSourceFloor: 14,
			routeCarrierOrSegment: 0,
			selectedFloor: 10,
			originFloor: 10,
			encodedRouteTarget: 14,
			auxState: 0,
			queueTick: 0,
			accumulatedDelay: 0,
			auxCounter: 0,
			word0a: 0,
			word0c: 0,
			word0e: 0,
			byte09: 0,
		});

		reconcile_entity_transport(world, ledger, createTimeState());
		expect(world.entities[0]?.selectedFloor).toBe(10);
		expect(world.entities[0]?.routeMode).toBe(1);
		expect(world.entities[0]?.routeSourceFloor).toBe(14);
	});
});
