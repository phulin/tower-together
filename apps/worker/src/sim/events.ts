import { applyRemoveElevatorCar } from "./commands";
import type { LedgerState } from "./ledger";
import { FAMILY_METRO } from "./resources";
import type { TimeState } from "./time";
import {
	type EventState,
	GRID_HEIGHT,
	UNDERGROUND_FLOORS,
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

// ─── LCG15 PRNG ─────────────────────────────────────────────────────────────

function sampleLcg15(es: EventState): number {
	es.lcgState = (es.lcgState * 0x15a4e35 + 1) & 0x7fff;
	return es.lcgState;
}

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
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	const objY = GRID_HEIGHT - 1 - floor;
	for (const [key, record] of Object.entries(world.placedObjects)) {
		const [, yStr] = key.split(",");
		if (Number(yStr) !== objY) continue;
		if (record.leftTileIndex < left) left = record.leftTileIndex;
		if (record.rightTileIndex > right) right = record.rightTileIndex;
	}
	if (left > right) return null;
	return { left, right };
}

function seedBombSearchCursor(world: WorldState, floor: number): void {
	const bounds = floorTileBoundsForFloor(world, floor);
	world.eventState.bombSearchCurrentFloor = floor;
	world.eventState.bombSearchScanTile = bounds ? bounds.right - 2 : -1;
}

function hasEmergencyResponseCoverage(world: WorldState): boolean {
	return world.gateFlags.recyclingCenterCount > 0;
}

function objectNewsCode(objectTypeCode: number): string | null {
	switch (objectTypeCode) {
		case 3:
		case 4:
		case 5:
			return "0x629";
		case 6:
			return sampleNewsVariant(["0x568", "0x569"]);
		case 7:
			return "0x5a8";
		case 9:
			return sampleLcgNews(10) === 0 ? "0x628" : "0x629";
		case 10:
		case 12:
			return sampleNewsVariant(["0x569", "0x668"]);
		case 18:
		case 29:
			return "0xb28";
		case 24:
			return sampleNewsVariant(["0x6a8", "0x6a9"]);
		default:
			return null;
	}
}

let newsLcgSource: EventState | null = null;
function sampleLcgNews(modulo: number): number {
	if (!newsLcgSource) return 0;
	return sampleLcg15(newsLcgSource) % modulo;
}

function sampleNewsVariant(codes: string[]): string {
	const index = sampleLcgNews(codes.length);
	return codes[index] ?? codes[0] ?? "news";
}

/** Delete all objects covering a given floor/tile (same teardown as demolition). */
function deleteObjectCoveringFloorTile(
	world: WorldState,
	floor: number,
	tile: number,
): void {
	const objY = GRID_HEIGHT - 1 - floor;
	for (const [key, record] of Object.entries(world.placedObjects)) {
		const [, yStr] = key.split(",");
		if (Number(yStr) !== objY) continue;
		if (tile >= record.leftTileIndex && tile <= record.rightTileIndex) {
			delete world.placedObjects[key];
			return;
		}
	}
}

/**
 * Shared floor-selection helper matching the binary's contiguous-live-floor scan.
 * Scans upward from lowerBound to find the first non-empty floor, then the first
 * empty floor after that contiguous occupied run. Returns a uniformly chosen floor
 * from [lowerBound, topLiveFloor], or -1 if no occupied floors exist above lowerBound.
 */
function selectRandomLiveFloor(
	world: WorldState,
	es: EventState,
	lowerBound: number,
): number {
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
	return lowerBound + (sampleLcg15(es) % range);
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
	if (time.starCount < 2 || time.starCount > 4) return;

	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const minFloor = lobbyHeight + UNDERGROUND_FLOORS + 10;

	// Select floor via contiguous-live-floor scan
	const selectedFloor = selectRandomLiveFloor(world, es, minFloor);
	if (selectedFloor < 0) return;

	// Require floor width >= 4 tiles
	const bounds = floorTileBoundsForFloor(world, selectedFloor);
	if (!bounds || bounds.right - bounds.left < 4) return;

	const tileRange = bounds.right - bounds.left - 4;
	const selectedTile =
		bounds.left + (tileRange > 0 ? sampleLcg15(es) % (tileRange + 1) : 0);

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

	const ransom = BOMB_RANSOM[time.starCount] ?? 0;
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
	_ledger: LedgerState,
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
		advanceBombSearch(world, time);
	}
	if ((es.gameStateFlags & 1) !== 0 && time.dayTick >= es.bombDeadline) {
		resolveBombSearch(world, time, false);
	}
}

function advanceBombSearch(world: WorldState, time: TimeState): void {
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
		checkSecurityPatrolBomb(world, time, floor, es.bombSearchScanTile);
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
	time: TimeState,
	floor: number,
	tile: number,
): void {
	const es = world.eventState;
	if ((es.gameStateFlags & 1) === 0) return; // no active bomb search
	if (floor === es.bombFloor && tile === es.bombTile) {
		resolveBombSearch(world, time, true);
	}
}

function resolveBombSearch(
	world: WorldState,
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
		applyBlastDamage(world);
		es.bombDeadline = time.dayTick + 50; // short delay before cleanup
	}
}

function applyBlastDamage(world: WorldState): void {
	const es = world.eventState;
	const floorMin = es.bombFloor - 2;
	const floorMax = es.bombFloor + 3;
	const tileMin = es.bombTile - BLAST_HALF_TILES;
	const tileMax = es.bombTile + BLAST_HALF_TILES - 1;
	for (let floor = floorMin; floor <= floorMax; floor++) {
		for (let tile = tileMin; tile <= tileMax; tile++) {
			deleteObjectCoveringFloorTile(world, floor, tile);
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
	if (time.starCount <= 2) return;
	// Guard: no cathedral guest dispatch active
	if (
		world.gateFlags.evalSimIndex >= 0 &&
		world.gateFlags.evalSimIndex !== 0xffff
	)
		return;

	const lobbyHeight = Math.max(1, world.lobbyHeight ?? 1);
	const minFloor = lobbyHeight + UNDERGROUND_FLOORS + 10;

	// Select floor via contiguous-live-floor scan
	const selectedFloor = selectRandomLiveFloor(world, es, minFloor);
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
	_ledger: LedgerState,
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
	advanceFireSpread(world, time);

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

	// Check resolution
	if (isFireExhausted(es) || time.dayTick >= 2000) {
		resolveFireEvent(world, time);
	}
}

function advanceFireSpread(world: WorldState, time: TimeState): void {
	const es = world.eventState;
	const topFloor = highestPopulatedFloor(world);
	if (topFloor < 0) return;

	for (let floor = 0; floor <= topFloor; floor++) {
		const floorDelay = Math.abs(floor - es.fireFloor) * FIRE_VERTICAL_DELAY;
		const ignitionTick = es.fireStartTick + floorDelay;

		if (time.dayTick < ignitionTick) continue;

		// Initialize fire on this floor
		if (es.fireLeftPos[floor] === 0xffff && es.fireRightPos[floor] === 0xffff) {
			if (time.dayTick === ignitionTick) {
				es.fireLeftPos[floor] = es.fireTile;
				es.fireRightPos[floor] = es.fireTile;
			}
			continue;
		}

		const elapsed = time.dayTick - ignitionTick;
		if (elapsed % FIRE_SPREAD_RATE !== 0) continue;

		const bounds = floorTileBoundsForFloor(world, floor);
		if (!bounds) continue;

		// Left front: move left
		if (es.fireLeftPos[floor] !== -1) {
			deleteObjectCoveringFloorTile(world, floor, es.fireLeftPos[floor]);
			es.fireLeftPos[floor]--;
			if (es.fireLeftPos[floor] < bounds.left) {
				es.fireLeftPos[floor] = -1;
			}
		}

		// Right front: move right, delete at position + 12
		if (es.fireRightPos[floor] !== -1) {
			const deletePos = es.fireRightPos[floor] + 12;
			if (deletePos <= bounds.right) {
				deleteObjectCoveringFloorTile(world, floor, deletePos);
			}
			es.fireRightPos[floor]++;
			if (es.fireRightPos[floor] + 12 > bounds.right) {
				es.fireRightPos[floor] = -1;
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

	const topFloor = highestPopulatedFloor(world);
	for (let floor = 0; floor <= topFloor; floor++) {
		if (
			es.fireLeftPos[floor] !== -1 &&
			es.fireLeftPos[floor] > es.helicopterExtinguishPos
		) {
			es.fireLeftPos[floor] = -1;
		}
		if (
			es.fireRightPos[floor] !== -1 &&
			es.fireRightPos[floor] > es.helicopterExtinguishPos
		) {
			es.fireRightPos[floor] = -1;
		}
	}

	if (es.helicopterExtinguishPos <= 0) {
		resolveFireEvent(world, time);
	}
}

function isFireExhausted(es: EventState): boolean {
	for (let floor = 0; floor < GRID_HEIGHT; floor++) {
		if (es.fireLeftPos[floor] !== -1 && es.fireLeftPos[floor] !== 0xffff)
			return false;
		if (es.fireRightPos[floor] !== -1 && es.fireRightPos[floor] !== 0xffff)
			return false;
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
	if (sampleLcg15(es) % 100 !== 0) return;

	if (world.gateFlags.metroPlaced === 0) return;

	// Sweep metro stack objects and toggle the display-only aux word.
	let activated = false;
	for (const record of Object.values(world.placedObjects)) {
		if (record.objectTypeCode !== FAMILY_METRO) continue;
		if (record.auxValueOrTimer === 0) {
			record.auxValueOrTimer = 2; // activate special visitor
			record.needsRefreshFlag = 1;
			activated = true;
		} else {
			record.auxValueOrTimer = 0; // clear
			record.needsRefreshFlag = 1;
		}
	}
	if (activated) {
		world.pendingNotifications.push({
			kind: "event",
			message: "0x271a",
		});
	}
}

// TODO: Spec documents viewport-sampling with 6 buckets, per-family eligibility
// gates, and classifier return codes. Current implementation approximates by
// picking a random placed object. See EVENTS.md "Random News Events" for the
// full viewport-sampling algorithm to implement when the clone has a viewport.
export function triggerRandomNewsEvent(
	world: WorldState,
	time: TimeState,
): void {
	const es = world.eventState;
	if (time.dayTick <= 0xf0) return;
	if (time.daypartIndex >= 6) return;
	if ((es.gameStateFlags & 9) !== 0) return;
	if (sampleLcg15(es) % 16 !== 0) return;

	const candidates = Object.values(world.placedObjects);
	newsLcgSource = es;
	try {
		if (candidates.length === 0) {
			world.pendingNotifications.push({
				kind: "news",
				message: sampleNewsVariant(["0x2712", "0x271b", "0x271c"]),
			});
			return;
		}
		const object = candidates[sampleLcg15(es) % candidates.length];
		if (!object) return;
		const code = objectNewsCode(object.objectTypeCode);
		if (!code) return;
		world.pendingNotifications.push({ kind: "news", message: code });
	} finally {
		newsLcgSource = null;
	}
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
		const ransom = BOMB_RANSOM[time.starCount] ?? 0;
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
		world.eventState.pendingCarrierEditColumn = -1;
		if (!accepted || column < 0) return true;
		applyRemoveElevatorCar(world, column);
		return true;
	}

	return false;
}
