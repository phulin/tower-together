/**
 * Reference trace test — verifies that a 4-office + 2-stair tower
 * reproduces the expected sim lifecycle from the reference trace.
 *
 * Trace setup:
 *   - Lobby on ground floor, tiles [100, 200)
 *   - Support floors for floors 1–3
 *   - 2 offices on floor 1: [100,109) and [109,118)
 *   - 2 offices on floor 2: [100,109) and [109,118)
 *   - Stairs floor 0→1 at tile 100, stairs floor 1→2 at tile 100
 *
 * Known divergences from the reference trace:
 *
 *   1. Income: our YEN_1001 office payout at rent-level 1 is 100×1000 = $100k
 *      per office; the reference trace pays ~$10k per office. Total income
 *      $400k vs reference $40k.
 *
 *   2. Office STATE_ACTIVE dispatches a venue visit immediately every tick.
 *      When no fast-food venue exists, sims fall through to STATE_NIGHT_B
 *      and stay parked for the rest of the day. The reference trace shows
 *      sims cycling through lunch-start → at-work → from-lunch → evening-dep
 *      → parked — a richer daily lifecycle where venue-unavailable sims
 *      remain in a working state instead of being shelved.
 */

import { describe, expect, it } from "vitest";
import { TowerSim } from "./index";
import { GROUND_Y } from "./world";

// ─── State code constants ────────────────────────────────────────────────────

const STATE_ACTIVE = 0x01;
const STATE_MORNING_GATE = 0x20;
const STATE_NIGHT_B = 0x26;
const STATE_PARKED = 0x27;
const STATE_MORNING_TRANSIT = 0x60;

// State name mapping for trace output
const STATE_NAMES = new Map<number, string>([
	[0x00, "to-office"],
	[0x01, "lunch-start"],
	[0x02, "lunch-alt"],
	[0x05, "evening-dep"],
	[0x20, "morning-in"],
	[0x21, "at-work"],
	[0x22, "venue-trip"],
	[0x25, "night-a"],
	[0x26, "night-b"],
	[0x27, "parked"],
	[0x40, "T-to-office"],
	[0x45, "T-evening"],
	[0x60, "T-morning"],
	[0x61, "T-to-work"],
	[0x62, "T-to-lunch"],
	[0x63, "T-from-lunch"],
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countByState(sims: Array<{ stateCode: number }>): Map<number, number> {
	const counts = new Map<number, number>();
	for (const sim of sims) {
		counts.set(sim.stateCode, (counts.get(sim.stateCode) ?? 0) + 1);
	}
	return counts;
}

function stateCount(counts: Map<number, number>, ...codes: number[]): number {
	let total = 0;
	for (const code of codes) {
		total += counts.get(code) ?? 0;
	}
	return total;
}

function formatStateCounts(counts: Map<number, number>): string {
	const parts: string[] = [];
	for (const [code, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
		const name = STATE_NAMES.get(code) ?? `0x${code.toString(16)}`;
		parts.push(`${name}:${n}`);
	}
	return `[${parts.join(" ")}]`;
}

// ─── Tower builder ───────────────────────────────────────────────────────────

function buildTraceTower(): TowerSim {
	const sim = TowerSim.create("trace-test", "Trace Test");

	// Phase 1: advance 97 ticks → dayTick wraps to 30
	// (new game starts at dayTick 2533; 2533 + 97 = 2630 ≥ 2600 → wraps to 30)
	for (let i = 0; i < 97; i++) sim.step();

	sim.freeBuild = true;

	// Lobby on ground floor x=[100,200)
	for (let x = 100; x < 200; x++) {
		sim.submitCommand({
			type: "place_tile",
			x,
			y: GROUND_Y,
			tileType: "lobby",
		});
	}

	// Floor support on floor 1 (y=108) and floor 2 (y=107), x=[100,200)
	for (const y of [GROUND_Y - 1, GROUND_Y - 2]) {
		for (let x = 100; x < 200; x++) {
			sim.submitCommand({ type: "place_tile", x, y, tileType: "floor" });
		}
	}

	// 4 offices: 2 on floor 1, 2 on floor 2 (each width 9)
	for (const y of [GROUND_Y - 1, GROUND_Y - 2]) {
		for (const x of [100, 109]) {
			expect(
				sim.submitCommand({ type: "place_tile", x, y, tileType: "office" })
					.accepted,
			).toBe(true);
		}
	}

	// Stairs: floor 0→1 (overlay on lobby at y=109), floor 1→2 (overlay at y=108)
	for (const y of [GROUND_Y, GROUND_Y - 1]) {
		expect(
			sim.submitCommand({ type: "place_tile", x: 100, y, tileType: "stairs" })
				.accepted,
		).toBe(true);
	}

	sim.freeBuild = false;

	// Adjust cash to match trace starting condition
	const snap = sim.saveState();
	snap.ledger.cashBalance = 1_999_000;
	return TowerSim.fromSnapshot(snap);
}

function advanceTo(sim: TowerSim, targetTotalTicks: number): void {
	while (sim.simTime < targetTotalTicks) sim.step();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("reference trace: 4 offices + 2 stairs", () => {
	it("spawns 24 sims for 4 offices", () => {
		const sim = buildTraceTower();
		expect(sim.simsToArray()).toHaveLength(24);
	});

	it("starts at totalTicks=97, dayTick=30, cash=$1,999,000", () => {
		const sim = buildTraceTower();
		expect(sim.simTime).toBe(97);
		expect(sim.cash).toBe(1_999_000);
	});

	it("all sims begin in morning gate", () => {
		const sim = buildTraceTower();
		const counts = countByState(sim.simsToArray());
		expect(stateCount(counts, STATE_MORNING_GATE)).toBe(24);
	});

	it("offices generate income during morning activation", () => {
		const sim = buildTraceTower();
		const cashBefore = sim.cash;
		advanceTo(sim, 200);
		// 3 offices activated by tick 200 → 3 × $10k = $30k
		expect(sim.cash).toBe(cashBefore + 30_000);
	});

	it("all 4 offices generate income by tick 500", () => {
		const sim = buildTraceTower();
		advanceTo(sim, 500);
		// 4 offices × $10k = $40k income
		expect(sim.cash).toBe(1_999_000 + 40_000);
	});

	it("sims transition through morning → active → night-b lifecycle", () => {
		const sim = buildTraceTower();

		// At tick 200: some sims dispatched, some still in morning gate
		advanceTo(sim, 200);
		let counts = countByState(sim.simsToArray());
		expect(stateCount(counts, STATE_MORNING_GATE)).toBeGreaterThan(0);
		expect(
			stateCount(counts, STATE_ACTIVE, STATE_MORNING_TRANSIT),
		).toBeGreaterThan(0);

		// By tick 900: most sims have left active states (night-b, parked, or departing)
		advanceTo(sim, 900);
		counts = countByState(sim.simsToArray());
		expect(stateCount(counts, STATE_ACTIVE)).toBe(0);
		expect(stateCount(counts, STATE_MORNING_GATE)).toBe(0);
	});

	it("sims return to morning gate after dayTick > 2300", () => {
		const sim = buildTraceTower();

		// By tick 2300 (totalTicks = 97 + 2300 - 30 = 2367), all in night-b or parked
		advanceTo(sim, 2367);
		let counts = countByState(sim.simsToArray());
		expect(
			stateCount(counts, STATE_NIGHT_B) + stateCount(counts, STATE_PARKED),
		).toBe(24);

		// By tick 2400 (totalTicks ~2467), sims reactivate to morning gate
		advanceTo(sim, 2467);
		counts = countByState(sim.simsToArray());
		expect(stateCount(counts, STATE_MORNING_GATE)).toBe(24);
	});

	it("day 1 morning: sims begin dispatching again", () => {
		const sim = buildTraceTower();

		// Day 1, tick 133 → totalTicks = 97 + (2600 - 30) + 133 = 2800
		// But our dayTick arithmetic: after 2600 ticks from dayTick 30,
		// we've gone through a full day and reached dayTick 30 again (day 1).
		// Then 103 more ticks to reach dayTick 133: totalTicks = 97 + 2703 = 2800
		advanceTo(sim, 2800);
		const counts = countByState(sim.simsToArray());
		// Some sims should be dispatching (morning transit) or arrived (night-b)
		const dispatched = stateCount(counts, STATE_MORNING_TRANSIT, STATE_NIGHT_B);
		expect(dispatched).toBeGreaterThan(0);
	});

	it("sim count stays stable throughout simulation", () => {
		const sim = buildTraceTower();
		for (let target = 200; target <= 2800; target += 100) {
			advanceTo(sim, target);
			expect(sim.simsToArray()).toHaveLength(24);
		}
	});

	// ── xfail: known divergences from the reference trace ──────────────────

	it.fails("xfail: venue-unavailable sims stay in working states instead of night-b", () => {
		const sim = buildTraceTower();

		// Reference trace at tick 633 (daypart 1):
		//   [from-lunch:16 to-office:4 lunch-start:3 T-to-lunch:1]
		// Sims cycle through active states even without fast-food venues.
		// Our sim: sims dispatch venue visits, fail, and land in night-b.
		advanceTo(sim, 900);
		const counts = countByState(sim.simsToArray());

		// In the reference, no sims are in night-b by end of day
		expect(stateCount(counts, STATE_NIGHT_B)).toBe(0);
	});

	it("prints full trace for manual comparison", () => {
		const sim = buildTraceTower();

		const lines: string[] = [];
		lines.push(
			`TICK totalTicks=${sim.simTime} cash=$${sim.cash.toLocaleString()} sims=${sim.simsToArray().length} ${formatStateCounts(countByState(sim.simsToArray()))}`,
		);

		for (let target = 100; target <= 2800; target += 100) {
			advanceTo(sim, target);
			const sims = sim.simsToArray();
			lines.push(
				`TICK totalTicks=${sim.simTime} cash=$${sim.cash.toLocaleString()} sims=${sims.length} ${formatStateCounts(countByState(sims))}`,
			);
		}

		// Print the trace (visible with --reporter=verbose)
		console.log("\n=== Simulation Trace ===");
		for (const line of lines) console.log(line);
		console.log("=== End Trace ===\n");
	});
});
