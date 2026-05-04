import { describe, expect, it } from "vitest";
import { tickVipSpecialVisitor } from "./events";
import { TowerSim } from "./index";
import {
	FAMILY_METRO_BOTTOM,
	FAMILY_METRO_MIDDLE,
	FAMILY_METRO_TOP,
	TILE_COSTS,
} from "./resources";
import { createTimeState } from "./time";

const GROUND_Y = 109;

function makeSimWithLobbyStrip(from = 90, to = 180): TowerSim {
	const sim = TowerSim.create("spacing-test", "Spacing");
	for (let x = from; x <= to; x++) {
		const result = sim.submitCommand({
			type: "place_tile",
			x,
			y: GROUND_Y,
			tileType: "lobby",
		});
		if (!result.accepted) {
			throw new Error(`lobby placement at x=${x} failed: ${result.reason}`);
		}
	}
	return sim;
}

function placeElevatorSegment(
	sim: TowerSim,
	x: number,
	floor: number,
	tileType: "elevator" | "elevatorExpress" | "elevatorService" = "elevator",
) {
	return sim.submitCommand({
		type: "place_tile",
		x,
		y: GROUND_Y - floor,
		tileType,
	});
}

describe("elevator shaft spacing", () => {
	it("allows extending the same shaft with additional segments", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 100, 1).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 100, 2).accepted).toBe(true);
	});

	it("rejects a second shaft within 4 tiles of an existing shaft", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		// Standard elevator width=4 → right edge at x=103. Spacing requires a
		// 4-tile gap, so the next shaft's left must be ≥108. x=107 leaves only
		// 3 empty tiles (104,105,106) between shafts.
		const rejection = placeElevatorSegment(sim, 107, 0);
		expect(rejection.accepted).toBe(false);
		expect(rejection.reason).toMatch(/too close/);
	});

	it("accepts a second standard shaft exactly 4 tiles away (8 tiles left-to-left)", () => {
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 108, 0).accepted).toBe(true);
	});

	it("requires 8 clear tiles on either side of an express shaft", () => {
		// Express (width 6) at column 100 → right=105. A standard shaft needs
		// ≥8 empty tiles from the express, so its left must be ≥114
		// (that's 14 tiles left-edge-to-left-edge).
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0, "elevatorExpress").accepted).toBe(
			true,
		);
		expect(placeElevatorSegment(sim, 113, 0).accepted).toBe(false);
		expect(placeElevatorSegment(sim, 114, 0).accepted).toBe(true);
	});

	it("requires 8 clear tiles when the new shaft is express", () => {
		// Standard at 100 (right=103). Next express needs ≥8 gap, so left ≥112.
		const sim = makeSimWithLobbyStrip();
		expect(placeElevatorSegment(sim, 100, 0).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 111, 0, "elevatorExpress").accepted).toBe(
			false,
		);
		expect(placeElevatorSegment(sim, 112, 0, "elevatorExpress").accepted).toBe(
			true,
		);
	});
});

function buildFloors(sim: TowerSim, floor: number, from: number, to: number) {
	for (let x = from; x <= to; x++) {
		const result = sim.submitCommand({
			type: "place_tile",
			x,
			y: GROUND_Y - floor,
			tileType: "floor",
		});
		if (!result.accepted) {
			throw new Error(
				`floor placement at x=${x},floor=${floor} failed: ${result.reason}`,
			);
		}
	}
}

function placeStairs(sim: TowerSim, x: number, floor: number) {
	return sim.submitCommand({
		type: "place_tile",
		x,
		y: GROUND_Y - floor,
		tileType: "stairs",
	});
}

describe("underground placement restrictions", () => {
	const UNDERGROUND_Y = 110;

	function placeAt(sim: TowerSim, x: number, y: number, tileType: string) {
		return sim.submitCommand({ type: "place_tile", x, y, tileType });
	}

	it("rejects rooms underground", () => {
		const sim = makeSimWithLobbyStrip();
		const blocked = [
			"hotelSingle",
			"hotelTwin",
			"hotelSuite",
			"office",
			"condo",
			"housekeeping",
			"lobby",
		];
		for (const tileType of blocked) {
			const r = placeAt(sim, 100, UNDERGROUND_Y, tileType);
			expect(r.accepted).toBe(false);
			expect(r.reason).toMatch(/underground/i);
		}
	});

	it("allows infrastructure and parking/recycling underground", () => {
		const sim = makeSimWithLobbyStrip();
		// Floor underground (hangs from ground lobby above).
		expect(placeAt(sim, 100, UNDERGROUND_Y, "floor").accepted).toBe(true);
		// Parking underground.
		expect(placeAt(sim, 120, UNDERGROUND_Y, "parking").accepted).toBe(true);
		// Elevator overlay extending into underground.
		expect(placeAt(sim, 140, UNDERGROUND_Y - 1, "elevator").accepted).toBe(
			true,
		);
		expect(placeAt(sim, 140, UNDERGROUND_Y, "elevator").accepted).toBe(true);
	});
});

describe("metro station placement", () => {
	function placeMetro(sim: TowerSim, x = 100, topY = GROUND_Y + 1) {
		return sim.submitCommand({
			type: "place_tile",
			x,
			y: topY,
			tileType: "metro",
		});
	}

	it("places a singleton 30-tile, three-floor stack with the top floor as anchor", () => {
		const sim = makeSimWithLobbyStrip(90, 150);
		const result = placeMetro(sim);
		expect(result.accepted).toBe(true);
		expect(result.patch).toHaveLength(90);

		const snap = sim.saveState();
		expect(snap.world.gateFlags.metroPlaced).toBe(1);
		expect(snap.world.gateFlags.metroStationFloorIndex).toBe(9);
		expect(snap.world.placedObjects["100,110"]?.objectTypeCode).toBe(
			FAMILY_METRO_TOP,
		);
		expect(snap.world.placedObjects["100,111"]?.objectTypeCode).toBe(
			FAMILY_METRO_MIDDLE,
		);
		expect(snap.world.placedObjects["100,112"]?.objectTypeCode).toBe(
			FAMILY_METRO_BOTTOM,
		);
		expect(snap.world.cellToAnchor["129,112"]).toBe("100,110");
	});

	it("rejects a second metro and resets the anchor floor when removed", () => {
		const sim = makeSimWithLobbyStrip(90, 180);
		expect(placeMetro(sim, 100).accepted).toBe(true);
		const second = placeMetro(sim, 140);
		expect(second.accepted).toBe(false);
		expect(second.reason).toMatch(/already placed/i);

		const removed = sim.submitCommand({
			type: "remove_tile",
			x: 110,
			y: GROUND_Y + 2,
		});
		expect(removed.accepted).toBe(true);
		const snap = sim.saveState();
		expect(snap.world.gateFlags.metroPlaced).toBe(0);
		expect(snap.world.gateFlags.metroStationFloorIndex).toBe(-1);
		expect(snap.world.placedObjects["100,110"]).toBeUndefined();
		expect(snap.world.placedObjects["100,111"]).toBeUndefined();
		expect(snap.world.placedObjects["100,112"]).toBeUndefined();
	});

	it("charges regardless of daypart and seeds the binary status word", () => {
		const paid = makeSimWithLobbyStrip(90, 150);
		const paidSnap = paid.saveState();
		paidSnap.time.daypartIndex = 4;
		const paidSim = TowerSim.fromSnapshot(paidSnap);
		const paidBefore = paidSim.cash;
		expect(placeMetro(paidSim).accepted).toBe(true);
		expect(paidSim.cash).toBe(paidBefore - TILE_COSTS.metro);
		expect(paidSim.saveState().world.placedObjects["100,110"]?.unitStatus).toBe(
			1,
		);

		const early = makeSimWithLobbyStrip(90, 150);
		const earlySnap = early.saveState();
		earlySnap.time.dayTick = 1200;
		earlySnap.time.daypartIndex = 3;
		const earlySim = TowerSim.fromSnapshot(earlySnap);
		const earlyBefore = earlySim.cash;
		expect(placeMetro(earlySim).accepted).toBe(true);
		expect(earlySim.cash).toBe(earlyBefore - TILE_COSTS.metro);
		expect(
			earlySim.saveState().world.placedObjects["100,110"]?.unitStatus,
		).toBe(0);
	});

	it("blocks carrier extension below the metro middle floor", () => {
		const sim = makeSimWithLobbyStrip(90, 150);
		expect(placeMetro(sim, 100).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 140, -1).accepted).toBe(true);
		expect(placeElevatorSegment(sim, 140, -2).accepted).toBe(true);
		const blocked = placeElevatorSegment(sim, 140, -3);
		expect(blocked.accepted).toBe(false);
		expect(blocked.reason).toMatch(/below the metro/i);
	});

	it("toggles the metro display variant and emits the arrival event", () => {
		const base = makeSimWithLobbyStrip(90, 150);
		const baseSnap = base.saveState();
		baseSnap.time.daypartIndex = 3;
		const sim = TowerSim.fromSnapshot(baseSnap);
		expect(placeMetro(sim).accepted).toBe(true);
		const snap = sim.saveState();
		snap.world.rngState = 54;
		snap.world.rngCallCount = 0;
		const time = createTimeState();
		time.dayTick = 0xf1;
		time.daypartIndex = 3;

		tickVipSpecialVisitor(snap.world, time);

		expect(snap.world.placedObjects["100,110"]?.unitStatus).toBe(2);
		expect(snap.world.placedObjects["100,111"]?.unitStatus).toBe(2);
		expect(snap.world.placedObjects["100,112"]?.unitStatus).toBe(2);
		expect(snap.world.pendingNotifications).toContainEqual({
			kind: "event",
			message: "metro_train_arrival",
		});
	});
});

describe("stairs alignment", () => {
	it("allows stacking stairs at the same column on consecutive floors", () => {
		const sim = makeSimWithLobbyStrip();
		buildFloors(sim, 1, 90, 180);
		buildFloors(sim, 2, 90, 180);
		buildFloors(sim, 3, 90, 180);
		expect(placeStairs(sim, 100, 0).accepted).toBe(true);
		expect(placeStairs(sim, 100, 1).accepted).toBe(true);
		expect(placeStairs(sim, 100, 2).accepted).toBe(true);
	});

	it("allows stairs that do not horizontally overlap", () => {
		const sim = makeSimWithLobbyStrip();
		buildFloors(sim, 1, 90, 180);
		buildFloors(sim, 2, 90, 180);
		// Stairs width=8 → cols [100..107] and [108..115] do not overlap.
		expect(placeStairs(sim, 100, 0).accepted).toBe(true);
		expect(placeStairs(sim, 108, 1).accepted).toBe(true);
	});

	it("rejects stairs that horizontally overlap an unaligned neighbor", () => {
		const sim = makeSimWithLobbyStrip();
		buildFloors(sim, 1, 90, 180);
		buildFloors(sim, 2, 90, 180);
		expect(placeStairs(sim, 100, 0).accepted).toBe(true);
		// cols [104..111] overlap [100..107] but anchor x=104 ≠ 100.
		const rejection = placeStairs(sim, 104, 1);
		expect(rejection.accepted).toBe(false);
		expect(rejection.reason).toMatch(/align/);
	});

	it("rejects stairs when no base tile exists on the floor above", () => {
		const sim = makeSimWithLobbyStrip();
		// Lobby strip exists on floor 0 but no floor 1 above.
		const rejection = placeStairs(sim, 100, 0);
		expect(rejection.accepted).toBe(false);
		expect(rejection.reason).toMatch(/floor above/);
	});
});
