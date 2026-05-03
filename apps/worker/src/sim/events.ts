import { applyRemoveElevatorCar } from "./commands";
import { type LedgerState, removeCashflowFromFamilyResource } from "./ledger";
import type { TimeState } from "./time";
import {
	type EventState,
	GRID_HEIGHT,
	sampleRng,
	type WorldState,
	yToFloor,
} from "./world";

// ─── Tuning constants ────────────────────────────────────────────────────────
// From startup tuning resource (type 0xff05, id 1000) at DS:0xe6xx.

const BOMB_DEADLINE_TICKS = 0x4b0; // 1200
/** Ransom amounts indexed by star count (2, 3, 4). Stars 1 and 5 cannot trigger. */
const BOMB_RANSOM: Record<number, number> = {
	2: 200_000,
	3: 300_000,
	4: 1_000_000,
};
/** Blast rectangle dimensions. */
const BLAST_HALF_TILES = 20;

const FIRE_SPREAD_RATE = 7; // DS:0xe644 — ticks per tile advance
const FIRE_VERTICAL_DELAY = 80; // DS:0xe646 — ticks per floor
const HELICOPTER_EXTINGUISH_RATE = 1; // DS:0xe648 — ticks per tile
const HELICOPTER_PROMPT_DELAY = 2; // DS:0xe64a — ticks after fire start / bomb extension
const RESCUE_COUNTDOWN_WITH_SECURITY = 80; // DS:0xe64c
const HELICOPTER_RESCUE_COST = 500_000; // DS:0xe688

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find the highest populated floor (has at least one placed object). */
function highestPopulatedFloor(world: WorldState): number {
	let maxFloor = -1;
	for (const [key] of Object.entries(world.placedObjects)) {
		const [, yStr] = key.split(",");
		const floor = yToFloor(Number(yStr));
		if (floor > maxFloor) maxFloor = floor;
	}
	return maxFloor;
}

function floorTileBoundsForFloor(
	world: WorldState,
	floor: number,
): { left: number; right: number } | null {
	// Match the binary's per-floor header bounds (field0_0x0[+2]/[+4],
	// initialized by `setup_floor_support` and read by the fire spread loop
	// at 10f0:03f2 / 10f0:0379). We approximate by scanning `world.cells` —
	// floor support + facilities — and rely on the augmented
	// `deleteObjectCoveringFloorTile` below to remove cells as fire eats
	// structure, so subsequent reads see the shrunk extent.
	//
	// NOTE(fire-parity): the binary's early front-clearing (e.g. right cleared
	// at exactly tick fireStartTick+36 with no spread cadence event) is NOT
	// driven by bounds shrinkage. It comes from firefighter-rescue helper sims
	// spawned by `initialize_service_response_entities(8)` (1100:033d) on
	// rescue decline. Their per-tick handler `firefighter_sim_per_tick_handler`
	// (1100:0bd3) walks them toward the fire; on arrival they call
	// `extinguish_fire_front_at_tile` (10f0:07d8) which asymmetrically clears
	// `g_fire_left_pos[floor]` iff `left <= tilePos < left+12` and
	// `g_fire_right_pos[floor]` iff `right <= tilePos < right+12`. TS does
	// not yet model these helpers — that's the next big feature for fire
	// parity. Until then, fronts only clear via the bounds check here.
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	const objY = GRID_HEIGHT - 1 - floor;
	for (const key of Object.keys(world.cells)) {
		const [xStr, yStr] = key.split(",");
		if (Number(yStr) !== objY) continue;
		const x = Number(xStr);
		if (x < left) left = x;
		if (x > right) right = x;
	}
	if (left > right) return null;
	return { left, right };
}

function seedBombSearchCursor(world: WorldState, floor: number): void {
	const bounds = floorTileBoundsForFloor(world, floor);
	world.eventState.bombSearchCurrentFloor = floor;
	world.eventState.bombSearchScanTile = bounds ? bounds.right - 2 : -1;
}

/**
 * Mirrors the binary's `g_security_office_count > 0` guard at
 * `trigger_fire_event` (10f0:003a) and `trigger_bomb_event` (10d0:0086).
 * The binary's counter at DS:0xbc6e is never incremented by placement
 * (`allocate_security_office_table_slot` populates the slot table but not
 * the count) — TS doesn't have that bug because we recompute from anchors.
 */
function hasEmergencyResponseCoverage(world: WorldState): boolean {
	for (const record of Object.values(world.placedObjects)) {
		if (record.objectTypeCode === 0x0e) return true; // FAMILY_SECURITY
	}
	return false;
}

// Random-news event: in the binary this drives audio playback only. The
// classifier result feeds play_classified_news_sound (11d0:042c), which loads a
// wave resource by ID and plays it via WAVMIX16.waveOutWrite. There is no
// visual popup on this path. The worker does not model audio; the client will
// own playback once the audio subsystem lands.

/**
 * Family codes the binary's `FUN_1200_3474` (1200:3474) validity gate
 * blocks from `delete_placed_object_and_release_sidecars`. The fire spread
 * code in `advance_fire_frontier_damage` calls
 * `delete_object_covering_floor_tile` (1200:3619) per spread tick, which
 * forwards into the validity gate — meaning fire **cannot destroy** these
 * families. Their tiles survive intact through a fire and bound the
 * spread fronts (the bounded right-front clears that the trace shows are
 * the visible consequence of this gating).
 *
 * Includes: security (0x0e), housekeeping (0x0f), parking + parking-aux
 * (0x18/0x19/0x1a), metro (0x1f/0x20), cathedral anchor + cells
 * (0x21/0x24-0x28), parking ramp lobby (0x2d). Floor support / lobby /
 * stairs / elevators are excluded from the placedObjects path entirely
 * (they live in `world.cells` only or in `world.carriers`), so fire's
 * record-deletion never touches them.
 */
const FIRE_INDESTRUCTIBLE_FAMILIES: ReadonlySet<number> = new Set([
	0x0e, 0x0f, 0x18, 0x19, 0x1a, 0x1f, 0x20, 0x21, 0x24, 0x25, 0x26, 0x27, 0x28,
	0x2d,
]);

/**
 * Mirror per-family side effects of `delete_placed_object_and_release_sidecars`
 * (1200:369d) for the subset of behavior the fire teardown depends on:
 *
 *   - Cash refund for condo (`remove_cashflow_from_family_resource`,
 *     1180:0966) — the only family with a direct cash refund on teardown.
 *   - Sim eviction sweep: sims whose home pointer matches the destroyed
 *     anchor get zeroed (binary `update_sim_tile_span` 1228:1018 second
 *     pass writes `sim[+4]=0; sim[+6]=0`). We approximate by clearing
 *     `familyCode=0` and `stateCode=0` on matching sims, which the rest
 *     of the sim subsystem treats as an empty slot.
 *
 * Punch list NOT yet wired (broader refactor): commercial-venue sidecar
 * freelist push (0x06/0x0a/0x0c), entertainment-link rebuild
 * (0x12/0x13/0x1d/0x1e/0x22/0x23), parking ramp coverage rebuild (0x0b/0x2c),
 * carrier-sidecar global-handle release (`FUN_1190_0884`), and the per-tile
 * occupant zero pass for office service-request entries.
 */
function applyTeardownSideEffects(
	world: WorldState,
	ledger: LedgerState,
	record: WorldState["placedObjects"][string],
	objY: number,
): void {
	const family = record.objectTypeCode;
	const cond = record.unitStatus ?? 0;
	// Cash refund: condo only. `cond < 0x18` matches binary 10f0:026e.
	if (family === 0x09 && cond < 0x18) {
		removeCashflowFromFamilyResource(ledger, "condo", record.evalLevel ?? 0, 9);
	}
	// Sim eviction sweep: find sims with home pointer landing inside the
	// destroyed record and zero them. The binary's `update_sim_tile_span`
	// is family-keyed (only sweeps sims of matching family on the affected
	// floor); we mirror that to avoid evicting unrelated sims that might
	// happen to be standing on the same floor in transit.
	const left = record.leftTileIndex;
	const right = record.rightTileIndex;
	for (const sim of world.sims) {
		if (sim.familyCode !== family) continue;
		if (sim.floorAnchor !== objY) continue;
		if (sim.homeColumn < left || sim.homeColumn > right) continue;
		sim.familyCode = 0;
		sim.stateCode = 0;
	}
}

/**
 * Delete the object/structure covering a given floor/tile.
 *
 * Mirrors `delete_object_covering_floor_tile` (1200:3619) →
 * `delete_placed_object_and_release_sidecars` (1200:369d), including the
 * validity gate that blocks destruction of indestructible families.
 *
 * On non-blocked deletions, also removes the cell at (tile, objY) so the
 * fire spread bounds shrink as the binary's per-floor header bounds do.
 */
function deleteObjectCoveringFloorTile(
	world: WorldState,
	ledger: LedgerState,
	floor: number,
	tile: number,
): void {
	const objY = GRID_HEIGHT - 1 - floor;
	for (const [key, record] of Object.entries(world.placedObjects)) {
		const [, yStr] = key.split(",");
		if (Number(yStr) !== objY) continue;
		if (tile < record.leftTileIndex || tile > record.rightTileIndex) continue;
		// Validity gate: indestructible families survive fire.
		if (FIRE_INDESTRUCTIBLE_FAMILIES.has(record.objectTypeCode)) return;
		applyTeardownSideEffects(world, ledger, record, objY);
		// Remove every cell the record covered, mirroring the binary's
		// per-floor blob compaction (FUN_1200_3b78). Doing this only at
		// the spread tile would leave neighboring cells of the same record
		// in the cell map, inflating bounds reads on subsequent ticks.
		for (let x = record.leftTileIndex; x <= record.rightTileIndex; x++) {
			const k = `${x},${objY}`;
			if (k in world.cells) delete world.cells[k];
			if (k in world.cellToAnchor) delete world.cellToAnchor[k];
		}
		delete world.placedObjects[key];
		return;
	}
	// No facility record matched — still remove the cell at this position
	// (e.g. floor support tile placed individually). This is what shrinks
	// bounds when the right front sweeps through structural floor support.
	const cellKey = `${tile},${objY}`;
	if (cellKey in world.cells) delete world.cells[cellKey];
	if (cellKey in world.cellToAnchor) delete world.cellToAnchor[cellKey];
}

/**
 * Shared floor-selection helper matching the binary's contiguous-live-floor scan.
 * Scans upward from lowerBound to find the first non-empty floor, then the first
 * empty floor after that contiguous occupied run. Returns a uniformly chosen floor
 * from [lowerBound, topLiveFloor], or -1 if no occupied floors exist above lowerBound.
 */
function selectRandomLiveFloor(world: WorldState, lowerBound: number): number {
	// Find the first non-empty floor at or above lowerBound
	let firstOccupied = -1;
	for (let f = lowerBound; f < GRID_HEIGHT; f++) {
		if (floorTileBoundsForFloor(world, f) !== null) {
			firstOccupied = f;
			break;
		}
	}
	if (firstOccupied < 0) return -1;

	// Find the end of the contiguous occupied run
	let topLiveFloor = firstOccupied;
	for (let f = firstOccupied + 1; f < GRID_HEIGHT; f++) {
		if (floorTileBoundsForFloor(world, f) === null) break;
		topLiveFloor = f;
	}

	const range = topLiveFloor - lowerBound + 1;
	if (range <= 0) return -1;
	return lowerBound + (sampleRng(world) % range);
}

// ─── Bomb Event ──────────────────────────────────────────────────────────────

/**
 * Check and trigger bomb event. Called at the daily event checkpoint
 * when `day_counter % 60 == 59`.
 */
export function tryTriggerBombEvent(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
): void {
	const es = world.eventState;
	// Guard: no active bomb or fire
	if ((es.gameStateFlags & 9) !== 0) return;
	// Guard: tower has at least one valid floor
	const topFloor = highestPopulatedFloor(world);
	if (topFloor < 0) return;
	// Guard: early part of day
	if (time.dayTick >= 0x4b1) return;
	// Guard: star 2, 3, or 4 only
	if (world.starCount < 2 || world.starCount > 4) return;

	// Binary: `g_lobby_height + 10` (DS:0xbc5a + 10), no underground term.
	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const minFloor = lobbyHeight + 10;

	// Select floor via contiguous-live-floor scan
	const selectedFloor = selectRandomLiveFloor(world, minFloor);
	if (selectedFloor < 0) return;

	// Require floor width >= 4 tiles
	const bounds = floorTileBoundsForFloor(world, selectedFloor);
	if (!bounds || bounds.right - bounds.left < 4) return;

	const tileRange = bounds.right - bounds.left - 4;
	const selectedTile =
		bounds.left + (tileRange > 0 ? sampleRng(world) % (tileRange + 1) : 0);

	es.bombFloor = selectedFloor;
	es.bombTile = selectedTile;
	es.gameStateFlags |= 1; // bomb active
	es.bombDeadline = BOMB_DEADLINE_TICKS;
	es.bombSearchLowerBound = selectedFloor - 1;
	es.bombSearchUpperBound = selectedFloor;
	if (hasEmergencyResponseCoverage(world)) {
		seedBombSearchCursor(world, selectedFloor);
	} else {
		es.bombSearchCurrentFloor = -1;
		es.bombSearchScanTile = -1;
	}

	const ransom = BOMB_RANSOM[world.starCount] ?? 0;
	world.pendingPrompts.push({
		promptId: `bomb_${time.dayCounter}`,
		promptKind: "bomb_ransom",
		message: `A bomb threat has been received! Pay $${ransom.toLocaleString()} ransom to avoid detonation?`,
		cost: ransom,
	});
}

/** Per-tick bomb handler. */
export function tickBombEvent(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	const es = world.eventState;
	// Check found/detonated cleanup
	if ((es.gameStateFlags & 0x60) !== 0 && time.dayTick >= es.bombDeadline) {
		bombCleanup(world, time);
		return;
	}
	// Check active search deadline → detonation
	if ((es.gameStateFlags & 1) !== 0 && hasEmergencyResponseCoverage(world)) {
		advanceBombSearch(world, ledger, time);
	}
	if ((es.gameStateFlags & 1) !== 0 && time.dayTick >= es.bombDeadline) {
		resolveBombSearch(world, ledger, time, false);
	}
}

function advanceBombSearch(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	const es = world.eventState;
	if (es.bombSearchCurrentFloor < 0) return;
	const floor = es.bombSearchCurrentFloor;
	const bounds = floorTileBoundsForFloor(world, floor);
	if (!bounds) {
		if (!advanceBombSearchFloor(world)) {
			es.bombSearchCurrentFloor = -1;
		}
		return;
	}
	if (es.bombSearchScanTile < 0) {
		es.bombSearchScanTile = bounds.right - 2;
	}
	if (bounds.left < es.bombSearchScanTile) {
		es.bombSearchScanTile -= 1;
		checkSecurityPatrolBomb(world, ledger, time, floor, es.bombSearchScanTile);
		return;
	}
	if (!advanceBombSearchFloor(world)) {
		es.bombSearchCurrentFloor = -1;
	}
}

function advanceBombSearchFloor(world: WorldState): boolean {
	const es = world.eventState;
	const current = es.bombSearchCurrentFloor;
	if (current < 0) return false;
	const tryAbove =
		current <= es.bombFloor ? es.bombSearchUpperBound : es.bombSearchLowerBound;
	const tryBelow =
		current <= es.bombFloor ? es.bombSearchLowerBound : es.bombSearchUpperBound;
	for (const candidate of [tryAbove, tryBelow]) {
		if (candidate < 0 || candidate >= GRID_HEIGHT) continue;
		if (candidate === current) continue;
		const bounds = floorTileBoundsForFloor(world, candidate);
		if (!bounds) continue;
		if (candidate >= es.bombFloor) {
			es.bombSearchUpperBound = candidate + 1;
		} else {
			es.bombSearchLowerBound = candidate - 1;
		}
		seedBombSearchCursor(world, candidate);
		return true;
	}
	return false;
}

/**
 * Called when a security guard visits a floor/tile.
 * If it matches the bomb position, the bomb is found.
 */
export function checkSecurityPatrolBomb(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	floor: number,
	tile: number,
): void {
	const es = world.eventState;
	if ((es.gameStateFlags & 1) === 0) return; // no active bomb search
	if (floor === es.bombFloor && tile === es.bombTile) {
		resolveBombSearch(world, ledger, time, true);
	}
}

function resolveBombSearch(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	found: boolean,
): void {
	const es = world.eventState;
	es.gameStateFlags &= ~1; // clear active search
	if (found) {
		es.gameStateFlags |= 0x20; // bomb found
		es.bombDeadline = time.dayTick + HELICOPTER_PROMPT_DELAY; // reuse tuning delay
	} else {
		es.gameStateFlags |= 0x40; // bomb detonated
		applyBlastDamage(world, ledger);
		es.bombDeadline = time.dayTick + 50; // short delay before cleanup
	}
}

function applyBlastDamage(world: WorldState, ledger: LedgerState): void {
	const es = world.eventState;
	const floorMin = es.bombFloor - 2;
	const floorMax = es.bombFloor + 3;
	const tileMin = es.bombTile - BLAST_HALF_TILES;
	const tileMax = es.bombTile + BLAST_HALF_TILES - 1;
	for (let floor = floorMin; floor <= floorMax; floor++) {
		for (let tile = tileMin; tile <= tileMax; tile++) {
			deleteObjectCoveringFloorTile(world, ledger, floor, tile);
		}
	}
}

function bombCleanup(world: WorldState, time: TimeState): void {
	const es = world.eventState;
	// Clear found/detonated flags
	es.gameStateFlags &= ~0x60;
	es.bombSearchCurrentFloor = -1;
	es.bombSearchScanTile = -1;
	es.bombSearchLowerBound = -1;
	es.bombSearchUpperBound = -1;
	// Fast-forward time to 1500 if earlier
	if (time.dayTick < 1500) {
		(time as { dayTick: number }).dayTick = 1500;
		(time as { daypartIndex: number }).daypartIndex = Math.floor(1500 / 400);
	}
}

// ─── Fire Event ──────────────────────────────────────────────────────────────

/**
 * Check and trigger fire event. Called at the daily event checkpoint
 * when `day_counter % 84 == 83`.
 */
export function tryTriggerFireEvent(
	world: WorldState,
	_ledger: LedgerState,
	time: TimeState,
): void {
	const es = world.eventState;
	// Guard: no active bomb or fire
	if ((es.gameStateFlags & 9) !== 0) return;
	// Guard: tower has at least one valid floor
	const topFloor = highestPopulatedFloor(world);
	if (topFloor < 0) return;
	// Guard: early daypart (< 4)
	if (time.daypartIndex >= 4) return;
	// Guard: star > 2
	if (world.starCount <= 2) return;
	// Guard: no cathedral guest dispatch active
	if (
		world.gateFlags.evalSimIndex >= 0 &&
		world.gateFlags.evalSimIndex !== 0xffff
	)
		return;

	// Binary: `g_lobby_height + 10` (DS:0xbc5a + 10), no underground term.
	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const minFloor = lobbyHeight + 10;

	// Select floor via contiguous-live-floor scan
	const selectedFloor = selectRandomLiveFloor(world, minFloor);
	if (selectedFloor < 0) return;

	// Require floor width >= 32 tiles
	const bounds = floorTileBoundsForFloor(world, selectedFloor);
	if (!bounds || bounds.right - bounds.left < 0x20) return;

	es.fireFloor = selectedFloor;
	es.fireTile = bounds.right - 0x20;
	es.gameStateFlags |= 8; // fire active
	es.fireStartTick = time.dayTick;
	es.fireLeftPos.fill(0xffff);
	es.fireRightPos.fill(0xffff);
	// Eager-init the fireFloor entries to fireTile — mirrors the binary's
	// trigger writes at `fireFloor*2 + 0xbd7e` / `fireFloor*2 + 0xbc8e`
	// (10f0:00d0-ish region). The spread loop then advances from this seed
	// rather than waiting for an "ignition tick" to lazy-init.
	es.fireLeftPos[selectedFloor] = es.fireTile;
	es.fireRightPos[selectedFloor] = es.fireTile;

	if (hasEmergencyResponseCoverage(world)) {
		es.rescueCountdown = RESCUE_COUNTDOWN_WITH_SECURITY;
	} else {
		es.rescueCountdown = 0;
	}
	es.helicopterExtinguishPos = 0;
}

/** Per-tick fire spread and resolution. */
export function tickFireEvent(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	const es = world.eventState;
	if ((es.gameStateFlags & 8) === 0) return;

	// Rescue countdown
	if (es.rescueCountdown > 0) {
		es.rescueCountdown--;
		return;
	}

	// Helicopter extinguish
	if (es.helicopterExtinguishPos > 0) {
		advanceHelicopterExtinguish(world, time);
	}

	// Normal fire spread
	advanceFireSpread(world, ledger, time);

	// Check helicopter prompt timing
	if (
		es.helicopterExtinguishPos === 0 &&
		time.dayTick === es.fireStartTick + HELICOPTER_PROMPT_DELAY
	) {
		world.pendingPrompts.push({
			promptId: `fire_${time.dayCounter}`,
			promptKind: "fire_rescue",
			message: `Fire is spreading! Call helicopter rescue for $${HELICOPTER_RESCUE_COST.toLocaleString()}?`,
			cost: HELICOPTER_RESCUE_COST,
		});
	}

	// Check resolution. Binary uses exact-equals at 10d0:0049 — `dayTick >=`
	// would fire every tick after 2000, but the binary cleanup happens once
	// at the boundary and then fast-forwards dayTick to 1500 (so the comparison
	// never re-triggers). Using `>=` here corrupts cleanup state if the boundary
	// is missed; using `===` matches the binary edge.
	if (isFireExhausted(es) || time.dayTick === 2000) {
		resolveFireEvent(world, time);
	}
}

function advanceFireSpread(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	const es = world.eventState;

	// Binary `advance_fire_frontier_damage` (10f0:0306) iterates **all 120
	// floor entries**, not just up to the populated max — vertical-delay
	// ignitions on un-burned floors are governed by the per-floor array
	// state, not by the live-floor scan. Match that.
	for (let floor = 0; floor < GRID_HEIGHT; floor++) {
		const floorDelay = Math.abs(floor - es.fireFloor) * FIRE_VERTICAL_DELAY;
		const ignitionTick = es.fireStartTick + floorDelay;

		if (time.dayTick < ignitionTick) continue;

		// Lazy ignition for non-fireFloor entries (the fireFloor itself was
		// eager-initialized by `tryTriggerFireEvent`).
		if (es.fireLeftPos[floor] === 0xffff && es.fireRightPos[floor] === 0xffff) {
			if (time.dayTick === ignitionTick) {
				es.fireLeftPos[floor] = es.fireTile;
				es.fireRightPos[floor] = es.fireTile;
			}
			continue;
		}

		// Spread cadence: binary uses **absolute** `g_day_tick % spread_rate
		// == 0` (10f0:039a, 10f0:0411), not elapsed-since-ignition. The
		// difference matters when `fireStartTick` is not a multiple of the
		// rate — the binary fires on tick boundaries shared across all
		// floors, while the elapsed model phases each floor independently.
		if (time.dayTick % FIRE_SPREAD_RATE !== 0) continue;

		const bounds = floorTileBoundsForFloor(world, floor);
		if (!bounds) continue;

		// Left front: move left. Binary writes 0xffff sentinel when the
		// front crosses the floor's left bound (10f0:03a5).
		if (es.fireLeftPos[floor] !== 0xffff) {
			deleteObjectCoveringFloorTile(
				world,
				ledger,
				floor,
				es.fireLeftPos[floor],
			);
			es.fireLeftPos[floor]--;
			if (es.fireLeftPos[floor] < bounds.left) {
				es.fireLeftPos[floor] = 0xffff;
			}
		}

		// Right front: move right, delete at position + 12. Binary writes
		// 0xffff when right+12 outruns the floor's right bound (10f0:0420).
		if (es.fireRightPos[floor] !== 0xffff) {
			const deletePos = es.fireRightPos[floor] + 12;
			if (deletePos <= bounds.right) {
				deleteObjectCoveringFloorTile(world, ledger, floor, deletePos);
			}
			es.fireRightPos[floor]++;
			if (es.fireRightPos[floor] + 12 > bounds.right) {
				es.fireRightPos[floor] = 0xffff;
			}
		}
	}
}

function advanceHelicopterExtinguish(world: WorldState, time: TimeState): void {
	const es = world.eventState;
	if (es.helicopterExtinguishPos <= 0) return;

	// Decrement position by 1 every HELICOPTER_EXTINGUISH_RATE ticks
	if (time.dayTick % HELICOPTER_EXTINGUISH_RATE !== 0) return;
	es.helicopterExtinguishPos--;

	// `clear_fire_boundaries_past_spread_width` (10f0:0858) — full 120-floor
	// sweep, write 0xffff sentinel.
	for (let floor = 0; floor < GRID_HEIGHT; floor++) {
		if (
			es.fireLeftPos[floor] !== 0xffff &&
			es.fireLeftPos[floor] > es.helicopterExtinguishPos
		) {
			es.fireLeftPos[floor] = 0xffff;
		}
		if (
			es.fireRightPos[floor] !== 0xffff &&
			es.fireRightPos[floor] > es.helicopterExtinguishPos
		) {
			es.fireRightPos[floor] = 0xffff;
		}
	}

	if (es.helicopterExtinguishPos <= 0) {
		resolveFireEvent(world, time);
	}
}

function isFireExhausted(es: EventState): boolean {
	for (let floor = 0; floor < GRID_HEIGHT; floor++) {
		if (es.fireLeftPos[floor] !== 0xffff) return false;
		if (es.fireRightPos[floor] !== 0xffff) return false;
	}
	return true;
}

function resolveFireEvent(world: WorldState, time: TimeState): void {
	const es = world.eventState;
	es.gameStateFlags &= ~8; // clear fire flag
	es.fireLeftPos.fill(0xffff);
	es.fireRightPos.fill(0xffff);
	es.helicopterExtinguishPos = 0;
	es.rescueCountdown = 0;
	if (time.dayTick < 1500) {
		(time as { dayTick: number }).dayTick = 1500;
		(time as { daypartIndex: number }).daypartIndex = Math.floor(1500 / 400);
	}
}

// ─── VIP Special Visitor Event ───────────────────────────────────────────────

/**
 * Per-tick VIP special visitor check. Binary-verified from
 * `trigger_vip_special_visitor` at 11f0:0273.
 */
export function tickVipSpecialVisitor(
	world: WorldState,
	time: TimeState,
): void {
	const es = world.eventState;
	// Guards
	if (time.dayTick <= 0xf0) return;
	if (time.daypartIndex >= 4) return;
	if ((es.gameStateFlags & 9) !== 0) return;
	// Eligibility is keyed off the metro placement/floor state.
	if (
		world.gateFlags.vipSuiteFloor < 0 ||
		world.gateFlags.vipSuiteFloor === 0xffff
	) {
		return;
	}

	// 1% chance per tick
	if (sampleRng(world) % 100 !== 0) return;

	if (world.gateFlags.metroPlaced === 0) return;

	// TODO: Metro is a 3-floor stack in the binary (codes 0x1f/0x20/0x21); the
	// metro_floor DS variable drives VIP eligibility. TS doesn't yet model the
	// metro stack, so this sweep is inert — metroPlaced never gets set.
}

// Random-news event: audio-only in the binary (play_classified_news_sound @
// 11d0:042c → WAVMIX16.waveOutWrite). No visual popup. The worker keeps the
// RNG-consuming gates so the shared RNG stream stays in sync with the binary,
// but emits nothing. When the client audio subsystem lands, it will own
// playback of the classifier's selected wave ID.
export function triggerRandomNewsEvent(
	world: WorldState,
	time: TimeState,
): void {
	const es = world.eventState;
	if (es.disableNewsEvents) return;
	if (time.dayTick <= 0xf0) return;
	if (time.daypartIndex >= 6) return;
	if ((es.gameStateFlags & 9) !== 0) return;
	if (sampleRng(world) % 16 !== 0) return;
	// TODO(client-audio): viewport-sample 6 buckets, classify the sampled slot
	// per EVENTS.md "Random News Events", and play the resulting wave resource.
	// Until then the gate fires but no sound/notification is emitted.
}

// ─── Daily event checkpoint dispatcher ───────────────────────────────────────

/**
 * Called from runCheckpoints at the daily event check timing.
 * Dispatches bomb/fire triggers based on day_counter modular conditions.
 */
export function checkDailyEvents(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): void {
	if (time.dayCounter % 84 === 83) {
		tryTriggerFireEvent(world, ledger, time);
	}
	if (time.dayCounter % 60 === 59) {
		tryTriggerBombEvent(world, ledger, time);
	}
}

/**
 * Handle a player's response to a prompt.
 * Returns true if the prompt was recognized and handled.
 */
export function handlePromptResponse(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
	promptId: string,
	accepted: boolean,
): boolean {
	if (promptId.startsWith("bomb_")) {
		if (!accepted) return true; // refused — bomb stays armed (default behavior)
		// Pay ransom: deactivate bomb
		const ransom = BOMB_RANSOM[world.starCount] ?? 0;
		if (ransom > 0 && ledger.cashBalance >= ransom) {
			ledger.cashBalance -= ransom;
			bombCleanup(world, time);
			world.pendingNotifications.push({
				kind: "event",
				message: "Ransom paid. The bomb threat has been resolved.",
			});
		}
		return true;
	}

	if (promptId.startsWith("fire_")) {
		if (!accepted) return true; // declined helicopter — fire spreads naturally
		const es = world.eventState;
		if ((es.gameStateFlags & 8) === 0) return true; // fire already resolved
		const bounds = floorTileBoundsForFloor(world, es.fireFloor);
		if (bounds && ledger.cashBalance >= HELICOPTER_RESCUE_COST) {
			ledger.cashBalance -= HELICOPTER_RESCUE_COST;
			es.helicopterExtinguishPos = bounds.right - 12;
			world.pendingNotifications.push({
				kind: "event",
				message: "Helicopter dispatched to fight the fire!",
			});
		}
		return true;
	}

	if (promptId.startsWith("carrier_remove_")) {
		const column = world.eventState.pendingCarrierEditColumn;
		const y = world.eventState.pendingCarrierEditY;
		world.eventState.pendingCarrierEditColumn = -1;
		world.eventState.pendingCarrierEditY = -1;
		if (!accepted || column < 0 || y < 0) return true;
		applyRemoveElevatorCar(world, column, y);
		return true;
	}

	return false;
}
