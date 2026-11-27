import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { PromptTemplate, Theme } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager as TuiKeybindingsManager } from "@earendil-works/pi-tui";

type ThemeModule = {
	theme: Theme;
	initTheme(name?: string, watch?: boolean): void;
	setTheme(name: string, watch?: boolean): { success: boolean; error?: string };
	getAvailableThemes(): string[];
	getEditorTheme(): EditorTheme;
	onThemeChange(callback: () => void): void;
	stopThemeWatcher(): void;
	getTerminalTheme(): "dark" | "light";
	setRegisteredThemes(themes: Theme[]): void;
};

export type AppKeybindings = TuiKeybindingsManager & { reload(): void; getKeys(id: string): string[]; matches(data: string, id: string): boolean };

type KeybindingsModule = { KeybindingsManager: { create(agentDir?: string): AppKeybindings }; KEYBINDINGS: Record<string, { defaultKeys: string | string[]; description?: string }> };
type PromptsModule = { expandPromptTemplate(text: string, templates: PromptTemplate[]): string };
type ClipboardImageModule = { readClipboardImage(): Promise<{ bytes: Uint8Array; mimeType: string } | null> };

function load<T>(path: string): Promise<T> {
	return import(pathToFileURL(join(getPackageDir(), "dist", path)).href) as Promise<T>;
}

export const themes = await load<ThemeModule>("modes/interactive/theme/theme.js");
export const keybindingsModule = await load<KeybindingsModule>("core/keybindings.js");
export const prompts = await load<PromptsModule>("core/prompt-templates.js");
export const clipboardImage = await load<ClipboardImageModule>("utils/clipboard-image.js").catch(() => undefined);

export const theme: Theme = themes.theme;

type ViewportModule = { createChatViewport(options: Record<string, unknown>): { root: import("@earendil-works/pi-tui").Component; transcript: unknown } };
export const viewport = await load<ViewportModule>("modes/interactive/chat-viewport.js");

export const ui: { keys: AppKeybindings } = { keys: undefined as never };

type ScopedModelsModule = {
	ScopedModelsSelectorComponent: new (
		config: { allModels: unknown[]; enabledModelIds: string[] | null },
		callbacks: { onChange(ids: string[] | null): void; onPersist(ids: string[] | null): void; onCancel(): void },
	) => import("@earendil-works/pi-tui").Component;
};
export const { ScopedModelsSelectorComponent } = await load<ScopedModelsModule>("modes/interactive/components/scoped-models-selector.js");
