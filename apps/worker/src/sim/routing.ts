import {
	GRID_HEIGHT,
	MAX_SPECIAL_LINKS,
	type WorldState,
	yToFloor,
} from "./world";

// ─── Rebuild special-link segment table (§3.1) ────────────────────────────────

/**
 * Populate world.special_links from world.carriers (elevators) and world.overlays (escalators).
 * Each carrier registers one segment; escalators are grouped by column.
 * bit 0 of flags: 1 = express-mode segment (carrier_mode 2), 0 = local-mode.
 *
 * Escalators are special-link segments with carrier_id = -1. They always use local-mode
 * routing (flags bit 0 = 0). Grouped by column; one segment covers the full contiguous span.
 */
export function rebuild_special_links(world: WorldState): void {
	world.special_links = Array.from({ length: MAX_SPECIAL_LINKS }, () => ({
		active: false,
		flags: 0,
		start_floor: 0,
		height_metric: 0,
		carrier_id: -1,
	}));

	let idx = 0;

	// Elevator carriers
	for (const carrier of world.carriers) {
		if (idx >= MAX_SPECIAL_LINKS) break;
		const seg = world.special_links[idx++];
		seg.active = true;
		// mode 2 (Service Elevator) = express-mode; modes 0/1 = local-mode
		seg.flags = carrier.carrier_mode === 2 ? 1 : 0;
		seg.start_floor = carrier.bottom_served_floor;
		seg.height_metric = carrier.top_served_floor - carrier.bottom_served_floor;
		seg.carrier_id = carrier.carrier_id;
	}

	// Escalator overlays: group by column, one segment per column covering the full span
	const escColumns = new Map<number, Set<number>>();
	for (const [key, type] of Object.entries(world.overlays)) {
		if (type !== "escalator") continue;
		const [xStr, yStr] = key.split(",");
		const col = Number(xStr);
		const floor = yToFloor(Number(yStr));
		if (!escColumns.has(col)) escColumns.set(col, new Set());
		// biome-ignore lint/style/noNonNullAssertion: just inserted
		escColumns.get(col)!.add(floor);
	}
	for (const [, floors] of escColumns) {
		if (idx >= MAX_SPECIAL_LINKS) break;
		const sorted = [...floors].sort((a, b) => a - b);
		const bottom = sorted[0];
		const top = sorted[sorted.length - 1];
		const seg = world.special_links[idx++];
		seg.active = true;
		seg.flags = 0; // escalators are always local-mode
		seg.start_floor = bottom;
		seg.height_metric = top - bottom;
		seg.carrier_id = -1;
	}
}

// ─── Rebuild floor walkability flags (§3.1) ───────────────────────────────────

/**
 * For every floor covered by at least one active special-link segment:
 *   bit 0 → reachable by a local elevator or escalator
 *   bit 1 → reachable by an express elevator
 */
export function rebuild_walkability_flags(world: WorldState): void {
	world.floor_walkability_flags = new Array(GRID_HEIGHT).fill(0);

	for (const seg of world.special_links) {
		if (!seg.active) continue;
		const bit = (seg.flags & 1) !== 0 ? 2 : 1; // express → bit 1, local → bit 0
		const hi = seg.start_floor + seg.height_metric;
		for (let f = seg.start_floor; f <= hi; f++) {
			if (f >= 0 && f < GRID_HEIGHT) world.floor_walkability_flags[f] |= bit;
		}
	}
}

// ─── Rebuild transfer-group cache (§3.2) ─────────────────────────────────────

/**
 * Each floor's entry is a bitmask of carrier IDs whose range includes that floor.
 * Parking objects (family 0x18 = code 24) are accounted for here too; they don't
 * change the bitmask but mark that floor as an explicit transfer point in Phase 4.
 * Max 32 carriers supported by 32-bit bitmask.
 */
export function rebuild_transfer_group_cache(world: WorldState): void {
	world.transfer_group_cache = new Array(GRID_HEIGHT).fill(0);

	for (const carrier of world.carriers) {
		if (carrier.carrier_id >= 32) continue; // overflow guard
		const bit = 1 << carrier.carrier_id;
		for (
			let f = carrier.bottom_served_floor;
			f <= carrier.top_served_floor;
			f++
		) {
			if (f >= 0 && f < GRID_HEIGHT) world.transfer_group_cache[f] |= bit;
		}
	}
}

// ─── Walkability checks (§3.1) ────────────────────────────────────────────────

/**
 * True if every floor in [from, to] (inclusive) has bit 0 set —
 * i.e., is reachable by at least one local elevator or escalator.
 */
export function is_floor_span_walkable_for_local_route(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	const lo = Math.min(fromFloor, toFloor);
	const hi = Math.max(fromFloor, toFloor);
	for (let f = lo; f <= hi; f++) {
		if (!(world.floor_walkability_flags[f] & 1)) return false;
	}
	return true;
}

/**
 * True if every floor in [from, to] (inclusive) has bit 1 set —
 * i.e., is reachable by at least one express elevator.
 */
export function is_floor_span_walkable_for_express_route(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): boolean {
	const lo = Math.min(fromFloor, toFloor);
	const hi = Math.max(fromFloor, toFloor);
	for (let f = lo; f <= hi; f++) {
		if (!(world.floor_walkability_flags[f] & 2)) return false;
	}
	return true;
}

// ─── Route candidate selection (§3.3) ────────────────────────────────────────

export interface RouteCandidate {
	carrier_id: number;
	cost: number;
}

/**
 * Find the lowest-cost route from from_floor to to_floor.
 *
 * Priority order (lower cost wins):
 *   Local special-link  → |Δfloor| × 8
 *   Express special-link → |Δfloor| × 8 + 0x280
 *   Carrier direct       → |Δfloor| × 8 + 0x280
 *   Carrier transfer     → |Δfloor| × 8 + 3000
 *
 * Returns null if no route exists.
 */
export function select_best_route_candidate(
	world: WorldState,
	fromFloor: number,
	toFloor: number,
): RouteCandidate | null {
	if (fromFloor === toFloor) return null;

	const delta = Math.abs(fromFloor - toFloor);
	const lo = Math.min(fromFloor, toFloor);
	const hi = Math.max(fromFloor, toFloor);
	let best: RouteCandidate | null = null;

	function tryCandidate(carrierId: number, cost: number): void {
		if (!best || cost < best.cost) best = { carrier_id: carrierId, cost };
	}

	// Check special-link segments first (covers local + express carriers)
	for (const seg of world.special_links) {
		if (!seg.active) continue;
		if (seg.start_floor > lo || seg.start_floor + seg.height_metric < hi)
			continue;
		const isExpress = (seg.flags & 1) !== 0;
		tryCandidate(seg.carrier_id, isExpress ? delta * 8 + 0x280 : delta * 8);
	}

	// Check direct carrier connections (safety net if special_links not rebuilt)
	for (const carrier of world.carriers) {
		if (carrier.bottom_served_floor > lo || carrier.top_served_floor < hi)
			continue;
		tryCandidate(carrier.carrier_id, delta * 8 + 0x280);
	}

	// Check transfer routes via transfer_group_cache
	const aMask = world.transfer_group_cache[fromFloor] ?? 0;
	const bMask = world.transfer_group_cache[toFloor] ?? 0;
	for (let t = 0; t < GRID_HEIGHT; t++) {
		if (t === fromFloor || t === toFloor) continue;
		const tMask = world.transfer_group_cache[t] ?? 0;
		const leg1 = aMask & tMask; // carriers covering fromFloor → t
		const leg2 = tMask & bMask; // carriers covering t → toFloor
		// Valid transfer: leg1 and leg2 non-zero and distinct (different carriers)
		if (leg1 && leg2 && (leg1 & leg2) === 0) {
			tryCandidate(ctz(leg1), delta * 8 + 3000);
			break; // first transfer found is sufficient for cost comparison
		}
	}

	return best;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Count trailing zeros — index of lowest set bit. */
function ctz(n: number): number {
	if (n === 0) return 32;
	return Math.log2(n & -n) | 0;
}
