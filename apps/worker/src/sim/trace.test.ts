/**
 * Trace tests — build towers from fixture JSON specs, step through
 * the simulation, and compare against reference JSONL traces.
 *
 * Each fixture pair (build_X.json + build_X.jsonl) defines:
 *   - .json: floor extents and facility placements
 *   - .jsonl: reference trace snapshots (day, tick, cash, sim states)
 */

// @ts-expect-error vitest runs in Node; not in CF worker types
import assert from "node:assert/strict";
// @ts-expect-error vitest runs in Node; not in CF worker types
import { readFileSync } from "node:fs";
// @ts-expect-error vitest runs in Node; not in CF worker types
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { TowerSim } from "./index";
import { DAY_TICK_MAX, DAY_TICK_NEW_DAY, NEW_GAME_DAY_TICK } from "./time";
import { GROUND_Y, type WorldState } from "./world";

const fixtureDir = `${fileURLToPath(new URL(".", import.meta.url))}fixtures`;

// ─── Types ──────────────────────────────────────────────────────────────────

interface FacilitySpec {
	type: string;
	floor?: number;
	left: number;
	right?: number;
	bottom?: number;
	top?: number;
	cars?: number;
}

interface ScheduledBatch {
	day: number;
	tick: number;
	facilities: FacilitySpec[];
}

interface BuildSpec {
	floor_extent: Record<string, { left: number; right: number }>;
	facilities: FacilitySpec[];
	scheduled_facilities?: ScheduledBatch[];
}

interface TraceCar {
	currentFloor: number;
	directionFlag: number;
	targetFloor: number;
	stabilizeCounter?: number;
	dwellCounter?: number;
	assignedCount?: number;
	prevFloor?: number;
	arrivalSeen?: number;
	arrivalTick?: number;
}
interface TraceCarrier {
	column: number;
	mode: number;
	capacity: number;
	bottomFloor: number;
	topFloor: number;
	cars: TraceCar[];
}

interface TraceEntry {
	day: number;
	tick: number;
	daypart: number;
	stars: number;
	cash: number;
	calendar_phase: number;
	metro_floor: number;
	population: number;
	rng_calls?: number;
	gates: {
		security: boolean;
		office: boolean;
		recycling: boolean;
		route: boolean;
	};
	sim_states: number[];
	sims: Record<
		string,
		{
			count: number;
			stress_avg?: number;
			stress_min?: number;
			stress_max?: number;
			states: Record<string, number>;
		}
	>;
	carriers?: TraceCarrier[];
	fire?: {
		flags: number;
		fire_active: boolean;
		bomb_active: boolean;
		security_count: number;
		eval_entity_idx: number;
		fire_floor: number;
		fire_tile: number;
		fire_start_tick: number;
		rescue_countdown: number;
		helicopter_extinguish_pos: number;
		fire_left_pos: Record<string, number>;
		fire_right_pos: Record<string, number>;
	};
}

// ─── Fixture tile name → sim tile name mapping ─────────────────────────────

const FIXTURE_TILE_MAP: Record<string, string> = {
	office: "office",
	condo: "condo",
	restaurant: "restaurant",
	"fast-food": "fastFood",
	retail: "retail",
	cinema: "cinema",
	"party-hall": "partyHall",
	single: "hotelSingle",
	twin: "hotelTwin",
	suite: "hotelSuite",
	stairs: "stairs",
	security: "security",
	housekeeping: "housekeeping",
	medical: "medical",
	metro: "metro",
	cathedral: "cathedral",
	lobby: "lobby",
};

// ─── Trace sim key → familyCode mapping ────────────────────────────────────

const TRACE_SIM_KEY_TO_FAMILY: Record<string, number> = {
	office: 7,
	condo: 9,
	restaurant: 6,
	"fast-food": 12,
	retail: 10,
	cinema: 18,
	"party-hall": 30,
	single: 3,
	twin: 4,
	suite: 5,
	security: 14,
	housekeeping: 15,
	"cathedral-a": 0x24,
	"cathedral-b": 0x24,
	"cathedral-c": 0x24,
	"cathedral-d": 0x24,
	"cathedral-e": 0x24,
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadFixture(name: string): { spec: BuildSpec; trace: TraceEntry[] } {
	const specPath = `${fixtureDir}/build_${name}.json`;
	const tracePath = `${fixtureDir}/build_${name}.jsonl`;
	const spec: BuildSpec = JSON.parse(readFileSync(specPath, "utf-8"));
	const trace: TraceEntry[] = readFileSync(tracePath, "utf-8")
		.trim()
		.split("\n")
		.map((line: string) => JSON.parse(line));
	return { spec, trace };
}

function withoutTime(entry: TraceEntry): Omit<TraceEntry, "day" | "tick"> {
	const { day: _day, tick: _tick, ...rest } = entry;
	return rest;
}

function refFireInactive(entry: TraceEntry): boolean {
	return !!entry.fire && !entry.fire.fire_active;
}

function dropTerminalDuplicateDump(trace: TraceEntry[]): TraceEntry[] {
	if (trace.length < 2) return trace;
	const prev = trace[trace.length - 2];
	const last = trace[trace.length - 1];
	if (JSON.stringify(withoutTime(prev)) !== JSON.stringify(withoutTime(last))) {
		return trace;
	}
	// The emulator trace writer appends one final dump after the run loop.
	// Most fixtures duplicate the same tick; build_sky_office labels that
	// terminal duplicate as the next tick even though no simulation state ran.
	return trace.slice(0, -1);
}

function traceTickToTotalTicks(day: number, tick: number): number {
	// Day 0 starts at dayTick=2533, runs through 2599→0→...→2299.
	// Day D (D>=1) starts at dayTick=2300, runs 2600 ticks to next 2300.
	if (day === 0) {
		return (tick - NEW_GAME_DAY_TICK + DAY_TICK_MAX) % DAY_TICK_MAX;
	}
	const day0Length = DAY_TICK_MAX - NEW_GAME_DAY_TICK + DAY_TICK_NEW_DAY;
	return (
		day0Length +
		(day - 1) * DAY_TICK_MAX +
		((tick - DAY_TICK_NEW_DAY + DAY_TICK_MAX) % DAY_TICK_MAX)
	);
}

function placeFacilityList(sim: TowerSim, facilities: FacilitySpec[]): void {
	for (const fac of facilities) {
		if (
			fac.type === "elevator" ||
			fac.type === "elevatorExpress" ||
			fac.type === "elevatorService"
		) {
			const bottom = fac.bottom ?? fac.floor ?? 0;
			const top = fac.top ?? fac.floor ?? 0;
			for (let f = bottom; f <= top; f++) {
				sim.submitCommand({
					type: "place_tile",
					x: fac.left,
					y: GROUND_Y - f,
					tileType: fac.type,
				});
			}
			const numCars = fac.cars ?? 1;
			// Mirror simtower/emulator.py `build_carrier` add-car placement:
			// standard/service carriers get extras at evenly-spaced home
			// floors across [bottom, top]; express (mode 0) cycles through
			// the binary's valid stops (floors 1..10 and sky-lobby stops at
			// (floor-10)%15==14, i.e. 24, 39, 54, …).
			const isExpress = fac.type === "elevatorExpress";
			let homeFloors: number[];
			if (isExpress) {
				const validStops = [bottom];
				for (let f = bottom + 1; f <= top; f++) {
					const exe = f + 10;
					if (exe >= 11 && (exe - 10) % 15 === 14) validStops.push(f);
				}
				homeFloors = Array.from(
					{ length: numCars - 1 },
					(_, i) => validStops[(i + 1) % validStops.length],
				);
			} else {
				const span = top - bottom;
				homeFloors = Array.from({ length: numCars - 1 }, (_, i) =>
					numCars <= 1
						? bottom
						: bottom + Math.floor((span * (i + 1)) / (numCars - 1)),
				);
			}
			for (const homeFloor of homeFloors) {
				sim.submitCommand({
					type: "add_elevator_car",
					x: fac.left,
					y: GROUND_Y - homeFloor,
				});
			}
			continue;
		}
		const tileType = FIXTURE_TILE_MAP[fac.type];
		if (!tileType) {
			throw new Error(`Unknown fixture tile type: ${fac.type}`);
		}
		if (fac.floor === undefined) {
			throw new Error(`Facility ${fac.type} missing 'floor'`);
		}
		const y = GROUND_Y - fac.floor;
		// Wide lobby placements span [left, right); iterate single tiles.
		if (tileType === "lobby" && fac.right !== undefined) {
			for (let x = fac.left; x < fac.right; x++) {
				sim.submitCommand({ type: "place_tile", x, y, tileType });
			}
			continue;
		}
		sim.submitCommand({ type: "place_tile", x: fac.left, y, tileType });
	}
}

function placeTilesFromSpec(sim: TowerSim, spec: BuildSpec): void {
	sim.freeBuild = true;

	// Place lobby on ground floor
	const groundExtent = spec.floor_extent["0"];
	if (groundExtent) {
		for (let x = groundExtent.left; x < groundExtent.right; x++) {
			sim.submitCommand({
				type: "place_tile",
				x,
				y: GROUND_Y,
				tileType: "lobby",
			});
		}
	}

	// Place floor support for each non-ground floor (sorted bottom-up)
	const floors = Object.keys(spec.floor_extent)
		.map(Number)
		.filter((f) => f !== 0)
		.sort((a, b) => a - b);

	for (const floor of floors) {
		const extent = spec.floor_extent[String(floor)];
		const y = GROUND_Y - floor;
		// Sky lobbies sit on floors where (floor % 15 == 14) — game floors 14,
		// 29, 44, ... — matching the binary's express-stop convention and
		// `isValidLobbyY`. The Python emulator direct-writes tile 0x0b at those
		// levels so FAMILY_PARKING transfer-group entries form at internal
		// floor 24, 39, 54, ...
		const tileType = floor % 15 === 14 ? "lobby" : "floor";
		for (let x = extent.left; x < extent.right; x++) {
			sim.submitCommand({ type: "place_tile", x, y, tileType });
		}
	}

	placeFacilityList(sim, spec.facilities);

	sim.freeBuild = false;
}

/** Compute the 32-bit LCG state after N calls starting from a given seed. */
function computeRngState(seed: number, calls: number): number {
	let state = seed;
	for (let i = 0; i < calls; i++) {
		state = (Math.imul(state, 0x15a4e35) + 1) | 0;
	}
	return state;
}

function prepareFromTrace(spec: BuildSpec, trace: TraceEntry[]): TowerSim {
	// Trace fixtures are dumped from the binary, which places sky lobbies at
	// floors 14, 29, 44, ... — pin the world to perfect-parity so placement
	// validation and express-stop cadence match.
	const sim = TowerSim.create("trace-test", "Trace Test", "perfect-parity");
	// Place tiles at dayTick=2533 (day -1), matching the binary.
	placeTilesFromSpec(sim, spec);
	// Seed cash, rng state, and rng count from the day -1 baseline (trace[0]).
	const snap = sim.saveState();
	snap.ledger.cashBalance = trace[0].cash;
	snap.world.starCount = trace[0].stars;
	snap.world.currentPopulation = trace[0].population;
	if (trace[0].rng_calls !== undefined) {
		snap.world.rngCallCount = trace[0].rng_calls;
		snap.world.rngState = computeRngState(1, trace[0].rng_calls);
	}
	snap.world.eventState.disableNewsEvents = true;
	// Seed each car's currentFloor / targetFloor / prevFloor from the
	// baseline dump. The emulator's `build_carrier` drives the binary's
	// own placement + add-car path, which for express carriers only
	// accepts floors 1..10 and sky-lobby stops (24, 39, 54, ...). Deriving
	// home positions from a simple even-spread across [bottom, top] would
	// place cars on non-stop floors the binary never allows, so use the
	// fixture's actual baseline instead.
	const baselineCarriers = trace[0].carriers ?? [];
	for (const refCarrier of baselineCarriers) {
		const carrier = snap.world.carriers.find(
			(c) => c.column === refCarrier.column,
		);
		if (!carrier) continue;
		for (
			let c = 0;
			c < refCarrier.cars.length && c < carrier.cars.length;
			c++
		) {
			const refCar = refCarrier.cars[c];
			const ourCar = carrier.cars[c];
			ourCar.currentFloor = refCar.currentFloor;
			ourCar.targetFloor = refCar.targetFloor;
			ourCar.prevFloor = refCar.prevFloor ?? refCar.currentFloor;
		}
	}
	return TowerSim.fromSnapshot(snap);
	// No pre-advance — the test loop drives advancement through the day boundary.
}

function advanceTo(sim: TowerSim, targetTotalTicks: number): void {
	while (sim.simTime < targetTotalTicks) sim.step();
}

/** Sum of all sim counts across families in a trace entry. */
function traceSimTotal(entry: TraceEntry): number {
	let total = 0;
	for (const group of Object.values(entry.sims)) total += group.count;
	return total;
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const FIXTURE_NAMES = [
	"commercial",
	"condo",
	"condo_office_elevator",
	"condo_stuck",
	"dense_hotel",
	"dense_office",
	"elevator",
	"hotel",
	"lobby_only",
	"mixed",
	"mixed_elevator",
	"mixed_elevator_delayed",
	"mixed_multicar",
	"metro",
	"offices",
	"sky_office",
];

describe("trace: cathedral recovered path", () => {
	it("activates the 40 evaluation visitors at checkpoint 0 without a star gate", () => {
		const floorExtent = Object.fromEntries(
			Array.from({ length: 104 }, (_, floor) => [
				String(floor),
				{ left: 80, right: 180 },
			]),
		);
		const sim = TowerSim.create(
			"trace-cathedral",
			"Trace Cathedral",
			"perfect-parity",
		);
		placeTilesFromSpec(sim, {
			floor_extent: floorExtent,
			facilities: [{ type: "cathedral", floor: 103, left: 100 }],
		});

		const before = sim.simsToArray();
		assert.equal(before.length, 40);
		assert.deepEqual(
			Object.fromEntries(
				[...new Set(before.map((s) => s.familyCode))].map((family) => [
					family,
					before.filter((s) => s.familyCode === family).length,
				]),
			),
			{ 36: 40 },
		);
		assert.deepEqual(
			Object.fromEntries(
				[...new Set(before.map((s) => s.stateCode))].map((state) => [
					state,
					before.filter((s) => s.stateCode === state).length,
				]),
			),
			{ 39: 40 },
		);

		advanceTo(sim, traceTickToTotalTicks(0, 0));

		const after = sim.simsToArray();
		assert.equal(sim.starCount, 1);
		assert.deepEqual(
			Object.fromEntries(
				[...new Set(after.map((s) => s.stateCode))].map((state) => [
					state,
					after.filter((s) => s.stateCode === state).length,
				]),
			),
			{ 32: 40 },
		);
	});
});

describe("trace: build_fire (force-armed fire from binary)", () => {
	// build_fire: tower with security on F1 + offices on F11-13. The emulator
	// fast-forwards to day 83 / tick 0, writes star_count=3 and security_count=1,
	// then directly calls trigger_fire_event. Trace dumps capture spread,
	// helicopter prompt (declined), cleanup, and post-cleanup steady state.
	it("matches binary fire spread + cleanup", () => {
		const { spec, trace } = loadFixture("fire");
		if (trace.length === 0) return;

		const sim = TowerSim.create("trace-fire", "Trace Fire", "perfect-parity");
		placeTilesFromSpec(sim, spec);

		// Seed time + economy + event state from trace[0] (the binary's
		// post-force-trigger snapshot). The TS sim has no force-trigger entry
		// point, so we mimic it by writing fire state directly.
		const seed = trace[0];
		const fire = seed.fire;
		if (!fire) throw new Error("fixture must include fire state");

		const snap = sim.saveState();
		snap.time.dayCounter = seed.day;
		snap.time.dayTick = seed.tick;
		snap.time.daypartIndex = seed.daypart;
		snap.time.weekendFlag = seed.day % 3 === 2 ? 1 : 0;
		snap.world.starCount = seed.stars;
		snap.world.currentPopulation = seed.population;
		snap.ledger.cashBalance = seed.cash;
		snap.world.eventState.disableNewsEvents = true;
		snap.world.eventState.gameStateFlags = fire.flags;
		snap.world.eventState.fireFloor = fire.fire_floor;
		snap.world.eventState.fireTile = fire.fire_tile;
		snap.world.eventState.fireStartTick = fire.fire_start_tick;
		snap.world.eventState.rescueCountdown = fire.rescue_countdown;
		snap.world.eventState.helicopterExtinguishPos =
			fire.helicopter_extinguish_pos;
		snap.world.eventState.fireLeftPos = snap.world.eventState.fireLeftPos.map(
			() => 0xffff,
		);
		snap.world.eventState.fireRightPos = snap.world.eventState.fireRightPos.map(
			() => 0xffff,
		);
		for (const [k, v] of Object.entries(fire.fire_left_pos)) {
			snap.world.eventState.fireLeftPos[Number(k)] = Number(v);
		}
		for (const [k, v] of Object.entries(fire.fire_right_pos)) {
			snap.world.eventState.fireRightPos[Number(k)] = Number(v);
		}

		const seeded = TowerSim.fromSnapshot(snap);
		// Establish totalTicks baseline so advanceTo can compute relative steps.
		const baseTotal = seeded.simTime;

		// At tick fireStartTick + helicopter_prompt_delay = 2 the binary fires
		// the rescue dialog and (in this fixture) records IDOK = decline. The
		// test bypasses the worker prompt queue (we seeded fire already active),
		// so simulate the decline by submitting a prompt_response at that tick
		// — that triggers spawnFireRescueHelpers like the binary does.
		const declineAtTick = fire.fire_start_tick + 2;
		let declineSubmitted = false;

		// Validate per-tick parity through the fire-active entries only. Once
		// the binary cleans up at dayTick==2000 and fast-forwards to 1500,
		// the trace's dayTick numbering diverges from a wall-clock step
		// counter and per-tick alignment becomes fragile. Verify cleanup
		// happened (fire flag cleared) and stop there.
		let lastFireActive = -1;
		for (let i = trace.length - 1; i >= 0; i--) {
			if (trace[i].fire?.fire_active) {
				lastFireActive = i;
				break;
			}
		}
		const lastIdx = lastFireActive >= 0 ? lastFireActive + 1 : trace.length - 1;
		for (let entryIdx = 1; entryIdx <= lastIdx; entryIdx++) {
			const entry = trace[entryIdx];
			// Advance by the dayTick delta from previous entry. The fire fixture
			// stays on days 83-84, so dayTick deltas + day rollover suffice.
			const prev = trace[entryIdx - 1];
			let delta: number;
			if (entry.day === prev.day) {
				delta = entry.tick - prev.tick;
			} else {
				// rollover: prev.day → entry.day. dayCounter increments at tick 2300.
				delta = DAY_TICK_MAX - prev.tick + entry.tick;
			}
			// Cleanup boundary: when the binary's fire resolves at dayTick==2000
			// it fast-forwards dayTick to 1500, so the trace shows a discontinuity
			// (e.g. tick 150 → tick 1541 with ~1891 actual ticks of simulation).
			// Detect prev=fire-active, current=fire-inactive within the same day
			// and add the extra 500 ticks the binary swallowed.
			if (
				prev.fire?.fire_active &&
				refFireInactive(entry) &&
				entry.day === prev.day &&
				entry.tick >= 1500
			) {
				delta += 500;
			}
			for (let i = 0; i < delta; i++) {
				seeded.step();
				if (
					!declineSubmitted &&
					seeded.saveState().time.dayTick >= declineAtTick
				) {
					seeded.submitCommand({
						type: "prompt_response",
						promptId: `fire_${seed.day}`,
						accepted: false,
					});
					declineSubmitted = true;
				}
			}

			const ctx = `entry ${entryIdx} day=${entry.day} tick=${entry.tick}`;
			const ours = seeded.saveState();
			const ourFire = ours.world.eventState;
			const refFire = entry.fire;
			if (!refFire) throw new Error(`trace entry ${entryIdx} missing fire`);

			assert.equal(
				ourFire.gameStateFlags,
				refFire.flags,
				`gameStateFlags at ${ctx}`,
			);
			assert.equal(
				ourFire.fireFloor,
				refFire.fire_floor,
				`fireFloor at ${ctx}`,
			);
			assert.equal(ourFire.fireTile, refFire.fire_tile, `fireTile at ${ctx}`);
			assert.equal(
				ourFire.fireStartTick,
				refFire.fire_start_tick,
				`fireStartTick at ${ctx}`,
			);
			assert.equal(
				ourFire.helicopterExtinguishPos,
				refFire.helicopter_extinguish_pos,
				`helicopterExtinguishPos at ${ctx}`,
			);
			// Per-floor front comparison: collapse 120-entry arrays into the
			// same {floor: pos} sparse map the emulator dumps (omit 0xffff and 0).
			const ourLeft: Record<string, number> = {};
			const ourRight: Record<string, number> = {};
			for (let f = 0; f < ourFire.fireLeftPos.length; f++) {
				const v = ourFire.fireLeftPos[f];
				if (v !== 0xffff) ourLeft[String(f)] = v;
			}
			for (let f = 0; f < ourFire.fireRightPos.length; f++) {
				const v = ourFire.fireRightPos[f];
				if (v !== 0xffff) ourRight[String(f)] = v;
			}
			assert.deepEqual(ourLeft, refFire.fire_left_pos, `fireLeftPos at ${ctx}`);
			assert.deepEqual(
				ourRight,
				refFire.fire_right_pos,
				`fireRightPos at ${ctx}`,
			);
		}
		// Ensure we actually advanced (sanity check that delta loop ran).
		assert.ok(seeded.simTime > baseTotal, "test never stepped");

		// Post-fire coherence smoke check (the "game breaks after day-84 fire"
		// regression): advance well past cleanup and verify no sim points at
		// a destroyed facility, cash didn't go negative, and the fire flag
		// stays cleared. This is what would have caught the original bug.
		for (let i = 0; i < 200; i++) seeded.step();
		const post = seeded.saveState();
		assert.equal(
			post.world.eventState.gameStateFlags & 8,
			0,
			"fire flag re-armed after cleanup",
		);
		assert.equal(
			post.world.eventState.fireRescueHelpers.length,
			0,
			"firefighter helpers not drained at cleanup",
		);
		for (const sim of post.world.sims) {
			if (sim.familyCode === 0) continue;
			// Sims with a non-trivial home pointer must point to a real
			// placed object. Floor-anchor + home column should resolve.
			const objY = sim.floorAnchor;
			let home: WorldState["placedObjects"][string] | null = null;
			for (const [key, rec] of Object.entries(post.world.placedObjects)) {
				const [, yStr] = key.split(",");
				if (Number(yStr) !== objY) continue;
				if (
					sim.homeColumn >= rec.leftTileIndex &&
					sim.homeColumn <= rec.rightTileIndex
				)
					home = rec;
			}
			if (home === null) continue;
			assert.equal(
				home.objectTypeCode,
				sim.familyCode,
				`orphaned sim post-fire: family=${sim.familyCode} home=${sim.floorAnchor},${sim.homeColumn}`,
			);
		}
		assert.ok(
			post.ledger.cashBalance >= 0,
			`cash went negative post-fire: ${post.ledger.cashBalance}`,
		);
	});
});

describe("trace: build_fire_accept (helicopter rescue accepted)", () => {
	// Companion to build_fire that accepts the helicopter prompt (DialogBox
	// id 0xbc4 returns 2). The binary deducts $500K, sets
	// `helicopter_extinguish_pos = bounds.right - 12`, and the extinguish
	// loop sweeps fronts on the helicopter side until cleanup. Trace[0] is
	// pre-decline; later entries show post-cleanup state with extinguish_pos
	// non-zero and cash dropped by the rescue cost.
	it("deducts rescue cost and extinguishes via helicopter", () => {
		const { spec, trace } = loadFixture("fire_accept");
		if (trace.length === 0) return;
		const sim = TowerSim.create(
			"trace-fire-accept",
			"Trace Fire Accept",
			"perfect-parity",
		);
		placeTilesFromSpec(sim, spec);
		const seed = trace[0];
		const fire = seed.fire;
		if (!fire) throw new Error("fixture must include fire state");
		const snap = sim.saveState();
		snap.time.dayCounter = seed.day;
		snap.time.dayTick = seed.tick;
		snap.time.daypartIndex = seed.daypart;
		snap.world.starCount = seed.stars;
		snap.ledger.cashBalance = seed.cash;
		snap.world.eventState.disableNewsEvents = true;
		snap.world.eventState.gameStateFlags = fire.flags;
		snap.world.eventState.fireFloor = fire.fire_floor;
		snap.world.eventState.fireTile = fire.fire_tile;
		snap.world.eventState.fireStartTick = fire.fire_start_tick;
		snap.world.eventState.fireLeftPos = snap.world.eventState.fireLeftPos.map(
			() => 0xffff,
		);
		snap.world.eventState.fireRightPos = snap.world.eventState.fireRightPos.map(
			() => 0xffff,
		);
		for (const [k, v] of Object.entries(fire.fire_left_pos))
			snap.world.eventState.fireLeftPos[Number(k)] = Number(v);
		for (const [k, v] of Object.entries(fire.fire_right_pos))
			snap.world.eventState.fireRightPos[Number(k)] = Number(v);
		const seeded = TowerSim.fromSnapshot(snap);

		// Step until the helicopter prompt fires; submit ACCEPTED.
		const acceptAt = fire.fire_start_tick + 2;
		let accepted = false;
		const cashBefore = seeded.cash;
		for (let i = 0; i < 250 && !accepted; i++) {
			seeded.step();
			if (seeded.saveState().time.dayTick >= acceptAt) {
				seeded.submitCommand({
					type: "prompt_response",
					promptId: `fire_${seed.day}`,
					accepted: true,
				});
				accepted = true;
			}
		}
		assert.ok(accepted, "never submitted accept");
		// Helicopter rescue cost = $500,000 deducted immediately.
		assert.equal(
			cashBefore - seeded.cash,
			500_000,
			`expected $500K rescue deduction, got ${cashBefore - seeded.cash}`,
		);
		// helicopterExtinguishPos was seeded to a positive column (bounds.right - 12).
		assert.ok(
			seeded.saveState().world.eventState.helicopterExtinguishPos > 0,
			"helicopterExtinguishPos not set on accept",
		);

		// Run through cleanup, then verify fire resolved and post-fire state coherent.
		for (let i = 0; i < 2500; i++) seeded.step();
		const post = seeded.saveState();
		assert.equal(
			post.world.eventState.gameStateFlags & 8,
			0,
			"fire flag still set after helicopter extinguish + cleanup",
		);
	});
});

describe.each(FIXTURE_NAMES)("trace: build_%s", (fixtureName) => {
	const { spec, trace: rawTrace } = loadFixture(fixtureName);
	const trace = dropTerminalDuplicateDump(rawTrace);

	// Entry 0 is the day -1 / tick 2533 baseline; simulation entries start at index 1.
	const simEntries = trace.slice(1);

	// Fields in the fixture that this suite does NOT currently check, because the
	// sim has no direct mapping for them yet:
	//   - calendar_phase       (global 12-day phase counter; not modeled in TimeState)
	//   - sim_allocated/initialized/uninitialized (sim pool allocator bookkeeping)
	it("matches full reference trace", () => {
		if (simEntries.length === 0) return;
		const sim = prepareFromTrace(spec, trace);

		let prevSimCalls: number | undefined;
		let prevTraceCalls: number | undefined;

		const pendingScheduled: ScheduledBatch[] = (
			spec.scheduled_facilities ?? []
		).map((batch) => ({
			day: batch.day,
			tick: batch.tick,
			facilities: [...batch.facilities],
		}));

		for (const entry of simEntries) {
			advanceTo(sim, traceTickToTotalTicks(entry.day, entry.tick));
			// Fire any scheduled placement whose (day, tick) matches now, before
			// validating this entry — mirrors the emulator, which applies
			// placements at scheduler entry before the tick's dump. freeBuild
			// stays off so placement costs are charged (the initial batch was
			// placed in freeBuild mode; trace[0].cash already reflects its cost).
			for (let i = pendingScheduled.length - 1; i >= 0; i--) {
				const batch = pendingScheduled[i];
				if (batch.day === entry.day && batch.tick === entry.tick) {
					placeFacilityList(sim, batch.facilities);
					pendingScheduled.splice(i, 1);
				}
			}
			const ctx = `day=${entry.day} tick=${entry.tick}`;

			// ── Scalar fields ──────────────────────────────────────────────
			const gf = sim.gateFlags;
			assert.equal(
				sim.daypartIndex,
				entry.daypart,
				`daypart mismatch at ${ctx}`,
			);
			assert.equal(sim.starCount, entry.stars, `stars mismatch at ${ctx}`);
			assert.equal(
				sim.currentPopulation,
				entry.population,
				`population mismatch at ${ctx}`,
			);
			assert.equal(
				gf.metroStationFloorIndex,
				entry.metro_floor,
				`metro_floor mismatch at ${ctx}`,
			);
			assert.equal(
				gf.officeServiceOk !== 0,
				entry.gates.office,
				`gates.office at ${ctx}`,
			);
			assert.equal(
				gf.recyclingAdequate !== 0,
				entry.gates.recycling,
				`gates.recycling at ${ctx}`,
			);
			assert.equal(
				gf.routesViable !== 0,
				entry.gates.route,
				`gates.route at ${ctx}`,
			);
			assert.equal(
				entry.gates.security,
				false,
				`unexpected gates.security at ${ctx}`,
			);

			// ── Cash ───────────────────────────────────────────────────────
			assert.equal(
				sim.cash,
				entry.cash,
				`cash mismatch at ${ctx} fx=${fixtureName}`,
			);

			// ── Sim counts & states (only for entries with named families) ─
			const simKeys = Object.keys(entry.sims);
			const isActive =
				simKeys.length > 0 && simKeys.some((k) => !k.startsWith("0x"));
			if (isActive) {
				const simArray = sim.simsToArray();

				// Total sim count
				assert.equal(
					simArray.length,
					traceSimTotal(entry),
					`sim total mismatch at ${ctx}`,
				);

				// Per-family counts, state counts, and positive-stress values
				const byFamily = new Map<number, number>();
				const byFamilyState = new Map<number, Map<number, number>>();
				const byFamilyStress = new Map<number, number[]>();
				for (const sm of simArray) {
					byFamily.set(sm.familyCode, (byFamily.get(sm.familyCode) ?? 0) + 1);
					let m = byFamilyState.get(sm.familyCode);
					if (!m) {
						m = new Map();
						byFamilyState.set(sm.familyCode, m);
					}
					m.set(sm.stateCode, (m.get(sm.stateCode) ?? 0) + 1);
					// Per-sim stress = accumulatedTicks / tripCount (truncated), 0 if no trips.
					const stress =
						sm.tripCount > 0
							? Math.trunc(sm.accumulatedTicks / sm.tripCount)
							: 0;
					if (stress > 0) {
						const list = byFamilyStress.get(sm.familyCode) ?? [];
						list.push(stress);
						byFamilyStress.set(sm.familyCode, list);
					}
				}

				for (const [key, refGroup] of Object.entries(entry.sims)) {
					const familyCode = TRACE_SIM_KEY_TO_FAMILY[key];
					if (familyCode === undefined) continue;
					assert.equal(
						byFamily.get(familyCode) ?? 0,
						refGroup.count,
						`family ${key} count mismatch at ${ctx}`,
					);
					const ourStates = byFamilyState.get(familyCode) ?? new Map();
					const ourObj: Record<string, number> = {};
					for (const [st, cnt] of ourStates) ourObj[String(st)] = cnt;
					assert.deepEqual(
						ourObj,
						refGroup.states,
						`family ${key} state counts mismatch at ${ctx}`,
					);

					// Stress aggregates: computed over sims with stress > 0 only,
					// to match the Python emulator's dump_tick_state.
					if (
						refGroup.stress_avg !== undefined &&
						refGroup.stress_min !== undefined &&
						refGroup.stress_max !== undefined
					) {
						const stresses = byFamilyStress.get(familyCode) ?? [];
						const avg =
							stresses.length > 0
								? Math.trunc(
										stresses.reduce((a, b) => a + b, 0) / stresses.length,
									)
								: 0;
						const min = stresses.length > 0 ? Math.min(...stresses) : 0;
						const max = stresses.length > 0 ? Math.max(...stresses) : 0;
						assert.equal(
							avg,
							refGroup.stress_avg,
							`family ${key} stress_avg mismatch at ${ctx}`,
						);
						assert.equal(
							min,
							refGroup.stress_min,
							`family ${key} stress_min mismatch at ${ctx}`,
						);
						assert.equal(
							max,
							refGroup.stress_max,
							`family ${key} stress_max mismatch at ${ctx}`,
						);
					}
				}
			}

			// ── RNG call deltas ────────────────────────────────────────────
			if (entry.rng_calls !== undefined) {
				if (prevSimCalls !== undefined && prevTraceCalls !== undefined) {
					const simDelta = sim.rngCallCount - prevSimCalls;
					const traceDelta = entry.rng_calls - prevTraceCalls;
					assert.equal(
						simDelta,
						traceDelta,
						`rng_calls delta mismatch at ${ctx}: sim=${simDelta} trace=${traceDelta}`,
					);
				}
				prevSimCalls = sim.rngCallCount;
				prevTraceCalls = entry.rng_calls;
			}

			// ── Carrier car positions ──────────────────────────────────────
			if (Array.isArray(entry.carriers) && entry.carriers.length > 0) {
				const ourCarriers = sim.carriersToArray();
				const ourByCol = new Map<string, typeof ourCarriers>();
				for (const rec of ourCarriers) {
					const k = `${rec.column}:${rec.carrierMode}`;
					const list = ourByCol.get(k) ?? [];
					list.push(rec);
					ourByCol.set(k, list);
				}
				for (const refCarrier of entry.carriers) {
					const k = `${refCarrier.column}:${refCarrier.mode}`;
					const cars = ourByCol.get(k);
					assert.ok(cars !== undefined, `carrier ${k} missing at ${ctx}`);
					if (!cars) continue;
					assert.equal(
						cars.length,
						refCarrier.cars.length,
						`car count for ${k} at ${ctx}`,
					);
					for (let i = 0; i < refCarrier.cars.length; i++) {
						const ours = cars[i];
						const ref = refCarrier.cars[i];
						assert.equal(
							ours.currentFloor,
							ref.currentFloor,
							`car ${i} currentFloor at ${k} ${ctx}`,
						);
						assert.equal(
							ours.targetFloor,
							ref.targetFloor,
							`car ${i} targetFloor at ${k} ${ctx}`,
						);
						assert.equal(
							ours.directionFlag,
							ref.directionFlag,
							`car ${i} directionFlag at ${k} ${ctx}`,
						);
						if (ref.stabilizeCounter !== undefined)
							assert.equal(
								ours.settleCounter,
								ref.stabilizeCounter,
								`car ${i} stabilizeCounter at ${k} ${ctx}`,
							);
						if (ref.dwellCounter !== undefined)
							assert.equal(
								ours.dwellCounter,
								ref.dwellCounter,
								`car ${i} dwellCounter at ${k} ${ctx}`,
							);
						if (ref.assignedCount !== undefined)
							assert.equal(
								ours.assignedCount,
								ref.assignedCount,
								`car ${i} assignedCount at ${k} ${ctx}`,
							);
						if (ref.prevFloor !== undefined)
							assert.equal(
								ours.prevFloor,
								ref.prevFloor,
								`car ${i} prevFloor at ${k} ${ctx}`,
							);
						if (ref.arrivalSeen !== undefined)
							assert.equal(
								ours.arrivalSeen,
								ref.arrivalSeen,
								`car ${i} arrivalSeen at ${k} ${ctx}`,
							);
						if (ref.arrivalTick !== undefined)
							assert.equal(
								ours.arrivalTick,
								ref.arrivalTick,
								`car ${i} arrivalTick at ${k} ${ctx}`,
							);
					}
				}
			}
		}
	});
});
