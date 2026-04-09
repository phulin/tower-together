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
 * entity is unloaded at its destination. Mirrors the binary's
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

function get_schedule_index(time: TimeState): number {
	return time.calendarPhaseFlag * 7 + time.daypartIndex;
}

function speed_ticks(mode: 0 | 1 | 2): number {
	return mode === 2 ? EXPRESS_TICKS_PER_FLOOR : LOCAL_TICKS_PER_FLOOR;
}

function create_floor_queue(): CarrierFloorQueue {
	return {
		upCount: 0,
		upHeadIndex: 0,
		downCount: 0,
		downHeadIndex: 0,
		upQueueRouteIds: new Array(QUEUE_CAPACITY).fill(""),
		downQueueRouteIds: new Array(QUEUE_CAPACITY).fill(""),
	};
}

function get_car_capacity(carrier: CarrierRecord): number {
	return carrier.assignmentCapacity;
}

function find_route(carrier: CarrierRecord, routeId: string) {
	return carrier.pendingRoutes.find((route) => route.entityId === routeId);
}

function get_queue_state(carrier: CarrierRecord, floor: number) {
	const slot = floor_to_slot(carrier, floor);
	if (slot < 0 || slot >= carrier.floorQueues.length) return null;
	return carrier.floorQueues[slot] ?? null;
}

function get_queue_count(
	queue: CarrierFloorQueue,
	directionFlag: number,
): number {
	return directionFlag === 0 ? queue.upCount : queue.downCount;
}

function get_queue_head(
	queue: CarrierFloorQueue,
	directionFlag: number,
): number {
	return directionFlag === 0 ? queue.upHeadIndex : queue.downHeadIndex;
}

function get_queue_ids(
	queue: CarrierFloorQueue,
	directionFlag: number,
): string[] {
	return directionFlag === 0 ? queue.upQueueRouteIds : queue.downQueueRouteIds;
}

function enqueue_route_into_floor_queue(
	carrier: CarrierRecord,
	routeId: string,
	sourceFloor: number,
	directionFlag: number,
): boolean {
	const queue = get_queue_state(carrier, sourceFloor);
	if (!queue) return false;
	const count = get_queue_count(queue, directionFlag);
	if (count >= QUEUE_CAPACITY) return false;
	const ids = get_queue_ids(queue, directionFlag);
	const head = get_queue_head(queue, directionFlag);
	const writeIndex = (head + count) % QUEUE_CAPACITY;
	ids[writeIndex] = routeId;
	if (directionFlag === 0) queue.upCount += 1;
	else queue.downCount += 1;
	return true;
}

function pop_route_from_floor_queue(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): string | null {
	const queue = get_queue_state(carrier, floor);
	if (!queue) return null;
	const count = get_queue_count(queue, directionFlag);
	if (count <= 0) return null;
	const ids = get_queue_ids(queue, directionFlag);
	const head = get_queue_head(queue, directionFlag);
	const routeId = ids[head] ?? "";
	ids[head] = "";
	if (directionFlag === 0) {
		queue.upHeadIndex = (queue.upHeadIndex + 1) % QUEUE_CAPACITY;
		queue.upCount -= 1;
	} else {
		queue.downHeadIndex = (queue.downHeadIndex + 1) % QUEUE_CAPACITY;
		queue.downCount -= 1;
	}
	return routeId || null;
}

function peek_queue_route_ids(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): string[] {
	const queue = get_queue_state(carrier, floor);
	if (!queue) return [];
	const ids = get_queue_ids(queue, directionFlag);
	const count = get_queue_count(queue, directionFlag);
	const head = get_queue_head(queue, directionFlag);
	return Array.from(
		{ length: count },
		(_, index) => ids[(head + index) % QUEUE_CAPACITY] ?? "",
	).filter(Boolean);
}

function active_slot_limit(carrier: CarrierRecord): number {
	return Math.min(ACTIVE_SLOT_CAPACITY, carrier.assignmentCapacity);
}

function sync_pending_route_ids(car: CarrierCar): void {
	car.pendingRouteIds = car.activeRouteSlots
		.filter((slot) => slot.active)
		.map((slot) => slot.routeId);
}

function sync_route_slots(carrier: CarrierRecord, car: CarrierCar): void {
	car.activeRouteSlots = car.activeRouteSlots.filter((slot) => {
		if (!slot.active) return false;
		const route = find_route(carrier, slot.routeId);
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
	sync_pending_route_ids(car);
}

function has_active_slot(car: CarrierCar, routeId: string): boolean {
	return car.activeRouteSlots.some(
		(slot) => slot.active && slot.routeId === routeId,
	);
}

function add_route_slot(
	carrier: CarrierRecord,
	car: CarrierCar,
	route: CarrierRecord["pendingRoutes"][number],
): boolean {
	if (has_active_slot(car, route.entityId)) return true;
	const limit = active_slot_limit(carrier);
	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot || slot.active) continue;
		slot.routeId = route.entityId;
		slot.sourceFloor = route.sourceFloor;
		slot.destinationFloor = route.destinationFloor;
		slot.boarded = route.boarded;
		slot.active = true;
		sync_pending_route_ids(car);
		return true;
	}
	return false;
}

function reset_car_to_home(carrier: CarrierRecord, car: CarrierCar): void {
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

function compute_car_motion_mode(
	carrier: CarrierRecord,
	car: CarrierCar,
): 0 | 1 | 2 | 3 {
	const distToTarget = Math.abs(car.currentFloor - car.targetFloor);
	const distFromPrev = Math.abs(car.currentFloor - car.prevFloor);
	const firstLeg = distFromPrev === 0 && distToTarget > 0;

	if (carrier.carrierMode !== 0) {
		if (firstLeg) return 2;
		if (distToTarget < 2 || distFromPrev < 2) return 0;
		if (distToTarget < 4 || distFromPrev < 4) return 1;
		return 2;
	}

	if (firstLeg) return distToTarget > 4 ? 3 : 2;
	if (distToTarget < 2 || distFromPrev < 2) return 0;
	if (distToTarget > 4 && distFromPrev > 4) return 3;
	return 2;
}

function advance_car_position_one_step(
	carrier: CarrierRecord,
	car: CarrierCar,
): void {
	const motionMode = compute_car_motion_mode(carrier, car);
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

export function floor_to_slot(carrier: CarrierRecord, floor: number): number {
	if (floor < carrier.bottomServedFloor || floor > carrier.topServedFloor) {
		return -1;
	}
	if (carrier.carrierMode === 0) {
		const rel = floor - carrier.bottomServedFloor;
		if (rel >= 0 && rel < 10) return rel;
		if ((floor - 10) % 15 === 14) return Math.floor((floor - 10) / 15) + 10;
		return -1;
	}
	return floor - carrier.bottomServedFloor;
}

export function carrier_serves_floor(
	carrier: CarrierRecord,
	floor: number,
): boolean {
	return floor_to_slot(carrier, floor) >= 0;
}

function make_carrier_car(numSlots: number, homeFloor: number): CarrierCar {
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

export function make_carrier(
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
		return make_carrier_car(numSlots, Math.min(top, homeFloor));
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
		waitingCarResponseThreshold: 4,
		assignmentCapacity: mode === 0 ? 0x2a : 0x15,
		floorQueues: Array.from({ length: numSlots }, () => create_floor_queue()),
		pendingRoutes: [],
		completedRouteIds: [],
		cars,
	};
}

function sync_waiting_count(
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
		car.waitingCount[slot] = queue.upCount + queue.downCount;
	}

	const limit = active_slot_limit(carrier);
	for (let index = 0; index < limit; index++) {
		const slotRef = car.activeRouteSlots[index];
		if (!slotRef?.active || !slotRef.boarded) continue;
		const slot = floor_to_slot(carrier, slotRef.destinationFloor);
		if (slot < 0 || slot >= car.destinationCountByFloor.length) continue;
		const prev = car.destinationCountByFloor[slot] ?? 0;
		car.destinationCountByFloor[slot] = prev + 1;
		if (prev === 0) car.nonemptyDestinationCount += 1;
	}

	for (const route of carrier.pendingRoutes) {
		if (!route.boarded || route.assignedCarIndex !== carIndex) continue;
		const slot = floor_to_slot(carrier, route.destinationFloor);
		if (slot < 0 || slot >= car.destinationCountByFloor.length) continue;
		const prev = car.destinationCountByFloor[slot] ?? 0;
		if (prev === 0) car.nonemptyDestinationCount += 1;
		car.destinationCountByFloor[slot] = prev + 1;
	}
}

function sync_assignment_status(carrier: CarrierRecord): void {
	carrier.primaryRouteStatusByFloor.fill(0);
	carrier.secondaryRouteStatusByFloor.fill(0);

	for (const car of carrier.cars) {
		car.pendingAssignmentCount = 0;
	}

	for (const [carIndex, car] of carrier.cars.entries()) {
		sync_route_slots(carrier, car);
		sync_waiting_count(carrier, car, carIndex);
	}

	for (let slot = 0; slot < carrier.primaryRouteStatusByFloor.length; slot++) {
		const queue = carrier.floorQueues[slot];
		if (!queue) continue;
		if (queue.upCount >= QUEUE_CAPACITY) {
			carrier.primaryRouteStatusByFloor[slot] = 0x28;
		}
		if (queue.downCount >= QUEUE_CAPACITY) {
			carrier.secondaryRouteStatusByFloor[slot] = 0x28;
		}
	}

	for (const route of carrier.pendingRoutes) {
		if (route.boarded || route.assignedCarIndex < 0) continue;
		const slot = floor_to_slot(carrier, route.sourceFloor);
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

function pending_targets_in_direction(
	carrier: CarrierRecord,
	car: CarrierCar,
	directionFlag: number,
): boolean {
	const limit = active_slot_limit(carrier);
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

function find_best_available_car_for_floor(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): number {
	let bestIndex = -1;
	let bestIdleHomeScore = Number.POSITIVE_INFINITY;
	let bestMovingScore = Number.POSITIVE_INFINITY;
	let bestMovingIndex = -1;

	for (const [carIndex, car] of carrier.cars.entries()) {
		if (!car.active) continue;
		if (car.assignedCount >= get_car_capacity(carrier)) continue;

		if (
			car.currentFloor === floor &&
			car.doorWaitCounter === 0 &&
			(car.scheduleFlag !== 0 || car.directionFlag === directionFlag)
		) {
			return carIndex;
		}

		const distance = Math.abs(car.currentFloor - floor);
		const idleHome =
			car.pendingAssignmentCount === 0 &&
			car.nonemptyDestinationCount === 0 &&
			car.doorWaitCounter === 0 &&
			car.currentFloor === car.homeFloor;
		const sameDirectionForward =
			car.directionFlag === directionFlag &&
			(directionFlag === 0
				? floor >= car.currentFloor
				: floor <= car.currentFloor);
		const movingScore =
			distance +
			car.pendingAssignmentCount * 8 +
			(sameDirectionForward ? 0 : 8);

		if (idleHome && distance < bestIdleHomeScore) {
			bestIdleHomeScore = distance;
			bestIndex = carIndex;
		}
		if (movingScore < bestMovingScore) {
			bestMovingScore = movingScore;
			bestMovingIndex = carIndex;
		}
	}

	if (bestIndex >= 0 && bestMovingIndex >= 0) {
		if (
			bestMovingScore - bestIdleHomeScore <
			carrier.waitingCarResponseThreshold
		) {
			return bestMovingIndex;
		}
		return bestIndex;
	}
	return bestIndex >= 0 ? bestIndex : bestMovingIndex;
}

function assign_car_to_floor_request(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): void {
	const slot = floor_to_slot(carrier, floor);
	if (slot < 0) return;
	const table =
		directionFlag === 0
			? carrier.primaryRouteStatusByFloor
			: carrier.secondaryRouteStatusByFloor;
	if ((table[slot] ?? 0) !== 0) return;

	const carIndex = find_best_available_car_for_floor(
		carrier,
		floor,
		directionFlag,
	);
	if (carIndex < 0) return;
	for (const route of carrier.pendingRoutes) {
		if (route.boarded) continue;
		if (route.sourceFloor !== floor || route.directionFlag !== directionFlag)
			continue;
		route.assignedCarIndex = carIndex;
	}
	sync_assignment_status(carrier);
}

function assign_pending_floor_requests(carrier: CarrierRecord): void {
	for (let slot = 0; slot < carrier.floorQueues.length; slot++) {
		const floor = carrier.bottomServedFloor + slot;
		const queue = carrier.floorQueues[slot];
		if (!queue) continue;
		if (queue.upCount > 0) assign_car_to_floor_request(carrier, floor, 0);
		if (queue.downCount > 0) assign_car_to_floor_request(carrier, floor, 1);
	}
}

function process_unit_travel_queue(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): void {
	let remainingSlots = Math.max(
		0,
		get_car_capacity(carrier) - car.assignedCount,
	);
	if (remainingSlots === 0) return;

	let primaryDirection = car.directionFlag;
	let assignedRoutes = peek_queue_route_ids(
		carrier,
		car.currentFloor,
		primaryDirection,
	)
		.map((routeId) => find_route(carrier, routeId))
		.filter(
			(route): route is NonNullable<typeof route> =>
				route !== undefined &&
				!route.boarded &&
				route.assignedCarIndex === carIndex &&
				!has_active_slot(car, route.entityId),
		);

	if (
		assignedRoutes.length === 0 &&
		!pending_targets_in_direction(carrier, car, primaryDirection)
	) {
		primaryDirection = primaryDirection === 0 ? 1 : 0;
		car.directionFlag = primaryDirection;
		assignedRoutes = peek_queue_route_ids(
			carrier,
			car.currentFloor,
			primaryDirection,
		)
			.map((routeId) => find_route(carrier, routeId))
			.filter(
				(route): route is NonNullable<typeof route> =>
					route !== undefined &&
					!route.boarded &&
					route.assignedCarIndex === carIndex &&
					!has_active_slot(car, route.entityId),
			);
	}

	for (const route of assignedRoutes.slice(0, remainingSlots)) {
		pop_route_from_floor_queue(carrier, car.currentFloor, primaryDirection);
		if (add_route_slot(carrier, car, route)) remainingSlots -= 1;
	}

	if (remainingSlots > 0) {
		const alternateDirection = primaryDirection === 0 ? 1 : 0;
		const alternateRoutes = peek_queue_route_ids(
			carrier,
			car.currentFloor,
			alternateDirection,
		)
			.map((routeId) => find_route(carrier, routeId))
			.filter(
				(route): route is NonNullable<typeof route> =>
					route !== undefined &&
					!route.boarded &&
					route.assignedCarIndex === carIndex &&
					!has_active_slot(car, route.entityId),
			);
		for (const route of alternateRoutes.slice(0, remainingSlots)) {
			pop_route_from_floor_queue(carrier, car.currentFloor, alternateDirection);
			if (add_route_slot(carrier, car, route)) remainingSlots -= 1;
		}
	}

	sync_assignment_status(carrier);
}

function select_next_target(
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
): number {
	const dir = car.directionFlag === 0 ? 1 : -1;
	const targets: number[] = [];
	const limit = active_slot_limit(carrier);

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot?.active) continue;
		targets.push(slot.boarded ? slot.destinationFloor : slot.sourceFloor);
	}

	for (
		let floor = carrier.bottomServedFloor;
		floor <= carrier.topServedFloor;
		floor++
	) {
		const slot = floor_to_slot(carrier, floor);
		if (slot < 0) continue;
		if ((car.destinationCountByFloor[slot] ?? 0) > 0) targets.push(floor);
		if (
			carrier.primaryRouteStatusByFloor[slot] === carIndex + 1 ||
			carrier.secondaryRouteStatusByFloor[slot] === carIndex + 1
		) {
			targets.push(floor);
		}
	}

	if (car.pendingAssignmentCount === 0 && car.nonemptyDestinationCount === 0) {
		return car.homeFloor;
	}

	for (
		let floor = car.currentFloor + dir;
		floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
		floor += dir
	) {
		if (targets.includes(floor)) return floor;
	}

	if (
		(car.currentFloor === carrier.topServedFloor ||
			car.currentFloor === carrier.bottomServedFloor) &&
		car.scheduleFlag === 1
	) {
		car.directionFlag = car.directionFlag === 0 ? 1 : 0;
	}

	for (
		let floor = car.currentFloor - dir;
		floor >= carrier.bottomServedFloor && floor <= carrier.topServedFloor;
		floor -= dir
	) {
		if (targets.includes(floor)) return floor;
	}

	return car.currentFloor;
}

function load_schedule_flag(
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
	car.scheduleFlag = carrier.servedFloorFlags[get_schedule_index(time)] ?? 1;
}

function should_car_depart(
	carrier: CarrierRecord,
	car: CarrierCar,
	time: TimeState,
): boolean {
	if (car.assignedCount >= get_car_capacity(carrier)) return true;
	const scheduleIndex = get_schedule_index(time);
	if ((carrier.serviceScheduleFlags[scheduleIndex] ?? 1) === 0) {
		return true;
	}
	const isLobbyOrExpressFloor =
		car.currentFloor === 10 || (car.currentFloor - 10) % 15 === 14;
	if (car.currentFloor !== car.homeFloor && !isLobbyOrExpressFloor) return true;
	const dwellMultiplier = carrier.dwellMultiplierFlags[scheduleIndex] ?? 1;
	return Math.abs(time.dayTick - car.departureTimestamp) > dwellMultiplier * 30;
}

function board_and_unload_routes(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
	onArrival?: CarrierArrivalCallback,
): boolean {
	let changed = false;
	const limit = active_slot_limit(carrier);
	const arrivals: Array<{ routeId: string; floor: number }> = [];

	for (let index = 0; index < limit; index++) {
		const slot = car.activeRouteSlots[index];
		if (!slot?.active || !slot.boarded) continue;
		if (slot.destinationFloor !== car.currentFloor) continue;
		const arrivedRouteId = slot.routeId;
		const arrivedFloor = slot.destinationFloor;
		car.assignedCount = Math.max(0, car.assignedCount - 1);
		const destinationSlot = floor_to_slot(carrier, slot.destinationFloor);
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
			(candidate) => candidate.entityId !== arrivedRouteId,
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
		if (car.assignedCount >= get_car_capacity(carrier)) break;
		if (!slot?.active || slot.boarded) continue;
		const route = find_route(carrier, slot.routeId);
		if (!route || route.boarded) continue;
		if (route.assignedCarIndex !== carIndex) continue;
		if (route.sourceFloor !== car.currentFloor) continue;
		route.boarded = true;
		slot.boarded = true;
		car.assignedCount += 1;
		const destinationSlot = floor_to_slot(carrier, route.destinationFloor);
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
		sync_pending_route_ids(car);
		sync_assignment_status(carrier);
	}
	return changed;
}

function step_carrier_car(
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
		reset_car_to_home(carrier, car);
		return;
	}

	if (car.doorWaitCounter > 0) {
		if (compute_car_motion_mode(carrier, car) === 0) car.doorWaitCounter--;
		else car.doorWaitCounter = 0;
		return;
	}

	if (car.speedCounter > 0) {
		car.speedCounter--;
		if (car.speedCounter === 0) {
			car.prevFloor = car.currentFloor;
			advance_car_position_one_step(carrier, car);
			if (car.currentFloor === car.targetFloor) {
				if (car.doorWaitCounter === 0)
					car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
				car.departureFlag = 0;
			}
			if (car.doorWaitCounter === 0 && car.currentFloor !== car.targetFloor) {
				car.speedCounter = speed_ticks(carrier.carrierMode);
			}
		}
		return;
	}

	process_unit_travel_queue(carrier, car, carIndex);
	if (board_and_unload_routes(carrier, car, carIndex, onArrival)) {
		car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
		return;
	}

	load_schedule_flag(carrier, car, time);
	const next = select_next_target(car, carrier, carIndex);
	if (next === car.currentFloor) {
		const currentSlot = floor_to_slot(carrier, car.currentFloor);
		const waitingHere =
			currentSlot >= 0 ? (car.waitingCount[currentSlot] ?? 0) > 0 : false;
		if (waitingHere || car.assignedCount < get_car_capacity(carrier)) {
			if (car.departureFlag === 0) car.departureTimestamp = time.dayTick;
			car.speedCounter = DEPARTURE_SEQUENCE_TICKS;
			car.departureFlag = 1;
			return;
		}
		if (
			car.pendingRouteIds.length > 0 &&
			should_car_depart(carrier, car, time)
		) {
			car.speedCounter = 1;
		}
		return;
	}

	car.targetFloor = next;
	car.directionFlag = next > car.currentFloor ? 0 : 1;
	car.speedCounter = DEPARTURE_SEQUENCE_TICKS;
	if (car.departureFlag === 0) car.departureTimestamp = time.dayTick;
	car.departureFlag = 1;
}

export function tick_all_carriers(
	world: WorldState,
	time: TimeState,
	onArrival?: CarrierArrivalCallback,
): void {
	for (const carrier of world.carriers) {
		carrier.completedRouteIds = [];
		assign_pending_floor_requests(carrier);
		sync_assignment_status(carrier);
		for (const [carIndex, car] of carrier.cars.entries()) {
			step_carrier_car(car, carrier, carIndex, time, onArrival);
		}
	}
}

export function rebuild_carrier_list(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();

	for (const [key, type] of Object.entries(world.overlays)) {
		let mode: 0 | 1 | 2;
		if (type === "elevator") mode = 1;
		else if (type === "elevatorExpress") mode = 0;
		else if (type === "elevatorService") mode = 2;
		else continue;

		const [xStr, yStr] = key.split(",");
		const x = Number(xStr);
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
			existing.completedRouteIds ??= [];
			if (existing.primaryRouteStatusByFloor.length !== numSlots) {
				existing.primaryRouteStatusByFloor = new Array(numSlots).fill(0);
				existing.secondaryRouteStatusByFloor = new Array(numSlots).fill(0);
			}
			if (existing.floorQueues.length !== numSlots) {
				existing.floorQueues = Array.from({ length: numSlots }, () =>
					create_floor_queue(),
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
					reset_car_to_home(existing, car);
				}
				sync_route_slots(existing, car);
			}
			newCarriers.push(existing);
		} else {
			newCarriers.push(make_carrier(id++, col, mode, bottom, top));
		}
	}

	world.carriers = newCarriers;
	for (const carrier of world.carriers) {
		sync_assignment_status(carrier);
	}
}

export function init_carrier_state(world: WorldState): void {
	world.carriers ??= [];
	world.floorWalkabilityFlags ??= new Array(GRID_HEIGHT).fill(0);
	world.transferGroupCache ??= new Array(GRID_HEIGHT).fill(0);
}

export function enqueue_carrier_route(
	carrier: CarrierRecord,
	entityId: string,
	sourceFloor: number,
	destinationFloor: number,
	directionFlag: number,
): boolean {
	if (carrier.pendingRoutes.some((route) => route.entityId === entityId))
		return true;
	if (
		!enqueue_route_into_floor_queue(
			carrier,
			entityId,
			sourceFloor,
			directionFlag,
		)
	) {
		const slot = floor_to_slot(carrier, sourceFloor);
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
		entityId,
		sourceFloor,
		destinationFloor,
		boarded: false,
		directionFlag,
		assignedCarIndex: -1,
	};
	carrier.pendingRoutes.push(route);
	assign_pending_floor_requests(carrier);
	sync_assignment_status(carrier);
	return true;
}
