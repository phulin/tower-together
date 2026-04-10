import { gameScreenStyles as styles } from "./gameScreenStyles";
import type { ActivePrompt } from "./gameScreenTypes";

interface Props {
	prompt: ActivePrompt;
	onRespond: (accepted: boolean) => void;
}

export function GamePromptModal({ prompt, onRespond }: Props) {
	return (
		<div style={styles.modalOverlay}>
			<div style={styles.modal}>
				<div style={styles.modalIcon}>
					{prompt.promptKind === "bomb_ransom" ? "💣" : "🔥"}
				</div>
				<div style={styles.modalTitle}>
					{prompt.promptKind === "bomb_ransom"
						? "Bomb Threat"
						: "Fire Emergency"}
				</div>
				<div style={styles.modalMessage}>{prompt.message}</div>
				<div style={styles.modalButtons}>
					<button
						type="button"
						style={styles.modalAccept}
						onClick={() => onRespond(true)}
					>
						{prompt.cost ? `Pay $${prompt.cost.toLocaleString()}` : "Accept"}
					</button>
					<button
						type="button"
						style={styles.modalDecline}
						onClick={() => onRespond(false)}
					>
						Decline
					</button>
				</div>
			</div>
		</div>
	);
}
