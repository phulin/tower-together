import { useCallback, useEffect, useRef, useState } from "react";
import type { GameScene } from "../game/GameScene";
import { PhaserGame } from "../game/PhaserGame";

interface Toast {
	id: number;
	message: string;
}

let toastCounter = 0;

import * as socket from "../lib/socket";
import type { ConnectionStatus, SelectedTool, ServerMessage } from "../types";
import { DAY_TICK_MAX, TILE_COSTS } from "../types";

interface Props {
	playerId: string;
	displayName: string;
	towerId: string;
	onLeave: () => void;
}

interface ToolDef {
	id: SelectedTool;
	label: string;
	color: string;
	cost: number;
}

const TOOLS: ToolDef[] = [
	{ id: "empty", label: "Erase", color: "#888", cost: 0 },
	{ id: "floor", label: "Floor", color: "#777", cost: TILE_COSTS.floor },
	{ id: "lobby", label: "Lobby", color: "#c9a84c", cost: TILE_COSTS.lobby },
	{ id: "stairs", label: "Stairs", color: "#e8d5a3", cost: TILE_COSTS.stairs },
	{
		id: "hotel_single",
		label: "Single",
		color: "#2d9c8d",
		cost: TILE_COSTS.hotel_single,
	},
	{
		id: "hotel_twin",
		label: "Twin",
		color: "#2d7a9c",
		cost: TILE_COSTS.hotel_twin,
	},
	{
		id: "hotel_suite",
		label: "Suite",
		color: "#2d4f9c",
		cost: TILE_COSTS.hotel_suite,
	},
	{
		id: "vip_single",
		label: "VIP S",
		color: "#3d8c7d",
		cost: TILE_COSTS.vip_single,
	},
	{
		id: "vip_twin",
		label: "VIP T",
		color: "#3d6a8c",
		cost: TILE_COSTS.vip_twin,
	},
	{
		id: "vip_suite",
		label: "VIP Su",
		color: "#3d3f8c",
		cost: TILE_COSTS.vip_suite,
	},
	{
		id: "restaurant",
		label: "Restaurant",
		color: "#c07840",
		cost: TILE_COSTS.restaurant,
	},
	{
		id: "fast_food",
		label: "Fast Food",
		color: "#c0a040",
		cost: TILE_COSTS.fast_food,
	},
	{ id: "retail", label: "Retail", color: "#a0c040", cost: TILE_COSTS.retail },
	{ id: "office", label: "Office", color: "#8080c0", cost: TILE_COSTS.office },
	{ id: "condo", label: "Condo", color: "#60a080", cost: TILE_COSTS.condo },
	{ id: "cinema", label: "Cinema", color: "#c040a0", cost: TILE_COSTS.cinema },
	{
		id: "security",
		label: "Security",
		color: "#c04040",
		cost: TILE_COSTS.security,
	},
	{
		id: "housekeeping",
		label: "Housekeeping",
		color: "#8cb0c0",
		cost: TILE_COSTS.housekeeping,
	},
	{ id: "metro", label: "Metro", color: "#60c0c0", cost: TILE_COSTS.metro },
	{
		id: "fire_suppressor",
		label: "Fire Supp.",
		color: "#e06060",
		cost: TILE_COSTS.fire_suppressor,
	},
];

export function GameScreen({ playerId, displayName, towerId, onLeave }: Props) {
	const [selectedTool, setSelectedTool] = useState<SelectedTool>("floor");
	const [connectionStatus, setConnectionStatus] =
		useState<ConnectionStatus>("connecting");
	const [simTime, setSimTime] = useState(0);
	const [cash, setCash] = useState(0);
	const [playerCount, setPlayerCount] = useState(0);
	const [towerName, setTowerName] = useState(towerId);
	const [isRenaming, setIsRenaming] = useState(false);
	const [aliasInput, setAliasInput] = useState("");
	const [aliasError, setAliasError] = useState("");
	const [aliasSaving, setAliasSaving] = useState(false);
	const [toasts, setToasts] = useState<Toast[]>([]);

	const addToast = useCallback((message: string) => {
		const id = ++toastCounter;
		setToasts((prev) => [...prev, { id, message }]);
		setTimeout(() => {
			setToasts((prev) => prev.filter((t) => t.id !== id));
		}, 3000);
	}, []);

	const sceneRef = useRef<GameScene | null>(null);
	const canvasWrapperRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		return socket.onMessage((msg: ServerMessage) => {
			switch (msg.type) {
				case "init_state":
					setSimTime(msg.simTime);
					setCash(msg.cash);
					setTowerName(msg.name || msg.towerId);
					sceneRef.current?.applyInitState(msg.cells);
					break;
				case "state_patch":
					sceneRef.current?.applyPatch(msg.cells);
					break;
				case "command_result":
					if (msg.accepted && msg.patch) {
						sceneRef.current?.applyPatch(msg.patch.cells);
					} else if (!msg.accepted && msg.reason) {
						addToast(msg.reason);
					}
					break;
				case "presence_update":
					setPlayerCount(msg.playerCount);
					break;
				case "time_update":
					setSimTime(msg.simTime);
					break;
				case "economy_update":
					setCash(msg.cash);
					break;
			}
		});
	}, [addToast]);

	useEffect(() => {
		return socket.onStatus((status: ConnectionStatus) => {
			setConnectionStatus(status);
			if (status === "connected") {
				socket.send({ type: "join_tower", playerId, displayName });
			}
		});
	}, [playerId, displayName]);

	const handleCellClick = useCallback(
		(x: number, y: number, shift: boolean) => {
			if (selectedTool === "empty") {
				socket.send({ type: "remove_tile", x, y });
				return;
			}

			if (shift) {
				// Shift-click: fill the range between lastPlacedAnchor and this cell
				const fills = sceneRef.current?.computeShiftFill(x, y) ?? [];
				for (const pos of fills) {
					socket.send({
						type: "place_tile",
						x: pos.x,
						y: pos.y,
						tileType: selectedTool,
					});
				}
				// Update lastPlaced to rightmost/leftmost tile placed (last in array)
				if (fills.length > 0) {
					const last = fills[fills.length - 1];
					sceneRef.current?.setLastPlaced(last.x, last.y, selectedTool);
				}
			} else {
				socket.send({ type: "place_tile", x, y, tileType: selectedTool });
				sceneRef.current?.setLastPlaced(x, y, selectedTool);
			}
		},
		[selectedTool],
	);

	async function handleSetAlias() {
		const alias = aliasInput.trim().toLowerCase();
		if (!alias) return;
		setAliasSaving(true);
		setAliasError("");
		try {
			const res = await fetch(`/api/towers/${towerId}/alias`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ alias }),
			});
			if (!res.ok) {
				const err = (await res.json()) as { error: string };
				setAliasError(err.error || "Failed to set alias");
				return;
			}
			setTowerName(alias);
			setIsRenaming(false);
			window.history.replaceState(null, "", `/${alias}`);
		} catch {
			setAliasError("Network error");
		} finally {
			setAliasSaving(false);
		}
	}

	const day = Math.floor(simTime / DAY_TICK_MAX) + 1;
	// Map day_tick (0–2599) to SimTower clock: 6:00am (tick 0) → 1:00am next day (tick 2599)
	const dayTick = simTime % DAY_TICK_MAX;
	const hour = (6 + Math.floor((dayTick * 19) / DAY_TICK_MAX)) % 24;

	const statusColor =
		connectionStatus === "connected"
			? "#4ade80"
			: connectionStatus === "connecting"
				? "#facc15"
				: "#f87171";

	return (
		<div style={styles.container}>
			{/* Toolbar */}
			<div style={styles.toolbar}>
				<div style={styles.toolbarLeft}>
					{isRenaming ? (
						<form
							style={styles.renameForm}
							onSubmit={(e) => {
								e.preventDefault();
								handleSetAlias();
							}}
						>
							<input
								style={styles.renameInput}
								value={aliasInput}
								onChange={(e) => {
									setAliasInput(e.target.value);
									setAliasError("");
								}}
								placeholder="alias..."
								disabled={aliasSaving}
							/>
							<button
								style={styles.renameSave}
								type="submit"
								disabled={aliasSaving}
							>
								{aliasSaving ? "..." : "Save"}
							</button>
							<button
								style={styles.renameCancel}
								type="button"
								onClick={() => setIsRenaming(false)}
							>
								Cancel
							</button>
							{aliasError && (
								<span style={styles.renameError}>{aliasError}</span>
							)}
						</form>
					) : (
						<button
							type="button"
							style={styles.towerLabel}
							title={`${towerName} (click to rename)`}
							onClick={() => {
								setAliasInput(towerName === towerId ? "" : towerName);
								setAliasError("");
								setIsRenaming(true);
							}}
						>
							{towerName}
						</button>
					)}
					<div style={styles.toolGroup}>
						{TOOLS.map((t) => (
							<button
								type="button"
								key={t.id}
								title={t.cost > 0 ? `$${t.cost.toLocaleString()}` : ""}
								style={{
									...styles.toolBtn,
									borderColor: selectedTool === t.id ? t.color : "#444",
									background:
										selectedTool === t.id ? `${t.color}33` : "transparent",
									color: selectedTool === t.id ? t.color : "#999",
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
					<span style={styles.statItem}>
						Day {day} · {String(hour).padStart(2, "0")}h
					</span>
					<span style={styles.statItem}>
						{playerCount} player{playerCount !== 1 ? "s" : ""}
					</span>
					<button type="button" style={styles.leaveBtn} onClick={onLeave}>
						Leave
					</button>
				</div>
			</div>

			{/* Game canvas */}
			<div ref={canvasWrapperRef} style={styles.canvasWrapper}>
				<PhaserGame
					onCellClick={handleCellClick}
					selectedTool={selectedTool}
					sceneRef={sceneRef}
				/>
			</div>

			{/* Toasts */}
			{toasts.length > 0 && (
				<div style={styles.toastContainer}>
					{toasts.map((t) => (
						<div key={t.id} style={styles.toast}>
							{t.message}
						</div>
					))}
				</div>
			)}

			{/* Status bar */}
			<div style={styles.statusBar}>
				<span style={{ ...styles.statusDot, background: statusColor }} />
				<span style={styles.statusText}>
					{connectionStatus === "connected"
						? "Connected"
						: connectionStatus === "connecting"
							? "Connecting…"
							: "Disconnected"}
				</span>
				{connectionStatus === "disconnected" && (
					<button
						type="button"
						style={styles.reconnectBtn}
						onClick={() => socket.reconnect()}
					>
						Reconnect
					</button>
				)}
				<span style={styles.statusRight}>
					Tower: <span style={styles.towerIdSmall}>{towerId}</span>
				</span>
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		width: "100%",
		height: "100%",
		background: "#1a1a1a",
		overflow: "hidden",
	},
	toolbar: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		height: 48,
		padding: "0 16px",
		background: "#242424",
		borderBottom: "1px solid #333",
		flexShrink: 0,
	},
	toolbarLeft: { display: "flex", alignItems: "center", gap: 16 },
	toolbarRight: { display: "flex", alignItems: "center", gap: 16 },
	towerLabel: {
		fontSize: 14,
		fontWeight: 600,
		color: "#ccc",
		maxWidth: 140,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		cursor: "pointer",
		background: "transparent",
		border: "none",
		borderBottom: "1px dashed #555",
		padding: 0,
	},
	renameForm: {
		display: "flex",
		alignItems: "center",
		gap: 4,
	},
	renameInput: {
		width: 120,
		padding: "3px 8px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "#1a1a1a",
		color: "#e0e0e0",
		fontSize: 13,
		outline: "none",
	},
	renameSave: {
		padding: "3px 8px",
		borderRadius: 4,
		border: "1px solid #3a7bd5",
		background: "transparent",
		color: "#3a7bd5",
		fontSize: 11,
		cursor: "pointer",
	},
	renameCancel: {
		padding: "3px 8px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "transparent",
		color: "#888",
		fontSize: 11,
		cursor: "pointer",
	},
	renameError: {
		fontSize: 11,
		color: "#f87171",
	},
	toolGroup: { display: "flex", gap: 4 },
	toolBtn: {
		padding: "4px 10px",
		borderRadius: 4,
		border: "1px solid",
		fontSize: 12,
		fontWeight: 500,
		cursor: "pointer",
		transition: "all 0.1s",
	},
	cashDisplay: {
		fontSize: 15,
		fontWeight: 700,
		color: "#4ade80",
		fontVariantNumeric: "tabular-nums",
	},
	statItem: { fontSize: 12, color: "#aaa" },
	leaveBtn: {
		padding: "4px 12px",
		borderRadius: 4,
		border: "1px solid #555",
		background: "transparent",
		color: "#aaa",
		fontSize: 12,
		cursor: "pointer",
	},
	canvasWrapper: { flex: 1, overflow: "hidden", position: "relative" },
	statusBar: {
		display: "flex",
		alignItems: "center",
		height: 28,
		padding: "0 16px",
		background: "#1e1e1e",
		borderTop: "1px solid #2a2a2a",
		gap: 8,
		flexShrink: 0,
	},
	statusDot: { width: 7, height: 7, borderRadius: "50%", flexShrink: 0 },
	statusText: { fontSize: 11, color: "#888" },
	reconnectBtn: {
		padding: "2px 8px",
		borderRadius: 3,
		border: "1px solid #555",
		background: "transparent",
		color: "#ccc",
		fontSize: 11,
		cursor: "pointer",
	},
	statusRight: { marginLeft: "auto", fontSize: 11, color: "#666" },
	towerIdSmall: { fontFamily: "monospace", color: "#888" },
	toastContainer: {
		position: "absolute",
		bottom: 40,
		right: 16,
		display: "flex",
		flexDirection: "column",
		alignItems: "flex-end",
		gap: 6,
		pointerEvents: "none",
		zIndex: 100,
	},
	toast: {
		padding: "7px 14px",
		borderRadius: 6,
		background: "#3a1a1a",
		border: "1px solid #c0392b",
		color: "#f87171",
		fontSize: 13,
		whiteSpace: "nowrap",
	},
};
