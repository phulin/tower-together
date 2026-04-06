import Phaser from 'phaser'

const GRID_WIDTH = 64
const GRID_HEIGHT = 80
const CELL_SIZE = 16

const COLOR_EMPTY = 0x1a1a1a
const COLOR_FLOOR = 0x444444
const COLOR_ROOM_BASIC = 0x3a7bd5
const COLOR_HOVER = 0xffff00
const COLOR_GRID_LINE = 0x333333

export type CellClickHandler = (x: number, y: number) => void

export class GameScene extends Phaser.Scene {
  private cellGraphics!: Phaser.GameObjects.Graphics
  private gridGraphics!: Phaser.GameObjects.Graphics
  private hoverGraphics!: Phaser.GameObjects.Graphics

  private grid: Map<string, string> = new Map()
  private hoveredCell: { x: number; y: number } | null = null
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

    // Set world bounds
    this.cameras.main.setBounds(
      -CELL_SIZE * 4,
      -CELL_SIZE * 4,
      totalWidth + CELL_SIZE * 8,
      totalHeight + CELL_SIZE * 8,
    )

    // Center camera on grid
    this.cameras.main.centerOn(totalWidth / 2, totalHeight / 2)

    // Graphics layers
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
      g.beginPath()
      g.moveTo(x * CELL_SIZE, 0)
      g.lineTo(x * CELL_SIZE, totalHeight)
      g.strokePath()
    }
    for (let y = 0; y <= GRID_HEIGHT; y++) {
      g.beginPath()
      g.moveTo(0, y * CELL_SIZE)
      g.lineTo(totalWidth, y * CELL_SIZE)
      g.strokePath()
    }
  }

  private drawAllCells(): void {
    const g = this.cellGraphics
    g.clear()

    // Draw background
    g.fillStyle(COLOR_EMPTY, 1)
    g.fillRect(0, 0, GRID_WIDTH * CELL_SIZE, GRID_HEIGHT * CELL_SIZE)

    for (const [key, tileType] of this.grid) {
      const [x, y] = key.split(',').map(Number)
      this.drawCell(g, x, y, tileType)
    }
  }

  private drawCell(g: Phaser.GameObjects.Graphics, x: number, y: number, tileType: string): void {
    let color: number
    switch (tileType) {
      case 'floor':
        color = COLOR_FLOOR
        break
      case 'room_basic':
        color = COLOR_ROOM_BASIC
        break
      default:
        color = COLOR_EMPTY
        break
    }
    g.fillStyle(color, 1)
    g.fillRect(x * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 1, CELL_SIZE - 1)
  }

  private drawHover(): void {
    const g = this.hoverGraphics
    g.clear()
    if (!this.hoveredCell) return

    const { x, y } = this.hoveredCell
    if (x < 0 || x >= GRID_WIDTH || y < 0 || y >= GRID_HEIGHT) return

    g.fillStyle(COLOR_HOVER, 0.35)
    g.fillRect(x * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 1, CELL_SIZE - 1)
  }

  private worldToCell(wx: number, wy: number): { x: number; y: number } {
    return {
      x: Math.floor(wx / CELL_SIZE),
      y: Math.floor(wy / CELL_SIZE),
    }
  }

  private setupInput(): void {
    const cam = this.cameras.main

    // Mouse move -> hover
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const worldX = pointer.worldX
      const worldY = pointer.worldY
      const cell = this.worldToCell(worldX, worldY)

      if (cell.x !== this.hoveredCell?.x || cell.y !== this.hoveredCell?.y) {
        this.hoveredCell = cell
        this.drawHover()
      }

      // Handle panning
      if (this.isPanning) {
        const dx = pointer.x - this.panStartX
        const dy = pointer.y - this.panStartY
        cam.setScroll(this.camStartX - dx / cam.zoom, this.camStartY - dy / cam.zoom)
      }
    })

    // Middle mouse / right mouse down -> start pan
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.middleButtonDown() || pointer.rightButtonDown()) {
        this.isPanning = true
        this.panStartX = pointer.x
        this.panStartY = pointer.y
        this.camStartX = cam.scrollX
        this.camStartY = cam.scrollY
        return
      }

      // Left click -> place/remove
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

    // Zoom with scroll wheel
    this.input.on('wheel', (_pointer: Phaser.Input.Pointer, _gameObjects: unknown[], _deltaX: number, deltaY: number) => {
      const zoomFactor = deltaY > 0 ? 0.9 : 1.1
      const newZoom = Phaser.Math.Clamp(cam.zoom * zoomFactor, 0.25, 4)
      cam.setZoom(newZoom)
    })

    // Disable right-click context menu on canvas
    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  }
}
