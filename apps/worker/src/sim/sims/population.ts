import {
	FAMILY_CATHEDRAL_BASE,
	FAMILY_CINEMA,
	FAMILY_CONDO,
	FAMILY_HOUSEKEEPING,
	FAMILY_MEDICAL,
	FAMILY_OFFICE,
	FAMILY_PARTY_HALL,
	FAMILY_RECYCLING_CENTER_UPPER,
	FAMILY_SECURITY,
} from "../resources";
import type { CarrierRecord } from "../world";
import {
	GRID_HEIGHT,
	GROUND_Y,
	type PlacedObjectRecord,
	type SimRecord,
	type WorldState,
	yToFloor,
} from "../world";
import {
	CATHEDRAL_FAMILIES,
	COMMERCIAL_FAMILIES,
	ENTITY_POPULATION_BY_TYPE,
	HK_STATE_SEARCH,
	HOTEL_FAMILIES,
	ROUTE_IDLE,
	STATE_ACTIVE,
	STATE_HOTEL_PARKED,
	STATE_MORNING_GATE,
	STATE_PARKED,
} from "./states";
import { resetSimTripCounters } from "./trip-counters";

function makeSim(
	floorAnchor: number,
	homeColumn: number,
	baseOffset: number,
	familyCode: number,
	population: number,
	facilitySlot: number,
): SimRecord {
	return {
		floorAnchor,
		homeColumn,
		baseOffset,
		facilitySlot,
		familyCode,
		stateCode: initialStateForFamily(familyCode, baseOffset, population),
		route: ROUTE_IDLE,
		selectedFloor: floorAnchor,
		originFloor: floorAnchor,
		destinationFloor: -1,
		venueReturnState: 0,
		queueTick: 0,
		elapsedTicks: 0,
		transitTicksRemaining: 0,
		lastDemandTick: -1,
		tripCount: 0,
		accumulatedTicks: 0,
		targetRoomFloor: -1,
		targetRoomColumn: -1,
		spawnFloor: floorAnchor,
		postClaimCountdown: 0,
		encodedTargetFloor: 0,
		commercialVenueSlot: -1,
	};
}

function initialStateForFamily(
	familyCode: number,
	baseOffset: number,
	_population: number,
): number {
	if (HOTEL_FAMILIES.has(familyCode)) {
		// Binary NIGHT_B handler: base_offset == 0 → HOTEL_PARKED, others → MORNING_GATE.
		return baseOffset === 0 ? STATE_HOTEL_PARKED : STATE_MORNING_GATE;
	}
	if (CATHEDRAL_FAMILIES.has(familyCode)) return STATE_PARKED;
	if (familyCode === FAMILY_OFFICE) return STATE_MORNING_GATE;
	if (familyCode === FAMILY_CONDO) return STATE_MORNING_GATE;
	if (COMMERCIAL_FAMILIES.has(familyCode)) return STATE_MORNING_GATE;
	if (
		familyCode === FAMILY_RECYCLING_CENTER_UPPER ||
		familyCode === FAMILY_SECURITY
	)
		return STATE_ACTIVE;
	if (familyCode === FAMILY_HOUSEKEEPING) return HK_STATE_SEARCH;
	return STATE_PARKED;
}

export function simKey(sim: SimRecord): string {
	return `${sim.floorAnchor}:${sim.homeColumn}:${sim.familyCode}:${sim.baseOffset}`;
}

function objectKey(sim: SimRecord): string {
	const y = GRID_HEIGHT - 1 - sim.floorAnchor;
	return `${sim.homeColumn},${y}`;
}

const simOwnerCache = new WeakMap<SimRecord, PlacedObjectRecord>();

export function findObjectForSim(
	world: WorldState,
	sim: SimRecord,
): PlacedObjectRecord | undefined {
	const cached = simOwnerCache.get(sim);
	if (cached) return cached;
	const owner = world.placedObjects[objectKey(sim)];
	if (owner) simOwnerCache.set(sim, owner);
	return owner;
}

export function findSiblingSims(
	world: WorldState,
	sim: SimRecord,
): SimRecord[] {
	return world.sims.filter(
		(candidate) =>
			candidate.floorAnchor === sim.floorAnchor &&
			candidate.homeColumn === sim.homeColumn &&
			candidate.familyCode === sim.familyCode,
	);
}

export function clearSimRoute(sim: SimRecord): void {
	sim.route = ROUTE_IDLE;
	// Phase 5b: `sim.stateCode` bits are NOT cleared here. The binary's
	// `dispatch_destination_queue_entries` sets state_code bits via the
	// family handler it dispatches into (e.g. hotel state-0x60 → 0x01 on
	// arrival), so the family arrival handler — called right after
	// clearSimRoute — is responsible for any state-bit changes. Stripping
	// 0x40 unconditionally here corrupts the _TRANSIT phase byte that the
	// handler still needs to read to identify the arrival branch (e.g.
	// `sim.stateCode === STATE_MORNING_TRANSIT` in hotel.ts#handleHotelSimArrival).
	// Explicit state-bit clears are paired at the specific sites that park
	// the sim (resetSimRuntimeState, cleanupSimsForRemovedTile,
	// maybe-dispatch-after-wait, and the idle transitions inside family
	// state handlers).
}

function clearCarrierSlotsForRemovedSims(
	carrier: CarrierRecord,
	removedIds: Set<string>,
): void {
	carrier.pendingRoutes = carrier.pendingRoutes.filter(
		(route) => !removedIds.has(route.simId),
	);
	for (const car of carrier.cars) {
		for (const slot of car.activeRouteSlots) {
			if (!slot.active) continue;
			if (!removedIds.has(slot.routeId)) continue;
			if (slot.boarded) {
				car.assignedCount = Math.max(0, car.assignedCount - 1);
			}
			slot.active = false;
			slot.routeId = "";
			slot.sourceFloor = 0xff;
			slot.destinationFloor = 0xff;
			slot.boarded = false;
		}
		car.pendingRouteIds = car.pendingRouteIds.filter(
			(id) => !removedIds.has(id),
		);
	}
}

// Binary place_object_on_floor maintains a 10-entry FIFO of pending sim-slot
// reservations. Each placement (a) first-fit allocates a contiguous block of
// sim-record slots sized to its population (6 for medical, which reserves
// slots but fills none), (b) writes placeholder records tagged with the
// facility's (floor, facilitySlot), (c) enqueues the block. When the queue
// is about to exceed 10 entries, the oldest is finalized: occupant placeholders
// promote to live sims in place; medical placeholders are zeroed, freeing
// their slots for a later placement's first-fit to reclaim. This is what
// causes ~one office per medical to end up with sim indices earlier than its
// nominal placement order. See medical-allocation.md for the empirical
// derivation.
const PLACEMENT_QUEUE_SIZE = 10;
const MEDICAL_SLOT_WIDTH = 6;

interface QueueEntry {
	slotIndices: number[];
	zeroOnFinalize: boolean;
}

function firstFitSlot(occupied: boolean[], width: number): number {
	let run = 0;
	let runStart = -1;
	for (let i = 0; i < occupied.length; i++) {
		if (!occupied[i]) {
			if (run === 0) runStart = i;
			run++;
			if (run === width) return runStart;
		} else {
			run = 0;
		}
	}
	return occupied.length;
}

export function rebuildRuntimeSims(world: WorldState): void {
	const previous = new Map(
		world.sims.map((sim) => [simKey(sim), sim] as const),
	);

	// Sort by binary floor-by-floor allocation order: above-grade floors
	// ascending (y descending), then below-grade floors ascending (y ascending),
	// then x ascending within the same floor. This matches the binary's
	// entity table layout from _place_build_objects.
	const sortedEntries = Object.entries(world.placedObjects).sort(([a], [b]) => {
		const [ax, ay] = a.split(",").map(Number);
		const [bx, by] = b.split(",").map(Number);
		const aBelow = ay > GROUND_Y ? 1 : 0;
		const bBelow = by > GROUND_Y ? 1 : 0;
		if (aBelow !== bBelow) return aBelow - bBelow;
		if (aBelow === 0) {
			if (ay !== by) return by - ay;
		} else {
			if (ay !== by) return ay - by;
		}
		return ax - bx;
	});

	const slotByFloor = new Map<number, number>();
	const slots: (SimRecord | null)[] = [];
	const occupied: boolean[] = [];
	const queue: QueueEntry[] = [];

	for (const [key, object] of sortedEntries) {
		const familyCode = object.objectTypeCode;
		const runtimeFamilyCode = CATHEDRAL_FAMILIES.has(familyCode)
			? FAMILY_CATHEDRAL_BASE
			: familyCode;
		const isMedical = familyCode === FAMILY_MEDICAL;
		const population = ENTITY_POPULATION_BY_TYPE[familyCode] ?? 0;
		if (population === 0 && !isMedical) continue;

		const [x, y] = key.split(",").map(Number);
		const floorAnchor = yToFloor(y);
		const facilitySlot = slotByFloor.get(floorAnchor) ?? 0;
		slotByFloor.set(floorAnchor, facilitySlot + 1);

		const slotWidth = isMedical ? MEDICAL_SLOT_WIDTH : population;
		const start = firstFitSlot(occupied, slotWidth);
		const slotIndices: number[] = [];
		for (let j = 0; j < slotWidth; j++) {
			const idx = start + j;
			while (slots.length <= idx) {
				slots.push(null);
				occupied.push(false);
			}
			occupied[idx] = true;
			slotIndices.push(idx);
			if (isMedical) {
				slots[idx] = null;
				continue;
			}
			const fresh = makeSim(
				floorAnchor,
				x,
				j,
				runtimeFamilyCode,
				population,
				facilitySlot,
			);
			const prior = previous.get(simKey(fresh));
			if (prior) {
				slots[idx] = {
					...fresh,
					...prior,
					floorAnchor,
					homeColumn: x,
					facilitySlot,
				};
			} else {
				fresh.tripCount = 0;
				fresh.accumulatedTicks = 0;
				slots[idx] = fresh;
			}
		}

		queue.push({ slotIndices, zeroOnFinalize: isMedical });
		if (queue.length > PLACEMENT_QUEUE_SIZE) {
			const oldest = queue.shift();
			if (oldest?.zeroOnFinalize) {
				for (const i of oldest.slotIndices) {
					occupied[i] = false;
					slots[i] = null;
				}
			}
		}
	}

	world.sims = slots.filter((s): s is SimRecord => s !== null);
}

export function cleanupSimsForRemovedTile(
	world: WorldState,
	anchorX: number,
	y: number,
): void {
	const floorAnchor = yToFloor(y);
	const removedIds = new Set<string>();

	world.sims = world.sims.filter((sim) => {
		if (sim.homeColumn !== anchorX || sim.floorAnchor !== floorAnchor) {
			return true;
		}
		clearSimRoute(sim);
		sim.destinationFloor = -1;
		removedIds.add(simKey(sim));
		return false;
	});

	if (removedIds.size === 0) return;

	for (const carrier of world.carriers) {
		clearCarrierSlotsForRemovedSims(carrier, removedIds);
	}
}

export function resetSimRuntimeState(world: WorldState): void {
	for (const sim of world.sims) {
		const object = findObjectForSim(world, sim);
		if (!object) continue;
		const clearsDailyStress =
			COMMERCIAL_FAMILIES.has(sim.familyCode) ||
			sim.familyCode === FAMILY_SECURITY ||
			sim.familyCode === FAMILY_HOUSEKEEPING ||
			sim.familyCode === FAMILY_CINEMA ||
			sim.familyCode === FAMILY_PARTY_HALL ||
			sim.familyCode === 0x21 ||
			sim.familyCode === FAMILY_CATHEDRAL_BASE;
		if (clearsDailyStress) {
			resetSimTripCounters(sim);
		}

		if (HOTEL_FAMILIES.has(sim.familyCode)) {
			// Binary 1228:0000 reset_sim_runtime_state, family 3/4/5 case:
			// if get_current_sim_state_word(sim) == 0 → stateCode = 0x24
			// (STATE_HOTEL_PARKED). Other branches (room+0xb gate → 0x20/0x10)
			// are left to the existing day-boundary state machine.
			if (sim.baseOffset === 0) {
				sim.stateCode = STATE_HOTEL_PARKED;
			}
			continue;
		} else if (sim.familyCode === FAMILY_CONDO) {
			// Condos persist across day boundaries via CHECKOUT_QUEUE→TRANSITION.
			continue;
		} else if (sim.familyCode === FAMILY_HOUSEKEEPING) {
			sim.stateCode = HK_STATE_SEARCH;
			sim.targetRoomFloor = -1;
			sim.spawnFloor = sim.floorAnchor;
			sim.postClaimCountdown = 0;
		} else if (
			sim.familyCode === FAMILY_OFFICE ||
			COMMERCIAL_FAMILIES.has(sim.familyCode)
		) {
			// Spec TIME.md checkpoint 2500: family 6/7/10/12 → 0x20 (MORNING_GATE).
			sim.stateCode = STATE_MORNING_GATE;
		} else if (
			sim.familyCode === FAMILY_RECYCLING_CENTER_UPPER ||
			sim.familyCode === FAMILY_SECURITY
		) {
			// Stationary sims keep their current state across day boundaries.
			continue;
		} else {
			sim.stateCode = STATE_PARKED;
		}

		sim.selectedFloor = sim.floorAnchor;
		sim.originFloor = sim.floorAnchor;
		sim.route = ROUTE_IDLE;
		// Phase 5b note: state_code bit cleanup is NOT done here. The reset
		// block above already wrote a fresh stateCode (MORNING_GATE / PARKED
		// / HK_SEARCH). In the TS encoding MORNING_GATE (0x20) overlaps with
		// the binary's "waiting" bit — stripping 0x20 here would corrupt the
		// post-reset phase byte. The explicit byte-write is the authoritative
		// source; the bit helpers are reserved for transitions that keep the
		// base phase constant (e.g. `finalizeRuntimeRouteState`).
		sim.destinationFloor = -1;
		sim.venueReturnState = 0;
		sim.queueTick = 0;
		sim.elapsedTicks = 0;
		sim.transitTicksRemaining = 0;
	}
}
