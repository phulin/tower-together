import { YEN_1001, YEN_1002 } from "./resources";
import type { WorldState } from "./world";

// ─── Three-ledger money model ─────────────────────────────────────────────────
//
// cashBalance          — live balance, capped at 99,999,999
// primaryLedger[f]     — running daily activity count / rate for family f
// secondaryLedger[f]   — income accumulated since last 3-day rollover
// tertiaryLedger[f]    — expenses accumulated since last 3-day rollover
// cashBalanceCycleBase — balance saved at each rollover (net delta reporting)
//
// YEN #1001 / #1002 values are in units of ¥1,000.

const YEN_UNIT = 1_000;
const CASH_CAP = 99_999_999;

export interface LedgerState {
	cashBalance: number;
	/** Activity / income rate indexed by objectTypeCode. */
	primaryLedger: number[];
	/** Income since last 3-day rollover, indexed by objectTypeCode. */
	secondaryLedger: number[];
	/** Expenses since last 3-day rollover, indexed by objectTypeCode. */
	tertiaryLedger: number[];
	/** Balance saved at last rollover. */
	cashBalanceCycleBase: number;
}

export function createLedgerState(startingCash: number): LedgerState {
	return {
		cashBalance: startingCash,
		primaryLedger: new Array(256).fill(0),
		secondaryLedger: new Array(256).fill(0),
		tertiaryLedger: new Array(256).fill(0),
		cashBalanceCycleBase: startingCash,
	};
}

// ─── Income ───────────────────────────────────────────────────────────────────

/**
 * Credit checkout/activation income for a placed object using YEN #1001.
 * Called by entity checkout handlers (Phase 4). tileName is the canonical
 * string key (e.g. "hotelSingle", "office").
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
	ledger.cashBalance = Math.min(CASH_CAP, ledger.cashBalance + amount);
	if (familyCode >= 0 && familyCode < 256) {
		ledger.secondaryLedger[familyCode] += amount;
		ledger.primaryLedger[familyCode] += amount;
	}
}

// ─── Expense sweep ────────────────────────────────────────────────────────────

/**
 * Charge operating expenses for all placed tiles (YEN #1002).
 * Called at checkpoint 0x09e5 every 3 days.
 */
export function do_expense_sweep(ledger: LedgerState, world: WorldState): void {
	for (const obj of Object.values(world.placedObjects)) {
		const code = obj.objectTypeCode;
		// Carriers: use elevatorLocal / elevatorExpress / escalator keys
		let expenseKey: string;
		if (code === 0x01) {
			expenseKey = "elevatorLocal";
		} else if (code === 0x02) {
			expenseKey = "escalator";
		} else {
			// Map code → tile name via FAMILY_CODE_TO_TILE (imported lazily to avoid cycle)
			expenseKey = _codeToTile(code);
		}
		const rate = YEN_1002[expenseKey];
		if (!rate) continue;
		const amount = rate * YEN_UNIT;
		ledger.cashBalance = Math.max(0, ledger.cashBalance - amount);
		if (code >= 0 && code < 256) {
			ledger.tertiaryLedger[code] += amount;
		}
	}
}

// ─── Facility ledger rebuild ──────────────────────────────────────────────────

/**
 * Rebuild primaryLedger count by sweeping all placedObjects.
 * Called at checkpoint 0x00f0 (start of day).
 */
export function rebuild_facility_ledger(
	ledger: LedgerState,
	world: WorldState,
): void {
	ledger.primaryLedger.fill(0);
	for (const obj of Object.values(world.placedObjects)) {
		const code = obj.objectTypeCode;
		if (code >= 0 && code < 256) {
			ledger.primaryLedger[code] += 1;
		}
	}
}

// ─── 3-day rollover ───────────────────────────────────────────────────────────

/**
 * Called at checkpoint 0x09e5.
 * If this is a 3-day boundary (dayCounter % 3 === 0), run the full expense
 * sweep, save the cycle base, and reset rolling ledgers.
 */
export function do_ledger_rollover(
	ledger: LedgerState,
	world: WorldState,
	dayCounter: number,
): void {
	if (dayCounter % 3 !== 0) return;
	do_expense_sweep(ledger, world);
	ledger.cashBalanceCycleBase = ledger.cashBalance;
	ledger.secondaryLedger.fill(0);
	ledger.tertiaryLedger.fill(0);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

// Inline mapping to avoid a circular import with resources.ts
const CODE_TO_TILE: Record<number, string> = {
	3: "hotelSingle",
	4: "hotelTwin",
	5: "hotelSuite",
	6: "restaurant",
	7: "office",
	9: "condo",
	10: "fastFood",
	12: "retail",
	14: "metro",
	18: "cinema",
	20: "security",
	21: "housekeeping",
	24: "parking",
	29: "entertainment",
	31: "hotelSingle",
	32: "hotelTwin",
	33: "hotelSuite",
	40: "fireSuppressor",
};

function _codeToTile(code: number): string {
	return CODE_TO_TILE[code] ?? "";
}
