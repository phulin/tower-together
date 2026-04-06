import { useEffect, useRef, useCallback, useState } from 'react'
import { PhaserGame } from '../game/PhaserGame'
import { GameScene } from '../game/GameScene'
import { TowerSocket } from '../lib/socket'
import type { SelectedTool, ConnectionStatus, ServerMessage } from '../types'

interface Props {
  playerId: string
  displayName: string
  towerId: string
  onLeave: () => void
}

export function GameScreen({ playerId, displayName, towerId, onLeave }: Props) {
  const [selectedTool, setSelectedTool] = useState<SelectedTool>('floor')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [simTime, setSimTime] = useState(0)
  const [playerCount, setPlayerCount] = useState(0)
  const [towerName, setTowerName] = useState(towerId)

  const sceneRef = useRef<GameScene | null>(null)
  const socketRef = useRef<TowerSocket | null>(null)

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'init_state':
        setSimTime(msg.simTime)
        setTowerName(msg.name || msg.towerId)
        sceneRef.current?.applyInitState(msg.cells)
        break
      case 'state_patch':
        sceneRef.current?.applyPatch(msg.cells)
        break
      case 'command_result':
        if (msg.accepted && msg.patch) {
          sceneRef.current?.applyPatch(msg.patch.cells)
        }
        break
      case 'presence_update':
        setPlayerCount(msg.playerCount)
        break
      case 'time_update':
        setSimTime(msg.simTime)
        break
    }
  }, [])

  const handleStatus = useCallback((status: ConnectionStatus) => {
    setConnectionStatus(status)
    if (status === 'connected') {
      socketRef.current?.send({ type: 'join_tower', playerId, displayName })
    }
  }, [playerId, displayName])

  useEffect(() => {
    const socket = new TowerSocket(towerId, handleMessage, handleStatus)
    socketRef.current = socket
    return () => {
      socket.destroy()
      socketRef.current = null
    }
  }, [towerId, handleMessage, handleStatus])

  const handleCellClick = useCallback((x: number, y: number) => {
    const socket = socketRef.current
    if (!socket) return

    // Access grid state from scene to decide place vs remove
    const scene = sceneRef.current
    if (!scene) return

    // We need to know what's currently at the cell to decide action.
    // The scene exposes the grid via a public getter we'll add, or we track it here.
    // For simplicity: if tool is empty, always remove. Otherwise place.
    if (selectedTool === 'empty') {
      socket.send({ type: 'remove_tile', x, y })
    } else {
      socket.send({ type: 'place_tile', x, y, tileType: selectedTool })
    }
  }, [selectedTool])

  function handleReconnect() {
    socketRef.current?.reconnect()
  }

  function formatSimTime(t: number): string {
    const days = Math.floor(t / (24 * 60))
    const hours = Math.floor((t % (24 * 60)) / 60)
    const mins = t % 60
    return `Day ${days + 1}  ${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`
  }

  const statusColor =
    connectionStatus === 'connected'
      ? '#4ade80'
      : connectionStatus === 'connecting'
      ? '#facc15'
      : '#f87171'

  const tools: Array<{ id: SelectedTool; label: string; color: string }> = [
    { id: 'empty', label: 'Erase', color: '#888' },
    { id: 'floor', label: 'Floor', color: '#444' },
    { id: 'room_basic', label: 'Room', color: '#3a7bd5' },
  ]

  return (
    <div style={styles.container}>
      {/* Top toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <span style={styles.towerLabel} title={towerId}>
            {towerName}
          </span>
          <div style={styles.toolGroup}>
            {tools.map((t) => (
              <button
                key={t.id}
                style={{
                  ...styles.toolBtn,
                  borderColor: selectedTool === t.id ? t.color : '#444',
                  background: selectedTool === t.id ? t.color + '33' : 'transparent',
                  color: selectedTool === t.id ? t.color : '#999',
                }}
                onClick={() => setSelectedTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div style={styles.toolbarRight}>
          <span style={styles.statItem}>{formatSimTime(simTime)}</span>
          <span style={styles.statItem}>
            {playerCount} player{playerCount !== 1 ? 's' : ''}
          </span>
          <button style={styles.leaveBtn} onClick={onLeave}>
            Leave
          </button>
        </div>
      </div>

      {/* Game canvas */}
      <div style={styles.canvasWrapper}>
        <PhaserGame
          onCellClick={handleCellClick}
          sceneRef={sceneRef}
        />
      </div>

      {/* Bottom status bar */}
      <div style={styles.statusBar}>
        <span style={{ ...styles.statusDot, background: statusColor }} />
        <span style={styles.statusText}>
          {connectionStatus === 'connected'
            ? 'Connected'
            : connectionStatus === 'connecting'
            ? 'Connecting...'
            : 'Disconnected'}
        </span>
        {connectionStatus === 'disconnected' && (
          <button style={styles.reconnectBtn} onClick={handleReconnect}>
            Reconnect
          </button>
        )}
        <span style={styles.statusRight}>
          Tower ID: <span style={styles.towerIdSmall}>{towerId}</span>
        </span>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    background: '#1a1a1a',
    overflow: 'hidden',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 48,
    padding: '0 16px',
    background: '#242424',
    borderBottom: '1px solid #333',
    flexShrink: 0,
  },
  toolbarLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  toolbarRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  towerLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: '#ccc',
    maxWidth: 160,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  toolGroup: {
    display: 'flex',
    gap: 6,
  },
  toolBtn: {
    padding: '5px 14px',
    borderRadius: 5,
    border: '1px solid',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.1s',
  },
  statItem: {
    fontSize: 13,
    color: '#aaa',
  },
  leaveBtn: {
    padding: '5px 14px',
    borderRadius: 5,
    border: '1px solid #555',
    background: 'transparent',
    color: '#aaa',
    fontSize: 13,
    cursor: 'pointer',
  },
  canvasWrapper: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    height: 32,
    padding: '0 16px',
    background: '#1e1e1e',
    borderTop: '1px solid #2a2a2a',
    gap: 8,
    flexShrink: 0,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusText: {
    fontSize: 12,
    color: '#888',
  },
  reconnectBtn: {
    padding: '2px 10px',
    borderRadius: 4,
    border: '1px solid #555',
    background: 'transparent',
    color: '#ccc',
    fontSize: 12,
    cursor: 'pointer',
  },
  statusRight: {
    marginLeft: 'auto',
    fontSize: 12,
    color: '#666',
  },
  towerIdSmall: {
    fontFamily: 'monospace',
    color: '#888',
  },
}
