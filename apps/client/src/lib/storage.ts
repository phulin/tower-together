const PLAYER_ID_KEY = 'tower_together_player_id'
const DISPLAY_NAME_KEY = 'tower_together_display_name'
const RECENT_TOWERS_KEY = 'tower_together_recent_towers'

export function getPlayerId(): string | null {
  return localStorage.getItem(PLAYER_ID_KEY)
}

export function getDisplayName(): string | null {
  return localStorage.getItem(DISPLAY_NAME_KEY)
}

export function savePlayer(playerId: string, displayName: string): void {
  localStorage.setItem(PLAYER_ID_KEY, playerId)
  localStorage.setItem(DISPLAY_NAME_KEY, displayName)
}

export function clearPlayer(): void {
  localStorage.removeItem(PLAYER_ID_KEY)
  localStorage.removeItem(DISPLAY_NAME_KEY)
}

export function getRecentTowers(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_TOWERS_KEY)
    if (!raw) return []
    return JSON.parse(raw) as string[]
  } catch {
    return []
  }
}

export function addRecentTower(towerId: string): void {
  const existing = getRecentTowers()
  const updated = [towerId, ...existing.filter((id) => id !== towerId)].slice(0, 5)
  localStorage.setItem(RECENT_TOWERS_KEY, JSON.stringify(updated))
}

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
