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
import { CloudManager } from "./clouds";
import {
	CAR_COLOR,
	COLOR_HOVER,
	COLOR_UNDERGROUND,
	DEFAULT_TICK_INTERVAL_MS,
	ENTITY_STRESS_COLORS,
	LABEL_PANEL_WIDTH,
	MAX_ZOOM,
	MIN_ZOOM,
	TILE_COLORS,
	TILE_HEIGHT,
	TILE_LABEL_COLORS,
	TILE_LABELS,
	TILE_WIDTH,
} from "./gameSceneConstants";
import {
	computeShiftFill,
	getHoverBounds,
	type PlacementAnchor,
} from "./gameScenePlacement";
import {
	collectElevatorColumnsByFloor,
	getCarBounds,
	getDisplayedCars,
	getQueuedEntityLayout,
	getQueuedEntityQueueKey,
	type PresentationClock,
	type TimedSnapshot,
} from "./gameSceneTransport";
import { buildOccupancyByCar, isQueuedEntity } from "./transportSelectors";

export type CellClickHandler = (x: number, y: number, shift: boolean) => void;
export type CellInspectHandler = (x: number, y: number) => void;

export class GameScene extends Phaser.Scene {
	private cellGraphics!: Phaser.GameObjects.Graphics;
	private entityGraphics!: Phaser.GameObjects.Graphics;
	private carGraphics!: Phaser.GameObjects.Graphics;

	private hoverGraphics!: Phaser.GameObjects.Graphics;
	private cloudManager!: CloudManager;
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
	private previousEntitySnapshot: TimedSnapshot<EntityStateData> | null = null;
	private currentEntitySnapshot: TimedSnapshot<EntityStateData> | null = null;
	private previousCarrierSnapshot: TimedSnapshot<CarrierCarStateData> | null =
		null;
	private currentCarrierSnapshot: TimedSnapshot<CarrierCarStateData> | null =
		null;
	private presentationClock: PresentationClock = {
		simTime: 0,
		receivedAtMs: 0,
		tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
	};

	private hoveredCell: { x: number; y: number } | null = null;
	private selectedTool: string = "floor";
	private onCellClick: CellClickHandler | null = null;
	private onCellInspect: CellInspectHandler | null = null;

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
	private lastPlacedAnchor: PlacementAnchor | null = null;

	// Shift key state (for preview)
	private isShiftHeld = false;

	constructor() {
		super({ key: "GameScene" });
	}

	setOnCellClick(handler: CellClickHandler): void {
		this.onCellClick = handler;
	}

	setOnCellInspect(handler: CellInspectHandler): void {
		this.onCellInspect = handler;
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
		return computeShiftFill(
			clickX,
			clickY,
			this.selectedTool,
			this.lastPlacedAnchor,
			this.grid,
		);
	}

	applyInitState(
		cells: Array<{
			x: number;
			y: number;
			tileType: string;
			isAnchor: boolean;
			isOverlay?: boolean;
		}>,
		simTime: number,
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
		this.previousEntitySnapshot = null;
		this.currentEntitySnapshot = { simTime, items: entities };
		this.previousCarrierSnapshot = null;
		this.currentCarrierSnapshot = { simTime, items: carriers };
		this.presentationClock = {
			simTime,
			receivedAtMs: performance.now(),
			tickIntervalMs: DEFAULT_TICK_INTERVAL_MS,
		};
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

	applyEntities(simTime: number, entities: EntityStateData[]): void {
		this.previousEntitySnapshot = this.currentEntitySnapshot;
		this.currentEntitySnapshot = { simTime, items: entities };
		this.drawDynamicOverlays();
	}

	applyCarriers(simTime: number, carriers: CarrierCarStateData[]): void {
		this.previousCarrierSnapshot = this.currentCarrierSnapshot;
		this.currentCarrierSnapshot = { simTime, items: carriers };
		this.drawDynamicOverlays();
	}

	setPresentationClock(
		simTime: number,
		receivedAtMs: number,
		tickIntervalMs = DEFAULT_TICK_INTERVAL_MS,
	): void {
		this.presentationClock = {
			simTime,
			receivedAtMs,
			tickIntervalMs:
				tickIntervalMs > 0 ? tickIntervalMs : DEFAULT_TICK_INTERVAL_MS,
		};
	}

	create(): void {
		const totalWidth = GRID_WIDTH * TILE_WIDTH;

		// Fit wide towers when possible, but never start below Phaser's default 1x zoom.
		const initialZoom = Phaser.Math.Clamp(
			this.scale.width / totalWidth,
			MIN_ZOOM,
			MAX_ZOOM,
		);
		this.cameras.main.setZoom(initialZoom);
		this.cameras.main.centerOn(
			totalWidth / 2,
			(UNDERGROUND_Y - 8) * TILE_HEIGHT,
		);

		this.cellGraphics = this.add.graphics();
		this.entityGraphics = this.add.graphics();
		this.carGraphics = this.add.graphics();
		this.hoverGraphics = this.add.graphics();

		// Depth ordering: sky (0) -> clouds (1) -> cells (2) -> overlays (3-4)
		this.cellGraphics.setDepth(2);
		this.entityGraphics.setDepth(3);
		this.carGraphics.setDepth(3);
		this.hoverGraphics.setDepth(4);

		this.arrowKeys =
			this.input.keyboard?.createCursorKeys() as Phaser.Types.Input.Keyboard.CursorKeys;

		this.drawSky();
		this.drawAllCells();

		this.cloudManager = new CloudManager(this, 1);
		this.cloudManager.loadTextures();

		this.setupInput();
		this.setupFloorLabels();
	}

	update(_time: number, delta: number): void {
		const cam = this.cameras.main;
		const PAN_SPEED = 6 / cam.zoom;
		if (this.arrowKeys.left.isDown) cam.scrollX -= PAN_SPEED;
		if (this.arrowKeys.right.isDown) cam.scrollX += PAN_SPEED;
		if (this.arrowKeys.up.isDown) cam.scrollY -= PAN_SPEED;
		if (this.arrowKeys.down.isDown) cam.scrollY += PAN_SPEED;

		this.cloudManager.update(delta);
		this.updateFloorLabels();
		this.drawDynamicOverlays();
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

	private drawSky(): void {
		const skyW = GRID_WIDTH * TILE_WIDTH;
		const skyH = UNDERGROUND_Y * TILE_HEIGHT;

		// Build a 1-pixel-wide vertical gradient on an offscreen canvas.
		const canvas = document.createElement("canvas");
		canvas.width = 1;
		canvas.height = skyH;
		const ctx = canvas.getContext("2d")!;
		const grad = ctx.createLinearGradient(0, 0, 0, skyH);
		grad.addColorStop(0, "#1a3a6e"); // deep blue at top
		grad.addColorStop(0.6, "#5ba8d4"); // mid sky
		grad.addColorStop(1, "#b4ddf0"); // pale horizon
		ctx.fillStyle = grad;
		ctx.fillRect(0, 0, 1, skyH);

		// Create a Phaser texture from the canvas and stretch it across the sky.
		if (this.textures.exists("skyGradient")) {
			this.textures.remove("skyGradient");
		}
		this.textures.addCanvas("skyGradient", canvas);
		const sky = this.add.image(0, 0, "skyGradient");
		sky.setOrigin(0, 0);
		sky.setDisplaySize(skyW, skyH);
		sky.setDepth(0);
	}

	private drawAllCells(): void {
		const g = this.cellGraphics;
		g.clear();
		this.clearTileLabels();

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
		this.drawDynamicOverlays();
	}

	private drawDynamicOverlays(): void {
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
		const elevatorColumnsByFloor = collectElevatorColumnsByFloor(
			this.overlayGrid,
		);
		const entitySnapshot = this.currentEntitySnapshot ??
			this.previousEntitySnapshot ?? { simTime: 0, items: [] };

		for (const entity of entitySnapshot.items) {
			if (!isQueuedEntity(entity)) continue;
			const color = ENTITY_STRESS_COLORS[entity.stressLevel] ?? 0x111111;
			const queueKey = getQueuedEntityQueueKey(entity, elevatorColumnsByFloor);
			const queueIndex = queueIndices.get(queueKey) ?? 0;
			queueIndices.set(queueKey, queueIndex + 1);
			const { gridX, gridY } = getQueuedEntityLayout(
				entity,
				elevatorColumnsByFloor,
				queueIndex,
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
		const entitySnapshot = this.currentEntitySnapshot ??
			this.previousEntitySnapshot ?? { simTime: 0, items: [] };
		const occupancyByCar = buildOccupancyByCar(entitySnapshot.items);

		for (const car of getDisplayedCars(
			this.currentCarrierSnapshot,
			this.previousCarrierSnapshot,
			this.presentationClock,
		)) {
			const { x, y, width, height } = getCarBounds(car);
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

		if (
			this.isShiftHeld &&
			this.lastPlacedAnchor &&
			this.selectedTool !== "empty"
		) {
			this.drawShiftPreview();
			return;
		}

		const { x, y } = this.hoveredCell;
		const hoverBounds = getHoverBounds(x, y, this.selectedTool);
		if (!hoverBounds) return;

		g.fillStyle(COLOR_HOVER, 0.2);
		g.lineStyle(1, COLOR_HOVER, 0.9);
		g.fillRect(
			hoverBounds.x,
			hoverBounds.y,
			hoverBounds.width,
			hoverBounds.height,
		);
		g.strokeRect(
			hoverBounds.x,
			hoverBounds.y,
			hoverBounds.width,
			hoverBounds.height,
		);
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
			if (pointer.rightButtonDown()) {
				const cell = this.worldToCell(pointer.worldX, pointer.worldY);
				if (
					cell.x >= 0 &&
					cell.x < GRID_WIDTH &&
					cell.y >= 0 &&
					cell.y < GRID_HEIGHT
				) {
					this.onCellInspect?.(cell.x, cell.y);
				}
				return;
			}
			if (pointer.middleButtonDown()) {
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
					// Pinch or shift-modified trackpad scroll -> zoom around mouse position.
					// Use Phaser's camera transform helpers instead of duplicating the math,
					// so the anchor remains stable with RESIZE scaling and centered cameras.
					const oldZoom = cam.zoom;
					const newZoom = Phaser.Math.Clamp(
						oldZoom * (deltaY > 0 ? 0.9 : 1.1),
						MIN_ZOOM,
						MAX_ZOOM,
					);
					if (newZoom === oldZoom) return;
					cam.preRender();
					const worldPointBefore = cam.getWorldPoint(p.x, p.y);
					cam.setZoom(newZoom);
					cam.preRender();
					const worldPointAfter = cam.getWorldPoint(p.x, p.y);
					cam.scrollX += worldPointBefore.x - worldPointAfter.x;
					cam.scrollY += worldPointBefore.y - worldPointAfter.y;
					cam.preRender();
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
