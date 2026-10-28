// The search benchmark page (test/bench/search.ts) in a WKWebView, the engine of the macOS app: whether Find's
// highlights work there, and how long queries take. Usage: swift test/bench/webkit.swift <url>
import Cocoa
import WebKit

let url = URL(string: CommandLine.arguments[1])!
let app = NSApplication.shared
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820), styleMask: [.titled], backing: .buffered, defer: false)
// The window stays off screen, so nothing shows over the person's work. WebKit throttles such a page's timers and
// pauses its frames, so animation frames run at once here and each query is timed as the work it causes (counting,
// highlighting, the palette's rows), synchronously, without the paint. Paint timing is Chrome's run.
let config = WKWebViewConfiguration()
config.preferences.inactiveSchedulingPolicy = .none
config.userContentController.addUserScript(WKUserScript(source: "window.requestAnimationFrame = (f) => { f(performance.now()); return 0; }; window.cancelAnimationFrame = () => {};", injectionTime: .atDocumentStart, forMainFrameOnly: true))
let web = WKWebView(frame: window.contentView!.bounds, configuration: config)
window.contentView!.addSubview(web)

final class Run: NSObject, WKNavigationDelegate {
  func webView(_ w: WKWebView, didFinish n: WKNavigation!) {
    let js = """
    while (!window.bench) await new Promise((r) => setTimeout(r, 20));
    const b = window.bench;
    const lines = [];
    lines.push(`WebKit ${navigator.userAgent.match(/AppleWebKit\\/([\\d.]+)/)?.[1]}; CSS highlights: ${b.highlights() ? "yes" : "no (boxes)"}`);
    const p = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(q / 100 * xs.length) - 1)];
    const type = (input, q) => { const t0 = performance.now(); input.value = q; input.dispatchEvent(new Event("input")); return performance.now() - t0; };
    const find = document.getElementById("find-input");
    const t0 = performance.now();
    b.openFind();
    type(find, "checkout");
    lines.push(`Find, opening it and the first query (reads all 2,000 blocks): ${(performance.now() - t0).toFixed(1)} ms (${document.getElementById("find-count").textContent})`);
    lines.push("| Query | Results | p50 ms | p95 ms |", "|---|---|---|---|");
    for (const q of ["cart total", "the", "zzz-not-there", "s"]) {
      type(find, q);
      const ms = [];
      for (let n = 0; n < 20; n++) { type(find, ""); ms.push(type(find, q)); }
      lines.push(`| Find "${q}" | ${document.getElementById("find-count").textContent.split("/")[1]} matches | ${p(ms, 50).toFixed(1)} | ${p(ms, 95).toFixed(1)} |`);
    }
    type(find, "cart total");
    const texts = [...(CSS.highlights?.get("syncpi-find") ?? []), ...(CSS.highlights?.get("syncpi-find-current") ?? [])].map((r) => r.toString().toLowerCase());
    const boxed = document.querySelectorAll(".find-box.current").length > 0;
    const palette = document.getElementById("palette-input");
    for (const [tab, q] of [["all", "cart"], ["files", "src"], ["threads", "session"]]) {
      b.openPalette(tab);
      type(palette, q);
      const ms = [];
      for (let n = 0; n < 20; n++) { type(palette, ""); ms.push(type(palette, q)); }
      lines.push(`| Palette ${tab} "${q}" | ${document.querySelectorAll("#palette-list .palette-row").length} rows | ${p(ms, 50).toFixed(1)} | ${p(ms, 95).toFixed(1)} |`);
    }
    lines.push(`Highlights for "cart total": ${texts.length} ranges, every one exactly the match: ${texts.length > 0 && texts.every((t) => t === "cart total")}; current match boxed: ${boxed}`);
    return lines.join(String.fromCharCode(10));
    """
    w.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
      switch result {
      case .success(let value): print(value)
      case .failure(let error): print("error: \(error)"); exit(1)
      }
      exit(0)
    }
  }
}
let run = Run()
web.navigationDelegate = run
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 240) { print("timed out"); exit(1) }
app.run()
