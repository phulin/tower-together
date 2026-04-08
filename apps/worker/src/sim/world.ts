// Grid and floor model constants
export const GRID_WIDTH = 64;
export const GRID_HEIGHT = 120; // floor indices 0–119; floor 10 = ground ("0"), floor 119 = top

/** Convert grid Y coordinate to floor index (0=bottom underground, 119=top). */
export function yToFloor(y: number): number {
	return GRID_HEIGHT - 1 - y;
}

/** Convert floor index to grid Y coordinate. */
export function floorToY(floor: number): number {
	return GRID_HEIGHT - 1 - floor;
}
export const UNDERGROUND_FLOORS = 10; // floors 0–9 underground; floor 10 = ground ("0")
export const UNDERGROUND_Y = GRID_HEIGHT - UNDERGROUND_FLOORS; // Y=110: first underground row
export const GROUND_Y = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS; // Y=109: ground lobby row

/** True iff the given Y is a valid lobby row (ground or every 15 floors above). */
export function isValidLobbyY(y: number): boolean {
	const floorsAboveGround = GROUND_Y - y;
	return floorsAboveGround >= 0 && floorsAboveGround % 15 === 0;
}

// ─── Carrier types ────────────────────────────────────────────────────────────

export interface CarrierCar {
	current_floor: number;
	door_wait_counter: number;
	speed_counter: number;
	assigned_count: number;
	/** 0 = upward (floor increases), 1 = downward. */
	direction_flag: number;
	target_floor: number;
	prev_floor: number;
	departure_flag: number;
	departure_timestamp: number;
	schedule_flag: number;
	/** Waiting entity count indexed by floor slot. */
	waiting_count: number[];
}

export interface CarrierRecord {
	carrier_id: number;
	/** X column of the shaft. */
	column: number;
	/**
	 * 0 = Express Elevator, 1 = Standard Elevator, 2 = Service Elevator.
	 * (From placement dispatcher FUN_1200_082c.)
	 * Route scorer treats modes 0/1 as "local-mode" (carrier_mode != 2) and
	 * mode 2 as "express-mode" long-hop carrier (carrier_mode == 2).
	 * Escalators are NOT carriers — they are special-link segments.
	 */
	carrier_mode: 0 | 1 | 2;
	top_served_floor: number;
	bottom_served_floor: number;
	/** 14 entries: 7 dayparts × 2 calendar phases. 1 = floor served, 0 = skipped. */
	served_floor_flags: number[];
	primary_route_status_by_floor: number[];
	secondary_route_status_by_floor: number[];
	cars: CarrierCar[];
}

// ─── Routing types ────────────────────────────────────────────────────────────

export const MAX_SPECIAL_LINKS = 64;

export interface SpecialLinkSegment {
	active: boolean;
	/** bit 0 = express flag; bits 7:1 = half-span. */
	flags: number;
	start_floor: number;
	/** Floor span (top = start_floor + height_metric). */
	height_metric: number;
	carrier_id: number;
}

// ─── PlacedObjectRecord ───────────────────────────────────────────────────────

/**
 * 18-byte (0x12) per-object simulation record for every placed non-infrastructure tile.
 * Offset layout confirmed via FUN_1200_1847 and FUN_1200_293e placer initialization.
 * Keyed in WorldState.placed_objects by "anchorX,y".
 *
 * Offsets +0x00..+0x05 hold family-specific runtime bytes (used by entity records in
 * Phase 4); they are not named fields here.
 */
export interface PlacedObjectRecord {
	/** +0x06 word: leftmost tile x (anchor column). */
	left_tile_index: number;
	/** +0x08 word: rightmost tile x (anchor x + width − 1). */
	right_tile_index: number;
	/** +0x0a byte: placement-time SimTower object-type code (e.g. 3 = hotel_single, 6 = restaurant). */
	object_type_code: number;
	/** +0x0b byte: per-family lifecycle byte (stay_phase / open-close state). Init = 0. */
	stay_phase: number;
	/** +0x0c word: tool-counter rotation index at init; runtime cycle counter. Init = 0. */
	aux_value_or_timer: number;
	/** +0x12 byte: index into WorldState.sidecars; init = −1 (no sidecar). */
	linked_record_index: number;
	/** +0x13 byte: dirty bit; init = 1 so the first refresh sweep picks it up. */
	needs_refresh_flag: number;
	/** +0x14 byte: first-activation latch; init = 1. */
	pairing_active_flag: number;
	/**
	 * +0x15 byte: operational rating — 0 = bad/refund-eligible, 1 = ok, 2 = good.
	 * Init = −1 (invalid); first scoring sweep populates.
	 */
	pairing_status: number;
	/**
	 * +0x16 byte: pricing tier 0–3 (0 = best payout, 3 = worst).
	 * Init = 1 for families 3/4/5/7/9/10; init = 4 (no payout) for all others.
	 */
	variant_index: number;
	/** +0x17 byte: cumulative activation count; init = 0, capped at 0x78. */
	activation_tick_count: number;
}

// ─── Gate flags ───────────────────────────────────────────────────────────────

/**
 * Global simulation gate flags, initialized by new_game_initializer.
 * These drive the per-star qualitative advancement conditions and security state.
 */
export interface GateFlags {
	/** [0xc198..0xc19b] — purpose unresolved; init = 0xffffffff (all-ones). */
	unknown_c198: number;
	/** metro_placed [0xc19e] — set when a type-0x0e (metro) object is placed. */
	metro_placed: number;
	/** office_placed [0xc19f] — set when a type-0x07 (office) object is placed. */
	office_placed: number;
	/** office_service_ok [0xc197] — updated by office-service evaluation every 9th day. */
	office_service_ok: number;
	/** security_adequate [0xc1a0] — set by update_security_housekeeping_state. */
	security_adequate: number;
	/** routes_viable [0xc1a1] — set by rebuild_path_seed_bucket_table when star > 2. */
	routes_viable: number;
	/** g_vip_system_eligibility [0xbc5c] — floor index of placed VIP suite; 0xffff = none. */
	vip_suite_floor: number;
	/** g_eval_entity_index [0xbc60] — runtime index of evaluation entity; 0xffff = none. */
	eval_entity_index: number;
	/** g_security_ledger_scale [0xbc68] — incremented each time a security guard is placed. */
	security_ledger_scale: number;
	/** g_facility_progress_override — set every 8 days when star < 5. */
	facility_progress_override: number;
}

export function createGateFlags(): GateFlags {
	return {
		unknown_c198: 0xffffffff,
		metro_placed: 0,
		office_placed: 0,
		office_service_ok: 0,
		security_adequate: 0,
		routes_viable: 0,
		vip_suite_floor: 0xffff, // −1: no VIP suite
		eval_entity_index: 0xffff, // −1: no evaluation in progress
		security_ledger_scale: 0,
		facility_progress_override: 0,
	};
}

// ─── Sidecar records ──────────────────────────────────────────────────────────

export interface CommercialVenueRecord {
	kind: "commercial_venue";
	/** 0xff = invalid / demolished. */
	owner_subtype_index: number;
	capacity: number;
	visit_count: number;
}

export interface ServiceRequestEntry {
	kind: "service_request";
	owner_subtype_index: number;
}

export interface EntertainmentLinkRecord {
	kind: "entertainment_link";
	owner_subtype_index: number;
	/** 0xff = no pair yet. */
	paired_subtype_index: number;
}

export type SidecarRecord =
	| CommercialVenueRecord
	| ServiceRequestEntry
	| EntertainmentLinkRecord;

// ─── WorldState ───────────────────────────────────────────────────────────────

/** All placed tile data for one tower. */
export interface WorldState {
	towerId: string;
	name: string;
	width: number;
	height: number;
	/** Global simulation gate flags (star advancement, security, etc.). */
	gate_flags: GateFlags;
	/** "x,y" → tileType for every occupied cell (anchors and extensions alike). */
	cells: Record<string, string>;
	/** Extension cell key → anchor cell key. */
	cellToAnchor: Record<string, string>;
	/** Anchor cell key → overlay tileType (e.g. "stairs"). */
	overlays: Record<string, string>;
	/** Extension cell key → anchor cell key for overlays. */
	overlayToAnchor: Record<string, string>;
	/**
	 * "anchorX,y" → PlacedObjectRecord for every simulated (non-infrastructure)
	 * placed tile. Infrastructure tiles (floor, lobby, stairs) do not have records.
	 */
	placed_objects: Record<string, PlacedObjectRecord>;
	/** Sidecar records, indexed by PlacedObjectRecord.linked_record_index. */
	sidecars: SidecarRecord[];
	/** One CarrierRecord per elevator/escalator shaft. Rebuilt from cells on mutation. */
	carriers: CarrierRecord[];
	/** Special-link segment table (max MAX_SPECIAL_LINKS entries). Rebuilt from carriers. */
	special_links: SpecialLinkSegment[];
	/** Per-floor walkability bitmask (bit 0 = local, bit 1 = express). Size = GRID_HEIGHT. */
	floor_walkability_flags: number[];
	/** Per-floor bitmask of carrier IDs that serve each floor. Size = GRID_HEIGHT. */
	transfer_group_cache: number[];
}
