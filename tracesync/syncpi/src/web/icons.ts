// The mark of the model behind each reply, as Delta does: who wrote it at a glance. Marks come from
// @lobehub/icons-static-svg (MIT), monochrome in currentColor so they follow the theme. Matched on the model id first,
// since a provider like exe.dev's gateway or OpenRouter serves many vendors' models.
import anthropic from "@lobehub/icons-static-svg/icons/anthropic.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi.svg";
import meta from "@lobehub/icons-static-svg/icons/meta.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen.svg";
import xai from "@lobehub/icons-static-svg/icons/xai.svg";
import zai from "@lobehub/icons-static-svg/icons/zai.svg";
import { escapeHtml } from "./dom.ts";

const MARKS: [RegExp, string, string][] = [
	[/claude|anthropic/, "Anthropic", anthropic],
	[/\bgpt|openai|codex|\bo\d\b|\bo\d-/, "OpenAI", openai],
	[/gemini|google|gemma/, "Google", gemini],
	[/kimi|moonshot/, "Moonshot AI", kimi],
	[/glm|zai|z-ai|zhipu/, "Z.ai", zai],
	[/grok|xai|x-ai/, "xAI", xai],
	[/deepseek/, "DeepSeek", deepseek],
	[/qwen|alibaba/, "Qwen", qwen],
	[/mistral|codestral|devstral/, "Mistral", mistral],
	[/llama|meta/, "Meta", meta],
	[/minimax/, "MiniMax", minimax],
];

/** The vendor behind `provider/model` and its mark (an SVG in currentColor), when it's one we know. */
export function modelVendor(model: string | undefined): { name: string; svg: string } | undefined {
	const ref = (model ?? "").toLowerCase();
	const [, modelId = ref] = ref.split(/\/(.*)/);
	const match = MARKS.find(([pattern]) => pattern.test(modelId)) ?? MARKS.find(([pattern]) => pattern.test(ref));
	if (match === undefined) return undefined;
	return { name: match[1], svg: match[2].replace(/<title>.*?<\/title>/, "").replace(/ (width|height)="1em"/g, "") };
}

const PROVIDERS: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "ChatGPT subscription",
	openrouter: "OpenRouter",
	exe: "exe.dev",
	google: "Google",
	"google-gemini-cli": "Gemini CLI",
	"github-copilot": "GitHub Copilot",
	xai: "xAI",
	groq: "Groq",
	mistral: "Mistral",
	faux: "Test model",
};

/** How a provider (the part of a model reference before "/") is named to people. */
export function providerName(provider: string): string {
	return PROVIDERS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/** An avatar for `provider/model`: the vendor's mark, or the model's first letter when it isn't one we know. */
export function modelAvatar(model: string | undefined): string {
	const vendor = modelVendor(model);
	const title = escapeHtml(model ?? "agent");
	if (vendor === undefined) {
		const id = (model ?? "").split("/").pop() ?? "";
		return `<span class="avatar model-avatar" title="${title}">${escapeHtml((id[0] ?? "?").toUpperCase())}</span>`;
	}
	return `<span class="avatar model-avatar" title="${escapeHtml(vendor.name)} · ${title}">${vendor.svg}</span>`;
}
