import { flushCarriersEndOfDay } from "./carriers";
import { activateEvalSims, dispatchEvalMiddayReturn } from "./cathedral";
import {
	activateEntertainmentLowerHalf,
	activateEntertainmentUpperHalf,
	advanceEntertainmentLowerPhaseAndAccrue,
	advanceEntertainmentUpperPhase,
	promoteAndActivateSingleLower,
	seedEntertainmentBudgets,
} from "./entertainment";
import { checkDailyEvents } from "./events";
import {
	doLedgerRollover,
	type LedgerState,
	rebuildFacilityLedger,
} from "./ledger";
import {
	resetRecyclingCenterDutyTier,
	updateRecyclingCenterState,
} from "./recycling";
import {
	closeCommercialVenues,
	normalizeUnitStatusEndOfDay,
	refundUnhappyFacilities,
	resetCommercialVenueCycle,
	resetSimRuntimeState,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "./sims";
import type { TimeState } from "./time";
import type { WorldState } from "./world";

// ─── Sim state bundle ─────────────────────────────────────────────────────────

export interface SimState {
	time: TimeState;
	world: WorldState;
	ledger: LedgerState;
}

// ─── Checkpoint bodies ────────────────────────────────────────────────────────

function checkpointStartOfDay(_s: SimState): void {
	// Activate cathedral guest sims
	activateEvalSims(_s.world, _s.time);
}

function checkpointRecyclingReset(_s: SimState): void {
	resetRecyclingCenterDutyTier(_s.world);
}

function checkpointFacilityLedgerRebuild(s: SimState): void {
	checkDailyEvents(s.world, s.ledger, s.time);
	rebuildFacilityLedger(s.ledger, s.world);
	seedEntertainmentBudgets(s.world);
}

function checkpointEntertainmentHalf1(_s: SimState): void {
	resetCommercialVenueCycle(_s.world, _s.ledger);
	activateEntertainmentUpperHalf(_s.world);
}

function checkpointHotelSaleReset(_s: SimState): void {
	_s.world.gateFlags.family345SaleCount = 0;
	dispatchEvalMiddayReturn(_s.world);
	promoteAndActivateSingleLower(_s.world);
}

function checkpointEntertainmentHalf2(_s: SimState): void {
	resetCommercialVenueCycle(_s.world, _s.ledger);
	activateEntertainmentLowerHalf(_s.world);
}

function checkpointEntertainmentPhase1(_s: SimState): void {
	advanceEntertainmentUpperPhase(_s.world);
}

function checkpointMidday(_s: SimState): void {
	// Spec execution order at checkpoint 0x640:
	// 1. Spread existing cockroach infestations
	spreadCockroachInfestation(_s.world, _s.time);
	// 2. Recompute hotel status + handle vacancy expiry + refresh occupancy
	updateHotelOperationalAndOccupancy(_s.world, _s.time);
	// 3. Normal midday tasks
	resetCommercialVenueCycle(_s.world, _s.ledger);
	advanceEntertainmentLowerPhaseAndAccrue(_s.world, _s.ledger);
	updateRecyclingCenterState(_s.world, _s.ledger, _s.time, 0);
}

function checkpointAfternoonNotification(_s: SimState): void {
	_s.world.pendingNotifications.push({ kind: "afternoon" });
}

function checkpointNoop(_s: SimState): void {
	// Intentional no-op (previously mislabeled in the spec)
}

function checkpointEntertainmentPhase2(_s: SimState): void {
	closeCommercialVenues(_s.world);
}

function checkpointLateFacility(_s: SimState): void {
	updateRecyclingCenterState(_s.world, _s.ledger, _s.time, 2);
}

function checkpointType6Advance(_s: SimState): void {
	closeCommercialVenues(_s.world);
}

function checkpointDayCounter(s: SimState): void {
	// Increment dayCounter and recompute calendarPhaseFlag.
	// (time.ts already does this via advanceOneTick; this body is a no-op here
	//  because time state is mutated in advanceOneTick before runCheckpoints.)
	void s;
}

function checkpointRuntimeRefresh(_s: SimState): void {
	resetSimRuntimeState(_s.world);
	normalizeUnitStatusEndOfDay(_s.world);
}

function checkpointLedgerRollover(s: SimState): void {
	doLedgerRollover(s.ledger, s.world, s.time.dayCounter, s.time.starCount);
	if (s.time.dayCounter % 3 === 0) {
		refundUnhappyFacilities(s.world, s.ledger, s.time);
	}
}

function checkpointEndOfDay(_s: SimState): void {
	flushCarriersEndOfDay(_s.world);
	_s.world.pendingNotifications.push({ kind: "end_of_day" });
}

function checkpointRecyclingFinal(_s: SimState): void {
	updateRecyclingCenterState(_s.world, _s.ledger, _s.time, 5);
}

// ─── Checkpoint table ─────────────────────────────────────────────────────────

const CHECKPOINTS: Array<[number, (s: SimState) => void]> = [
	[0x000, checkpointStartOfDay],
	[0x020, checkpointRecyclingReset],
	[0x0f0, checkpointFacilityLedgerRebuild],
	[0x3e8, checkpointEntertainmentHalf1],
	[0x4b0, checkpointHotelSaleReset],
	[0x578, checkpointEntertainmentHalf2],
	[0x5dc, checkpointEntertainmentPhase1],
	[0x640, checkpointMidday],
	[0x6a4, checkpointAfternoonNotification],
	[0x708, checkpointNoop],
	[0x76c, checkpointEntertainmentPhase2],
	[0x7d0, checkpointLateFacility],
	[0x898, checkpointType6Advance],
	[0x8fc, checkpointDayCounter],
	[0x9c4, checkpointRuntimeRefresh],
	[0x9e5, checkpointLedgerRollover],
	[0x9f6, checkpointEndOfDay],
	[0x0a06, checkpointRecyclingFinal],
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Fire all checkpoints whose tick falls in the half-open interval
 * (prev_tick, curr_tick].  Handles day wraparound: when curr_tick < prev_tick
 * the tick counter crossed zero, so checkpoints at tick 0 are included.
 */
export function runCheckpoints(
	state: SimState,
	prev_tick: number,
	curr_tick: number,
): void {
	const wrapped = curr_tick < prev_tick; // day boundary crossed this step
	for (const [tick, fn] of CHECKPOINTS) {
		if (wrapped) {
			// Fire everything after prev_tick through day-end, then 0..curr_tick
			if (tick > prev_tick || tick <= curr_tick) fn(state);
		} else {
			if (tick > prev_tick && tick <= curr_tick) fn(state);
		}
	}
}
