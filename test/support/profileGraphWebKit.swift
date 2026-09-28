// Synthetic graph only. Serve graphWorker.browser.cjs with PROFILE_SERVE=1.
// Compile into a disposable macOS app bundle; see the graph-attention profile.
import Cocoa
import WebKit
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let config = WKWebViewConfiguration()
config.userContentController.addUserScript(WKUserScript(source: "window.EventSource=class extends EventTarget {constructor(){super();setTimeout(()=>this.dispatchEvent(new Event('open')),0)}close(){}};window.framesMeasured=0;const nativeRaf=requestAnimationFrame;window.requestAnimationFrame=fn=>nativeRaf(t=>{window.framesMeasured++;fn(t)});", injectionTime: .atDocumentStart, forMainFrameOnly: true))
let view = WKWebView(frame: NSRect(x:0,y:0,width:1440,height:1000), configuration:config)
let window = NSWindow(contentRect:view.frame,styleMask:[.titled,.closable,.resizable],backing:.buffered,defer:false)
window.contentView=view
window.title="Synthetic graph performance test"
window.makeKeyAndOrderFront(nil)
view.load(URLRequest(url:URL(string:"http://127.0.0.1:53918/")!))
Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    view.evaluateJavaScript("JSON.stringify({frames:window.framesMeasured, visibility:document.visibilityState, canvases:document.querySelectorAll('canvas').length, attention:!!document.querySelector('.attention-overlay.has-attention'), opacity:document.querySelector('.attention-overlay') ? getComputedStyle(document.querySelector('.attention-overlay')).opacity:null})") { result, error in
        let value = (result as? String) ?? String(describing:error)
        try? value.write(toFile:"/tmp/bb-graph-webkit-state.json", atomically:true, encoding:.utf8)
    }
}
app.run()
