use gpui::{AssetSource, Result, SharedString};
use gpui_component::Icon;
use std::borrow::Cow;

// Embed app-specific symbols alongside GPUI Component's Lucide icons.
pub struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let bytes: Option<&'static [u8]> = match path {
            "syncpi/archive.svg" => Some(include_bytes!("../assets/icons/archive.svg")),
            "syncpi/git-branch.svg" => Some(include_bytes!("../assets/icons/git-branch.svg")),
            "syncpi/pin.svg" => Some(include_bytes!("../assets/icons/pin.svg")),
            "syncpi/bookmark.svg" => Some(include_bytes!("../assets/icons/bookmark.svg")),
            "syncpi/message-square.svg" => {
                Some(include_bytes!("../assets/icons/message-square.svg"))
            }
            "syncpi/refresh-cw.svg" => Some(include_bytes!("../assets/icons/refresh-cw.svg")),
            "syncpi/users.svg" => Some(include_bytes!("../assets/icons/users.svg")),
            "syncpi/crosshair.svg" => Some(include_bytes!("../assets/icons/crosshair.svg")),
            "syncpi/code.svg" => Some(include_bytes!("../assets/icons/code.svg")),
            "models/anthropic.svg" => Some(include_bytes!("../assets/models/anthropic.svg")),
            "models/openai.svg" => Some(include_bytes!("../assets/models/openai.svg")),
            "models/gemini.svg" => Some(include_bytes!("../assets/models/gemini.svg")),
            "models/kimi.svg" => Some(include_bytes!("../assets/models/kimi.svg")),
            "models/zai.svg" => Some(include_bytes!("../assets/models/zai.svg")),
            "models/xai.svg" => Some(include_bytes!("../assets/models/xai.svg")),
            "models/deepseek.svg" => Some(include_bytes!("../assets/models/deepseek.svg")),
            "models/qwen.svg" => Some(include_bytes!("../assets/models/qwen.svg")),
            "models/mistral.svg" => Some(include_bytes!("../assets/models/mistral.svg")),
            "models/meta.svg" => Some(include_bytes!("../assets/models/meta.svg")),
            "models/minimax.svg" => Some(include_bytes!("../assets/models/minimax.svg")),
            _ => None,
        };
        match bytes {
            Some(bytes) => Ok(Some(Cow::Borrowed(bytes))),
            None => gpui_component_assets::Assets.load(path),
        }
    }
    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        gpui_component_assets::Assets.list(path)
    }
}
pub fn icon(name: &str) -> Icon {
    Icon::default().path(format!("syncpi/{name}.svg"))
}

/// The vendor behind a `provider/model` reference and its mark, as in src/web/icons.ts. Matched on the model id
/// first, since a gateway (exe.dev, OpenRouter) serves many vendors' models.
pub fn model_vendor(model: &str) -> Option<(&'static str, String)> {
    const VENDORS: [(&str, &str, &[&str]); 11] = [
        ("Anthropic", "anthropic", &["claude", "anthropic"]),
        ("OpenAI", "openai", &["gpt", "openai", "codex"]),
        ("Google", "gemini", &["gemini", "google", "gemma"]),
        ("Moonshot AI", "kimi", &["kimi", "moonshot"]),
        ("Z.ai", "zai", &["glm", "zai", "z-ai", "zhipu"]),
        ("xAI", "xai", &["grok", "xai", "x-ai"]),
        ("DeepSeek", "deepseek", &["deepseek"]),
        ("Qwen", "qwen", &["qwen", "alibaba"]),
        ("Mistral", "mistral", &["mistral", "codestral", "devstral"]),
        ("Meta", "meta", &["llama", "meta"]),
        ("MiniMax", "minimax", &["minimax"]),
    ];
    let reference = model.to_lowercase();
    let id = reference
        .split_once('/')
        .map_or(reference.as_str(), |(_, id)| id);
    // OpenAI's reasoning models are named o1, o3, o4-mini and so on.
    let reasoning = |s: &str| {
        s.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| {
            w.len() > 1 && w.starts_with('o') && w[1..].chars().all(|c| c.is_ascii_digit())
        })
    };
    let find = |s: &str| {
        VENDORS
            .iter()
            .find(|(_, _, words)| words.iter().any(|w| s.contains(w)))
            .map(|(name, file, _)| (*name, format!("models/{file}.svg")))
            .or_else(|| reasoning(s).then(|| ("OpenAI", "models/openai.svg".to_owned())))
    };
    find(id).or_else(|| find(&reference))
}

/// How a provider (the part of a model reference before "/") is named to people, as in src/web/icons.ts.
pub fn provider_name(provider: &str) -> String {
    match provider {
        "anthropic" => "Anthropic".into(),
        "openai" => "OpenAI".into(),
        "openai-codex" => "ChatGPT subscription".into(),
        "openrouter" => "OpenRouter".into(),
        "exe" => "exe.dev".into(),
        "google" => "Google".into(),
        "google-gemini-cli" => "Gemini CLI".into(),
        "github-copilot" => "GitHub Copilot".into(),
        "xai" => "xAI".into(),
        "groq" => "Groq".into(),
        "mistral" => "Mistral".into(),
        "faux" => "Test model".into(),
        other => {
            let mut chars = other.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        }
    }
}
