import { FAMILY_PARKING } from "../resources";
import type { TimeState } from "../time";
import type { ServiceRequestEntry, SimRecord, WorldState } from "../world";
import {
	advanceSimTripCounters,
	rebaseSimElapsedFromClock,
} from "./trip-counters";

export function rebuildParkingDemandLog(world: WorldState): void {
	world.parkingDemandLog = [];
	for (let i = 0; i < world.sidecars.length; i++) {
		const rec = world.sidecars[i];
		if (rec.kind !== "service_request") continue;
		if (rec.ownerSubtypeIndex === 0xff) continue;
		if (rec.floorIndex === undefined) continue;
		if (rec.coverageFlag === 1) continue;

		let isParking = false;
		for (const obj of Object.values(world.placedObjects)) {
			if (
				obj.objectTypeCode === FAMILY_PARKING &&
				obj.linkedRecordIndex === i
			) {
				isParking = true;
				break;
			}
		}
		if (isParking) {
			world.parkingDemandLog.push(i);
		}
	}
}

export function tryAssignParkingService(
	world: WorldState,
	time: TimeState,
	sim: SimRecord,
): boolean {
	if (world.parkingDemandLog.length === 0) return false;
	const idx =
		world.parkingDemandLog[
			Math.floor(Math.random() * world.parkingDemandLog.length)
		];
	const rec = world.sidecars[idx] as ServiceRequestEntry | undefined;
	if (!rec || rec.kind !== "service_request") return false;
	rebaseSimElapsedFromClock(sim, time);
	advanceSimTripCounters(sim);
	return true;
}
