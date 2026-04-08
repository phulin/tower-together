// Day cycle constants
export const DAY_TICK_MAX = 0x0a28; // 2600 ticks per day
export const DAY_TICK_INCOME = 0x08fc; // 2300: checkpoint where day_counter increments

/**
 * Starting day_tick for a new game (from new_game_initializer at 0x10d8_07f6).
 * Value 2533 = daypart_index 6 — game starts mid-day; first full daily checkpoint
 * sequence (0x000..0xa27) runs only on the second sim day.
 */
export const NEW_GAME_DAY_TICK = 0x9e5; // 2533

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

/** Zero-based time state for unit tests and generic initialization. */
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
 * New-game time state matching new_game_initializer at 0x10d8_07f6.
 * Starts at tick 0x9e5 (daypart 6) so the first full day cycle begins on day 2.
 */
export function createNewGameTimeState(): TimeState {
	return {
		day_tick: NEW_GAME_DAY_TICK,
		daypart_index: Math.floor(NEW_GAME_DAY_TICK / 400), // = 6
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
	const totalTicks = t.total_ticks + 1;
	let dayTick = t.day_tick + 1;
	let dayCounter = t.day_counter;
	let calendarPhaseFlag = t.calendar_phase_flag;
	let incomeCheckpoint = false;

	if (dayTick >= DAY_TICK_MAX) {
		dayTick = 0;
	}

	if (dayTick === DAY_TICK_INCOME) {
		dayCounter = t.day_counter + 1;
		calendarPhaseFlag = (dayCounter % 12) % 3 >= 2 ? 1 : 0;
		incomeCheckpoint = true;
	}

	return {
		time: {
			day_tick: dayTick,
			daypart_index: Math.floor(dayTick / 400),
			day_counter: dayCounter,
			calendar_phase_flag: calendarPhaseFlag,
			star_count: t.star_count,
			total_ticks: totalTicks,
		},
		incomeCheckpoint,
	};
}

export function pre_day_4(t: TimeState): boolean {
	return t.daypart_index < 4;
}
