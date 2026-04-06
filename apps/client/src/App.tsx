import { useEffect, useState } from "react";
import * as socket from "./lib/socket";
import { getDisplayName, getPlayerId } from "./lib/storage";
import { GameScreen } from "./screens/GameScreen";
import { GuestScreen } from "./screens/GuestScreen";
import { LobbyScreen } from "./screens/LobbyScreen";

type Screen = "guest" | "lobby" | "game";

function getTowerIdFromPath(): string {
	const path = window.location.pathname;
	const match = path.match(/^\/([a-zA-Z0-9_-]+)$/);
	return match ? match[1] : "";
}

export function App() {
	const [screen, setScreen] = useState<Screen>("guest");
	const [playerId, setPlayerId] = useState<string>("");
	const [displayName, setDisplayName] = useState<string>("");
	const [towerId, setTowerId] = useState<string>("");

	// On mount, check stored player and URL path
	useEffect(() => {
		const storedId = getPlayerId();
		const storedName = getDisplayName();
		if (storedId && storedName) {
			setPlayerId(storedId);
			setDisplayName(storedName);
			const urlTower = getTowerIdFromPath();
			if (urlTower) {
				socket.connect(urlTower);
				setTowerId(urlTower);
				setScreen("game");
			} else {
				setScreen("lobby");
			}
		}
	}, []);

	// Handle browser back/forward
	useEffect(() => {
		function onPopState() {
			const urlTower = getTowerIdFromPath();
			if (urlTower && playerId) {
				socket.connect(urlTower);
				setTowerId(urlTower);
				setScreen("game");
			} else {
				socket.disconnect();
				setTowerId("");
				setScreen(playerId ? "lobby" : "guest");
			}
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [playerId]);

	function handleGuestEnter(id: string, name: string) {
		setPlayerId(id);
		setDisplayName(name);
		const urlTower = getTowerIdFromPath();
		if (urlTower) {
			socket.connect(urlTower);
			setTowerId(urlTower);
			setScreen("game");
		} else {
			setScreen("lobby");
		}
	}

	function handleJoinTower(id: string) {
		socket.connect(id);
		setTowerId(id);
		setScreen("game");
		window.history.pushState(null, "", `/${id}`);
	}

	function handleLeaveGame() {
		socket.disconnect();
		setTowerId("");
		setScreen("lobby");
		window.history.pushState(null, "", "/");
	}

	function handleLogout() {
		socket.disconnect();
		setPlayerId("");
		setDisplayName("");
		setTowerId("");
		setScreen("guest");
		window.history.pushState(null, "", "/");
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
