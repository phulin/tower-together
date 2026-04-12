import type { CarrierCarStateData, SimStateData } from "../types";
import { GRID_HEIGHT, TILE_WIDTHS } from "../types";
import {
	EXPRESS_TICKS_PER_FLOOR,
	FAMILY_POPULATION,
	FAMILY_WIDTHS,
	LOCAL_TICKS_PER_FLOOR,
	TILE_HEIGHT,
	TILE_WIDTH,
} from "./gameSceneConstants";

export interface TimedSnapshot<T> {
	simTime: number;
	items: T[];
}

export interface PresentationClock {
	simTime: number;
	receivedAtMs: number;
	tickIntervalMs: number;
}

export interface QueuedSimLayout {
	gridX: number;
	gridY: number;
}

export function getPresentationTime(
	presentationClock: PresentationClock,
	now = performance.now(),
): number {
	const elapsedMs = Math.max(0, now - presentationClock.receivedAtMs);
	const tickIntervalMs = Math.max(1, presentationClock.tickIntervalMs);
	return presentationClock.simTime + Math.min(1, elapsedMs / tickIntervalMs);
}

export function predictCarFloor(
	car: CarrierCarStateData,
	additionalTicks = 0,
): number {
	if (car.currentFloor === car.targetFloor || car.speedCounter <= 0) {
		return car.currentFloor;
	}

	const ticksPerFloor =
		car.carrierMode === 2 ? EXPRESS_TICKS_PER_FLOOR : LOCAL_TICKS_PER_FLOOR;
	const travelledTicks = Math.max(
		0,
		ticksPerFloor - car.speedCounter + additionalTicks,
	);
	const travelledFloors = travelledTicks / ticksPerFloor;
	const maxTravel = Math.abs(car.targetFloor - car.currentFloor);
	const clampedTravel = Math.min(maxTravel, travelledFloors);
	const direction = car.targetFloor > car.currentFloor ? 1 : -1;
	return car.currentFloor + direction * clampedTravel;
}

export function getDisplayedCars(
	current: TimedSnapshot<CarrierCarStateData> | null,
	previous: TimedSnapshot<CarrierCarStateData> | null,
	presentationClock: PresentationClock,
): CarrierCarStateData[] {
	if (!current) return [];

	const presentationTime = getPresentationTime(presentationClock);
	if (
		previous &&
		presentationTime >= previous.simTime &&
		presentationTime <= current.simTime
	) {
		const progress =
			(presentationTime - previous.simTime) /
			Math.max(1, current.simTime - previous.simTime);
		const previousByKey = new Map(
			previous.items.map((car) => [`${car.carrierId}:${car.carIndex}`, car]),
		);
		return current.items.map((car) => {
			const from = previousByKey.get(`${car.carrierId}:${car.carIndex}`);
			if (!from) return car;
			const interpolatedFloor =
				predictCarFloor(from, 0) +
				(predictCarFloor(car, 0) - predictCarFloor(from, 0)) * progress;
			return {
				...car,
				currentFloor: interpolatedFloor,
			};
		});
	}

	return current.items.map((car) => ({
		...car,
		currentFloor: predictCarFloor(
			car,
			Math.max(0, presentationTime - current.simTime),
		),
	}));
}

export function collectElevatorColumnsByFloor(
	overlayGrid: Map<string, string>,
): Map<number, number[]> {
	const result = new Map<number, number[]>();
	for (const [key, type] of overlayGrid) {
		if (type !== "elevator") continue;
		const [x, y] = key.split(",").map(Number);
		const floor = GRID_HEIGHT - 1 - y;
		const columns = result.get(floor);
		if (columns) {
			if (!columns.includes(x)) columns.push(x);
		} else {
			result.set(floor, [x]);
		}
	}

	for (const columns of result.values()) {
		columns.sort((a, b) => a - b);
	}
	return result;
}

export function getQueuedSimLayout(
	sim: SimStateData,
	elevatorColumnsByFloor: Map<number, number[]>,
	queueIndex: number,
): QueuedSimLayout {
	const spanWidth = FAMILY_WIDTHS[sim.familyCode] ?? 1;
	const population = FAMILY_POPULATION[sim.familyCode] ?? 1;
	const slotFraction = (sim.baseOffset + 0.5) / population;
	const fallbackX = sim.homeColumn + slotFraction * spanWidth;
	const elevatorColumn = pickElevatorColumn(sim, elevatorColumnsByFloor);
	const hasSelectedFloorColumns = elevatorColumnsByFloor.has(sim.selectedFloor);
	const gridX =
		elevatorColumn === sim.homeColumn && !hasSelectedFloorColumns
			? fallbackX
			: elevatorColumn +
				(TILE_WIDTHS.elevator ?? 4) / 2 +
				0.35 +
				queueIndex * 0.9;

	return {
		gridX,
		gridY: GRID_HEIGHT - 1 - sim.selectedFloor + 0.5,
	};
}

export function getQueuedSimQueueKey(
	sim: SimStateData,
	elevatorColumnsByFloor: Map<number, number[]>,
): string {
	return `${sim.selectedFloor}:${pickElevatorColumn(
		sim,
		elevatorColumnsByFloor,
	)}`;
}

export function getCarBounds(car: CarrierCarStateData): {
	x: number;
	y: number;
	width: number;
	height: number;
} {
	const shaftWidthCells = TILE_WIDTHS.elevator ?? 4;
	const slotCount = Math.max(1, car.carCount);
	const shaftPixelWidth = shaftWidthCells * TILE_WIDTH;
	const gutter = 1;
	const usableWidth = shaftPixelWidth - gutter * (slotCount + 1);
	const width = Math.max(3, Math.floor(usableWidth / slotCount));
	const height = Math.max(8, Math.floor(TILE_HEIGHT * 0.55));
	const x = car.column * TILE_WIDTH + gutter + car.carIndex * (width + gutter);
	const y =
		(GRID_HEIGHT - 1 - predictCarFloor(car) + 0.5) * TILE_HEIGHT - height / 2;
	return { x, y, width, height };
}

function pickElevatorColumn(
	sim: SimStateData,
	elevatorColumnsByFloor: Map<number, number[]>,
): number {
	const columns = elevatorColumnsByFloor.get(sim.floorAnchor);
	const selectedColumns = elevatorColumnsByFloor.get(sim.selectedFloor);
	const availableColumns = selectedColumns ?? columns;
	if (!availableColumns || availableColumns.length === 0) {
		return sim.homeColumn;
	}

	let best = availableColumns[0] ?? sim.homeColumn;
	let bestDistance = Math.abs(best - sim.homeColumn);
	for (const column of availableColumns) {
		const distance = Math.abs(column - sim.homeColumn);
		if (distance < bestDistance) {
			best = column;
			bestDistance = distance;
		}
	}
	return best;
}
