export type TileType =
	| "empty"
	| "floor"
	| "lobby"
	| "stairs"
	| "hotel_single"
	| "hotel_twin"
	| "hotel_suite";

export type SelectedTool = TileType;

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

// Width in grid cells for each placeable tile type
export const TILE_WIDTHS: Record<string, number> = {
	floor: 1,
	lobby: 1,
	stairs: 2,
	hotel_single: 1,
	hotel_twin: 2,
	hotel_suite: 3,
};

// Build cost in dollars
export const TILE_COSTS: Record<string, number> = {
	floor: 5_000,
	lobby: 0,
	stairs: 0,
	hotel_single: 50_000,
	hotel_twin: 80_000,
	hotel_suite: 120_000,
};

export type ServerMessage =
	| {
			type: "init_state";
			towerId: string;
			name: string;
			simTime: number;
			cash: number;
			width: number;
			height: number;
			cells: Array<{ x: number; y: number; tileType: string; isAnchor: boolean; isOverlay?: boolean }>;
	  }
	| {
			type: "state_patch";
			cells: Array<{ x: number; y: number; tileType: string; isAnchor: boolean; isOverlay?: boolean }>;
	  }
	| {
			type: "command_result";
			accepted: boolean;
			patch?: { cells: Array<{ x: number; y: number; tileType: string; isAnchor: boolean; isOverlay?: boolean }> };
			reason?: string;
	  }
	| { type: "presence_update"; playerCount: number }
	| { type: "time_update"; simTime: number }
	| { type: "economy_update"; cash: number }
	| { type: "pong" };

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| { type: "place_tile"; x: number; y: number; tileType: string }
	| { type: "remove_tile"; x: number; y: number }
	| { type: "ping" };
