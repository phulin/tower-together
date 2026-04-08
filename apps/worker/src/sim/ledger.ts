import { YEN_1001, YEN_1002 } from "./resources";
import type { WorldState } from "./world";

// ─── Three-ledger money model ─────────────────────────────────────────────────
//
// cash_balance         — live balance, capped at 99,999,999
// primary_ledger[f]    — running daily activity count / rate for family f
// secondary_ledger[f]  — income accumulated since last 3-day rollover
// tertiary_ledger[f]   — expenses accumulated since last 3-day rollover
// cash_balance_cycle_base — balance saved at each rollover (net delta reporting)
//
// YEN #1001 / #1002 values are in units of ¥1,000.

const YEN_UNIT = 1_000;
const CASH_CAP = 99_999_999;

export interface LedgerState {
	cash_balance: number;
	/** Activity / income rate indexed by object_type_code. */
	primary_ledger: number[];
	/** Income since last 3-day rollover, indexed by object_type_code. */
	secondary_ledger: number[];
	/** Expenses since last 3-day rollover, indexed by object_type_code. */
	tertiary_ledger: number[];
	/** Balance saved at last rollover. */
	cash_balance_cycle_base: number;
}

export function createLedgerState(starting_cash: number): LedgerState {
	return {
		cash_balance: starting_cash,
		primary_ledger: new Array(256).fill(0),
		secondary_ledger: new Array(256).fill(0),
		tertiary_ledger: new Array(256).fill(0),
		cash_balance_cycle_base: starting_cash,
	};
}

// ─── Income ───────────────────────────────────────────────────────────────────

/**
 * Credit checkout/activation income for a placed object using YEN #1001.
 * Called by entity checkout handlers (Phase 4). tile_name is the canonical
 * string key (e.g. "hotel_single", "office").
 */
export function add_cashflow_from_family_resource(
	ledger: LedgerState,
	tileName: string,
	variantIndex: number,
	familyCode: number,
): void {
	const payouts = YEN_1001[tileName];
	if (!payouts) return;
	const amount = payouts[Math.min(variantIndex, 3)] * YEN_UNIT;
	ledger.cash_balance = Math.min(CASH_CAP, ledger.cash_balance + amount);
	if (familyCode >= 0 && familyCode < 256) {
		ledger.secondary_ledger[familyCode] += amount;
		ledger.primary_ledger[familyCode] += amount;
	}
}

// ─── Expense sweep ────────────────────────────────────────────────────────────

/**
 * Charge operating expenses for all placed tiles (YEN #1002).
 * Called at checkpoint 0x09e5 every 3 days.
 */
export function do_expense_sweep(ledger: LedgerState, world: WorldState): void {
	for (const obj of Object.values(world.placed_objects)) {
		const code = obj.object_type_code;
		// Carriers: use elevator_local / elevator_express / escalator keys
		let expenseKey: string;
		if (code === 0x01) {
			expenseKey = "elevator_local";
		} else if (code === 0x02) {
			expenseKey = "escalator";
		} else {
			// Map code → tile name via FAMILY_CODE_TO_TILE (imported lazily to avoid cycle)
			expenseKey = _codeToTile(code);
		}
		const rate = YEN_1002[expenseKey];
		if (!rate) continue;
		const amount = rate * YEN_UNIT;
		ledger.cash_balance = Math.max(0, ledger.cash_balance - amount);
		if (code >= 0 && code < 256) {
			ledger.tertiary_ledger[code] += amount;
		}
	}
}

// ─── Facility ledger rebuild ──────────────────────────────────────────────────

/**
 * Rebuild primary_ledger count by sweeping all placed_objects.
 * Called at checkpoint 0x00f0 (start of day).
 */
export function rebuild_facility_ledger(
	ledger: LedgerState,
	world: WorldState,
): void {
	ledger.primary_ledger.fill(0);
	for (const obj of Object.values(world.placed_objects)) {
		const code = obj.object_type_code;
		if (code >= 0 && code < 256) {
			ledger.primary_ledger[code] += 1;
		}
	}
}

// ─── 3-day rollover ───────────────────────────────────────────────────────────

/**
 * Called at checkpoint 0x09e5.
 * If this is a 3-day boundary (day_counter % 3 === 0), run the full expense
 * sweep, save the cycle base, and reset rolling ledgers.
 */
export function do_ledger_rollover(
	ledger: LedgerState,
	world: WorldState,
	dayCounter: number,
): void {
	if (dayCounter % 3 !== 0) return;
	do_expense_sweep(ledger, world);
	ledger.cash_balance_cycle_base = ledger.cash_balance;
	ledger.secondary_ledger.fill(0);
	ledger.tertiary_ledger.fill(0);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Inline mapping to avoid a circular import with resources.ts
const CODE_TO_TILE: Record<number, string> = {
	3: "hotel_single",
	4: "hotel_twin",
	5: "hotel_suite",
	6: "restaurant",
	7: "office",
	9: "condo",
	10: "fast_food",
	12: "retail",
	14: "metro",
	18: "cinema",
	20: "security",
	21: "housekeeping",
	24: "parking",
	29: "entertainment",
	31: "vip_single",
	32: "vip_twin",
	33: "vip_suite",
	40: "fire_suppressor",
};

function _codeToTile(code: number): string {
	return CODE_TO_TILE[code] ?? "";
}
