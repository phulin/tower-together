// ─── WebSocket messages from client ──────────────────────────────────────────

export type ClientMessage =
	| { type: "join_tower"; playerId: string; displayName: string }
	| { type: "place_tile"; x: number; y: number; tileType: string }
	| { type: "remove_tile"; x: number; y: number }
	| { type: "ping" }
	| { type: "set_speed"; multiplier: 1 | 3 | 10 }
	| { type: "prompt_response"; promptId: string; accepted: boolean }
	| { type: "query_cell"; x: number; y: number }
	| { type: "set_rent_level"; x: number; y: number; rentLevel: number }
	| { type: "add_elevator_car"; x: number }
	| { type: "remove_elevator_car"; x: number };

// ─── WebSocket messages to client ────────────────────────────────────────────

export type CellData = {
	x: number;
	y: number;
	tileType: string;
	isAnchor: boolean;
	isOverlay?: boolean;
};

export type EntityStateData = {
	id: string;
	floorAnchor: number;
	selectedFloor: number;
	subtypeIndex: number;
	baseOffset: number;
	familyCode: number;
	stateCode: number;
	routeMode: number;
	carrierId: number | null;
	assignedCarIndex: number;
	boardedOnCarrier: boolean;
	stressLevel: "low" | "medium" | "high";
};

export type CarrierCarStateData = {
	carrierId: number;
	carIndex: number;
	carCount: number;
	column: number;
	carrierMode: 0 | 1 | 2;
	currentFloor: number;
	targetFloor: number;
	speedCounter: number;
	doorWaitCounter: number;
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
			cells: CellData[];
			entities: EntityStateData[];
			carriers: CarrierCarStateData[];
	  }
	| { type: "state_patch"; cells: CellData[] }
	| { type: "entity_update"; entities: EntityStateData[] }
	| { type: "carrier_update"; carriers: CarrierCarStateData[] }
	| {
			type: "command_result";
			accepted: boolean;
			patch?: { cells: CellData[] };
			reason?: string;
	  }
	| { type: "presence_update"; playerCount: number }
	| { type: "time_update"; simTime: number }
	| { type: "economy_update"; cash: number }
	| { type: "notification"; kind: string; message: string }
	| {
			type: "prompt";
			promptId: string;
			promptKind: "bomb_ransom" | "fire_rescue";
			message: string;
			cost?: number;
	  }
	| { type: "prompt_dismissed"; promptId: string }
	| {
			type: "cell_info";
			x: number;
			y: number;
			tileType: string;
			objectInfo?: {
				objectTypeCode: number;
				rentLevel: number;
				evalLevel: number;
				unitStatus: number;
				activationTickCount: number;
			};
			carrierInfo?: {
				carrierId: number;
				carrierMode: 0 | 1 | 2;
				topServedFloor: number;
				bottomServedFloor: number;
				carCount: number;
				maxCars: number;
				servedFloors: number[];
			};
	  }
	| { type: "pong" };
