// Grid and floor model constants
export const GRID_WIDTH = 64;
export const GRID_HEIGHT = 120; // floor indices 0–119
export const UNDERGROUND_FLOORS = 10; // floors 0–9 underground; floor 10 = ground ("0")
export const UNDERGROUND_Y = GRID_HEIGHT - UNDERGROUND_FLOORS; // Y=110: first underground row
export const GROUND_Y = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS; // Y=109: ground lobby row

/** True iff the given Y is a valid lobby row (ground or every 15 floors above). */
export function isValidLobbyY(y: number): boolean {
	const floorsAboveGround = GROUND_Y - y;
	return floorsAboveGround >= 0 && floorsAboveGround % 15 === 0;
}

// ─── PlacedObjectRecord ───────────────────────────────────────────────────────

/**
 * Per-object simulation record for every placed non-infrastructure tile.
 * Mirrors the SimTower object record layout from the spec.
 * Keyed in WorldState.placed_objects by "anchorX,y".
 */
export interface PlacedObjectRecord {
	/** Leftmost tile x (anchor column). */
	left_tile_index: number;
	/** Rightmost tile x (anchor x + width − 1). */
	right_tile_index: number;
	/** SimTower family/object-type code (e.g. 3 = hotel_single, 6 = restaurant). */
	object_type_code: number;
	/** stay_phase / open-close state; 0 = idle/vacant. */
	object_state_code: number;
	/** Index into WorldState.sidecars; −1 if no sidecar. */
	linked_record_index: number;
	aux_value_or_timer: number;
	/** Base x within the multi-tile span (= left_tile_index). */
	subtype_tile_offset: number;
	needs_refresh_flag: number;
	/** Operational rating: 0 = C (poor), 1 = B, 2 = A (excellent). */
	pairing_status: number;
	pairing_active_flag: number;
	activation_tick_count: number;
	/** Pricing tier: 0 = best, 3 = worst. */
	variant_index: number;
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
}
