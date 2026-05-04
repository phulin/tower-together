// 1208:0196 run_simulation_day_scheduler
//
// Advances g_day_tick and fires checkpoint handlers. In the binary the event
// rolls (VIP visitor, bomb, fire, random news) are triggered inside the
// checkpoint handler table; we keep them as free-standing calls for now and
// route them through this module in the same relative order as the previous
// `TowerSim.step()` implementation.
import { flushCarriersEndOfDay } from "../carriers";
import { activateEvalSims, dispatchEvalMiddayReturn } from "../cathedral";
import { dispatchActiveRequestsByFamily } from "../daily/drain-active-requests";
import {
	activateEntertainmentLowerHalf,
	activateEntertainmentUpperHalf,
	advanceEntertainmentLowerPairedPhaseAndAccrue,
	advanceEntertainmentUpperPhase,
	advancePartyHallPhaseAndAccrue,
	promoteCinemaAndActivatePartyHall,
	promoteCinemaLinksToReadyPhase,
	seedEntertainmentBudgets,
} from "../entertainment";
import {
	checkDailyEvents,
	tickBombEvent,
	tickFireEvent,
	tickVipSpecialVisitor,
	triggerRandomNewsEvent,
} from "../events";
import { rebuildAllSimTileSpans } from "../families/tile-spans";
import {
	activateThreeDayCashflow,
	doExpenseSweep,
	doLedgerRollover,
	type LedgerState,
	rebuildFacilityLedger,
} from "../ledger";
import {
	resetRecyclingCenterDutyTier,
	updateRecyclingCenterState,
} from "../recycling";
import {
	FAMILY_CONDO,
	FAMILY_FAST_FOOD,
	FAMILY_HOTEL_SINGLE,
	FAMILY_HOTEL_TWIN,
	FAMILY_OFFICE,
	FAMILY_RESTAURANT,
	FAMILY_RETAIL,
} from "../resources";
import {
	advanceObjectStayPhaseTiers,
	closeCommercialVenuesByFamily,
	normalizeUnitStatusEndOfDay,
	rebuildCommercialVenueRuntime,
	rebuildRestaurantFacilityRecords,
	recomputeAllObjectOperationalStatus,
	refundUnhappyFacilities,
	resetSimRuntimeState,
	resetSimTripCounters,
	spreadCockroachInfestation,
	updateHotelOperationalAndOccupancy,
} from "../sims";
import { STATE_HOTEL_PARKED, STATE_MORNING_GATE } from "../sims/states";
import { advanceOneTick, type TimeState } from "../time";
import type { WorldState } from "../world";

// ─── Sim state bundle ─────────────────────────────────────────────────────────

export interface SimState {
	time: TimeState;
	world: WorldState;
	ledger: LedgerState;
}

// ─── Checkpoint bodies ────────────────────────────────────────────────────────

function checkpointStartOfDay(s: SimState): void {
	// Binary: update_periodic_facility_progress_override (1020:0df8) — every
	// 8th day (dayCounter % 8 === 4), if tower is below 5 stars, enable the
	// override seed slot AND set bit 0x10 in g_game_state_flags. Cleared at
	// midday (0x640) by clear_facility_progress_override (1020:0e1c).
	if (
		s.time.dayCounter % 8 === 4 &&
		s.world.starCount < 5 &&
		(s.world.eventState.gameStateFlags & 0x10) === 0
	) {
		s.world.gateFlags.facilityProgressOverride = 1;
		s.world.eventState.gameStateFlags |= 0x10;
	}
	// Medical daily flag: latched to 1 at day-start when starCount > 2.
	// Cleared by failed medical trips during the day; gates star 3→4 and 4→5.
	if (s.world.starCount > 2) {
		s.world.gateFlags.officeServiceOkMedical = 1;
	}
	// Activate cathedral guest sims
	activateEvalSims(s.world);
}

function checkpointRecyclingReset(s: SimState): void {
	resetRecyclingCenterDutyTier(s.world);
}

function checkpointFacilityLedgerRebuild(s: SimState): void {
	checkDailyEvents(s.world, s.ledger, s.time);
	rebuildFacilityLedger(s.ledger, s.world);
	rebuildCommercialVenueRuntime(s.world, s.time);
	seedEntertainmentBudgets(s.world);
}

function checkpointEntertainmentHalf1(_s: SimState): void {
	// Binary 0x3e8 dispatches activate_entertainment_link_half_runtime_phase
	// only — it touches g_entertainment_link_table and sim-table state but
	// not g_commercial_venue_record_table. Earlier TS rolled fast-food/retail
	// today→yesterday here, which clobbered the day's accumulated visit
	// counts before the dayTick=240 ledger contribution could read them.
	activateEntertainmentUpperHalf(_s.world);
}

function checkpointHotelSaleReset(_s: SimState): void {
	_s.world.gateFlags.family345SaleCount = 0;
	dispatchEvalMiddayReturn(_s.world);
	promoteCinemaAndActivatePartyHall(_s.world);
	const hotelFamilyCounts = new Map<number, number>();
	for (const object of Object.values(_s.world.placedObjects)) {
		if (
			object.objectTypeCode === FAMILY_HOTEL_SINGLE ||
			object.objectTypeCode === FAMILY_HOTEL_TWIN
		) {
			hotelFamilyCounts.set(
				object.objectTypeCode,
				(hotelFamilyCounts.get(object.objectTypeCode) ?? 0) + 1,
			);
		}
	}
	if (_s.world.carriers.length === 0) {
		for (const sim of _s.world.sims) {
			if (
				sim.stateCode === STATE_HOTEL_PARKED &&
				(sim.familyCode === FAMILY_HOTEL_SINGLE ||
					sim.familyCode === FAMILY_HOTEL_TWIN) &&
				(hotelFamilyCounts.get(sim.familyCode) ?? 0) === 1
			) {
				sim.stateCode = STATE_MORNING_GATE;
			}
		}
	}
}

function checkpointEntertainmentHalf2(_s: SimState): void {
	// Binary 0x578: entertainment-only — see checkpointEntertainmentHalf1.
	activateEntertainmentLowerHalf(_s.world);
}

function checkpointEntertainmentPhase1(_s: SimState): void {
	advanceEntertainmentUpperPhase(_s.world);
}

function checkpointMidday(_s: SimState): void {
	// Binary: clear_facility_progress_override (1020:0e1c) — disable override
	// seed slot AND clear bit 0x10 in g_game_state_flags (gated on bit set).
	if ((_s.world.eventState.gameStateFlags & 0x10) !== 0) {
		_s.world.gateFlags.facilityProgressOverride = 0;
		_s.world.eventState.gameStateFlags &= ~0x10;
	}
	// Spec execution order at checkpoint 0x640:
	// 0. rebuild_type6_facility_records (binary 1208:xxx): restaurant per-cycle
	//    seeding — reopens restaurants, refills remainingCapacity to 10, resets
	//    eligibility threshold, rolls visit counters.
	rebuildRestaurantFacilityRecords(_s.world, _s.time);
	// 1. Spread existing cockroach infestations
	spreadCockroachInfestation(_s.world, _s.time);
	// 2. Recompute hotel status + handle vacancy expiry + refresh occupancy
	updateHotelOperationalAndOccupancy(_s.world, _s.time);
	// 3. Normal midday tasks (binary 0x640 commercial work is restricted to
	//    rebuild_type6_facility_records above; fast-food/retail counters
	//    stay untouched until dayTick=240's rebuild_linked_facility_records).
	advancePartyHallPhaseAndAccrue(_s.world, _s.ledger, _s.time.dayCounter);
	// Binary 0x640: promote_entertainment_links_to_ready_phase(1, 1)
	// promotes cinema-paired link.linkPhaseState 2 -> 3.
	promoteCinemaLinksToReadyPhase(_s.world);
	updateRecyclingCenterState(_s.world, _s.ledger, 0);
	// 4. advance_object_stay_phase_tiers @ 1230:0b5f — raises unit_status bands
	//    (hotel 0x18→0x20, 0x28→0x30, 0x38→0x40; office 0x00→0x08, 0x10→0x18;
	//    condo 0x18→0x20 + low-band +8). Runs after the refresh pass so the
	//    gate sees the pre-advance status.
	advanceObjectStayPhaseTiers(_s.world);
}

function checkpointNoop(_s: SimState): void {
	// Intentional no-op (previously mislabeled in the spec)
}

function checkpointEntertainmentPhase2(_s: SimState): void {
	advanceEntertainmentLowerPairedPhaseAndAccrue(
		_s.world,
		_s.ledger,
		_s.time.dayCounter,
	);
}

function checkpointLateFacility(_s: SimState): void {
	closeCommercialVenuesByFamily(_s.world, _s.ledger, FAMILY_RETAIL);
	closeCommercialVenuesByFamily(_s.world, _s.ledger, FAMILY_FAST_FOOD);
	updateRecyclingCenterState(_s.world, _s.ledger, 2);
	// Note: `tryAdvanceStarCount` no longer fires from this checkpoint. The
	// binary calls `check_and_advance_star_rating` (1148:002d) every tick
	// from `FUN_1098_03ab` (1098:03ab), which we mirror by invoking it at
	// the top of `carrierTick` in tick/carrier-tick.ts.
}

function checkpointType6Advance(_s: SimState): void {
	closeCommercialVenuesByFamily(_s.world, _s.ledger, FAMILY_RESTAURANT);
}

function checkpointDayCounter(s: SimState): void {
	// Increment dayCounter and recompute weekendFlag.
	// (time.ts already does this via advanceOneTick; this body is a no-op here
	//  because time state is mutated in advanceOneTick before runCheckpoints.)
	void s;
}

function checkpointRuntimeRefresh(_s: SimState): void {
	rebuildAllSimTileSpans(_s.world);
	resetSimRuntimeState(_s.world);
	normalizeUnitStatusEndOfDay(_s.world);
	// Binary 1208:0196 at g_day_tick == 0x9c4 additionally fires
	// 1190:0977 dispatch_active_requests_by_family — a once-per-day
	// sweep over the active-request table that re-routes stuck sims
	// through their family dispatch handler.
	dispatchActiveRequestsByFamily(_s.world, _s.ledger, _s.time);
}

function checkpointLedgerRollover(s: SimState): void {
	// Binary also calls reset_sim_runtime_state at checkpoint 0x9e5.
	resetSimRuntimeState(s.world);
	doLedgerRollover(s.ledger, s.world, s.time.dayCounter);
	recomputeAllObjectOperationalStatus(s.world);
	if (s.time.dayCounter % 3 === 0) {
		activateThreeDayCashflow(s.world, s.ledger, s.time.dayCounter);
		doExpenseSweep(s.ledger, s.world);
		refundUnhappyFacilities(s.world, s.ledger, s.time);
		// Binary activate_family_cashflow_if_operational resets trip counters for
		// all office and condo sims on the 3-day cycle (spec: 2533 step 2).
		for (const sim of s.world.sims) {
			if (sim.familyCode === FAMILY_OFFICE || sim.familyCode === FAMILY_CONDO) {
				resetSimTripCounters(sim);
			}
		}
	}
}

function checkpointEndOfDay(_s: SimState): void {
	flushCarriersEndOfDay(_s.world);
}

function checkpointRecyclingFinal(_s: SimState): void {
	updateRecyclingCenterState(_s.world, _s.ledger, 5);
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

/**
 * Binary `run_simulation_day_scheduler` (1208:0196).
 *
 * Advances `g_day_tick` and fires all checkpoint handlers. Also drives the
 * per-tick event rolls (random news, VIP visitor, bomb, fire). The TS order
 * preserved here matches the previous `TowerSim.step()` sequence:
 *
 *   advanceOneTick
 *   triggerRandomNewsEvent
 *   tickVipSpecialVisitor
 *   runCheckpoints
 *   tickBombEvent
 *   tickFireEvent
 *
 * Returns the updated TimeState. Callers should assign the result back onto
 * their time slot before invoking `carrierTick`.
 */
export function runSimulationDayScheduler(
	world: WorldState,
	ledger: LedgerState,
	time: TimeState,
): TimeState {
	const prevTick = time.dayTick;
	const { time: nextTime } = advanceOneTick(time);
	const currTick = nextTime.dayTick;

	triggerRandomNewsEvent(world, nextTime);
	tickVipSpecialVisitor(world, nextTime);
	runCheckpoints({ time: nextTime, world, ledger }, prevTick, currTick);

	tickBombEvent(world, ledger, nextTime);
	tickFireEvent(world, ledger, nextTime);

	return nextTime;
}
