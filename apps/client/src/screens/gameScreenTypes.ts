export interface Toast {
	id: number;
	message: string;
	variant: "error" | "info";
}

export interface ActivePrompt {
	promptId: string;
	promptKind: "bomb_ransom" | "fire_rescue";
	message: string;
	cost?: number;
}

export interface CellInfoData {
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
