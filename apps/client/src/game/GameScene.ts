import Phaser from "phaser";
import {
	type CarrierCarStateData,
	type EntityStateData,
	GRID_HEIGHT,
	GRID_WIDTH,
	TILE_WIDTHS,
	UNDERGROUND_FLOORS,
	UNDERGROUND_Y,
} from "../types";

const TILE_WIDTH = 4;
const TILE_HEIGHT = TILE_WIDTH * 4;

const TILE_LABELS: Partial<Record<string, string>> = {
	hotelSingle: "R",
	hotelTwin: "T",
	hotelSuite: "S",
	restaurant: "R",
	fastFood: "F",
	retail: "$",
	office: "O",
	condo: "C",
	cinema: "M",
	security: "X",
	housekeeping: "H",
	metro: "U",
	fireSuppressor: "F",
};

const TILE_LABEL_COLORS: Partial<Record<string, string>> = {
	hotelSingle: "#ffffff",
	hotelTwin: "#ffffff",
	hotelSuite: "#ffffff",
	restaurant: "#4a2707",
	fastFood: "#4a2707",
	retail: "#233000",
	office: "#23313d",
	condo: "#4a4108",
	cinema: "#ffffff",
	security: "#ffffff",
	housekeeping: "#1f3945",
	metro: "#124040",
	fireSuppressor: "#ffffff",
};

// Tile fill colors
const TILE_COLORS: Record<string, number> = {
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
	security: 0xc04040,
	housekeeping: 0x8cb0c0,
	parking: 0x707080,
	metro: 0x60c0c0,
	fireSuppressor: 0xe06060,
	elevator: 0xb0a070,
	escalator: 0xa0b070,
};

const COLOR_SKY = 0x5ba8d4; // blue sky (above ground)
const COLOR_UNDERGROUND = 0x3d2010; // dark brown soil (underground)
const COLOR_GRID_LINE = 0x333333;
const COLOR_HOVER = 0xffff00;
const ENTITY_STRESS_COLORS: Record<EntityStateData["stressLevel"], number> = {
	low: 0x111111,
	medium: 0xff5fa2,
	high: 0xd81919,
};
const CAR_COLOR = 0xf6d463;

const FAMILY_WIDTHS: Record<number, number> = {
	3: TILE_WIDTHS.hotelSingle,
	4: TILE_WIDTHS.hotelTwin,
	5: TILE_WIDTHS.hotelSuite,
	7: TILE_WIDTHS.office,
	9: TILE_WIDTHS.condo,
};

const FAMILY_POPULATION: Record<number, number> = {
	3: 1,
	4: 2,
	5: 3,
	7: 6,
	9: 3,
};

const ELEVATOR_QUEUE_STATES = new Set([0x04, 0x05]);

export type CellClickHandler = (x: number, y: number, shift: boolean) => void;

const LABEL_PANEL_WIDTH = 24;

export class GameScene extends Phaser.Scene {
	private cellGraphics!: Phaser.GameObjects.Graphics;
	private entityGraphics!: Phaser.GameObjects.Graphics;
	private carGraphics!: Phaser.GameObjects.Graphics;
	private gridGraphics!: Phaser.GameObjects.Graphics;
	private hoverGraphics!: Phaser.GameObjects.Graphics;
	private floorLabelBg!: Phaser.GameObjects.Rectangle;
	private floorLabels: Phaser.GameObjects.Text[] = [];
	private tileLabels: Phaser.GameObjects.Text[] = [];
	private carLabels: Phaser.GameObjects.Text[] = [];

	// Stores every occupied cell: "x,y" -> tileType (including extension cells)
	private grid: Map<string, string> = new Map();
	// Keys of anchor cells only (used for rendering)
	private anchorSet: Set<string> = new Set();
	// Overlay tiles (e.g. stairs) keyed by "x,y"
	private overlayGrid: Map<string, string> = new Map();
	private entities: EntityStateData[] = [];
	private carriers: CarrierCarStateData[] = [];

	private hoveredCell: { x: number; y: number } | null = null;
	private selectedTool: string = "floor";
	private onCellClick: CellClickHandler | null = null;

	// Pan state
	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private camStartX = 0;
	private camStartY = 0;

	// Arrow-key pan
	private arrowKeys!: Phaser.Types.Input.Keyboard.CursorKeys;

	// Drag-to-paint state
	private isDragging = false;
	private draggedCells = new Set<string>();

	// Last non-shift placement anchor (for shift-fill)
	private lastPlacedAnchor: { x: number; y: number; tileType: string } | null =
		null;

	// Shift key state (for preview)
	private isShiftHeld = false;

	constructor() {
		super({ key: "GameScene" });
	}

	setOnCellClick(handler: CellClickHandler): void {
		this.onCellClick = handler;
	}

	setSelectedTool(tool: string): void {
		this.selectedTool = tool;
		this.drawHover(); // refresh hover preview width
	}

	setLastPlaced(x: number, y: number, tileType: string): void {
		this.lastPlacedAnchor = { x, y, tileType };
	}

	/** Compute shift-fill positions between lastPlacedAnchor and (clickX, clickY).
	 *  Fills every row in the Y range.  Within each row tiles are packed left (if the
	 *  last-placed anchor is to the left of the click) or right (if to the right),
	 *  skipping any already-occupied cells. */
	computeShiftFill(
		clickX: number,
		clickY: number,
	): Array<{ x: number; y: number }> {
		if (!this.lastPlacedAnchor || this.selectedTool === "empty") return [];
		const { x: lx, y: ly, tileType: lastType } = this.lastPlacedAnchor;

		// Only fill if we're placing the same tile type as the anchor
		if (lastType !== this.selectedTool) return [];

		const tileWidth = TILE_WIDTHS[this.selectedTool] ?? 1;
		const lastTileWidth = TILE_WIDTHS[lastType] ?? 1;
		const yMin = Math.min(ly, clickY);
		const yMax = Math.max(ly, clickY);
		const results: Array<{ x: number; y: number }> = [];

		if (lx < clickX) {
			// Last placed is to the LEFT → pack left on every row.
			// On the anchor's own row start after the tile; other rows include its columns.
			const fillEnd = clickX;
			for (let y = yMin; y <= yMax; y++) {
				const fillStart = y === ly ? lx + lastTileWidth : lx;
				if (fillStart > fillEnd) continue;
				results.push(...this.packLeft(fillStart, fillEnd, y, tileWidth));
			}
		} else if (lx > clickX) {
			// Last placed is to the RIGHT → pack right on every row.
			// On the anchor's own row end before the tile; other rows include its columns.
			const fillStart = clickX;
			for (let y = yMin; y <= yMax; y++) {
				const fillEnd = y === ly ? lx - 1 : lx + lastTileWidth - 1;
				if (fillStart > fillEnd) continue;
				results.push(...this.packRight(fillStart, fillEnd, y, tileWidth));
			}
		}
		return results;
	}

	private packLeft(
		fillStart: number,
		fillEnd: number,
		y: number,
		tileWidth: number,
	): Array<{ x: number; y: number }> {
		const placements: Array<{ x: number; y: number }> = [];
		const tentative = new Set<string>();
		let x = fillStart;
		while (x <= fillEnd && x + tileWidth - 1 < GRID_WIDTH) {
			if (this.cellsAvailable(x, y, tileWidth, tentative)) {
				placements.push({ x, y });
				for (let dx = 0; dx < tileWidth; dx++) tentative.add(`${x + dx},${y}`);
				x += tileWidth;
			} else {
				x += 1;
			}
		}
		return placements;
	}

	private packRight(
		fillStart: number,
		fillEnd: number,
		y: number,
		tileWidth: number,
	): Array<{ x: number; y: number }> {
		const placements: Array<{ x: number; y: number }> = [];
		const tentative = new Set<string>();
		// Start from rightmost anchor that keeps tile within both fillEnd and grid bounds
		let x = Math.min(fillEnd, GRID_WIDTH - tileWidth);
		while (x >= fillStart) {
			if (this.cellsAvailable(x, y, tileWidth, tentative)) {
				placements.unshift({ x, y }); // prepend to keep left-to-right order
				for (let dx = 0; dx < tileWidth; dx++) tentative.add(`${x + dx},${y}`);
				x -= tileWidth;
			} else {
				x -= 1;
			}
		}
		return placements;
	}

	private cellsAvailable(
		x: number,
		y: number,
		tileWidth: number,
		tentative: Set<string>,
	): boolean {
		// Stairs sit on top of existing tiles — not shift-fillable via this path.
		if (this.selectedTool === "stairs") return false;
		if (this.selectedTool === "lobby") {
			const floorsAboveGround = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS - y;
			if (floorsAboveGround < 0 || floorsAboveGround % 15 !== 0) return false;
		}
		const needsSupport = this.selectedTool !== "lobby";
		const canReplaceFloor = this.selectedTool !== "floor";
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (tentative.has(key)) return false;
			if (this.grid.has(key)) {
				if (canReplaceFloor && this.grid.get(key) === "floor") {
					// floor will be replaced — allowed
				} else {
					return false;
				}
			}
			if (needsSupport) {
				if (y + 1 >= GRID_HEIGHT || !this.grid.has(`${x + dx},${y + 1}`))
					return false;
			}
		}
		return true;
	}

	applyInitState(
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
		}>,
		entities: EntityStateData[] = [],
		carriers: CarrierCarStateData[] = [],
	): void {
		this.grid.clear();
		this.anchorSet.clear();
		this.overlayGrid.clear();
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			if (cell.isOverlay) {
				if (cell.tileType !== "empty") this.overlayGrid.set(key, cell.tileType);
			} else if (cell.tileType !== "empty") {
				this.grid.set(key, cell.tileType);
				if (cell.isAnchor) this.anchorSet.add(key);
			}
		}
		this.entities = entities;
		this.carriers = carriers;
		this.drawAllCells();
	}

	applyPatch(
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
		}>,
	): void {
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			if (cell.isOverlay) {
				if (cell.tileType === "empty") {
					this.overlayGrid.delete(key);
				} else {
					this.overlayGrid.set(key, cell.tileType);
				}
			} else if (cell.tileType === "empty") {
				this.grid.delete(key);
				this.anchorSet.delete(key);
			} else {
				this.grid.set(key, cell.tileType);
				if (cell.isAnchor) {
					this.anchorSet.add(key);
				} else {
					this.anchorSet.delete(key);
				}
			}
		}
		this.drawAllCells();
	}

	applyEntities(entities: EntityStateData[]): void {
		this.entities = entities;
		this.drawAllCells();
	}

	applyCarriers(carriers: CarrierCarStateData[]): void {
		this.carriers = carriers;
		this.drawAllCells();
	}

	create(): void {
		const totalWidth = GRID_WIDTH * TILE_WIDTH;

		// Zoom so the grid fills the viewport horizontally, then center near ground floor
		const initialZoom = this.scale.width / totalWidth;
		this.cameras.main.setZoom(initialZoom);
		this.cameras.main.centerOn(
			totalWidth / 2,
			(UNDERGROUND_Y - 8) * TILE_HEIGHT,
		);

		this.gridGraphics = this.add.graphics();
		this.cellGraphics = this.add.graphics();
		this.entityGraphics = this.add.graphics();
		this.carGraphics = this.add.graphics();
		this.hoverGraphics = this.add.graphics();

		this.arrowKeys =
			this.input.keyboard?.createCursorKeys() as Phaser.Types.Input.Keyboard.CursorKeys;

		this.drawGrid();
		this.drawAllCells();
		this.setupInput();
		this.setupFloorLabels();
	}

	update(): void {
		const cam = this.cameras.main;
		const PAN_SPEED = 6 / cam.zoom;
		if (this.arrowKeys.left.isDown) cam.scrollX -= PAN_SPEED;
		if (this.arrowKeys.right.isDown) cam.scrollX += PAN_SPEED;
		if (this.arrowKeys.up.isDown) cam.scrollY -= PAN_SPEED;
		if (this.arrowKeys.down.isDown) cam.scrollY += PAN_SPEED;

		this.updateFloorLabels();
	}

	private setupFloorLabels(): void {
		// Very tall rectangle so it always covers the full viewport height regardless of camera position
		this.floorLabelBg = this.add.rectangle(
			0,
			0,
			LABEL_PANEL_WIDTH,
			1_000_000,
			0x000000,
			0.55,
		);
		this.floorLabelBg.setOrigin(0, 0.5);
		this.floorLabelBg.setScrollFactor(0, 0);
		this.floorLabelBg.setDepth(10);

		for (let i = 0; i < GRID_HEIGHT; i++) {
			const uiLabel = GRID_HEIGHT - 1 - i - UNDERGROUND_FLOORS;
			const isUnderground = i >= UNDERGROUND_Y;
			const text = this.add.text(
				0,
				i * TILE_HEIGHT + TILE_HEIGHT / 2,
				String(uiLabel),
				{
					fontSize: "11px",
					fontFamily: "Arial, sans-serif",
					fontStyle: "bold",
					color: isUnderground ? "#886644" : "#5588aa",
					align: "center",
					resolution: window.devicePixelRatio * 4,
				},
			);
			text.setScrollFactor(0, 1);
			text.setDepth(11);
			text.setOrigin(0.5, 0.5);
			this.floorLabels.push(text);
		}
	}

	private updateFloorLabels(): void {
		const cam = this.cameras.main;
		const zoom = cam.zoom;
		// Camera pivots zoom around the screen center, so with scrollFactor(0):
		//   screenX = halfW + zoom * (worldX - halfW)
		// Inverse: worldX = halfW + (screenX - halfW) / zoom
		const halfW = this.scale.width / 2;

		// bg.width is in world units; rendered screen width = LABEL_PANEL_WIDTH * zoom (expands when zoomed in)
		this.floorLabelBg.x = halfW * (1 - 1 / zoom);
		this.floorLabelBg.width = LABEL_PANEL_WIDTH;

		// label center in screen space = LABEL_PANEL_WIDTH * zoom / 2
		const labelX = halfW * (1 - 1 / zoom) + LABEL_PANEL_WIDTH / 2;
		for (let i = 0; i < GRID_HEIGHT; i++) {
			const label = this.floorLabels[i];
			if (!label) continue;
			label.setX(labelX);
		}
	}

	private drawGrid(): void {
		const g = this.gridGraphics;
		g.clear();
		g.lineStyle(1, COLOR_GRID_LINE, 0.5);

		const totalWidth = GRID_WIDTH * TILE_WIDTH;
		const totalHeight = GRID_HEIGHT * TILE_HEIGHT;

		for (let x = 0; x <= GRID_WIDTH; x++) {
			g.beginPath();
			g.moveTo(x * TILE_WIDTH, 0);
			g.lineTo(x * TILE_WIDTH, totalHeight);
			g.strokePath();
		}
		for (let y = 0; y <= GRID_HEIGHT; y++) {
			g.beginPath();
			g.moveTo(0, y * TILE_HEIGHT);
			g.lineTo(totalWidth, y * TILE_HEIGHT);
			g.strokePath();
		}
	}

	private drawAllCells(): void {
		const g = this.cellGraphics;
		g.clear();
		this.entityGraphics.clear();
		this.carGraphics.clear();
		this.clearTileLabels();

		// Sky background (above ground)
		g.fillStyle(COLOR_SKY, 1);
		g.fillRect(0, 0, GRID_WIDTH * TILE_WIDTH, UNDERGROUND_Y * TILE_HEIGHT);
		// Underground background
		g.fillStyle(COLOR_UNDERGROUND, 1);
		g.fillRect(
			0,
			UNDERGROUND_Y * TILE_HEIGHT,
			GRID_WIDTH * TILE_WIDTH,
			(GRID_HEIGHT - UNDERGROUND_Y) * TILE_HEIGHT,
		);

		// Tile types that should be merged into contiguous runs per row.
		const MERGE_TYPES = new Set(["floor", "lobby"]);

		// Draw non-merge anchor tiles (hotel tiles etc.) individually.
		for (const key of this.anchorSet) {
			const tileType = this.grid.get(key);
			if (!tileType || MERGE_TYPES.has(tileType)) continue;
			const color = TILE_COLORS[tileType];
			if (!color) continue;

			const [x, y] = key.split(",").map(Number);
			const w = TILE_WIDTHS[tileType] ?? 1;

			g.fillStyle(color, 1);
			g.fillRect(
				x * TILE_WIDTH + 1,
				y * TILE_HEIGHT + 1,
				w * TILE_WIDTH - 1,
				TILE_HEIGHT - 1,
			);
		}

		// Draw floor/lobby as merged runs per row.
		for (let y = 0; y < GRID_HEIGHT; y++) {
			let runStart = -1;
			let runType: string | null = null;
			for (let x = 0; x <= GRID_WIDTH; x++) {
				const cellType =
					x < GRID_WIDTH ? (this.grid.get(`${x},${y}`) ?? null) : null;
				const isMerge = cellType !== null && MERGE_TYPES.has(cellType);
				if (isMerge && cellType === runType) {
					// extend current run
				} else {
					if (runStart !== -1 && runType !== null) {
						const color = TILE_COLORS[runType];
						if (color) {
							g.fillStyle(color, 1);
							g.fillRect(
								runStart * TILE_WIDTH + 1,
								y * TILE_HEIGHT + 1,
								(x - runStart) * TILE_WIDTH - 1,
								TILE_HEIGHT - 1,
							);
						}
					}
					runStart = isMerge ? x : -1;
					runType = isMerge ? cellType : null;
				}
			}
		}

		// Draw overlay tiles on top of base tiles.
		const shaftRows = new Map<string, number[]>();
		for (const [key, type] of this.overlayGrid) {
			const [x, y] = key.split(",").map(Number);
			if (type === "stairs") {
				this.drawStairs(g, x, y);
			} else {
				const shaftKey = `${type}:${x}`;
				const rows = shaftRows.get(shaftKey);
				if (rows) {
					rows.push(y);
				} else {
					shaftRows.set(shaftKey, [y]);
				}
			}
		}

		for (const [shaftKey, rows] of shaftRows) {
			const [type, xText] = shaftKey.split(":");
			const x = Number(xText);
			const width = TILE_WIDTHS[type] ?? 1;
			g.lineStyle(2, 0x222222, 1.0);
			const sortedRows = rows.slice().sort((a, b) => a - b);
			let runStart = sortedRows[0];
			let previousRow = sortedRows[0];
			for (let i = 1; i < sortedRows.length; i++) {
				const row = sortedRows[i];
				if (row === previousRow + 1) {
					previousRow = row;
					continue;
				}
				g.strokeRect(
					x * TILE_WIDTH + 1,
					runStart * TILE_HEIGHT + 1,
					width * TILE_WIDTH - 2,
					(previousRow - runStart + 1) * TILE_HEIGHT - 2,
				);
				runStart = row;
				previousRow = row;
			}
			g.strokeRect(
				x * TILE_WIDTH + 1,
				runStart * TILE_HEIGHT + 1,
				width * TILE_WIDTH - 2,
				(previousRow - runStart + 1) * TILE_HEIGHT - 2,
			);
		}

		this.drawTileLabels();
		this.drawEntities();
		this.drawCars();
	}

	private clearTileLabels(): void {
		for (const label of this.tileLabels) label.destroy();
		this.tileLabels = [];
	}

	private clearCarLabels(): void {
		for (const label of this.carLabels) label.destroy();
		this.carLabels = [];
	}

	private drawTileLabels(): void {
		for (const key of this.anchorSet) {
			const tileType = this.grid.get(key);
			if (!tileType) continue;

			const labelText = TILE_LABELS[tileType];
			if (!labelText) continue;

			const [x, y] = key.split(",").map(Number);
			const width = TILE_WIDTHS[tileType] ?? 1;
			const label = this.add.text(
				(x + width / 2) * TILE_WIDTH,
				(y + 0.5) * TILE_HEIGHT,
				labelText,
				{
					fontSize: "11px",
					fontFamily: "Arial, sans-serif",
					fontStyle: "bold",
					color: TILE_LABEL_COLORS[tileType] ?? "#ffffff",
					resolution: window.devicePixelRatio * 4,
				},
			);
			label.setOrigin(0.5, 0.5);
			label.setDepth(5);
			this.tileLabels.push(label);
		}
	}

	private drawEntities(): void {
		const g = this.entityGraphics;
		g.clear();
		const queueIndices = new Map<string, number>();
		const elevatorColumnsByFloor = this.collectElevatorColumnsByFloor();

		for (const entity of this.entities) {
			if (!this.shouldRenderQueuedEntity(entity)) continue;
			const color = ENTITY_STRESS_COLORS[entity.stressLevel] ?? 0x111111;
			const spanWidth = FAMILY_WIDTHS[entity.familyCode] ?? 1;
			const population = FAMILY_POPULATION[entity.familyCode] ?? 1;
			const slotFraction = (entity.baseOffset + 0.5) / population;
			const defaultGridX = entity.subtypeIndex + slotFraction * spanWidth;
			const gridY = GRID_HEIGHT - 1 - entity.selectedFloor + 0.5;
			const queueKey = `${entity.selectedFloor}:${this.pickElevatorColumn(entity, elevatorColumnsByFloor)}`;
			const queueIndex = queueIndices.get(queueKey) ?? 0;
			queueIndices.set(queueKey, queueIndex + 1);
			const gridX = this.computeElevatorQueueX(
				entity,
				elevatorColumnsByFloor,
				queueIndex,
				defaultGridX,
			);
			const width = Math.max(2, TILE_WIDTH - 1);
			const height = Math.max(4, Math.floor(TILE_HEIGHT * 0.35));
			const px = gridX * TILE_WIDTH - width / 2;
			const py = gridY * TILE_HEIGHT - height / 2;

			g.fillStyle(color, 1);
			g.fillRect(px, py, width, height);
		}
	}

	private drawCars(): void {
		const g = this.carGraphics;
		g.clear();
		this.clearCarLabels();
		const occupancyByCar = new Map<string, number>();
		for (const entity of this.entities) {
			if (
				!entity.boardedOnCarrier ||
				entity.carrierId === null ||
				entity.assignedCarIndex < 0
			) {
				continue;
			}
			const key = `${entity.carrierId}:${entity.assignedCarIndex}`;
			occupancyByCar.set(key, (occupancyByCar.get(key) ?? 0) + 1);
		}

		for (const car of this.carriers) {
			const { x, y, width, height } = this.getCarBounds(car);
			const occupancy =
				occupancyByCar.get(`${car.carrierId}:${car.carIndex}`) ?? 0;

			g.fillStyle(CAR_COLOR, 1);
			g.fillRect(x, y, width, height);
			g.lineStyle(1, 0x6b5a1b, 1);
			g.strokeRect(x, y, width, height);
			this.drawCarOccupancyLabel(x, y, width, height, occupancy);
		}
	}

	private drawCarOccupancyLabel(
		x: number,
		y: number,
		width: number,
		height: number,
		occupancy: number,
	): void {
		const label = this.add.text(
			x + width / 2,
			y + height / 2,
			String(occupancy),
			{
				fontSize: "8px",
				fontFamily: "Arial, sans-serif",
				fontStyle: "bold",
				color: "#3b2d00",
				resolution: window.devicePixelRatio * 4,
			},
		);
		label.setOrigin(0.5, 0.5);
		label.setDepth(6);
		this.carLabels.push(label);
	}

	private getCarBounds(car: CarrierCarStateData): {
		x: number;
		y: number;
		width: number;
		height: number;
	} {
		const shaftWidthCells = TILE_WIDTHS.elevator ?? 4;
		const slotCount = Math.max(1, car.carCount);
		const shaftPixelWidth = shaftWidthCells * TILE_WIDTH;
		const gutter = 1;
		const usableWidth = shaftPixelWidth - gutter * (slotCount + 1);
		const width = Math.max(3, Math.floor(usableWidth / slotCount));
		const height = Math.max(8, Math.floor(TILE_HEIGHT * 0.55));
		const x =
			car.column * TILE_WIDTH + gutter + car.carIndex * (width + gutter);
		const y =
			this.carWorldY(car.currentFloor, car.targetFloor, car.speedCounter) -
			height / 2;
		return { x, y, width, height };
	}

	private carWorldY(
		currentFloor: number,
		targetFloor: number,
		speedCounter: number,
	): number {
		const currentY = (GRID_HEIGHT - 1 - currentFloor + 0.5) * TILE_HEIGHT;
		if (speedCounter <= 0 || currentFloor === targetFloor) return currentY;

		const direction = targetFloor > currentFloor ? -1 : 1;
		const ticksPerFloor = 8;
		const progress = (ticksPerFloor - speedCounter) / ticksPerFloor;
		return currentY + direction * progress * TILE_HEIGHT;
	}

	private shouldRenderQueuedEntity(entity: EntityStateData): boolean {
		return (
			!entity.boardedOnCarrier &&
			(ELEVATOR_QUEUE_STATES.has(entity.stateCode) || entity.routeMode === 2)
		);
	}

	private collectElevatorColumnsByFloor(): Map<number, number[]> {
		const result = new Map<number, number[]>();
		for (const [key, type] of this.overlayGrid) {
			if (type !== "elevator") continue;
			const [x, y] = key.split(",").map(Number);
			const floor = GRID_HEIGHT - 1 - y;
			const columns = result.get(floor);
			if (columns) {
				if (!columns.includes(x)) columns.push(x);
			} else {
				result.set(floor, [x]);
			}
		}

		for (const columns of result.values()) columns.sort((a, b) => a - b);
		return result;
	}

	private pickElevatorColumn(
		entity: EntityStateData,
		elevatorColumnsByFloor: Map<number, number[]>,
	): number {
		const columns = elevatorColumnsByFloor.get(entity.floorAnchor);
		const selectedColumns = elevatorColumnsByFloor.get(entity.selectedFloor);
		const availableColumns = selectedColumns ?? columns;
		if (!availableColumns || availableColumns.length === 0)
			return entity.subtypeIndex;

		let best = availableColumns[0] ?? entity.subtypeIndex;
		let bestDistance = Math.abs(best - entity.subtypeIndex);
		for (const column of availableColumns) {
			const distance = Math.abs(column - entity.subtypeIndex);
			if (distance < bestDistance) {
				best = column;
				bestDistance = distance;
			}
		}
		return best;
	}

	private computeElevatorQueueX(
		entity: EntityStateData,
		elevatorColumnsByFloor: Map<number, number[]>,
		queueIndex: number,
		fallbackX: number,
	): number {
		const elevatorColumn = this.pickElevatorColumn(
			entity,
			elevatorColumnsByFloor,
		);
		if (
			elevatorColumn === entity.subtypeIndex &&
			!elevatorColumnsByFloor.has(entity.selectedFloor)
		) {
			return fallbackX;
		}

		const shaftCenter = elevatorColumn + (TILE_WIDTHS.elevator ?? 4) / 2;
		return shaftCenter + 0.35 + queueIndex * 0.9;
	}

	/** Draw stairs bridging the floor at (gx,gy) and the floor above (gy-1). */
	private drawStairs(
		g: Phaser.GameObjects.Graphics,
		gx: number,
		gy: number,
	): void {
		const startX = gx * TILE_WIDTH + 1;
		const startY = (gy + 1) * TILE_HEIGHT;
		const numSteps = 8;
		const stairWidth = TILE_WIDTHS.stairs ?? 1;
		const sw = (TILE_WIDTH * stairWidth - 2) / numSteps;
		const sh = (TILE_HEIGHT * 2) / numSteps;

		g.fillStyle(0xffffff, 0.65);
		for (let i = 0; i < numSteps; i++) {
			const sx = startX + i * sw;
			const sy = startY - (i + 1) * sh;
			g.fillRect(sx, sy, 2, sh); // riser (vertical)
			g.fillRect(sx, sy, sw, 2); // tread (horizontal)
		}
	}

	private drawHover(): void {
		const g = this.hoverGraphics;
		if (!g) return;
		g.clear();
		if (!this.hoveredCell) return;

		// While shift is held and a fill is possible, show the fill outline preview
		if (
			this.isShiftHeld &&
			this.lastPlacedAnchor &&
			this.selectedTool !== "empty"
		) {
			this.drawShiftPreview();
			return;
		}

		const { x, y } = this.hoveredCell;
		if (y < 0 || y >= GRID_HEIGHT) return;

		// Lobby is only placeable on ground floor and every 15 floors above
		if (this.selectedTool === "lobby") {
			const floorsAboveGround = GRID_HEIGHT - 1 - UNDERGROUND_FLOORS - y;
			if (floorsAboveGround < 0 || floorsAboveGround % 15 !== 0) return;
		}

		const width =
			this.selectedTool !== "empty" ? (TILE_WIDTHS[this.selectedTool] ?? 1) : 1;
		// Stairs also span the floor above
		const heightCells = this.selectedTool === "stairs" ? 2 : 1;

		// Clamp to grid
		const startX = Math.max(0, x);
		const endX = Math.min(GRID_WIDTH - 1, x + width - 1);
		const startY = Math.max(0, y - heightCells + 1);
		if (startX > endX) return;

		const previewX = startX * TILE_WIDTH + 1;
		const previewY = startY * TILE_HEIGHT + 1;
		const previewWidth = (endX - startX + 1) * TILE_WIDTH - 1;
		const previewHeight = (y - startY + 1) * TILE_HEIGHT - 1;

		g.fillStyle(COLOR_HOVER, 0.2);
		g.lineStyle(1, COLOR_HOVER, 0.9);
		g.fillRect(previewX, previewY, previewWidth, previewHeight);
		g.strokeRect(previewX, previewY, previewWidth, previewHeight);
	}

	private drawShiftPreview(): void {
		if (!this.hoveredCell) return;
		const g = this.hoverGraphics;
		const fills = this.computeShiftFill(this.hoveredCell.x, this.hoveredCell.y);
		if (fills.length === 0) return;

		const tileWidth = TILE_WIDTHS[this.selectedTool] ?? 1;
		const pw = tileWidth * TILE_WIDTH - 1;
		const ph = TILE_HEIGHT - 1;

		g.fillStyle(COLOR_HOVER, 0.12);
		g.lineStyle(1, COLOR_HOVER, 0.75);
		for (const { x, y } of fills) {
			const px = x * TILE_WIDTH + 1;
			const py = y * TILE_HEIGHT + 1;
			g.fillRect(px, py, pw, ph);
			g.strokeRect(px, py, pw, ph);
		}
	}

	private worldToCell(wx: number, wy: number): { x: number; y: number } {
		return {
			x: Math.floor(wx / TILE_WIDTH),
			y: Math.floor(wy / TILE_HEIGHT),
		};
	}

	private setupInput(): void {
		const cam = this.cameras.main;

		this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
			const cell = this.worldToCell(pointer.worldX, pointer.worldY);
			const shift = !!(pointer.event as MouseEvent).shiftKey;

			const cellChanged =
				cell.x !== this.hoveredCell?.x || cell.y !== this.hoveredCell?.y;
			const shiftChanged = shift !== this.isShiftHeld;
			this.hoveredCell = cell;
			this.isShiftHeld = shift;
			if (cellChanged || shiftChanged) this.drawHover();

			if (this.isPanning) {
				const dx = pointer.x - this.panStartX;
				const dy = pointer.y - this.panStartY;
				cam.setScroll(
					this.camStartX - dx / cam.zoom,
					this.camStartY - dy / cam.zoom,
				);
			} else if (this.isDragging && pointer.leftButtonDown()) {
				const cellKey = `${cell.x},${cell.y}`;
				if (
					!this.draggedCells.has(cellKey) &&
					cell.x >= 0 &&
					cell.x < GRID_WIDTH &&
					cell.y >= 0 &&
					cell.y < GRID_HEIGHT
				) {
					this.draggedCells.add(cellKey);
					this.onCellClick?.(cell.x, cell.y, false);
				}
			}
		});

		this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
			if (pointer.middleButtonDown() || pointer.rightButtonDown()) {
				this.isPanning = true;
				this.panStartX = pointer.x;
				this.panStartY = pointer.y;
				this.camStartX = cam.scrollX;
				this.camStartY = cam.scrollY;
				return;
			}

			if (pointer.leftButtonDown()) {
				const cell = this.worldToCell(pointer.worldX, pointer.worldY);
				if (
					cell.x < 0 ||
					cell.x >= GRID_WIDTH ||
					cell.y < 0 ||
					cell.y >= GRID_HEIGHT
				)
					return;
				this.isDragging = true;
				this.draggedCells.clear();
				this.draggedCells.add(`${cell.x},${cell.y}`);
				const shift = !!(pointer.event as MouseEvent).shiftKey;
				this.onCellClick?.(cell.x, cell.y, shift);
			}
		});

		this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
			if (!pointer.middleButtonDown() && !pointer.rightButtonDown()) {
				this.isPanning = false;
			}
			this.isDragging = false;
		});

		this.input.on(
			"wheel",
			(
				p: Phaser.Input.Pointer,
				_o: unknown[],
				deltaX: number,
				deltaY: number,
			) => {
				const wheelEvent = p.event as WheelEvent;
				if (wheelEvent.ctrlKey || wheelEvent.shiftKey) {
					// Pinch or shift-modified trackpad scroll -> zoom
					const newZoom = Phaser.Math.Clamp(
						cam.zoom * (deltaY > 0 ? 0.9 : 1.1),
						0.25,
						4,
					);
					cam.setZoom(newZoom);
				} else {
					// Two-finger scroll -> pan
					cam.scrollX += deltaX / cam.zoom;
					cam.scrollY += deltaY / cam.zoom;
				}
			},
		);

		this.game.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

		// Redraw hover when shift is pressed/released without moving the mouse
		this.input.keyboard?.on("keydown-SHIFT", () => {
			this.isShiftHeld = true;
			this.drawHover();
		});
		this.input.keyboard?.on("keyup-SHIFT", () => {
			this.isShiftHeld = false;
			this.drawHover();
		});
	}
}
