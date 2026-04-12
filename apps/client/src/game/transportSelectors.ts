import type { CarrierCarStateData, SimStateData } from "../types";

export const ELEVATOR_QUEUE_STATES = new Set([0x04, 0x05]);

export interface TransportMetrics {
	totalPopulation: number;
	queuedSims: number;
	boardedSims: number;
	activeTrips: number;
	totalCars: number;
	movingCars: number;
	doorWaitCars: number;
	peakCarLoad: number;
	state22Sims: number;
	checkoutQueueSims: number;
}

export function isQueuedSim(sim: SimStateData): boolean {
	return (
		!sim.boardedOnCarrier &&
		(sim.stateCode === 0x22 ||
			ELEVATOR_QUEUE_STATES.has(sim.stateCode) ||
			sim.routeMode === 2)
	);
}

export function isMovingCar(car: CarrierCarStateData): boolean {
	return car.speedCounter > 0 || car.currentFloor !== car.targetFloor;
}

export function buildOccupancyByCar(sims: SimStateData[]): Map<string, number> {
	const occupancyByCar = new Map<string, number>();
	for (const sim of sims) {
		if (
			!sim.boardedOnCarrier ||
			sim.carrierId === null ||
			sim.assignedCarIndex < 0
		) {
			continue;
		}

		const key = `${sim.carrierId}:${sim.assignedCarIndex}`;
		occupancyByCar.set(key, (occupancyByCar.get(key) ?? 0) + 1);
	}
	return occupancyByCar;
}

export function buildTransportMetrics(
	sims: SimStateData[],
	carriers: CarrierCarStateData[],
): TransportMetrics {
	const queuedSims = sims.filter(isQueuedSim);
	const boardedSims = sims.filter((sim) => sim.boardedOnCarrier);
	const occupancyByCar = buildOccupancyByCar(sims);

	return {
		totalPopulation: sims.length,
		queuedSims: queuedSims.length,
		boardedSims: boardedSims.length,
		activeTrips: sims.filter((sim) => sim.routeMode !== 0).length,
		totalCars: carriers.length,
		movingCars: carriers.filter(isMovingCar).length,
		doorWaitCars: carriers.filter((car) => car.doorWaitCounter > 0).length,
		peakCarLoad: Math.max(0, ...occupancyByCar.values()),
		state22Sims: sims.filter((sim) => sim.stateCode === 0x22).length,
		checkoutQueueSims: sims.filter((sim) =>
			ELEVATOR_QUEUE_STATES.has(sim.stateCode),
		).length,
	};
}
