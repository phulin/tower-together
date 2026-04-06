import { useState } from "react";
import { generateUUID, savePlayer } from "../lib/storage";

interface Props {
	onEnter: (playerId: string, displayName: string) => void;
}

export function GuestScreen({ onEnter }: Props) {
	const [name, setName] = useState("");
	const [error, setError] = useState("");

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const trimmed = name.trim();
		if (!trimmed) {
			setError("Please enter a display name.");
			return;
		}
		const playerId = generateUUID();
		savePlayer(playerId, trimmed);
		onEnter(playerId, trimmed);
	}

	return (
		<div style={styles.container}>
			<div style={styles.card}>
				<h1 style={styles.title}>Tower Together</h1>
				<p style={styles.subtitle}>A multiplayer tower building game</p>
				<form onSubmit={handleSubmit} style={styles.form}>
					<label style={styles.label} htmlFor="displayName">
						Display Name
					</label>
					<input
						id="displayName"
						style={styles.input}
						type="text"
						placeholder="Enter your name..."
						value={name}
						onChange={(e) => {
							setName(e.target.value);
							setError("");
						}}
						maxLength={32}
					/>
					{error && <p style={styles.error}>{error}</p>}
					<button style={styles.button} type="submit">
						Enter as Guest
					</button>
				</form>
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
	},
	card: {
		background: "#242424",
		border: "1px solid #333",
		borderRadius: 12,
		padding: "40px 48px",
		minWidth: 360,
		textAlign: "center",
	},
	title: {
		fontSize: 32,
		fontWeight: 700,
		color: "#e0e0e0",
		marginBottom: 8,
	},
	subtitle: {
		fontSize: 14,
		color: "#888",
		marginBottom: 32,
	},
	form: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
	},
	label: {
		textAlign: "left",
		fontSize: 14,
		color: "#aaa",
	},
	input: {
		padding: "10px 14px",
		borderRadius: 6,
		border: "1px solid #444",
		background: "#1a1a1a",
		color: "#e0e0e0",
		fontSize: 16,
		outline: "none",
	},
	error: {
		color: "#f87171",
		fontSize: 13,
		textAlign: "left",
	},
	button: {
		marginTop: 8,
		padding: "12px 0",
		borderRadius: 6,
		border: "none",
		background: "#3a7bd5",
		color: "#fff",
		fontSize: 16,
		fontWeight: 600,
		cursor: "pointer",
	},
};
