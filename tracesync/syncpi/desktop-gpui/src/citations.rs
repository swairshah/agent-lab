// File citations in messages, as in Delta and the web view: a link to a project file ([the cart](src/cart.ts#L12-L16))
// or a project file name in backticks opens that file. gpui-component's markdown view hands every link to the OS, so
// file links are rewritten to syncpi://open/<path>#L12-L16 before rendering; the app registers the syncpi scheme
// (see scripts/package-macos.mjs), macOS gives the URL back, and the desktop opens the file at those lines.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

/// A file to open, and the lines it was cited at.
pub type Opened = (String, Option<(usize, usize)>);

fn files() -> &'static Mutex<HashSet<String>> {
    static FILES: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    FILES.get_or_init(Default::default)
}

fn opened() -> &'static Mutex<Vec<Opened>> {
    static OPENED: OnceLock<Mutex<Vec<Opened>>> = OnceLock::new();
    OPENED.get_or_init(Default::default)
}

/// The open thread's project files, for linking file names in backticks.
pub fn set_files(list: &[String]) {
    *files().lock().unwrap() = list.iter().cloned().collect();
}

/// A relative path to a project file, without a scheme, an absolute root or "..".
fn is_project_path(href: &str) -> bool {
    let path = href.split('#').next().unwrap_or("");
    !path.is_empty()
        && !path.contains("://")
        && !path.starts_with('/')
        && !path.starts_with("mailto:")
        && !path.split('/').any(|p| p == "..")
}

/// Markdown with file links pointing at syncpi://open/, outside code fences.
pub fn rewrite(markdown: &str) -> String {
    let known = files().lock().unwrap().clone();
    let mut fenced = false;
    let mut out = Vec::new();
    for line in markdown.split('\n') {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
        }
        out.push(if fenced {
            line.to_owned()
        } else {
            rewrite_line(line, &known)
        });
    }
    out.join("\n")
}

fn rewrite_line(line: &str, known: &HashSet<String>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(i) = rest.find(['`', ']']) {
        let (before, from) = rest.split_at(i);
        out.push_str(before);
        if let Some(after) = from.strip_prefix("](") {
            // A link target: point project files at syncpi://open/.
            if let Some(end) = after.find(')') {
                let href = &after[..end];
                out.push_str("](");
                if is_project_path(href) {
                    out.push_str("syncpi://open/");
                    out.push_str(href.trim_start_matches("./"));
                } else {
                    out.push_str(href);
                }
                out.push(')');
                rest = &after[end + 1..];
                continue;
            }
            out.push_str("](");
            rest = after;
        } else if let Some(after) = from.strip_prefix('`') {
            // Inline code: a project file name becomes a link, unless it's already a link's text.
            match after.find('`') {
                Some(end) => {
                    let name = after[..end].trim().trim_start_matches("./");
                    let in_link = out.ends_with('[');
                    if !in_link && known.contains(name) {
                        out.push_str(&format!("[`{name}`](syncpi://open/{name})"));
                    } else {
                        out.push('`');
                        out.push_str(&after[..end]);
                        out.push('`');
                    }
                    rest = &after[end + 1..];
                }
                None => {
                    out.push('`');
                    rest = after;
                }
            }
        } else {
            out.push(']');
            rest = &from[1..];
        }
    }
    out.push_str(rest);
    out
}

/// Takes a syncpi://open/<path>#L12-L16 URL the OS handed back.
pub fn handle_url(url: &str) {
    let Some(target) = url.strip_prefix("syncpi://open/") else {
        return;
    };
    let (path, anchor) = target.split_once('#').unwrap_or((target, ""));
    let lines = anchor.strip_prefix('L').and_then(|range| {
        let (start, end) = range.split_once('-').unwrap_or((range, range));
        let start: usize = start.parse().ok()?;
        Some((start, end.trim_start_matches('L').parse().unwrap_or(start)))
    });
    let path = path.replace("%20", " ");
    if is_project_path(&path) {
        opened().lock().unwrap().push((path, lines));
    }
}

/// Files to open, oldest first.
pub fn take() -> Vec<Opened> {
    std::mem::take(&mut *opened().lock().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_links_and_file_names() {
        let known: HashSet<String> = ["src/cart.ts".to_owned()].into_iter().collect();
        assert_eq!(
            rewrite_line("see [it](src/cart.ts#L2-L3) now", &known),
            "see [it](syncpi://open/src/cart.ts#L2-L3) now"
        );
        assert_eq!(
            rewrite_line("[web](https://x.dev) and `src/cart.ts`", &known),
            "[web](https://x.dev) and [`src/cart.ts`](syncpi://open/src/cart.ts)"
        );
        assert_eq!(
            rewrite_line("`other.ts` and [`src/cart.ts`](src/cart.ts)", &known),
            "`other.ts` and [`src/cart.ts`](syncpi://open/src/cart.ts)"
        );
        assert_eq!(rewrite_line("[up](../secret)", &known), "[up](../secret)");
    }
}
