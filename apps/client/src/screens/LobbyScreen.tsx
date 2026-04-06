import { useState } from "react";
import { addRecentTower, clearPlayer, getRecentTowers } from "../lib/storage";

interface Props {
	displayName: string;
	onJoinTower: (towerId: string) => void;
	onLogout: () => void;
}

export function LobbyScreen({ displayName, onJoinTower, onLogout }: Props) {
	const [joinId, setJoinId] = useState("");
	const [joinError, setJoinError] = useState("");
	const [isCreating, setIsCreating] = useState(false);
	const [createError, setCreateError] = useState("");

	const recentTowers = getRecentTowers();

	async function handleCreate() {
		setIsCreating(true);
		setCreateError("");
		try {
			const res = await fetch("/api/towers", { method: "POST" });
			if (!res.ok) throw new Error(`Server error: ${res.status}`);
			const data = (await res.json()) as { towerId: string };
			addRecentTower(data.towerId);
			onJoinTower(data.towerId);
		} catch (e) {
			setCreateError(e instanceof Error ? e.message : "Failed to create tower");
		} finally {
			setIsCreating(false);
		}
	}

	function handleJoin(e: React.FormEvent) {
		e.preventDefault();
		const id = joinId.trim();
		if (!id) {
			setJoinError("Please enter a tower ID.");
			return;
		}
		addRecentTower(id);
		onJoinTower(id);
	}

	function handleRecentJoin(towerId: string) {
		addRecentTower(towerId);
		onJoinTower(towerId);
	}

	function handleLogout() {
		clearPlayer();
		onLogout();
	}

	return (
		<div style={styles.container}>
			<div style={styles.card}>
				<div style={styles.header}>
					<h1 style={styles.title}>Tower Lobby</h1>
					<div style={styles.userRow}>
						<span style={styles.userName}>{displayName}</span>
						<button
							type="button"
							style={styles.logoutBtn}
							onClick={handleLogout}
						>
							Change Name
						</button>
					</div>
				</div>

				<div style={styles.section}>
					<h2 style={styles.sectionTitle}>Create a Tower</h2>
					<button
						type="button"
						style={{ ...styles.primaryButton, opacity: isCreating ? 0.6 : 1 }}
						onClick={handleCreate}
						disabled={isCreating}
					>
						{isCreating ? "Creating..." : "Create Tower"}
					</button>
					{createError && <p style={styles.error}>{createError}</p>}
				</div>

				<div style={styles.divider} />

				<div style={styles.section}>
					<h2 style={styles.sectionTitle}>Join a Tower</h2>
					<form onSubmit={handleJoin} style={styles.joinForm}>
						<input
							style={styles.input}
							type="text"
							placeholder="Tower ID..."
							value={joinId}
							onChange={(e) => {
								setJoinId(e.target.value);
								setJoinError("");
							}}
						/>
						<button style={styles.secondaryButton} type="submit">
							Join
						</button>
					</form>
					{joinError && <p style={styles.error}>{joinError}</p>}
				</div>

				{recentTowers.length > 0 && (
					<>
						<div style={styles.divider} />
						<div style={styles.section}>
							<h2 style={styles.sectionTitle}>Recent Towers</h2>
							<div style={styles.recentList}>
								{recentTowers.map((id) => (
									<button
										type="button"
										key={id}
										style={styles.recentItem}
										onClick={() => handleRecentJoin(id)}
									>
										<span style={styles.recentId}>{id}</span>
										<span style={styles.recentJoin}>Join</span>
									</button>
								))}
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		width: "100%",
		height: "100%",
		background: "#1a1a1a",
		overflow: "auto",
		padding: 24,
	},
	card: {
		background: "#242424",
		border: "1px solid #333",
		borderRadius: 12,
		padding: "32px 40px",
		minWidth: 400,
		maxWidth: 480,
		width: "100%",
	},
	header: {
		marginBottom: 24,
	},
	title: {
		fontSize: 28,
		fontWeight: 700,
		color: "#e0e0e0",
		marginBottom: 8,
	},
	userRow: {
		display: "flex",
		alignItems: "center",
		gap: 12,
	},
	userName: {
		color: "#aaa",
		fontSize: 14,
	},
	logoutBtn: {
		background: "none",
		border: "none",
		color: "#3a7bd5",
		fontSize: 13,
		cursor: "pointer",
		padding: 0,
		textDecoration: "underline",
	},
	section: {
		marginBottom: 4,
	},
	sectionTitle: {
		fontSize: 16,
		fontWeight: 600,
		color: "#ccc",
		marginBottom: 12,
	},
	primaryButton: {
		width: "100%",
		padding: "11px 0",
		borderRadius: 6,
		border: "none",
		background: "#3a7bd5",
		color: "#fff",
		fontSize: 15,
		fontWeight: 600,
		cursor: "pointer",
	},
	joinForm: {
		display: "flex",
		gap: 8,
	},
	input: {
		flex: 1,
		padding: "10px 14px",
		borderRadius: 6,
		border: "1px solid #444",
		background: "#1a1a1a",
		color: "#e0e0e0",
		fontSize: 15,
		outline: "none",
	},
	secondaryButton: {
		padding: "10px 20px",
		borderRadius: 6,
		border: "1px solid #3a7bd5",
		background: "transparent",
		color: "#3a7bd5",
		fontSize: 15,
		fontWeight: 600,
		cursor: "pointer",
	},
	divider: {
		height: 1,
		background: "#333",
		margin: "20px 0",
	},
	error: {
		color: "#f87171",
		fontSize: 13,
		marginTop: 8,
	},
	recentList: {
		display: "flex",
		flexDirection: "column",
		gap: 6,
	},
	recentItem: {
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		padding: "8px 12px",
		borderRadius: 6,
		border: "1px solid #333",
		background: "#1a1a1a",
		cursor: "pointer",
		color: "#e0e0e0",
		textAlign: "left",
		width: "100%",
	},
	recentId: {
		fontSize: 13,
		fontFamily: "monospace",
		color: "#aaa",
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap",
		flex: 1,
	},
	recentJoin: {
		fontSize: 13,
		color: "#3a7bd5",
		marginLeft: 12,
		flexShrink: 0,
	},
};
