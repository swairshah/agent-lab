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

/** An avatar for `provider/model`: the vendor's mark, or the model's first letter when it isn't one we know. */
export function modelAvatar(model: string | undefined): string {
	const ref = (model ?? "").toLowerCase();
	const [, modelId = ref] = ref.split(/\/(.*)/);
	const match = MARKS.find(([pattern]) => pattern.test(modelId)) ?? MARKS.find(([pattern]) => pattern.test(ref));
	const title = escapeHtml(model ?? "agent");
	if (match === undefined) return `<span class="avatar model-avatar" title="${title}">${escapeHtml((modelId[0] ?? "?").toUpperCase())}</span>`;
	const svg = match[2].replace(/<title>.*?<\/title>/, "").replace(/ (width|height)="1em"/g, "");
	return `<span class="avatar model-avatar" title="${escapeHtml(match[1])} · ${title}">${svg}</span>`;
}
