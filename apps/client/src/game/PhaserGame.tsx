import { useEffect, useRef } from 'react'
import Phaser from 'phaser'
import { GameScene } from './GameScene'

interface Props {
  onCellClick: (x: number, y: number) => void
  sceneRef: React.MutableRefObject<GameScene | null>
}

export function PhaserGame({ onCellClick, sceneRef }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const gameRef = useRef<Phaser.Game | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const scene = new GameScene()
    sceneRef.current = scene

    const config: Phaser.Types.Core.GameConfig = {
      type: Phaser.AUTO,
      parent: containerRef.current,
      backgroundColor: '#1a1a1a',
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: '100%',
        height: '100%',
      },
      scene: scene,
      disableContextMenu: false,
    }

    gameRef.current = new Phaser.Game(config)

    return () => {
      sceneRef.current = null
      gameRef.current?.destroy(true)
      gameRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Wire up click callback whenever it changes
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setOnCellClick(onCellClick)
  }, [onCellClick, sceneRef])

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%' }}
    />
  )
}
