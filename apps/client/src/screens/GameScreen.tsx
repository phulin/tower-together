import { useEffect, useRef, useCallback, useState } from 'react'
import { PhaserGame } from '../game/PhaserGame'
import { GameScene } from '../game/GameScene'
import { TowerSocket } from '../lib/socket'
import { TILE_COSTS } from '../types'
import type { SelectedTool, ConnectionStatus, ServerMessage } from '../types'

interface Props {
  playerId: string
  displayName: string
  towerId: string
  onLeave: () => void
}

interface ToolDef {
  id: SelectedTool
  label: string
  color: string
  cost: number
}

const TOOLS: ToolDef[] = [
  { id: 'empty',        label: 'Erase',       color: '#888',    cost: 0 },
  { id: 'floor',        label: 'Floor',       color: '#777',    cost: TILE_COSTS.floor },
  { id: 'lobby',        label: 'Lobby',       color: '#c9a84c', cost: TILE_COSTS.lobby },
  { id: 'hotel_single', label: 'Single',      color: '#2d9c8d', cost: TILE_COSTS.hotel_single },
  { id: 'hotel_twin',   label: 'Twin',        color: '#2d7a9c', cost: TILE_COSTS.hotel_twin },
  { id: 'hotel_suite',  label: 'Suite',       color: '#2d4f9c', cost: TILE_COSTS.hotel_suite },
]

export function GameScreen({ playerId, displayName, towerId, onLeave }: Props) {
  const [selectedTool, setSelectedTool] = useState<SelectedTool>('floor')
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const [simTime, setSimTime] = useState(0)
  const [cash, setCash] = useState(0)
  const [playerCount, setPlayerCount] = useState(0)
  const [towerName, setTowerName] = useState(towerId)

  const sceneRef = useRef<GameScene | null>(null)
  const socketRef = useRef<TowerSocket | null>(null)

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'init_state':
        setSimTime(msg.simTime)
        setCash(msg.cash)
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
      case 'economy_update':
        setCash(msg.cash)
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
    return () => { socket.destroy(); socketRef.current = null }
  }, [towerId, handleMessage, handleStatus])

  const handleCellClick = useCallback((x: number, y: number) => {
    if (!socketRef.current) return
    if (selectedTool === 'empty') {
      socketRef.current.send({ type: 'remove_tile', x, y })
    } else {
      socketRef.current.send({ type: 'place_tile', x, y, tileType: selectedTool })
    }
  }, [selectedTool])

  const day = Math.floor(simTime / 24) + 1
  const hour = simTime % 24

  const statusColor =
    connectionStatus === 'connected'   ? '#4ade80' :
    connectionStatus === 'connecting'  ? '#facc15' : '#f87171'

  return (
    <div style={styles.container}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          <span style={styles.towerLabel} title={towerId}>{towerName}</span>
          <div style={styles.toolGroup}>
            {TOOLS.map((t) => (
              <button
                key={t.id}
                title={t.cost > 0 ? `$${t.cost.toLocaleString()}` : ''}
                style={{
                  ...styles.toolBtn,
                  borderColor: selectedTool === t.id ? t.color : '#444',
                  background:  selectedTool === t.id ? t.color + '33' : 'transparent',
                  color:       selectedTool === t.id ? t.color : '#999',
                }}
                onClick={() => setSelectedTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.toolbarRight}>
          <span style={styles.cashDisplay}>${cash.toLocaleString()}</span>
          <span style={styles.statItem}>Day {day} · {String(hour).padStart(2, '0')}:00</span>
          <span style={styles.statItem}>{playerCount} player{playerCount !== 1 ? 's' : ''}</span>
          <button style={styles.leaveBtn} onClick={onLeave}>Leave</button>
        </div>
      </div>

      {/* Game canvas */}
      <div style={styles.canvasWrapper}>
        <PhaserGame
          onCellClick={handleCellClick}
          selectedTool={selectedTool}
          sceneRef={sceneRef}
        />
      </div>

      {/* Status bar */}
      <div style={styles.statusBar}>
        <span style={{ ...styles.statusDot, background: statusColor }} />
        <span style={styles.statusText}>
          {connectionStatus === 'connected'  ? 'Connected'    :
           connectionStatus === 'connecting' ? 'Connecting…'  : 'Disconnected'}
        </span>
        {connectionStatus === 'disconnected' && (
          <button style={styles.reconnectBtn} onClick={() => socketRef.current?.reconnect()}>
            Reconnect
          </button>
        )}
        <span style={styles.statusRight}>
          Tower: <span style={styles.towerIdSmall}>{towerId}</span>
        </span>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex', flexDirection: 'column',
    width: '100%', height: '100%',
    background: '#1a1a1a', overflow: 'hidden',
  },
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    height: 48, padding: '0 16px',
    background: '#242424', borderBottom: '1px solid #333', flexShrink: 0,
  },
  toolbarLeft:  { display: 'flex', alignItems: 'center', gap: 16 },
  toolbarRight: { display: 'flex', alignItems: 'center', gap: 16 },
  towerLabel: {
    fontSize: 14, fontWeight: 600, color: '#ccc',
    maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  toolGroup: { display: 'flex', gap: 4 },
  toolBtn: {
    padding: '4px 10px', borderRadius: 4, border: '1px solid',
    fontSize: 12, fontWeight: 500, cursor: 'pointer', transition: 'all 0.1s',
  },
  cashDisplay: {
    fontSize: 15, fontWeight: 700, color: '#4ade80', fontVariantNumeric: 'tabular-nums',
  },
  statItem: { fontSize: 12, color: '#aaa' },
  leaveBtn: {
    padding: '4px 12px', borderRadius: 4, border: '1px solid #555',
    background: 'transparent', color: '#aaa', fontSize: 12, cursor: 'pointer',
  },
  canvasWrapper: { flex: 1, overflow: 'hidden', position: 'relative' },
  statusBar: {
    display: 'flex', alignItems: 'center', height: 28, padding: '0 16px',
    background: '#1e1e1e', borderTop: '1px solid #2a2a2a', gap: 8, flexShrink: 0,
  },
  statusDot:    { width: 7, height: 7, borderRadius: '50%', flexShrink: 0 },
  statusText:   { fontSize: 11, color: '#888' },
  reconnectBtn: {
    padding: '2px 8px', borderRadius: 3, border: '1px solid #555',
    background: 'transparent', color: '#ccc', fontSize: 11, cursor: 'pointer',
  },
  statusRight:  { marginLeft: 'auto', fontSize: 11, color: '#666' },
  towerIdSmall: { fontFamily: 'monospace', color: '#888' },
}
