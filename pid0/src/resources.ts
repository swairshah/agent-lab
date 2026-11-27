import { readFileSync } from "node:fs";
import { DefaultResourceLoader, getAgentDir, type PromptTemplate, SettingsManager, type Skill, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { prompts, themes } from "./pi.ts";

export type ResourceOptions = {
	skillPaths?: string[];
	promptPaths?: string[];
	themePaths?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
};

export function piAgentDir(): string {
	return process.env.PID0_PI_DIR ?? getAgentDir();
}

export class Resources {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settings: SettingsManager;
	templates: PromptTemplate[] = [];
	skills: Skill[] = [];
	diagnostics: string[] = [];
	readonly #options: ResourceOptions;

	private constructor(cwd: string, options: ResourceOptions) {
		this.cwd = cwd;
		this.agentDir = piAgentDir();
		this.#options = options;
		this.settings = SettingsManager.create(cwd, this.agentDir);
	}

	static async load(cwd: string, options: ResourceOptions = {}): Promise<Resources> {
		const resources = new Resources(cwd, options);
		await resources.reload();
		return resources;
	}

	async reload(): Promise<void> {
		await this.settings.reload();
		const o = this.#options;
		const loader = new DefaultResourceLoader({
			cwd: this.cwd,
			agentDir: this.agentDir,
			settingsManager: this.settings,
			noExtensions: true,
			noContextFiles: true,
			...(o.skillPaths?.length ? { additionalSkillPaths: o.skillPaths } : {}),
			...(o.promptPaths?.length ? { additionalPromptTemplatePaths: o.promptPaths } : {}),
			...(o.themePaths?.length ? { additionalThemePaths: o.themePaths } : {}),
			...(o.noSkills ? { noSkills: true } : {}),
			...(o.noPromptTemplates ? { noPromptTemplates: true } : {}),
			...(o.noThemes ? { noThemes: true } : {}),
		});
		await loader.reload();
		const loadedPrompts = loader.getPrompts();
		const loadedSkills = loader.getSkills();
		const loadedThemes = loader.getThemes();
		this.templates = loadedPrompts.prompts;
		this.skills = loadedSkills.skills;
		themes.setRegisteredThemes(loadedThemes.themes);
		this.diagnostics = [...loadedPrompts.diagnostics, ...loadedSkills.diagnostics, ...loadedThemes.diagnostics].map((d) => `${d.type}: ${d.message}${d.path ? ` (${d.path})` : ""}`);
	}

	get skillCommands(): boolean {
		return this.settings.getEnableSkillCommands();
	}

	expand(text: string): string {
		let out = text;
		if (out.startsWith("/skill:")) {
			const space = out.search(/\s/);
			const name = space < 0 ? out.slice(7) : out.slice(7, space);
			const args = space < 0 ? "" : out.slice(space + 1).trim();
			const skill = this.skills.find((s) => s.name === name);
			if (skill) {
				try {
					const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
					const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
					out = args ? `${block}\n\n${args}` : block;
				} catch {}
			}
		}
		return prompts.expandPromptTemplate(out, this.templates);
	}
}
