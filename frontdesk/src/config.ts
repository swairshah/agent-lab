import { resolve } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";

export type WorkerKind = "opus" | "sol";

const env = process.env;

export const faux = env.FRONTDESK_FAUX === "1";

export const dbPath = resolve(env.FRONTDESK_DB ?? ".data/session.sqlite");

export const workspace = resolve(env.FRONTDESK_WORKSPACE ?? process.cwd());

export const port = Number(env.FRONTDESK_PORT ?? 4318);

const FAUX: ModelRef = { provider: "faux", modelId: "faux-1" };

export const textFrontendModel: ModelRef = faux
	? FAUX
	: { provider: "openai", modelId: env.FRONTDESK_TEXT_MODEL ?? "gpt-5.6-luna" };

export const voiceModel = env.FRONTDESK_VOICE_MODEL ?? "gpt-realtime-2.1";

export const voiceName = env.FRONTDESK_VOICE ?? "marin";

export const transcriptionModel = env.FRONTDESK_TRANSCRIBE_MODEL ?? "gpt-4o-mini-transcribe";

export const workerModels: Record<WorkerKind, ModelRef> = faux
	? { opus: FAUX, sol: FAUX }
	: {
			opus: { provider: "anthropic", modelId: env.FRONTDESK_OPUS_MODEL ?? "claude-opus-5-5" },
			sol: { provider: "openai", modelId: env.FRONTDESK_SOL_MODEL ?? "gpt-5.6-sol" },
		};

export const defaultWorker: WorkerKind = env.FRONTDESK_DEFAULT_WORKER === "sol" ? "sol" : "opus";
