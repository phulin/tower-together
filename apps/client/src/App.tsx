import { useEffect, useState } from "react";
import { getDisplayName, getPlayerId } from "./lib/storage";
import { GameScreen } from "./screens/GameScreen";
import { GuestScreen } from "./screens/GuestScreen";
import { LobbyScreen } from "./screens/LobbyScreen";

type Screen = "guest" | "lobby" | "game";

export function App() {
	const [screen, setScreen] = useState<Screen>("guest");
	const [playerId, setPlayerId] = useState<string>("");
	const [displayName, setDisplayName] = useState<string>("");
	const [towerId, setTowerId] = useState<string>("");

	// On mount, check if we already have a stored player
	useEffect(() => {
		const storedId = getPlayerId();
		const storedName = getDisplayName();
		if (storedId && storedName) {
			setPlayerId(storedId);
			setDisplayName(storedName);
			setScreen("lobby");
		}
	}, []);

	function handleGuestEnter(id: string, name: string) {
		setPlayerId(id);
		setDisplayName(name);
		setScreen("lobby");
	}

	function handleJoinTower(id: string) {
		setTowerId(id);
		setScreen("game");
	}

	function handleLeaveGame() {
		setTowerId("");
		setScreen("lobby");
	}

	function handleLogout() {
		setPlayerId("");
		setDisplayName("");
		setTowerId("");
		setScreen("guest");
	}

	switch (screen) {
		case "guest":
			return <GuestScreen onEnter={handleGuestEnter} />;
		case "lobby":
			return (
				<LobbyScreen
					displayName={displayName}
					onJoinTower={handleJoinTower}
					onLogout={handleLogout}
				/>
			);
		case "game":
			return (
				<GameScreen
					playerId={playerId}
					displayName={displayName}
					towerId={towerId}
					onLeave={handleLeaveGame}
				/>
			);
	}
}
