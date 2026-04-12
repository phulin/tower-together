import { RingBuffer } from "./ring-buffer";
import { resolveTransferFloor } from "./routing";
import type { TimeState } from "./time";
import {
	type CarrierCar,
	type CarrierFloorQueue,
	type CarrierRecord,
	GRID_HEIGHT,
	type WorldState,
	yToFloor,
} from "./world";

/**
 * Optional callback invoked synchronously from inside the carrier tick when an
 * sim is unloaded at its destination. Mirrors the binary's
 * `dispatch_destination_queue_entries` path, which calls the family state
 * handler directly during the carrier tick instead of via a separate later
 * sweep over `completedRouteIds`.
 */
export type CarrierArrivalCallback = (
	routeId: string,
	arrivalFloor: number,
) => void;

const LOCAL_TICKS_PER_FLOOR = 8;
const EXPRESS_TICKS_PER_FLOOR = 4;
const DEPARTURE_SEQUENCE_TICKS = 5;
const QUEUE_CAPACITY = 40;
const ACTIVE_SLOT_CAPACITY = 42;

function getScheduleIndex(time: TimeState): number {
	return time.calendarPhaseFlag * 7 + time.daypartIndex;
}

function speedTicks(mode: 0 | 1 | 2): number {
	return mode === 2 ? EXPRESS_TICKS_PER_FLOOR : LOCAL_TICKS_PER_FLOOR;
}

function createFloorQueue(): CarrierFloorQueue {
	return {
		up: new RingBuffer<string>(QUEUE_CAPACITY, ""),
		down: new RingBuffer<string>(QUEUE_CAPACITY, ""),
	};
}

function getCarCapacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

function findRoute(carrier: CarrierRecord, routeId: string) {
	return carrier.pendingRoutes.find((route) => route.simId === routeId);
}

function getQueueState(carrier: CarrierRecord, floor: number) {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0 || slot >= carrier.floorQueues.length) return null;
	return carrier.floorQueues[slot] ?? null;
}

function getDirectionQueue(
	queue: CarrierFloorQueue,
	directionFlag: number,
): RingBuffer<string> {
	return directionFlag === 0 ? queue.up : queue.down;
}

function activeSlotLimit(carrier: CarrierRecord): number {
	return Math.min(ACTIVE_SLOT_CAPACITY, carrier.assignmentCapacity);
}

function syncPendingRouteIds(car: CarrierCar): void {
	car.pendingRouteIds = car.activeRouteSlots
		.filter((slot) => slot.active)
		.map((slot) => slot.routeId);
}

function syncRouteSlots(carrier: CarrierRecord, car: CarrierCar): void {
	car.activeRouteSlots = car.activeRouteSlots.filter((slot) => {
		if (!slot.active) return false;
		const route = findRoute(carrier, slot.routeId);
		if (!route) return false;
		slot.sourceFloor = route.sourceFloor;
		slot.destinationFloor = route.destinationFloor;
		slot.boarded = route.boarded;
		return true;
	});
	while (car.activeRouteSlots.length < ACTIVE_SLOT_CAPACITY) {
		car.activeRouteSlots.push({
			routeId: "",
			sourceFloor: 0xff,
			destinationFloor: 0xff,
			boarded: false,
			active: false,
		});
	}
	syncPendingRouteIds(car);
}

function hasActiveSlot(car: CarrierCar, routeId: string): boolean {
	return car.activeRouteSlots.some(
		(slot) => slot.active && slot.routeId === routeId,
	);
}

function addRouteSlot(
	carrier: CarrierRecord,
	car: CarrierCar,
	route: CarrierRecord["pendingRoutes"][number],
): boolean {
	if (hasActiveSlot(car, route.simId)) return true;
	const limit = activeSlotLimit(carrier);
	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot || slot.active) continue;
		slot.routeId = route.simId;
		slot.sourceFloor = route.sourceFloor;
		slot.destinationFloor = route.destinationFloor;
		slot.boarded = route.boarded;
		slot.active = true;
		syncPendingRouteIds(car);
		return true;
	}
	return false;
}

function resetCarToHome(carrier: CarrierRecord, car: CarrierCar): void {
	const homeFloor = Math.min(
		carrier.topServedFloor,
		Math.max(carrier.bottomServedFloor, car.homeFloor),
	);
	car.currentFloor = homeFloor;
	car.targetFloor = homeFloor;
	car.prevFloor = homeFloor;
	car.speedCounter = 0;
	car.doorWaitCounter = 0;
	car.assignedCount = 0;
	car.pendingAssignmentCount = 0;
	car.departureFlag = 0;
	car.destinationCountByFloor.fill(0);
	car.nonemptyDestinationCount = 0;
	for (const slot of car.activeRouteSlots) {
		slot.routeId = "";
		slot.sourceFloor = 0xff;
		slot.destinationFloor = 0xff;
		slot.boarded = false;
		slot.active = false;
	}
	car.pendingRouteIds = [];
}

function computeCarMotionMode(
	carrier: CarrierRecord,
	car: CarrierCar,
): 0 | 1 | 2 | 3 {
	const distToTarget = Math.abs(car.currentFloor - car.targetFloor);
	const distFromPrev = Math.abs(car.currentFloor - car.prevFloor);
	// First leg: prevFloor === currentFloor, car needs to depart
	const firstLeg = distFromPrev === 0 && distToTarget > 0;

	// Express carriers (mode 0): stop within 2 floors, +/-3 when both > 4, +/-1 otherwise
	if (carrier.carrierMode === 0) {
		if (firstLeg) return distToTarget > 4 ? 3 : 2;
		if (distToTarget < 2 || distFromPrev < 2) return 0;
		if (distToTarget > 4 && distFromPrev > 4) return 3;
		return 2;
	}

	// Standard (1) and Service (2): stop within 2 floors, slow-stop within 4, +/-1 otherwise
	if (firstLeg) return 2;
	if (distToTarget < 2 || distFromPrev < 2) return 0;
	if (distToTarget < 4 || distFromPrev < 4) return 1;
	return 2;
}

function advanceCarPositionOneStep(
	carrier: CarrierRecord,
	car: CarrierCar,
): void {
	const motionMode = computeCarMotionMode(carrier, car);
	if (motionMode === 0) {
		car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
		return;
	}
	if (motionMode === 1) {
		car.doorWaitCounter = 2;
		return;
	}

	const stepSize = motionMode === 3 ? 3 : 1;
	const direction = car.targetFloor > car.currentFloor ? 1 : -1;
	const nextFloor = car.currentFloor + direction * stepSize;
	if (direction > 0) {
		car.currentFloor = Math.min(nextFloor, car.targetFloor);
	} else {
		car.currentFloor = Math.max(nextFloor, car.targetFloor);
	}
}

export function floorToSlot(carrier: CarrierRecord, floor: number): number {
	if (floor < carrier.bottomServedFloor || floor > carrier.topServedFloor) {
		return -1;
	}
	if (carrier.carrierMode === 0) {
		const rel = floor - carrier.bottomServedFloor;
		if (rel >= 0 && rel < 10) return rel;
		// Lobbies: floor IDs 10, 25, 40, 55, 70, 85, 100 → slots 10+
		if (floor >= 10 && (floor - 10) % 15 === 0) return (floor - 10) / 15 + 10;
		return -1;
	}
	return floor - carrier.bottomServedFloor;
}

export function carrierServesFloor(
	carrier: CarrierRecord,
	floor: number,
): boolean {
	return floorToSlot(carrier, floor) >= 0;
}

function makeCarrierCar(numSlots: number, homeFloor: number): CarrierCar {
	return {
		active: true,
		currentFloor: homeFloor,
		doorWaitCounter: 0,
		speedCounter: 0,
		assignedCount: 0,
		pendingAssignmentCount: 0,
		directionFlag: 0,
		targetFloor: homeFloor,
		prevFloor: homeFloor,
		homeFloor,
		departureFlag: 0,
		departureTimestamp: 0,
		scheduleFlag: 0,
		waitingCount: new Array(numSlots).fill(0),
		destinationCountByFloor: new Array(numSlots).fill(0),
		nonemptyDestinationCount: 0,
		activeRouteSlots: Array.from({ length: ACTIVE_SLOT_CAPACITY }, () => ({
			routeId: "",
			sourceFloor: 0xff,
			destinationFloor: 0xff,
			boarded: false,
			active: false,
		})),
		pendingRouteIds: [],
	};
}

export function makeCarrier(
	id: number,
	col: number,
	mode: 0 | 1 | 2,
	bottom: number,
	top: number,
	numCars = 1,
): CarrierRecord {
	const numSlots = top - bottom + 1;
	const clampedCars = Math.max(1, Math.min(8, numCars));
	const span = Math.max(0, top - bottom);
	const cars = Array.from({ length: clampedCars }, (_, index) => {
		const homeFloor =
			clampedCars === 1
				? bottom
				: bottom + Math.floor((span * index) / (clampedCars - 1));
		return makeCarrierCar(numSlots, Math.min(top, homeFloor));
	});

	return {
		carrierId: id,
		column: col,
		carrierMode: mode,
		topServedFloor: top,
		bottomServedFloor: bottom,
		servedFloorFlags: new Array(14).fill(1),
		primaryRouteStatusByFloor: new Array(numSlots).fill(0),
		secondaryRouteStatusByFloor: new Array(numSlots).fill(0),
		serviceScheduleFlags: new Array(14).fill(1),
		dwellMultiplierFlags: new Array(14).fill(1),
		expressDirectionFlags: new Array(14).fill(0),
		waitingCarResponseThreshold: 4,
		assignmentCapacity: mode === 0 ? 0x2a : 0x15,
		floorQueues: Array.from({ length: numSlots }, () => createFloorQueue()),
		pendingRoutes: [],
		completedRouteIds: [],
		cars,
	};
}

function syncWaitingCount(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): void {
	car.waitingCount.fill(0);
	car.destinationCountByFloor.fill(0);
	car.nonemptyDestinationCount = 0;

	for (let slot = 0; slot < carrier.floorQueues.length; slot++) {
		const queue = carrier.floorQueues[slot];
		if (!queue) continue;
		car.waitingCount[slot] = queue.up.size + queue.down.size;
	}

	const limit = activeSlotLimit(carrier);
	for (let index = 0; index < limit; index++) {
		const slotRef = car.activeRouteSlots[index];
		if (!slotRef?.active || !slotRef.boarded) continue;
		const slot = floorToSlot(carrier, slotRef.destinationFloor);
		if (slot < 0 || slot >= car.destinationCountByFloor.length) continue;
		const prev = car.destinationCountByFloor[slot] ?? 0;
		car.destinationCountByFloor[slot] = prev + 1;
		if (prev === 0) car.nonemptyDestinationCount += 1;
	}

	for (const route of carrier.pendingRoutes) {
		if (!route.boarded || route.assignedCarIndex !== carIndex) continue;
		const slot = floorToSlot(carrier, route.destinationFloor);
		if (slot < 0 || slot >= car.destinationCountByFloor.length) continue;
		const prev = car.destinationCountByFloor[slot] ?? 0;
		if (prev === 0) car.nonemptyDestinationCount += 1;
		car.destinationCountByFloor[slot] = prev + 1;
	}
}

function syncAssignmentStatus(carrier: CarrierRecord): void {
	carrier.primaryRouteStatusByFloor.fill(0);
	carrier.secondaryRouteStatusByFloor.fill(0);

	for (const car of carrier.cars) {
		car.pendingAssignmentCount = 0;
	}

	for (const [carIndex, car] of carrier.cars.entries()) {
		syncRouteSlots(carrier, car);
		syncWaitingCount(carrier, car, carIndex);
	}

	for (let slot = 0; slot < carrier.primaryRouteStatusByFloor.length; slot++) {
		const queue = carrier.floorQueues[slot];
		if (!queue) continue;
		if (queue.up.isFull) {
			carrier.primaryRouteStatusByFloor[slot] = 0x28;
		}
		if (queue.down.isFull) {
			carrier.secondaryRouteStatusByFloor[slot] = 0x28;
		}
	}

	for (const route of carrier.pendingRoutes) {
		if (route.boarded || route.assignedCarIndex < 0) continue;
		const slot = floorToSlot(carrier, route.sourceFloor);
		if (slot < 0) continue;
		const table =
			route.directionFlag === 0
				? carrier.primaryRouteStatusByFloor
				: carrier.secondaryRouteStatusByFloor;
		if (table[slot] === 0x28) continue;
		table[slot] = route.assignedCarIndex + 1;
		const assignedCar = carrier.cars[route.assignedCarIndex];
		if (assignedCar) assignedCar.pendingAssignmentCount += 1;
	}
}

function pendingTargetsInDirection(
	carrier: CarrierRecord,
	car: CarrierCar,
	directionFlag: number,
): boolean {
	const limit = activeSlotLimit(carrier);
	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot?.active) continue;
		const floor = slot.boarded ? slot.destinationFloor : slot.sourceFloor;
		if (
			directionFlag === 0
				? floor >= car.currentFloor
				: floor <= car.currentFloor
		) {
			return true;
		}
	}
	return false;
}

function findBestAvailableCarForFloor(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): number {
	let bestIdleHomeCost = Number.POSITIVE_INFINITY;
	let bestIdleHomeIndex = -1;
	let bestForwardCost = Number.POSITIVE_INFINITY;
	let bestForwardIndex = -1;
	let bestWrapCost = Number.POSITIVE_INFINITY;
	let bestWrapIndex = -1;

	for (const [carIndex, car] of carrier.cars.entries()) {
		if (!car.active) continue;
		if (car.assignedCount >= getCarCapacity(carrier)) continue;

		// Immediate early-accept: car at floor with doors closed and either
		// schedule byte nonzero or direction already matches
		if (
			car.currentFloor === floor &&
			car.doorWaitCounter === 0 &&
			(car.scheduleFlag !== 0 || car.directionFlag === directionFlag)
		) {
			return carIndex;
		}

		const distance = Math.abs(car.currentFloor - floor);

		// Idle-home candidate: at home, no assignments, doors closed
		const isIdleHome =
			car.pendingAssignmentCount === 0 &&
			car.nonemptyDestinationCount === 0 &&
			car.doorWaitCounter === 0 &&
			car.currentFloor === car.homeFloor;

		if (isIdleHome) {
			const cost = distance;
			if (cost < bestIdleHomeCost) {
				bestIdleHomeCost = cost;
				bestIdleHomeIndex = carIndex;
			}
		}

		// Same-direction forward candidate: moving in requested direction
		// and request lies ahead
		const isSameDirectionForward =
			car.directionFlag === directionFlag &&
			(directionFlag === 0
				? floor > car.currentFloor
				: floor < car.currentFloor);

		if (isSameDirectionForward) {
			const cost =
				directionFlag === 0
					? floor - car.currentFloor
					: car.currentFloor - floor;
			if (cost < bestForwardCost) {
				bestForwardCost = cost;
				bestForwardIndex = carIndex;
			}
		} else {
			// Wrap/reversal candidate
			let cost: number;
			if (car.directionFlag === directionFlag) {
				// Same direction but request is behind the sweep
				if (directionFlag === 0) {
					cost = car.targetFloor - car.currentFloor + (car.targetFloor - floor);
				} else {
					cost = car.currentFloor - car.targetFloor + (floor - car.targetFloor);
				}
			} else {
				// Opposite direction: distance via next turn floor
				if (directionFlag === 0) {
					// Request is upward, car is going down
					const turnFloor = car.targetFloor;
					if (floor <= car.currentFloor) {
						cost = Math.abs(car.currentFloor - floor);
					} else {
						cost = car.currentFloor - turnFloor + (floor - turnFloor);
					}
				} else {
					// Request is downward, car is going up
					const turnFloor = car.targetFloor;
					if (floor >= car.currentFloor) {
						cost = Math.abs(floor - car.currentFloor);
					} else {
						cost = turnFloor - car.currentFloor + (turnFloor - floor);
					}
				}
			}
			if (cost < bestWrapCost) {
				bestWrapCost = cost;
				bestWrapIndex = carIndex;
			}
		}
	}

	// Select best moving candidate: prefer forward over wrap/reversal
	let bestMovingCost: number;
	let bestMovingIndex: number;
	if (bestForwardIndex >= 0) {
		bestMovingCost = bestForwardCost;
		bestMovingIndex = bestForwardIndex;
	} else {
		bestMovingCost = bestWrapCost;
		bestMovingIndex = bestWrapIndex;
	}

	// Threshold tie-break between moving and idle-home
	if (bestIdleHomeIndex >= 0 && bestMovingIndex >= 0) {
		if (
			bestMovingCost - bestIdleHomeCost <
			carrier.waitingCarResponseThreshold
		) {
			return bestMovingIndex;
		}
		return bestIdleHomeIndex;
	}
	if (bestIdleHomeIndex >= 0) return bestIdleHomeIndex;
	if (bestMovingIndex >= 0) return bestMovingIndex;

	// Degenerate fallback: write car index 0 (binary quirk)
	return 0;
}

function clearSimRouteById(world: WorldState, simId: string): void {
	for (const sim of world.sims) {
		const key = `${sim.floorAnchor}:${sim.homeColumn}:${sim.familyCode}:${sim.baseOffset}`;
		if (key !== simId) continue;
		sim.route = { mode: "idle" };
		sim.routeRetryDelay = 0;
		return;
	}
}

function clearStaleFloorAssignments(
	carrier: CarrierRecord,
	floor: number,
	carIndex: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;
	if (carrier.primaryRouteStatusByFloor[slot] === carIndex + 1) {
		carrier.primaryRouteStatusByFloor[slot] = 0;
	}
	if (carrier.secondaryRouteStatusByFloor[slot] === carIndex + 1) {
		carrier.secondaryRouteStatusByFloor[slot] = 0;
	}
}

function assignCarToFloorRequest(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): void {
	const slot = floorToSlot(carrier, floor);
	if (slot < 0) return;
	const table =
		directionFlag === 0
			? carrier.primaryRouteStatusByFloor
			: carrier.secondaryRouteStatusByFloor;

	// If a car is already assigned, reuse it for any new unassigned routes.
	// Only search for the best car when no assignment exists yet.
	let carIndex: number;
	const existing = table[slot] ?? 0;
	if (existing > 0 && existing !== 0x28) {
		carIndex = existing - 1;
	} else if (existing === 0x28) {
		return; // queue-full sentinel — skip
	} else {
		carIndex = findBestAvailableCarForFloor(carrier, floor, directionFlag);
		if (carIndex < 0) return;
	}

	for (const route of carrier.pendingRoutes) {
		if (route.boarded) continue;
		if (route.sourceFloor !== floor || route.directionFlag !== directionFlag)
			continue;
		if (route.assignedCarIndex >= 0) continue; // already assigned
		route.assignedCarIndex = carIndex;
	}
	syncAssignmentStatus(carrier);
}

function assignPendingFloorRequests(carrier: CarrierRecord): void {
	for (let slot = 0; slot < carrier.floorQueues.length; slot++) {
		const floor = carrier.bottomServedFloor + slot;
		const queue = carrier.floorQueues[slot];
		if (!queue) continue;
		if (!queue.up.isEmpty) assignCarToFloorRequest(carrier, floor, 0);
		if (!queue.down.isEmpty) assignCarToFloorRequest(carrier, floor, 1);
	}
}

function processUnitTravelQueue(
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

	const floorQueue = getQueueState(carrier, car.currentFloor);

	function drainDirection(directionFlag: number): void {
		if (!floorQueue) return;
		const buf = getDirectionQueue(floorQueue, directionFlag);
		const assignedRoutes = buf
			.peekAll()
			.map((routeId) => findRoute(carrier, routeId))
			.filter(
				(route): route is NonNullable<typeof route> =>
					route !== undefined &&
					!route.boarded &&
					route.assignedCarIndex === carIndex &&
					!hasActiveSlot(car, route.simId),
			);
		for (const route of assignedRoutes.slice(0, remainingSlots)) {
			buf.pop();
			const resolvedFloor = resolveTransferFloor(
				world,
				carrier.carrierId,
				car.currentFloor,
				route.destinationFloor,
			);
			if (resolvedFloor < 0) {
				carrier.pendingRoutes = carrier.pendingRoutes.filter(
					(candidate) => candidate.simId !== route.simId,
				);
				clearSimRouteById(world, route.simId);
				continue;
			}
			route.destinationFloor = resolvedFloor;
			if (addRouteSlot(carrier, car, route)) remainingSlots -= 1;
		}
	}

	let primaryDirection = car.directionFlag;
	drainDirection(primaryDirection);

	if (
		remainingSlots > 0 &&
		!pendingTargetsInDirection(carrier, car, primaryDirection)
	) {
		primaryDirection = primaryDirection === 0 ? 1 : 0;
		car.directionFlag = primaryDirection;
		drainDirection(primaryDirection);
	}

	// Gate alternate-direction drain on expressDirectionFlags:
	// 0 = normal (both), 1 = express-to-top (up only), 2 = express-to-bottom (down only)
	const expressDir = carrier.expressDirectionFlags[getScheduleIndex(time)] ?? 0;
	const allowAlternate =
		expressDir === 0 ||
		(expressDir === 1 && primaryDirection === 0) ||
		(expressDir === 2 && primaryDirection === 1);

	if (remainingSlots > 0 && allowAlternate) {
		drainDirection(primaryDirection === 0 ? 1 : 0);
	}

	syncAssignmentStatus(carrier);
}

function selectNextTarget(
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	expressDirectionFlag: number,
): number {
	// No pending work: return to home floor
	if (car.pendingAssignmentCount === 0 && car.nonemptyDestinationCount === 0) {
		return car.homeFloor;
	}

	// Build target set from active route slots and floor-assignment tables
	const targetSet = new Set<number>();
	const limit = activeSlotLimit(carrier);

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot?.active) continue;
		targetSet.add(slot.boarded ? slot.destinationFloor : slot.sourceFloor);
	}

	for (
		let floor = carrier.bottomServedFloor;
		floor <= carrier.topServedFloor;
		floor++
	) {
		const slot = floorToSlot(carrier, floor);
		if (slot < 0) continue;
		if ((car.destinationCountByFloor[slot] ?? 0) > 0) targetSet.add(floor);
		if (
			carrier.primaryRouteStatusByFloor[slot] === carIndex + 1 ||
			carrier.secondaryRouteStatusByFloor[slot] === carIndex + 1
		) {
			targetSet.add(floor);
		}
	}

	// Express-direction-dependent scanning
	if (expressDirectionFlag === 1) {
		// Express up: scan downward for assignments, fallback = top_served_floor
		for (
			let floor = car.currentFloor - 1;
			floor >= carrier.bottomServedFloor;
			floor--
		) {
			if (targetSet.has(floor)) return floor;
		}
		return carrier.topServedFloor;
	}

	if (expressDirectionFlag === 2) {
		// Express down: scan upward for assignments, fallback = bottom_served_floor
		for (
			let floor = car.currentFloor + 1;
			floor <= carrier.topServedFloor;
			floor++
		) {
			if (targetSet.has(floor)) return floor;
		}
		return carrier.bottomServedFloor;
	}

	// Normal: bidirectional sweep in current direction, wrap at endpoints
	const dir = car.directionFlag === 0 ? 1 : -1;
	for (
		let floor = car.currentFloor + dir;
		floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
		floor += dir
	) {
		if (targetSet.has(floor)) return floor;
	}

	// Wrap: reverse direction and scan from opposite endpoint back
	for (
		let floor = car.currentFloor - dir;
		floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
		floor -= dir
	) {
		if (targetSet.has(floor)) return floor;
	}

	// No target found
	return -1;
}

function loadScheduleFlag(
	carrier: CarrierRecord,
	car: CarrierCar,
	time: TimeState,
): void {
	if (
		car.currentFloor !== carrier.bottomServedFloor &&
		car.currentFloor !== carrier.topServedFloor
	) {
		return;
	}
	car.scheduleFlag = carrier.dwellMultiplierFlags[getScheduleIndex(time)] ?? 1;
}

function shouldCarDepart(
	carrier: CarrierRecord,
	car: CarrierCar,
	time: TimeState,
): boolean {
	if (car.assignedCount >= getCarCapacity(carrier)) return true;
	const scheduleIndex = getScheduleIndex(time);
	if ((carrier.serviceScheduleFlags[scheduleIndex] ?? 1) === 0) {
		return true;
	}
	return (
		Math.abs(time.dayTick - car.departureTimestamp) > car.scheduleFlag * 30
	);
}

function boardAndUnloadRoutes(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
	onArrival?: CarrierArrivalCallback,
): boolean {
	let changed = false;
	const limit = activeSlotLimit(carrier);
	const arrivals: Array<{ routeId: string; floor: number }> = [];

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot?.active || !slot.boarded) continue;
		if (slot.destinationFloor !== car.currentFloor) continue;
		const arrivedRouteId = slot.routeId;
		const arrivedFloor = slot.destinationFloor;
		car.assignedCount = Math.max(0, car.assignedCount - 1);
		const destinationSlot = floorToSlot(carrier, slot.destinationFloor);
		if (destinationSlot >= 0) {
			const prev = car.destinationCountByFloor[destinationSlot] ?? 0;
			car.destinationCountByFloor[destinationSlot] = Math.max(0, prev - 1);
			if (prev === 1) {
				car.nonemptyDestinationCount = Math.max(
					0,
					car.nonemptyDestinationCount - 1,
				);
			}
		}
		slot.active = false;
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(candidate) => candidate.simId !== arrivedRouteId,
		);
		if (!carrier.completedRouteIds.includes(arrivedRouteId)) {
			carrier.completedRouteIds.push(arrivedRouteId);
		}
		arrivals.push({ routeId: arrivedRouteId, floor: arrivedFloor });
		changed = true;
	}

	if (onArrival) {
		for (const arrival of arrivals) {
			onArrival(arrival.routeId, arrival.floor);
		}
	}

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (car.assignedCount >= getCarCapacity(carrier)) break;
		if (!slot?.active || slot.boarded) continue;
		const route = findRoute(carrier, slot.routeId);
		if (!route || route.boarded) continue;
		if (route.assignedCarIndex !== carIndex) continue;
		if (route.sourceFloor !== car.currentFloor) continue;
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
		for (const slot of car.activeRouteSlots) {
			if (!slot.active) {
				slot.routeId = "";
				slot.sourceFloor = 0xff;
				slot.destinationFloor = 0xff;
				slot.boarded = false;
			}
		}
		syncPendingRouteIds(car);
		syncAssignmentStatus(carrier);
	}
	return changed;
}

function stepCarrierCar(
	world: WorldState,
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	time: TimeState,
	onArrival?: CarrierArrivalCallback,
): void {
	if (!car.active) return;

	if (
		car.currentFloor < carrier.bottomServedFloor ||
		car.currentFloor > carrier.topServedFloor
	) {
		resetCarToHome(carrier, car);
		return;
	}

	if (car.doorWaitCounter > 0) {
		if (computeCarMotionMode(carrier, car) === 0) car.doorWaitCounter--;
		else car.doorWaitCounter = 0;
		return;
	}

	if (car.speedCounter > 0) {
		car.speedCounter--;
		if (car.speedCounter === 0) {
			car.prevFloor = car.currentFloor;
			advanceCarPositionOneStep(carrier, car);
			if (car.currentFloor === car.targetFloor) {
				if (car.doorWaitCounter === 0)
					car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
				car.departureFlag = 0;
			}
			if (car.doorWaitCounter === 0 && car.currentFloor !== car.targetFloor) {
				car.speedCounter = speedTicks(carrier.carrierMode);
			}
		}
		return;
	}

	processUnitTravelQueue(world, carrier, car, carIndex, time);
	if (boardAndUnloadRoutes(carrier, car, carIndex, onArrival)) {
		car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
		return;
	}

	loadScheduleFlag(carrier, car, time);
	const next = selectNextTarget(
		car,
		carrier,
		carIndex,
		carrier.expressDirectionFlags[getScheduleIndex(time)] ?? 0,
	);

	if (next < 0 || next === car.currentFloor) {
		// At target floor with no further targets: check if passengers waiting
		const currentSlot = floorToSlot(carrier, car.currentFloor);
		const waitingHere =
			currentSlot >= 0 ? (car.waitingCount[currentSlot] ?? 0) > 0 : false;
		if (waitingHere) {
			// Passengers waiting: begin departure/boarding sequence
			clearStaleFloorAssignments(carrier, car.currentFloor, carIndex);
			car.speedCounter = DEPARTURE_SEQUENCE_TICKS;
			if (car.departureFlag === 0) car.departureTimestamp = time.dayTick;
			car.departureFlag = 1;
			return;
		}
		// Car has boarded passengers and should depart
		if (car.assignedCount > 0 && shouldCarDepart(carrier, car, time)) {
			car.speedCounter = 1;
		}
		return;
	}

	// Move toward next target
	car.targetFloor = next;
	car.directionFlag = next > car.currentFloor ? 0 : 1;
	// Clear stale assignments at current floor before departing
	clearStaleFloorAssignments(carrier, car.currentFloor, carIndex);
	car.speedCounter = DEPARTURE_SEQUENCE_TICKS;
	if (car.departureFlag === 0) car.departureTimestamp = time.dayTick;
	car.departureFlag = 1;
}

export function tickAllCarriers(
	world: WorldState,
	time: TimeState,
	onArrival?: CarrierArrivalCallback,
): void {
	for (const carrier of world.carriers) {
		carrier.completedRouteIds = [];
		assignPendingFloorRequests(carrier);
		syncAssignmentStatus(carrier);
		for (const [carIndex, car] of carrier.cars.entries()) {
			stepCarrierCar(world, car, carrier, carIndex, time, onArrival);
		}
	}
}

/**
 * End-of-day carrier flush (checkpoint 0x9f6).
 * Drains all floor queues, clears pending routes, and resets every car to its
 * home floor. This prevents stale overnight passengers.
 */
export function flushCarriersEndOfDay(world: WorldState): void {
	for (const carrier of world.carriers) {
		// Drain floor queues
		for (const queue of carrier.floorQueues.values()) {
			queue.up.head = 0;
			queue.up.count = 0;
			queue.down.head = 0;
			queue.down.count = 0;
		}

		// Clear pending and completed route tracking
		carrier.pendingRoutes = [];
		carrier.completedRouteIds = [];

		// Reset every car to home floor
		for (const car of carrier.cars) {
			resetCarToHome(carrier, car);
		}
	}
}

export function rebuildCarrierList(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();
	const overlayKeys = new Set<string>([
		...Object.keys(world.overlays),
		...Object.keys(world.overlayToAnchor),
	]);

	for (const key of overlayKeys) {
		const anchorKey = world.overlayToAnchor[key] ?? key;
		const type = world.overlays[anchorKey];
		let mode: 0 | 1 | 2;
		if (type === "elevator") mode = 1;
		else if (type === "elevatorExpress") mode = 0;
		else if (type === "elevatorService") mode = 2;
		else continue;

		const [anchorXStr] = anchorKey.split(",");
		const [, yStr] = key.split(",");
		const x = Number(anchorXStr);
		const y = Number(yStr);
		const floor = yToFloor(y);

		if (!columns.has(x)) columns.set(x, { floors: new Set(), mode });
		columns.get(x)?.floors.add(floor);
	}

	const newCarriers: CarrierRecord[] = [];
	let id = 0;

	for (const [col, { floors, mode }] of columns) {
		const sorted = [...floors].sort((a, b) => a - b);
		const bottom = sorted[0];
		const top = sorted[sorted.length - 1];
		const numSlots = top - bottom + 1;

		const existing = world.carriers.find((carrier) => carrier.column === col);
		if (existing) {
			existing.carrierId = id++;
			existing.carrierMode = mode;
			existing.topServedFloor = top;
			existing.bottomServedFloor = bottom;
			existing.waitingCarResponseThreshold ??= 4;
			existing.assignmentCapacity ??= mode === 0 ? 0x2a : 0x15;
			if (existing.servedFloorFlags.length !== 14) {
				existing.servedFloorFlags = new Array(14).fill(1);
			}
			if (existing.serviceScheduleFlags.length !== 14) {
				existing.serviceScheduleFlags = new Array(14).fill(1);
			}
			if (
				!Array.isArray(existing.dwellMultiplierFlags) ||
				existing.dwellMultiplierFlags.length !== 14
			) {
				existing.dwellMultiplierFlags = new Array(14).fill(1);
			}
			if (
				!Array.isArray(existing.expressDirectionFlags) ||
				existing.expressDirectionFlags.length !== 14
			) {
				existing.expressDirectionFlags = new Array(14).fill(0);
			}
			existing.completedRouteIds ??= [];
			if (existing.primaryRouteStatusByFloor.length !== numSlots) {
				existing.primaryRouteStatusByFloor = new Array(numSlots).fill(0);
				existing.secondaryRouteStatusByFloor = new Array(numSlots).fill(0);
			}
			if (existing.floorQueues.length !== numSlots) {
				existing.floorQueues = Array.from({ length: numSlots }, () =>
					createFloorQueue(),
				);
			}
			for (const car of existing.cars) {
				if (car.waitingCount.length !== numSlots) {
					car.waitingCount = new Array(numSlots).fill(0);
				}
				if (car.destinationCountByFloor.length !== numSlots) {
					car.destinationCountByFloor = new Array(numSlots).fill(0);
				}
				car.nonemptyDestinationCount ??= 0;
				car.activeRouteSlots ??= Array.from(
					{ length: ACTIVE_SLOT_CAPACITY },
					() => ({
						routeId: "",
						sourceFloor: 0xff,
						destinationFloor: 0xff,
						boarded: false,
						active: false,
					}),
				);
				car.homeFloor = Math.min(top, Math.max(bottom, car.homeFloor));
				if (car.currentFloor < bottom || car.currentFloor > top) {
					resetCarToHome(existing, car);
				}
				syncRouteSlots(existing, car);
			}
			newCarriers.push(existing);
		} else {
			newCarriers.push(makeCarrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = newCarriers;
	for (const carrier of world.carriers) {
		syncAssignmentStatus(carrier);
	}
}

export function initCarrierState(world: WorldState): void {
	world.carriers ??= [];
	world.floorWalkabilityFlags ??= new Array(GRID_HEIGHT).fill(0);
	world.transferGroupCache ??= new Array(GRID_HEIGHT).fill(0);
}

export function enqueueCarrierRoute(
	carrier: CarrierRecord,
	simId: string,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
): boolean {
	if (carrier.pendingRoutes.some((route) => route.simId === simId)) return true;
	const floorQueue = getQueueState(carrier, sourceFloor);
	if (
		!floorQueue ||
		!getDirectionQueue(floorQueue, directionFlag).push(simId)
	) {
		const slot = floorToSlot(carrier, sourceFloor);
		if (slot >= 0) {
			const table =
				directionFlag === 0
					? carrier.primaryRouteStatusByFloor
					: carrier.secondaryRouteStatusByFloor;
			table[slot] = 0x28;
		}
		return false;
	}
	const route = {
		simId,
		sourceFloor,
		destinationFloor,
		boarded: false,
		directionFlag,
		assignedCarIndex: -1,
	};
	carrier.pendingRoutes.push(route);
	assignPendingFloorRequests(carrier);
	syncAssignmentStatus(carrier);
	return true;
}
