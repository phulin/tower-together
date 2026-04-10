import type { SelectedTool } from "../types";
import { gameScreenStyles as styles } from "./gameScreenStyles";

interface ToolDef {
	id: SelectedTool;
	label: string;
	color: string;
	cost: number;
}

interface Props {
	tools: ToolDef[];
	isRenaming: boolean;
	aliasInput: string;
	aliasError: string;
	aliasSaving: boolean;
	towerId: string;
	towerName: string;
	selectedTool: SelectedTool;
	cash: number;
	day: number;
	hour: number;
	playerCount: number;
	onAliasInputChange: (value: string) => void;
	onRenameStart: () => void;
	onRenameCancel: () => void;
	onRenameSubmit: () => void;
	onToolSelect: (tool: SelectedTool) => void;
	onLeave: () => void;
}

export function GameToolbar({
	tools,
	isRenaming,
	aliasInput,
	aliasError,
	aliasSaving,
	towerId,
	towerName,
	selectedTool,
	cash,
	day,
	hour,
	playerCount,
	onAliasInputChange,
	onRenameStart,
	onRenameCancel,
	onRenameSubmit,
	onToolSelect,
	onLeave,
}: Props) {
	return (
		<div style={styles.toolbar}>
			<div style={styles.toolbarLeft}>
				{isRenaming ? (
					<form
						style={styles.renameForm}
						onSubmit={(event) => {
							event.preventDefault();
							onRenameSubmit();
						}}
					>
						<input
							style={styles.renameInput}
							value={aliasInput}
							onChange={(event) => onAliasInputChange(event.target.value)}
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
							onClick={onRenameCancel}
						>
							Cancel
						</button>
						{aliasError && <span style={styles.renameError}>{aliasError}</span>}
					</form>
				) : (
					<button
						type="button"
						style={styles.towerLabel}
						title={`${towerName} (click to rename)`}
						onClick={onRenameStart}
					>
						{towerName || towerId}
					</button>
				)}
				<div style={styles.toolGroup}>
					{tools.map((tool) => (
						<button
							type="button"
							key={tool.id}
							title={tool.cost > 0 ? `$${tool.cost.toLocaleString()}` : ""}
							style={{
								...styles.toolBtn,
								borderColor: selectedTool === tool.id ? tool.color : "#444",
								background:
									selectedTool === tool.id ? `${tool.color}33` : "transparent",
								color: selectedTool === tool.id ? tool.color : "#999",
							}}
							onClick={() => onToolSelect(tool.id)}
						>
							{tool.label}
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
	);
}
