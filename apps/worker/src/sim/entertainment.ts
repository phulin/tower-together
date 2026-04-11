import { STATE_ACTIVE, STATE_ARRIVED, STATE_PARKED } from "./entities";
import type { LedgerState } from "./ledger";
import { FAMILY_CINEMA, FAMILY_ENTERTAINMENT } from "./resources";
import type { PlacedObjectRecord, WorldState } from "./world";

const ENTERTAINMENT_FAMILY_PAIRED = FAMILY_CINEMA;
const ENTERTAINMENT_FAMILY_SINGLE = FAMILY_ENTERTAINMENT;

/**
 * Paired-link budget tiers indexed by `linkAgeCounter / 3`.
 * Selectors 0..6 -> [40, 40, 40, 20], selectors 7..13 -> [60, 60, 40, 20].
 */
function pairedBudget(linkAgeCounter: number, selector: number): number {
	const ageTier = Math.min(3, Math.trunc(linkAgeCounter / 3));
	const lowSelectorTable = [40, 40, 40, 20];
	const highSelectorTable = [60, 60, 40, 20];
	const table =
		selector >= 0 && selector < 7 ? lowSelectorTable : highSelectorTable;
	return table[ageTier] ?? table[table.length - 1] ?? 20;
}

function findObjectBySidecarOwner(
	world: WorldState,
	sidecar: { ownerSubtypeIndex: number },
): PlacedObjectRecord | undefined {
	for (const object of Object.values(world.placedObjects)) {
		if (
			object.linkedRecordIndex >= 0 &&
			world.sidecars[object.linkedRecordIndex] === sidecar
		) {
			return object;
		}
	}
	return undefined;
}

/**
 * Seed entertainment link budgets and increment link age.
 * Called as part of the facility ledger rebuild checkpoint.
 */
export function seedEntertainmentBudgets(world: WorldState): void {
	for (const object of Object.values(world.placedObjects)) {
		if (
			object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED &&
			object.objectTypeCode !== ENTERTAINMENT_FAMILY_SINGLE
		)
			continue;
		if (object.linkedRecordIndex < 0) continue;
		const sidecar = world.sidecars[object.linkedRecordIndex];
		if (!sidecar || sidecar.kind !== "entertainment_link") continue;

		sidecar.attendanceCounter = 0;
		sidecar.activeRuntimeCount = 0;
		sidecar.linkPhaseState = 0;
		sidecar.pendingTransitionFlag = 0;
		sidecar.linkAgeCounter = Math.min(0x7f, sidecar.linkAgeCounter + 1);

		if (object.objectTypeCode === ENTERTAINMENT_FAMILY_PAIRED) {
			const budget = pairedBudget(
				sidecar.linkAgeCounter,
				sidecar.familySelectorOrSingleLinkFlag,
			);
			sidecar.forwardBudget = budget;
			sidecar.reverseBudget = budget;
		} else {
			sidecar.forwardBudget = 0;
			sidecar.reverseBudget = 50;
		}
	}
}

/**
 * Activate paired-link forward-half entities.
 * Sets forwardPhase to 1 for all paired entertainment links that are idle.
 */
export function activateEntertainmentForwardHalf(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object || object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED)
			continue;
		if (sidecar.linkPhaseState === 0) {
			sidecar.linkPhaseState = 1;
		}
	}
}

/**
 * Promote paired links to ready phase; activate single-link reverse-half.
 */
export function promoteAndActivateSingleReverse(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object) continue;

		if (object.objectTypeCode === ENTERTAINMENT_FAMILY_PAIRED) {
			if (sidecar.linkPhaseState === 2) {
				sidecar.linkPhaseState = 3;
			}
		} else if (object.objectTypeCode === ENTERTAINMENT_FAMILY_SINGLE) {
			if (sidecar.linkPhaseState === 0) {
				sidecar.linkPhaseState = 1;
			}
		}
	}
}

/**
 * Activate paired-link reverse-half entities still in phase 1.
 */
export function activateEntertainmentReverseHalf(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object || object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED)
			continue;
		if (sidecar.linkPhaseState === 1) {
			sidecar.linkPhaseState = 2;
		}
	}
}

/** Movie-theater (paired) attendance-tiered payout. */
function movieTheaterPayout(attendance: number): number {
	if (attendance >= 100) return 15_000;
	if (attendance >= 80) return 10_000;
	if (attendance >= 40) return 2_000;
	return 0;
}

/**
 * Advance paired-link forward phase.
 * Decrements active runtime count and accrues income for completed forward phases.
 */
export function advanceEntertainmentForwardPhase(world: WorldState): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object || object.objectTypeCode !== ENTERTAINMENT_FAMILY_PAIRED)
			continue;
		if (sidecar.linkPhaseState < 1) continue;

		sidecar.activeRuntimeCount = Math.max(
			0,
			sidecar.activeRuntimeCount - sidecar.forwardBudget,
		);
		sidecar.linkPhaseState = sidecar.activeRuntimeCount === 0 ? 1 : 2;

		// Park forward-half entities for this entertainment record
		for (const entity of world.entities) {
			if (entity.familyCode !== ENTERTAINMENT_FAMILY_PAIRED) continue;
			if (entity.subtypeIndex !== sidecar.ownerSubtypeIndex) continue;
			if (
				entity.stateCode >= STATE_ACTIVE &&
				entity.stateCode <= STATE_ARRIVED
			) {
				entity.stateCode = STATE_PARKED;
			}
		}
	}
}

/**
 * Advance reverse phase for both families, accrue cash income, reset phases.
 */
export function advanceEntertainmentReversePhaseAndAccrue(
	world: WorldState,
	ledger: LedgerState,
): void {
	for (const sidecar of world.sidecars) {
		if (sidecar.kind !== "entertainment_link") continue;
		const object = findObjectBySidecarOwner(world, sidecar);
		if (!object) continue;

		if (object.objectTypeCode === ENTERTAINMENT_FAMILY_PAIRED) {
			if (sidecar.linkPhaseState >= 1) {
				sidecar.activeRuntimeCount = Math.max(
					0,
					sidecar.activeRuntimeCount - sidecar.reverseBudget,
				);
				const payout = movieTheaterPayout(sidecar.attendanceCounter);
				if (payout > 0) {
					ledger.cashBalance = Math.min(
						99_999_999,
						ledger.cashBalance + payout,
					);
					ledger.incomeLedger[ENTERTAINMENT_FAMILY_PAIRED] =
						(ledger.incomeLedger[ENTERTAINMENT_FAMILY_PAIRED] ?? 0) + payout;
				}
			}
		} else if (object.objectTypeCode === ENTERTAINMENT_FAMILY_SINGLE) {
			if (sidecar.linkPhaseState >= 1) {
				sidecar.activeRuntimeCount = Math.max(
					0,
					sidecar.activeRuntimeCount - sidecar.reverseBudget,
				);
				if (sidecar.attendanceCounter > 0) {
					const payout = 20_000;
					ledger.cashBalance = Math.min(
						99_999_999,
						ledger.cashBalance + payout,
					);
					ledger.incomeLedger[ENTERTAINMENT_FAMILY_SINGLE] =
						(ledger.incomeLedger[ENTERTAINMENT_FAMILY_SINGLE] ?? 0) + payout;
				}
			}
		}

		// Reset phases
		sidecar.linkPhaseState = 0;

		// Park all entertainment entities for this record
		for (const entity of world.entities) {
			if (
				entity.familyCode !== object.objectTypeCode ||
				entity.subtypeIndex !== sidecar.ownerSubtypeIndex
			)
				continue;
			if (entity.stateCode !== STATE_PARKED) {
				entity.stateCode = STATE_PARKED;
			}
		}
	}
}
