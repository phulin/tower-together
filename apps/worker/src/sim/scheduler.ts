import {
	do_ledger_rollover,
	type LedgerState,
	rebuild_facility_ledger,
} from "./ledger";
import type { TimeState } from "./time";
import type { WorldState } from "./world";

// ─── Sim state bundle ─────────────────────────────────────────────────────────

export interface SimState {
	time: TimeState;
	world: WorldState;
	ledger: LedgerState;
}

// ─── Checkpoint bodies ────────────────────────────────────────────────────────

function checkpoint_start_of_day(_s: SimState): void {
	// Phase 3+: reset entity arrival queues
}

function checkpoint_housekeeping_reset(_s: SimState): void {
	// Phase 4: reset housekeeping cart duty tier
}

function checkpoint_facility_ledger_rebuild(s: SimState): void {
	rebuild_facility_ledger(s.ledger, s.world);
}

function checkpoint_entertainment_half1(_s: SimState): void {
	// Phase 4: entertainment venue phase 1 admission
}

function checkpoint_hotel_sale_reset(_s: SimState): void {
	// Phase 4: reset hotel nightly sale flags; eval entity midday return dispatch
}

function checkpoint_entertainment_half2(_s: SimState): void {
	// Phase 4: entertainment venue phase 2 admission
}

function checkpoint_entertainment_phase1(_s: SimState): void {
	// Phase 4
}

function checkpoint_midday(_s: SimState): void {
	// Phase 4: security/housekeeping tier-0 reset (always inadequate at midday)
}

function checkpoint_afternoon_notification(_s: SimState): void {
	// Phase 4: broadcast "afternoon" notification to clients if needed
}

function checkpoint_noop(_s: SimState): void {
	// Intentional no-op (previously mislabeled as security update in the spec)
}

function checkpoint_entertainment_phase2(_s: SimState): void {
	// Phase 4
}

function checkpoint_late_facility(_s: SimState): void {
	// Phase 4: security/housekeeping tier-2 check
}

function checkpoint_type6_advance(_s: SimState): void {
	// Phase 4: family-6 (restaurant) state advance
}

function checkpoint_day_counter(s: SimState): void {
	// Increment day_counter and recompute calendar_phase_flag.
	// (time.ts already does this via advanceOneTick; this body is a no-op here
	//  because time state is mutated in advanceOneTick before run_checkpoints.)
	void s;
}

function checkpoint_runtime_refresh(_s: SimState): void {
	// Phase 4: reset entity runtime state (restore idle without reallocating)
}

function checkpoint_ledger_rollover(s: SimState): void {
	do_ledger_rollover(s.ledger, s.world, s.time.day_counter);
}

function checkpoint_end_of_day(_s: SimState): void {
	// Phase 3+: flush carrier departure queues
}

function checkpoint_security_final(_s: SimState): void {
	// Phase 4: final daily security/housekeeping adequacy check
}

// ─── Checkpoint table ─────────────────────────────────────────────────────────

const CHECKPOINTS: Array<[number, (s: SimState) => void]> = [
	[0x000, checkpoint_start_of_day],
	[0x020, checkpoint_housekeeping_reset],
	[0x0f0, checkpoint_facility_ledger_rebuild],
	[0x3e8, checkpoint_entertainment_half1],
	[0x4b0, checkpoint_hotel_sale_reset],
	[0x578, checkpoint_entertainment_half2],
	[0x5dc, checkpoint_entertainment_phase1],
	[0x640, checkpoint_midday],
	[0x6a4, checkpoint_afternoon_notification],
	[0x708, checkpoint_noop],
	[0x76c, checkpoint_entertainment_phase2],
	[0x7d0, checkpoint_late_facility],
	[0x898, checkpoint_type6_advance],
	[0x8fc, checkpoint_day_counter],
	[0x9c4, checkpoint_runtime_refresh],
	[0x9e5, checkpoint_ledger_rollover],
	[0x9f6, checkpoint_end_of_day],
	[0x0a06, checkpoint_security_final],
];

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Fire all checkpoints whose tick falls in the half-open interval
 * (prev_tick, curr_tick].  Handles day wraparound: when curr_tick < prev_tick
 * the tick counter crossed zero, so checkpoints at tick 0 are included.
 */
export function run_checkpoints(
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
