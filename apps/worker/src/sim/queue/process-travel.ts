// 1218:0351 process_unit_travel_queue
// 1218:0d4e assign_request_to_runtime_route
//
// Per-tick queue-drain + boarding pass. Called from the outer carrier-tick
// loop after `dispatch_carrier_car_arrivals`.

import { floorToSlot } from "../carriers/slot";
import {
	activeSlotLimitFor,
	addRouteSlot,
	findRouteById,
	hasActiveSlot,
	normalizeInactiveSlots,
	syncAssignmentStatus,
	syncPendingRouteIds,
} from "../carriers/sync";
import { recomputeCarTargetAndDirection } from "../carriers/target";
import { chooseTransferFloorFromCarrierReachability } from "../reachability/mask-tests";
import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_SUITE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import { setSimInTransit } from "../sim-access/state-bits";
import { accumulateElapsedDelayIntoCurrentSim } from "../stress/accumulate-elapsed";
import { addDelayToCurrentSim } from "../stress/add-delay";

const STATE_BIT_FAMILIES = new Set<number>([
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_HOTEL_SUITE,
	FAMILY_RESTAURANT,
	FAMILY_OFFICE,
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_RETAIL,
]);

import type { TimeState } from "../time";
import type {
	CarrierCar,
	CarrierFloorQueue,
	CarrierRecord,
	WorldState,
} from "../world";
import type { RouteRequestRing } from "./route-record";

const REQUEUE_FAILURE_DELAY = 0;

/**
 * Binary `assign_request_to_runtime_route` (1218:0d4e) invokes
 * `accumulate_elapsed_delay_into_current_sim` for the assigned sim,
 * which rebases `elapsed_packed` from the clock and applies the lobby
 * discount for the request source floor.
 *
 * Only non-service carriers (mode != 2) perform the rebase; service
 * carriers do not update sim stress.
 */
function applyAssignmentStressUpdate(
	world: WorldState,
	time: TimeState,
	carrier: CarrierRecord,
	routeId: string,
	sourceFloor: number,
): void {
	if (carrier.carrierMode === 2) return;
	const sim = world.sims.find(
		(candidate) =>
			`${candidate.floorAnchor}:${candidate.homeColumn}:${candidate.familyCode}:${candidate.baseOffset}` ===
			routeId,
	);
	if (!sim) return;
	accumulateElapsedDelayIntoCurrentSim(world, time, sim, sourceFloor);
}

function getScheduleIndex(time: TimeState): number {
	return time.weekendFlag * 7 + time.daypartIndex;
}

function getCarCapacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

function getQueueState(
	carrier: CarrierRecord,
	floor: number,
): CarrierFloorQueue | null {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0 || slot >= carrier.floorQueues.length) return null;
	return carrier.floorQueues[slot] ?? null;
}

function getDirectionQueue(
	queue: CarrierFloorQueue,
	directionFlag: number,
): RouteRequestRing {
	return directionFlag === 1 ? queue.up : queue.down;
}

function clearSimRouteById(world: WorldState, simId: string): void {
	for (const sim of world.sims) {
		const key = `${sim.floorAnchor}:${sim.homeColumn}:${sim.familyCode}:${sim.baseOffset}`;
		if (key !== simId) continue;
		sim.route = { mode: "idle" };
		// Phase 5b bit-sync: failed transfer-floor resolution returns the
		// sim to idle. We strip only the 0x40 in-transit bit — 0x20 overlaps
		// TS phase encodings (MORNING_GATE = 0x20 etc.) and stripping it
		// would corrupt the post-failure phase byte. Gated to
		// dispatch_sim_behavior families only.
		if (STATE_BIT_FAMILIES.has(sim.familyCode)) setSimInTransit(sim, false);
		return;
	}
}

/**
 * Binary `assign_request_to_runtime_route` (1218:0d4e). Moves a popped
 * request from the floor ring into one of the car's active-route slots.
 * Runs the transfer-floor resolver (so multi-hop routes pick the right
 * intermediate destination) and, on failure, applies
 * `g_requeue_failure_delay` (currently 0) and force-dispatches the sim
 * back through its family handler.
 */
export function assignRequestToRuntimeRoute(
	world: WorldState,
	time: TimeState,
	carrier: CarrierRecord,
	car: CarrierCar,
	route: CarrierRecord["pendingRoutes"][number],
	carIndex?: number,
): boolean {
	const resolvedFloor = chooseTransferFloorFromCarrierReachability(
		world,
		carrier.carrierId,
		car.currentFloor,
		route.destinationFloor,
	);
	if (resolvedFloor < 0) {
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(candidate) => candidate.simId !== route.simId,
		);
		// Binary assign_request_to_runtime_route: on transfer-floor failure,
		// adds g_requeue_failure_delay then calls force_dispatch_sim_state_by_family,
		// which re-runs the family handler so routing is retried next stride.
		const failedSim = world.sims.find(
			(s) =>
				`${s.floorAnchor}:${s.homeColumn}:${s.familyCode}:${s.baseOffset}` ===
				route.simId,
		);
		if (failedSim) addDelayToCurrentSim(failedSim, REQUEUE_FAILURE_DELAY);
		clearSimRouteById(world, route.simId);
		return false;
	}
	route.destinationFloor = resolvedFloor;
	// Binary 1218:0d4e: store_request_in_active_route_slot writes the request
	// into THIS car's slot table — there's no per-car-index check on the slot
	// itself. If the route was previously assigned to a different car (via
	// assign_car_to_floor_request), the slot ownership transfers to the actual
	// boarding car. Mirror that by reassigning here so `boardWaitingRoutes` can
	// fire on the next pass without being blocked by a stale carIndex.
	if (carIndex !== undefined) {
		route.assignedCarIndex = carIndex;
	}
	const stored = addRouteSlot(carrier, car, route);
	if (stored) {
		applyAssignmentStressUpdate(
			world,
			time,
			carrier,
			route.simId,
			route.sourceFloor,
		);
	}
	if (stored && carIndex !== undefined && car.dwellCounter === 0) {
		recomputeCarTargetAndDirection(carrier, car, carIndex);
	}
	return stored;
}

function drainFloorQueueForCar(
	world: WorldState,
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
	time: TimeState,
): void {
	// When schedule is disabled, car does not pick up passengers
	const scheduleIndex = getScheduleIndex(time);
	if ((carrier.serviceScheduleFlags[scheduleIndex] ?? 1) === 0) return;

	let remainingSlots = Math.max(0, getCarCapacity(carrier) - car.assignedCount);
	if (remainingSlots === 0) return;

	const floorQueueState = getQueueState(carrier, car.currentFloor);
	if (!floorQueueState) return;
	const floorQueue: CarrierFloorQueue = floorQueueState;

	// Binary 1218:0351 flip-during-dwell: when the car's current-direction
	// queue is empty, no routes are in-flight (pac==0), and no onboard riders
	// (ndc==0), check the opposite direction. If that queue has entries, flip
	// the car's direction flag and drain from the flipped direction.
	const qCurBuf = getDirectionQueue(floorQueue, car.directionFlag);
	if (
		qCurBuf.size === 0 &&
		car.pendingAssignmentCount === 0 &&
		car.nonemptyDestinationCount === 0
	) {
		const oppositeDirection = car.directionFlag === 1 ? 0 : 1;
		const qOppBuf = getDirectionQueue(floorQueue, oppositeDirection);
		if (qOppBuf.size !== 0) {
			car.directionFlag = oppositeDirection;
		}
	}

	// Binary 1218:0351: pop cap per direction is 1 unless dwellCounter == 1
	// exactly (then cap = remainingSlots).
	const popCap = car.dwellCounter === 1 ? remainingSlots : 1;

	function drainDirection(directionFlag: number): void {
		const buf = getDirectionQueue(floorQueue, directionFlag);
		const traceOn =
			(globalThis as { __DRAIN_TRACE__?: boolean }).__DRAIN_TRACE__ === true;
		if (traceOn) {
			const peek = buf.peekAll();
			console.log(
				`[drain] dt=${time.dayTick} car.fl=${car.currentFloor} dw=${car.dwellCounter} dir=${directionFlag} qLen=${buf.size} popCap=${popCap} remSlots=${remainingSlots} queue=[${peek
					.map((id: string) => {
						const r = findRouteById(carrier, id);
						return r
							? `${id}→${r.destinationFloor}(ci=${r.assignedCarIndex}${r.boarded ? "B" : ""})`
							: id;
					})
					.join(",")}]`,
			);
		}
		// Binary 1218:0351 drains the queue strictly FIFO via repeated
		// `pop_unit_queue_request` + `assign_request_to_runtime_route` calls.
		// Pops `queue_count` items from the head (capped at `remainingSlots`
		// when dc==1, else 1). Each pop processes whoever is at the head; if
		// assignment fails the binary calls `force_dispatch_sim_state_by_family`
		// which may re-enqueue at the tail. There is NO per-car-index filter
		// in the binary; pre-assignment via `primary_route_status_by_floor`
		// selects a single car at enqueue time and that car drains the queue.
		//
		// Earlier code built a filtered preview of the queue (skipping boarded
		// duplicates and routes assigned to other cars) and then called
		// `buf.pop()` once per filtered match. Because pop() always removes the
		// head, the pop and the assigned route diverged: a popped head that
		// did not match the filter was discarded but the matching route a few
		// positions deeper was assigned without being removed from the queue,
		// leaving a stale duplicate. Subsequent pulses then re-popped that
		// duplicate, creating a self-perpetuating set of stale entries that
		// caused trace-test divergence (e.g., sim 22 in build_dense_office at
		// day=0 tick=187 boarded car 1 instead of car 5).
		//
		// Strict-FIFO behavior matching the binary: pop from the head and
		// attempt `assign_request_to_runtime_route`. Cap on REAL assignment
		// attempts (mirroring the binary's `queue_count`); stale duplicates
		// are silently popped without consuming an attempt, since the binary
		// never produces them in the first place. Cleaning them up is just a
		// background side effect of the strict-FIFO drain.
		const maxAssignments = Math.min(popCap, remainingSlots);
		let assignmentAttempts = 0;
		while (assignmentAttempts < maxAssignments && buf.size > 0) {
			const routeId = buf.pop();
			if (routeId === undefined) break;
			const route = findRouteById(carrier, routeId);
			if (!route) continue;
			if (route.boarded || hasActiveSlot(car, route.simId)) {
				// Stale duplicate left over from a prior pulse — drop and keep
				// popping without consuming an assignment attempt.
				continue;
			}
			assignmentAttempts += 1;
			if (
				assignRequestToRuntimeRoute(world, time, carrier, car, route, carIndex)
			) {
				remainingSlots -= 1;
			}
		}
	}

	const primaryDirection = car.directionFlag;
	drainDirection(primaryDirection);

	// Binary: alternate-direction opportunistic drain when scheduleFlag != 0.
	if (car.scheduleFlag !== 0 && remainingSlots > 0) {
		const oppositeDirection = primaryDirection === 1 ? 0 : 1;
		drainDirection(oppositeDirection);
	}

	syncAssignmentStatus(carrier);
	if (car.dwellCounter === 0) {
		recomputeCarTargetAndDirection(carrier, car, carIndex);
	}
}

// Boarding-only half. Mirrors the per-slot board step inside
// process_unit_travel_queue (1218:0351) — moves riders from active-route
// slots (populated by drainFloorQueueForCar) onto the car. Stress
// accumulation belongs to `assignRequestToRuntimeRoute`, matching binary
// `assign_request_to_runtime_route` (1218:0d4e), not this board step.
function boardWaitingRoutes(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): boolean {
	let changed = false;
	const limit = activeSlotLimitFor(carrier);

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (car.assignedCount >= getCarCapacity(carrier)) break;
		if (!slot?.active || slot.boarded) continue;
		const route = findRouteById(carrier, slot.routeId);
		if (!route || route.boarded) continue;
		if (route.assignedCarIndex !== carIndex && route.assignedCarIndex !== -1)
			continue;
		if (route.sourceFloor !== car.currentFloor) continue;
		route.assignedCarIndex = carIndex;
		route.boarded = true;
		slot.boarded = true;
		car.assignedCount += 1;
		const destinationSlot = floorToSlot(carrier, route.destinationFloor);
		if (destinationSlot >= 0) {
			const prev = car.destinationCountByFloor[destinationSlot] ?? 0;
			car.destinationCountByFloor[destinationSlot] = prev + 1;
			if (prev === 0) car.nonemptyDestinationCount += 1;
		}
		changed = true;
	}

	if (changed) {
		normalizeInactiveSlots(car);
		syncPendingRouteIds(car);
		syncAssignmentStatus(carrier);
		if (car.dwellCounter === 0) {
			recomputeCarTargetAndDirection(carrier, car, carIndex);
		}
	}
	return changed;
}

/**
 * Binary `process_unit_travel_queue` (1218:0351). Pops riders from the
 * carrier's per-floor queue into this car's active-route slots, then
 * boards any slot whose source matches the current floor.
 *
 * Binary gates the queue pop on `(car[-0x5c] & 1) != 0` — only runs when
 * dwellCounter is odd. This creates the 1-tick lag between route enqueue
 * (at dwell=4) and boarding (at dwell=3).
 */
export function processUnitTravelQueue(
	world: WorldState,
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
	time: TimeState,
): void {
	if (!car.active) return;
	if ((car.dwellCounter & 1) !== 0) {
		drainFloorQueueForCar(world, carrier, car, carIndex, time);
	}
	boardWaitingRoutes(carrier, car, carIndex);
	if (
		car.dwellCounter === 1 &&
		time.dayCounter === 1 &&
		car.directionFlag === 0 &&
		car.currentFloor <= carrier.bottomServedFloor + 2 &&
		car.dwellStartPendingAssignmentCount > 0 &&
		car.pendingAssignmentCount === 0
	) {
		recomputeCarTargetAndDirection(carrier, car, carIndex);
	}
	if (
		car.dwellCounter === 3 &&
		time.dayCounter > 0 &&
		car.directionFlag === 0 &&
		car.currentFloor === carrier.bottomServedFloor &&
		car.targetFloor === car.currentFloor &&
		car.assignedCount === 0 &&
		car.dwellStartPendingAssignmentCount > 0 &&
		car.pendingAssignmentCount === 0
	) {
		recomputeCarTargetAndDirection(carrier, car, carIndex);
		drainFloorQueueForCar(world, carrier, car, carIndex, time);
		boardWaitingRoutes(carrier, car, carIndex);
	}
	if (
		car.dwellCounter === 0 &&
		car.settleCounter > 0 &&
		car.currentFloor === car.targetFloor
	) {
		recomputeCarTargetAndDirection(carrier, car, carIndex);
	}
	if (
		car.dwellCounter === 0 &&
		car.settleCounter > 0 &&
		car.assignedCount === 0 &&
		car.pendingAssignmentCount === 0 &&
		car.nonemptyDestinationCount === 0
	) {
		recomputeCarTargetAndDirection(carrier, car, carIndex);
	}
}
