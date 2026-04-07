import Phaser from "phaser";
import { TILE_WIDTHS } from "../types";

const GRID_WIDTH = 64;
const GRID_HEIGHT = 80;
const CELL_SIZE = 16;

// Tile fill colors
const TILE_COLORS: Record<string, number> = {
	floor: 0x555555,
	lobby: 0xc9a84c,
	hotel_single: 0x2d9c8d,
	hotel_twin: 0x2d7a9c,
	hotel_suite: 0x2d4f9c,
};

const COLOR_EMPTY = 0x1a1a1a;
const COLOR_GRID_LINE = 0x333333;
const COLOR_HOVER = 0xffff00;

export type CellClickHandler = (x: number, y: number, shift: boolean) => void;

export class GameScene extends Phaser.Scene {
	private cellGraphics!: Phaser.GameObjects.Graphics;
	private gridGraphics!: Phaser.GameObjects.Graphics;
	private hoverGraphics!: Phaser.GameObjects.Graphics;

	// Stores every occupied cell: "x,y" -> tileType (including extension cells)
	private grid: Map<string, string> = new Map();

	private hoveredCell: { x: number; y: number } | null = null;
	private selectedTool: string = "floor";
	private onCellClick: CellClickHandler | null = null;

	// Pan state
	private isPanning = false;
	private panStartX = 0;
	private panStartY = 0;
	private camStartX = 0;
	private camStartY = 0;

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
		for (let dx = 0; dx < tileWidth; dx++) {
			const key = `${x + dx},${y}`;
			if (this.grid.has(key) || tentative.has(key)) return false;
		}
		return true;
	}

	applyInitState(
		cells: Array<{ x: number; y: number; tileType: string }>,
	): void {
		this.grid.clear();
		for (const cell of cells) {
			if (cell.tileType !== "empty") {
				this.grid.set(`${cell.x},${cell.y}`, cell.tileType);
			}
		}
		this.drawAllCells();
	}

	applyPatch(cells: Array<{ x: number; y: number; tileType: string }>): void {
		for (const cell of cells) {
			const key = `${cell.x},${cell.y}`;
			if (cell.tileType === "empty") {
				this.grid.delete(key);
			} else {
				this.grid.set(key, cell.tileType);
			}
		}
		this.drawAllCells();
	}

	create(): void {
		const totalWidth = GRID_WIDTH * CELL_SIZE;
		const totalHeight = GRID_HEIGHT * CELL_SIZE;

		this.cameras.main.setBounds(
			-CELL_SIZE * 4,
			-CELL_SIZE * 4,
			totalWidth + CELL_SIZE * 8,
			totalHeight + CELL_SIZE * 8,
		);
		this.cameras.main.centerOn(totalWidth / 2, totalHeight / 2);

		this.cellGraphics = this.add.graphics();
		this.gridGraphics = this.add.graphics();
		this.hoverGraphics = this.add.graphics();

		this.drawGrid();
		this.drawAllCells();
		this.setupInput();
	}

	private drawGrid(): void {
		const g = this.gridGraphics;
		g.clear();
		g.lineStyle(1, COLOR_GRID_LINE, 0.5);

		const totalWidth = GRID_WIDTH * CELL_SIZE;
		const totalHeight = GRID_HEIGHT * CELL_SIZE;

		for (let x = 0; x <= GRID_WIDTH; x++) {
			g.beginPath();
			g.moveTo(x * CELL_SIZE, 0);
			g.lineTo(x * CELL_SIZE, totalHeight);
			g.strokePath();
		}
		for (let y = 0; y <= GRID_HEIGHT; y++) {
			g.beginPath();
			g.moveTo(0, y * CELL_SIZE);
			g.lineTo(totalWidth, y * CELL_SIZE);
			g.strokePath();
		}
	}

	private drawAllCells(): void {
		const g = this.cellGraphics;
		g.clear();

		// Background
		g.fillStyle(COLOR_EMPTY, 1);
		g.fillRect(0, 0, GRID_WIDTH * CELL_SIZE, GRID_HEIGHT * CELL_SIZE);

		// Draw each tile. For multi-cell objects, only draw from the leftmost cell
		// to produce a unified rectangle (no internal borders).
		const drawn = new Set<string>();

		for (const [key, tileType] of this.grid) {
			if (drawn.has(key)) continue;

			const [x, y] = key.split(",").map(Number);
			const color = TILE_COLORS[tileType];
			if (!color) continue; // unknown type, skip

			// Find the leftmost cell of this object in this row
			// (left neighbour has same type = this is an extension cell, skip)
			const leftKey = `${x - 1},${y}`;
			if (this.grid.get(leftKey) === tileType) {
				drawn.add(key);
				continue;
			}

			// Scan right to find the full run width for this object
			let runWidth = 1;
			while (this.grid.get(`${x + runWidth},${y}`) === tileType) {
				drawn.add(`${x + runWidth},${y}`);
				runWidth++;
			}
			drawn.add(key);

			const px = x * CELL_SIZE + 1;
			const py = y * CELL_SIZE + 1;
			const pw = runWidth * CELL_SIZE - 1;
			const ph = CELL_SIZE - 1;

			g.fillStyle(color, 1);
			g.fillRect(px, py, pw, ph);
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

		const width =
			this.selectedTool !== "empty" ? (TILE_WIDTHS[this.selectedTool] ?? 1) : 1;

		// Clamp to grid
		const startX = Math.max(0, x);
		const endX = Math.min(GRID_WIDTH - 1, x + width - 1);
		if (startX > endX) return;

		g.fillStyle(COLOR_HOVER, 0.35);
		for (let cx = startX; cx <= endX; cx++) {
			g.fillRect(
				cx * CELL_SIZE + 1,
				y * CELL_SIZE + 1,
				CELL_SIZE - 1,
				CELL_SIZE - 1,
			);
		}
	}

	private drawShiftPreview(): void {
		if (!this.hoveredCell) return;
		const g = this.hoverGraphics;
		const fills = this.computeShiftFill(this.hoveredCell.x, this.hoveredCell.y);
		if (fills.length === 0) return;

		const tileWidth = TILE_WIDTHS[this.selectedTool] ?? 1;
		const pw = tileWidth * CELL_SIZE - 1;
		const ph = CELL_SIZE - 1;

		g.fillStyle(COLOR_HOVER, 0.12);
		g.lineStyle(1, COLOR_HOVER, 0.75);
		for (const { x, y } of fills) {
			const px = x * CELL_SIZE + 1;
			const py = y * CELL_SIZE + 1;
			g.fillRect(px, py, pw, ph);
			g.strokeRect(px, py, pw, ph);
		}
	}

	private worldToCell(wx: number, wy: number): { x: number; y: number } {
		return {
			x: Math.floor(wx / CELL_SIZE),
			y: Math.floor(wy / CELL_SIZE),
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
				_p: Phaser.Input.Pointer,
				_o: unknown[],
				_dx: number,
				deltaY: number,
			) => {
				const newZoom = Phaser.Math.Clamp(
					cam.zoom * (deltaY > 0 ? 0.9 : 1.1),
					0.25,
					4,
				);
				cam.setZoom(newZoom);
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
