// Read-only macOS window verification. Does not capture titles or screenshots.
// swiftc test/support/profileNativeWindow.swift -o /tmp/bb-window-state
// /tmp/bb-window-state <app-pid>
import Cocoa
import CoreGraphics

guard CommandLine.arguments.count == 2,
      let pid = pid_t(CommandLine.arguments[1]),
      let app = NSRunningApplication(processIdentifier: pid) else {
    fatalError("Expected a running application PID")
}
let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let visibleMainWindows = windows.filter {
    guard ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid),
          ($0[kCGWindowLayer as String] as? Int) == 0,
          ($0[kCGWindowIsOnscreen as String] as? Bool) == true,
          let bounds = $0[kCGWindowBounds as String] as? [String: Any],
          let height = bounds["Height"] as? Double else { return false }
    return height > 100
}.count
let data: [String: Any] = ["hidden": app.isHidden, "active": app.isActive, "visibleMainWindows": visibleMainWindows]
print(String(data: try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys]), encoding: .utf8)!)
