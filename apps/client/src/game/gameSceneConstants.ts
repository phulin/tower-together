import type { EntityStateData } from "../types";
import { TILE_WIDTHS } from "../types";

export const TILE_WIDTH = 4;
export const TILE_HEIGHT = TILE_WIDTH * 4;

export const TILE_LABELS: Partial<Record<string, string>> = {
	hotelSingle: "R",
	hotelTwin: "T",
	hotelSuite: "S",
	restaurant: "R",
	fastFood: "F",
	retail: "$",
	office: "O",
	condo: "C",
	cinema: "M",
	recyclingCenterUpper: "R",
	recyclingCenterLower: "r",
	metro: "U",
	fireSuppressor: "F",
};

export const TILE_LABEL_COLORS: Partial<Record<string, string>> = {
	hotelSingle: "#ffffff",
	hotelTwin: "#ffffff",
	hotelSuite: "#ffffff",
	restaurant: "#4a2707",
	fastFood: "#4a2707",
	retail: "#233000",
	office: "#23313d",
	condo: "#4a4108",
	cinema: "#ffffff",
	recyclingCenterUpper: "#ffffff",
	recyclingCenterLower: "#1f3945",
	metro: "#124040",
	fireSuppressor: "#ffffff",
};

export const TILE_COLORS: Record<string, number> = {
	floor: 0x555555,
	lobby: 0xc9a77a,
	hotelSingle: 0xf28b82,
	hotelTwin: 0xe35d5b,
	hotelSuite: 0xb63c3c,
	restaurant: 0xe58a3a,
	fastFood: 0xf2b24d,
	retail: 0xa0c040,
	office: 0xa8b7c4,
	condo: 0xe7cf6b,
	cinema: 0xc040a0,
	entertainment: 0xa040c0,
	recyclingCenterUpper: 0xc04040,
	recyclingCenterLower: 0x8cb0c0,
	parking: 0x707080,
	metro: 0x60c0c0,
	fireSuppressor: 0xe06060,
	elevator: 0xb0a070,
	escalator: 0xa0b070,
};

export const COLOR_SKY = 0x5ba8d4;
export const COLOR_UNDERGROUND = 0x3d2010;
export const COLOR_GRID_LINE = 0x333333;
export const COLOR_HOVER = 0xffff00;
export const ENTITY_STRESS_COLORS: Record<
	EntityStateData["stressLevel"],
	number
> = {
	low: 0x111111,
	medium: 0xff5fa2,
	high: 0xd81919,
};
export const CAR_COLOR = 0xf6d463;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const DEFAULT_TICK_INTERVAL_MS = 50;
export const LOCAL_TICKS_PER_FLOOR = 8;
export const EXPRESS_TICKS_PER_FLOOR = 4;
export const LABEL_PANEL_WIDTH = 24;

export const FAMILY_WIDTHS: Record<number, number> = {
	3: TILE_WIDTHS.hotelSingle,
	4: TILE_WIDTHS.hotelTwin,
	5: TILE_WIDTHS.hotelSuite,
	7: TILE_WIDTHS.office,
	9: TILE_WIDTHS.condo,
};

export const FAMILY_POPULATION: Record<number, number> = {
	3: 1,
	4: 2,
	5: 3,
	7: 6,
	9: 3,
};
