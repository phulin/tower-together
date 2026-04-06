import Phaser from 'phaser'
import { TILE_WIDTHS } from '../types'

const GRID_WIDTH = 64
const GRID_HEIGHT = 80
const CELL_SIZE = 16

// Tile fill colors
const TILE_COLORS: Record<string, number> = {
  floor:         0x555555,
  lobby:         0xc9a84c,
  hotel_single:  0x2d9c8d,
  hotel_twin:    0x2d7a9c,
  hotel_suite:   0x2d4f9c,
}

const COLOR_EMPTY     = 0x1a1a1a
const COLOR_GRID_LINE = 0x333333
const COLOR_HOVER     = 0xffff00

export type CellClickHandler = (x: number, y: number) => void

export class GameScene extends Phaser.Scene {
  private cellGraphics!: Phaser.GameObjects.Graphics
  private gridGraphics!: Phaser.GameObjects.Graphics
  private hoverGraphics!: Phaser.GameObjects.Graphics

  // Stores every occupied cell: "x,y" -> tileType (including extension cells)
  private grid: Map<string, string> = new Map()

  private hoveredCell: { x: number; y: number } | null = null
  private selectedTool: string = 'floor'
  private onCellClick: CellClickHandler | null = null

  // Pan state
  private isPanning = false
  private panStartX = 0
  private panStartY = 0
  private camStartX = 0
  private camStartY = 0

  constructor() {
    super({ key: 'GameScene' })
  }

  setOnCellClick(handler: CellClickHandler): void {
    this.onCellClick = handler
  }

  setSelectedTool(tool: string): void {
    this.selectedTool = tool
    this.drawHover() // refresh hover preview width
  }

  applyInitState(cells: Array<{ x: number; y: number; tileType: string }>): void {
    this.grid.clear()
    for (const cell of cells) {
      if (cell.tileType !== 'empty') {
        this.grid.set(`${cell.x},${cell.y}`, cell.tileType)
      }
    }
    this.drawAllCells()
  }

  applyPatch(cells: Array<{ x: number; y: number; tileType: string }>): void {
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`
      if (cell.tileType === 'empty') {
        this.grid.delete(key)
      } else {
        this.grid.set(key, cell.tileType)
      }
    }
    this.drawAllCells()
  }

  create(): void {
    const totalWidth = GRID_WIDTH * CELL_SIZE
    const totalHeight = GRID_HEIGHT * CELL_SIZE

    this.cameras.main.setBounds(
      -CELL_SIZE * 4, -CELL_SIZE * 4,
      totalWidth + CELL_SIZE * 8, totalHeight + CELL_SIZE * 8,
    )
    this.cameras.main.centerOn(totalWidth / 2, totalHeight / 2)

    this.cellGraphics = this.add.graphics()
    this.gridGraphics = this.add.graphics()
    this.hoverGraphics = this.add.graphics()

    this.drawGrid()
    this.drawAllCells()
    this.setupInput()
  }

  private drawGrid(): void {
    const g = this.gridGraphics
    g.clear()
    g.lineStyle(1, COLOR_GRID_LINE, 0.5)

    const totalWidth = GRID_WIDTH * CELL_SIZE
    const totalHeight = GRID_HEIGHT * CELL_SIZE

    for (let x = 0; x <= GRID_WIDTH; x++) {
      g.beginPath(); g.moveTo(x * CELL_SIZE, 0); g.lineTo(x * CELL_SIZE, totalHeight); g.strokePath()
    }
    for (let y = 0; y <= GRID_HEIGHT; y++) {
      g.beginPath(); g.moveTo(0, y * CELL_SIZE); g.lineTo(totalWidth, y * CELL_SIZE); g.strokePath()
    }
  }

  private drawAllCells(): void {
    const g = this.cellGraphics
    g.clear()

    // Background
    g.fillStyle(COLOR_EMPTY, 1)
    g.fillRect(0, 0, GRID_WIDTH * CELL_SIZE, GRID_HEIGHT * CELL_SIZE)

    // Draw each tile. For multi-cell objects, only draw from the leftmost cell
    // to produce a unified rectangle (no internal borders).
    const drawn = new Set<string>()

    for (const [key, tileType] of this.grid) {
      if (drawn.has(key)) continue

      const [x, y] = key.split(',').map(Number)
      const color = TILE_COLORS[tileType]
      if (!color) continue // unknown type, skip

      // Find the leftmost cell of this object in this row
      // (left neighbour has same type = this is an extension cell, skip)
      const leftKey = `${x - 1},${y}`
      if (this.grid.get(leftKey) === tileType) {
        drawn.add(key)
        continue
      }

      // Scan right to find the full run width for this object
      let runWidth = 1
      while (this.grid.get(`${x + runWidth},${y}`) === tileType) {
        drawn.add(`${x + runWidth},${y}`)
        runWidth++
      }
      drawn.add(key)

      const px = x * CELL_SIZE + 1
      const py = y * CELL_SIZE + 1
      const pw = runWidth * CELL_SIZE - 1
      const ph = CELL_SIZE - 1

      g.fillStyle(color, 1)
      g.fillRect(px, py, pw, ph)
    }
  }

  private drawHover(): void {
    const g = this.hoverGraphics
    g.clear()
    if (!this.hoveredCell) return

    const { x, y } = this.hoveredCell
    if (y < 0 || y >= GRID_HEIGHT) return

    const width = (this.selectedTool !== 'empty') ? (TILE_WIDTHS[this.selectedTool] ?? 1) : 1

    // Clamp to grid
    const startX = Math.max(0, x)
    const endX = Math.min(GRID_WIDTH - 1, x + width - 1)
    if (startX > endX) return

    g.fillStyle(COLOR_HOVER, 0.35)
    for (let cx = startX; cx <= endX; cx++) {
      g.fillRect(cx * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 1, CELL_SIZE - 1)
    }
  }

  private worldToCell(wx: number, wy: number): { x: number; y: number } {
    return {
      x: Math.floor(wx / CELL_SIZE),
      y: Math.floor(wy / CELL_SIZE),
    }
  }

  private setupInput(): void {
    const cam = this.cameras.main

    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const cell = this.worldToCell(pointer.worldX, pointer.worldY)

      if (cell.x !== this.hoveredCell?.x || cell.y !== this.hoveredCell?.y) {
        this.hoveredCell = cell
        this.drawHover()
      }

      if (this.isPanning) {
        const dx = pointer.x - this.panStartX
        const dy = pointer.y - this.panStartY
        cam.setScroll(this.camStartX - dx / cam.zoom, this.camStartY - dy / cam.zoom)
      }
    })

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.middleButtonDown() || pointer.rightButtonDown()) {
        this.isPanning = true
        this.panStartX = pointer.x
        this.panStartY = pointer.y
        this.camStartX = cam.scrollX
        this.camStartY = cam.scrollY
        return
      }

      if (pointer.leftButtonDown()) {
        const cell = this.worldToCell(pointer.worldX, pointer.worldY)
        if (cell.x < 0 || cell.x >= GRID_WIDTH || cell.y < 0 || cell.y >= GRID_HEIGHT) return
        this.onCellClick?.(cell.x, cell.y)
      }
    })

    this.input.on('pointerup', (pointer: Phaser.Input.Pointer) => {
      if (!pointer.middleButtonDown() && !pointer.rightButtonDown()) {
        this.isPanning = false
      }
    })

    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown[], _dx: number, deltaY: number) => {
      const newZoom = Phaser.Math.Clamp(cam.zoom * (deltaY > 0 ? 0.9 : 1.1), 0.25, 4)
      cam.setZoom(newZoom)
    })

    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }
}
