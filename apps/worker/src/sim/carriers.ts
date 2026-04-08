import type { TimeState } from "./time";
import {
	type CarrierCar,
	type CarrierRecord,
	GRID_HEIGHT,
	type WorldState,
	yToFloor,
} from "./world";

const LOCAL_TICKS_PER_FLOOR = 8;
const EXPRESS_TICKS_PER_FLOOR = 4;
const DEPARTURE_SEQUENCE_TICKS = 5;

function get_schedule_index(time: TimeState): number {
	return time.calendarPhaseFlag * 7 + time.daypartIndex;
}

function speed_ticks(mode: 0 | 1 | 2): number {
	return mode === 2 ? EXPRESS_TICKS_PER_FLOOR : LOCAL_TICKS_PER_FLOOR;
}

function get_car_capacity(carrier: CarrierRecord): number {
	const servedSlots = new Set<number>();
	for (
		let floor = carrier.bottomServedFloor;
		floor <= carrier.topServedFloor;
		floor++
	) {
		const slot = floor_to_slot(carrier, floor);
		if (slot >= 0) servedSlots.add(slot);
	}
	return Math.max(1, servedSlots.size);
}

function find_route(carrier: CarrierRecord, routeId: string) {
	return carrier.pendingRoutes.find((route) => route.entityId === routeId);
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
}

function compute_car_motion_mode(
	carrier: CarrierRecord,
	car: CarrierCar,
): 0 | 1 | 2 | 3 {
	const distToTarget = Math.abs(car.currentFloor - car.targetFloor);
	const distFromPrev = Math.abs(car.currentFloor - car.prevFloor);
	const firstLeg = distFromPrev === 0 && distToTarget > 0;

	if (carrier.carrierMode === 2) {
		if (firstLeg) return distToTarget < 4 ? 1 : 2;
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
	if (carrier.carrierMode === 0 || carrier.carrierMode === 1) {
		const rel = floor - carrier.bottomServedFloor;
		if (rel >= 0 && rel < 10) return rel;
		if ((floor - 10) % 15 === 14) return Math.floor((floor - 10) / 15) + 10;
		return -1;
	}
	return floor - carrier.bottomServedFloor;
}

function make_carrier_car(
	_bottomFloor: number,
	numSlots: number,
	homeFloor: number,
): CarrierCar {
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
		return make_carrier_car(bottom, numSlots, Math.min(top, homeFloor));
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
		pendingRoutes: [],
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
	for (const route of carrier.pendingRoutes) {
		if (route.boarded) {
			const slot = floor_to_slot(carrier, route.destinationFloor);
			if (
				route.assignedCarIndex === carIndex &&
				slot >= 0 &&
				slot < car.destinationCountByFloor.length
			) {
				car.destinationCountByFloor[slot] += 1;
			}
			continue;
		}
		if (route.assignedCarIndex !== carIndex) continue;
		const slot = floor_to_slot(carrier, route.sourceFloor);
		if (slot < 0 || slot >= car.waitingCount.length) continue;
		car.waitingCount[slot] += 1;
	}
}

function sync_assignment_status(carrier: CarrierRecord): void {
	carrier.primaryRouteStatusByFloor.fill(0);
	carrier.secondaryRouteStatusByFloor.fill(0);

	for (const car of carrier.cars) {
		car.pendingAssignmentCount = 0;
	}

	for (const [carIndex, car] of carrier.cars.entries()) {
		sync_waiting_count(carrier, car, carIndex);
	}

	for (let slot = 0; slot < carrier.primaryRouteStatusByFloor.length; slot++) {
		for (const directionFlag of [0, 1] as const) {
			const table =
				directionFlag === 0
					? carrier.primaryRouteStatusByFloor
					: carrier.secondaryRouteStatusByFloor;
			const floor = carrier.bottomServedFloor + slot;
			const assignedRoutes = carrier.pendingRoutes.filter(
				(route) =>
					!route.boarded &&
					route.directionFlag === directionFlag &&
					route.sourceFloor === floor &&
					route.assignedCarIndex >= 0,
			);
			if (assignedRoutes.length === 0) continue;
			const assignedCarIndex = assignedRoutes[0]?.assignedCarIndex ?? -1;
			const assignedCar = carrier.cars[assignedCarIndex];
			if (!assignedCar) continue;
			assignedCar.pendingAssignmentCount += 1;
			const atCapacity = assignedCar.assignedCount >= get_car_capacity(carrier);
			const departingHere =
				assignedCar.departureFlag !== 0 &&
				assignedCar.currentFloor === floor &&
				assignedCar.directionFlag === directionFlag;
			table[slot] = atCapacity || departingHere ? 0x28 : assignedCarIndex + 1;
		}
	}
}

function pending_targets_in_direction(
	carrier: CarrierRecord,
	car: CarrierCar,
	directionFlag: number,
): boolean {
	return car.pendingRouteIds.some((routeId) => {
		const route = find_route(carrier, routeId);
		if (!route) return false;
		const floor = route.boarded ? route.destinationFloor : route.sourceFloor;
		return directionFlag === 0
			? floor >= car.currentFloor
			: floor <= car.currentFloor;
	});
}

function find_best_available_car_for_floor(
	carrier: CarrierRecord,
	floor: number,
	directionFlag: number,
): number {
	let bestIndex = -1;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const [carIndex, car] of carrier.cars.entries()) {
		if (!car.active) continue;
		const capacity = get_car_capacity(carrier);
		if (car.assignedCount >= capacity) continue;
		const travelFloor =
			car.pendingRouteIds.length > 0 ? car.targetFloor : car.currentFloor;
		const distance = Math.abs(travelFloor - floor);
		const directionPenalty =
			car.pendingRouteIds.length > 0 && car.directionFlag !== directionFlag
				? 4
				: 0;
		const score =
			distance +
			car.pendingAssignmentCount * 8 +
			car.pendingRouteIds.length * 2 +
			directionPenalty;
		if (score < bestScore) {
			bestScore = score;
			bestIndex = carIndex;
		}
	}
	return bestIndex;
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

	const matchingRoutes = carrier.pendingRoutes.filter(
		(route) =>
			!route.boarded &&
			route.assignedCarIndex < 0 &&
			route.sourceFloor === floor &&
			route.directionFlag === directionFlag,
	);
	if (matchingRoutes.length === 0) return;

	const carIndex = find_best_available_car_for_floor(
		carrier,
		floor,
		directionFlag,
	);
	if (carIndex < 0) return;
	for (const route of matchingRoutes) {
		route.assignedCarIndex = carIndex;
	}
	sync_assignment_status(carrier);
}

function assign_pending_floor_requests(carrier: CarrierRecord): void {
	for (const route of carrier.pendingRoutes) {
		if (route.boarded || route.assignedCarIndex >= 0) continue;
		assign_car_to_floor_request(
			carrier,
			route.sourceFloor,
			route.directionFlag,
		);
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
	let assignedRoutes = carrier.pendingRoutes.filter(
		(route) =>
			!route.boarded &&
			route.assignedCarIndex === carIndex &&
			route.directionFlag === primaryDirection &&
			!car.pendingRouteIds.includes(route.entityId),
	);

	if (
		assignedRoutes.length === 0 &&
		!pending_targets_in_direction(carrier, car, primaryDirection)
	) {
		primaryDirection = primaryDirection === 0 ? 1 : 0;
		car.directionFlag = primaryDirection;
		assignedRoutes = carrier.pendingRoutes.filter(
			(route) =>
				!route.boarded &&
				route.assignedCarIndex === carIndex &&
				route.directionFlag === primaryDirection &&
				!car.pendingRouteIds.includes(route.entityId),
		);
	}

	for (const route of assignedRoutes.slice(0, remainingSlots)) {
		car.pendingRouteIds.push(route.entityId);
		remainingSlots -= 1;
	}

	if (remainingSlots > 0) {
		const alternateRoutes = carrier.pendingRoutes.filter(
			(route) =>
				!route.boarded &&
				route.assignedCarIndex === carIndex &&
				route.directionFlag !== primaryDirection &&
				!car.pendingRouteIds.includes(route.entityId),
		);
		for (const route of alternateRoutes.slice(0, remainingSlots)) {
			car.pendingRouteIds.push(route.entityId);
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
	const targets = car.pendingRouteIds
		.map((routeId) => find_route(carrier, routeId))
		.filter((route): route is NonNullable<typeof route> => route !== undefined)
		.map((route) =>
			route.boarded ? route.destinationFloor : route.sourceFloor,
		);

	for (
		let floor = carrier.bottomServedFloor;
		floor <= carrier.topServedFloor;
		floor++
	) {
		const slot = floor_to_slot(carrier, floor);
		if (slot < 0) continue;
		if ((car.destinationCountByFloor[slot] ?? 0) > 0) {
			targets.push(floor);
		}
	}

	for (
		let floor = carrier.bottomServedFloor;
		floor <= carrier.topServedFloor;
		floor++
	) {
		const slot = floor_to_slot(carrier, floor);
		if (slot < 0) continue;
		if (
			carrier.primaryRouteStatusByFloor[slot] === carIndex + 1 ||
			carrier.secondaryRouteStatusByFloor[slot] === carIndex + 1
		) {
			targets.push(floor);
		}
	}

	if (car.pendingAssignmentCount === 0 && targets.length === 0) {
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
	if ((carrier.serviceScheduleFlags[get_schedule_index(time)] ?? 1) === 0) {
		return true;
	}
	return (
		Math.abs(time.dayTick - car.departureTimestamp) > car.scheduleFlag * 30
	);
}

function board_and_unload_routes(
	carrier: CarrierRecord,
	car: CarrierCar,
	carIndex: number,
): boolean {
	let changed = false;
	const capacity = get_car_capacity(carrier);

	for (const routeId of [...car.pendingRouteIds]) {
		const route = find_route(carrier, routeId);
		if (!route?.boarded) continue;
		if (route.destinationFloor !== car.currentFloor) continue;
		car.assignedCount = Math.max(0, car.assignedCount - 1);
		car.pendingRouteIds = car.pendingRouteIds.filter(
			(candidate) => candidate !== routeId,
		);
		carrier.pendingRoutes = carrier.pendingRoutes.filter(
			(candidate) => candidate.entityId !== routeId,
		);
		changed = true;
	}

	for (const routeId of [...car.pendingRouteIds]) {
		if (car.assignedCount >= capacity) break;
		const route = find_route(carrier, routeId);
		if (!route || route.boarded) continue;
		if (route.assignedCarIndex !== carIndex) continue;
		if (route.sourceFloor !== car.currentFloor) continue;
		route.boarded = true;
		car.assignedCount += 1;
		changed = true;
	}

	if (changed) sync_assignment_status(carrier);
	return changed;
}

function step_carrier_car(
	car: CarrierCar,
	carrier: CarrierRecord,
	carIndex: number,
	time: TimeState,
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
				if (car.doorWaitCounter === 0) {
					car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
				}
				car.departureFlag = 0;
			}
			if (car.doorWaitCounter === 0 && car.currentFloor !== car.targetFloor) {
				car.speedCounter = speed_ticks(carrier.carrierMode);
			}
		}
		return;
	}

	process_unit_travel_queue(carrier, car, carIndex);
	if (board_and_unload_routes(carrier, car, carIndex)) {
		car.doorWaitCounter = DEPARTURE_SEQUENCE_TICKS;
		return;
	}

	load_schedule_flag(carrier, car, time);
	const next = select_next_target(car, carrier, carIndex);
	if (next === car.currentFloor) {
		if (
			(car.waitingCount[floor_to_slot(carrier, car.currentFloor)] ?? 0) > 0 ||
			car.assignedCount < get_car_capacity(carrier)
		) {
			if (car.departureFlag === 0) {
				car.departureTimestamp = time.dayTick;
			}
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
	if (car.departureFlag === 0) {
		car.departureTimestamp = time.dayTick;
	}
	car.departureFlag = 1;
}

export function tick_all_carriers(world: WorldState, time: TimeState): void {
	for (const carrier of world.carriers) {
		assign_pending_floor_requests(carrier);
		sync_assignment_status(carrier);
		for (const [carIndex, car] of carrier.cars.entries()) {
			step_carrier_car(car, carrier, carIndex, time);
		}
	}
}

export function rebuild_carrier_list(world: WorldState): void {
	const columns = new Map<number, { floors: Set<number>; mode: 0 | 1 | 2 }>();

	for (const [key, type] of Object.entries(world.overlays)) {
		if (type !== "elevator") continue;
		const mode: 0 | 1 | 2 = 1;

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
			if (existing.servedFloorFlags.length !== 14) {
				existing.servedFloorFlags = new Array(14).fill(1);
			}
			if (existing.serviceScheduleFlags.length !== 14) {
				existing.serviceScheduleFlags = new Array(14).fill(1);
			}
			if (existing.primaryRouteStatusByFloor.length !== numSlots) {
				existing.primaryRouteStatusByFloor = new Array(numSlots).fill(0);
				existing.secondaryRouteStatusByFloor = new Array(numSlots).fill(0);
			}
			for (const car of existing.cars) {
				if (car.waitingCount.length !== numSlots) {
					car.waitingCount = new Array(numSlots).fill(0);
				}
				if (car.destinationCountByFloor.length !== numSlots) {
					car.destinationCountByFloor = new Array(numSlots).fill(0);
				}
				car.homeFloor = Math.min(top, Math.max(bottom, car.homeFloor));
				if (car.currentFloor < bottom || car.currentFloor > top) {
					reset_car_to_home(existing, car);
				}
				car.pendingRouteIds = car.pendingRouteIds.filter((routeId) =>
					existing.pendingRoutes.some((route) => route.entityId === routeId),
				);
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
): void {
	if (carrier.pendingRoutes.some((route) => route.entityId === entityId))
		return;
	carrier.pendingRoutes.push({
		entityId,
		sourceFloor,
		destinationFloor,
		boarded: false,
		directionFlag,
		assignedCarIndex: -1,
	});
	assign_pending_floor_requests(carrier);
	sync_assignment_status(carrier);
}
