// Day cycle constants
export const DAY_TICK_MAX = 0x0a28; // 2600 ticks per day
export const DAY_TICK_INCOME = 0x08fc; // 2300: checkpoint where day_counter increments

export interface TimeState {
	/** Current position within the day (0–2599). */
	day_tick: number;
	/** day_tick / 400, integer (0–6). */
	daypart_index: number;
	/** Increments at checkpoint 0x08fc each day. Used for calendar logic. */
	day_counter: number;
	/** (day_counter % 12) % 3 >= 2 ? 1 : 0 */
	calendar_phase_flag: number;
	/** 1–6 (6 = Tower). */
	star_count: number;
	/** Monotonically increasing tick counter since game start (for broadcast). */
	total_ticks: number;
}

export function createTimeState(): TimeState {
	return {
		day_tick: 0,
		daypart_index: 0,
		day_counter: 0,
		calendar_phase_flag: 0,
		star_count: 1,
		total_ticks: 0,
	};
}

/**
 * Advance time by one tick. Returns the new state and whether the
 * DAY_TICK_INCOME checkpoint was just crossed (triggers income collection).
 */
export function advanceOneTick(t: TimeState): {
	time: TimeState;
	incomeCheckpoint: boolean;
} {
	const total_ticks = t.total_ticks + 1;
	let day_tick = t.day_tick + 1;
	let day_counter = t.day_counter;
	let calendar_phase_flag = t.calendar_phase_flag;
	let incomeCheckpoint = false;

	if (day_tick >= DAY_TICK_MAX) {
		day_tick = 0;
	}

	if (day_tick === DAY_TICK_INCOME) {
		day_counter = t.day_counter + 1;
		calendar_phase_flag = (day_counter % 12) % 3 >= 2 ? 1 : 0;
		incomeCheckpoint = true;
	}

	return {
		time: {
			day_tick,
			daypart_index: Math.floor(day_tick / 400),
			day_counter,
			calendar_phase_flag,
			star_count: t.star_count,
			total_ticks,
		},
		incomeCheckpoint,
	};
}

export function pre_day_4(t: TimeState): boolean {
	return t.daypart_index < 4;
}
