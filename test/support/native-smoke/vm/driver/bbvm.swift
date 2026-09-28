// bbvm — a minimal Virtualization.framework host for the offline native smoke.
//
// It reads and writes UTM 4.7.5's Apple-backend `config.plist` (schema 4) so a
// bundle it creates is also openable in UTM, but it never talks to UTM: the
// installed BigBrain app is this process tree's TCC "responsible process", and
// Apple Events (utmctl) or Accessibility grants would attach to that app.
// Input is injected into our own VZVirtualMachineView in-process, so no
// Accessibility grant is needed; screenshots are of our own window only.
//
//   bbvm create <bundle.utm> --ipsw <file> [--cpus N] [--memory-mib N] [--disk-gib N]
//               [--name S] [--network] [--width N --height N]
//   bbvm run    <bundle.utm> --control <socket> --status <json> [--allow-network]
//
// `create` installs macOS from the official restore image (no display needed).
// `run` boots the bundle, shows its display, and serves newline-delimited JSON
// commands on a unix socket: state, screenshot, move, click, drag, scroll, key,
// type, stop (graceful), kill. It fails closed on any isolation control it does
// not understand, and refuses network unless the caller explicitly allows it.
import AppKit
import Foundation
import Virtualization

struct Fail: Error, CustomStringConvertible { let description: String; init(_ d: String) { description = d } }
func emit(_ obj: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(d); FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func die(_ message: String, _ code: Int32 = 2) -> Never { emit(["error": message]); exit(code) }

// MARK: - Arguments
struct Args {
    var positional: [String] = []; var flags: [String: String] = [:]; var switches: Set<String> = []
    init(_ argv: [String]) {
        var i = 0
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--") {
                let name = String(a.dropFirst(2))
                if i + 1 < argv.count, !argv[i + 1].hasPrefix("--") { flags[name] = argv[i + 1]; i += 2 } else { switches.insert(name); i += 1 }
            } else { positional.append(a); i += 1 }
        }
    }
    func int(_ k: String, _ d: Int) -> Int { flags[k].flatMap(Int.init) ?? d }
}

// MARK: - UTM schema-4 bundle
final class Bundle4 {
    let url: URL
    var plist: [String: Any]
    var data: URL { url.appendingPathComponent("Data", isDirectory: true) }
    init(load url: URL) throws {
        self.url = url
        let raw = try Data(contentsOf: url.appendingPathComponent("config.plist"))
        guard let p = try PropertyListSerialization.propertyList(from: raw, format: nil) as? [String: Any] else { throw Fail("config.plist is not a dictionary") }
        plist = p
    }
    init(new url: URL, plist: [String: Any]) { self.url = url; self.plist = plist }
    func save() throws {
        let d = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
        try d.write(to: url.appendingPathComponent("config.plist"), options: .atomic)
    }
    func dict(_ k: String) throws -> [String: Any] { guard let v = plist[k] as? [String: Any] else { throw Fail("Missing \(k)") }; return v }
    func list(_ k: String) throws -> [[String: Any]] { guard let v = plist[k] as? [[String: Any]] else { throw Fail("Missing \(k)") }; return v }
    static func localName(_ s: Any?) throws -> String {
        guard let s = s as? String, !s.isEmpty, s != ".", s != "..", !s.contains("/"), !s.contains(":") else { throw Fail("Drive/aux paths must be plain names inside Data") }
        return s
    }

    /// Fail-closed translation to a VZ configuration. `allowNetwork` is the only relaxation.
    func vz(allowNetwork: Bool) throws -> VZVirtualMachineConfiguration {
        guard plist["Backend"] as? String == "Apple", plist["ConfigurationVersion"] as? Int == 4 else { throw Fail("Only UTM Apple schema 4") }
        let known: Set<String> = ["Information", "System", "Virtualization", "SharedDirectory", "Display", "Drive", "Network", "Serial", "Backend", "ConfigurationVersion"]
        guard Set(plist.keys).isSubset(of: known) else { throw Fail("Unknown configuration fields: \(Set(plist.keys).subtracting(known))") }
        guard (plist["SharedDirectory"] as? [Any] ?? []).isEmpty else { throw Fail("SharedDirectory must be empty") }
        guard try list("Serial").isEmpty else { throw Fail("Serial must be empty") }
        let system = try dict("System"), boot = try dict("Boot", in: system), mac = try dict("MacPlatform", in: system)
        guard system["Architecture"] as? String == "aarch64", boot["OperatingSystem"] as? String == "macOS" else { throw Fail("Expected aarch64 macOS guest") }
        let virt = try dict("Virtualization")
        guard virt["Audio"] as? Bool == false, virt["ClipboardSharing"] as? Bool == false, (virt["Rosetta"] as? Bool ?? false) == false else { throw Fail("Audio, ClipboardSharing and Rosetta must be off") }

        let c = VZVirtualMachineConfiguration()
        let platform = VZMacPlatformConfiguration()
        guard let hwData = mac["HardwareModel"] as? Data, let hw = VZMacHardwareModel(dataRepresentation: hwData), hw.isSupported else { throw Fail("Unsupported or missing HardwareModel") }
        guard let idData = mac["MachineIdentifier"] as? Data, let mid = VZMacMachineIdentifier(dataRepresentation: idData) else { throw Fail("Missing MachineIdentifier") }
        platform.hardwareModel = hw; platform.machineIdentifier = mid
        platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: data.appendingPathComponent(try Bundle4.localName(mac["AuxiliaryStoragePath"])))
        c.platform = platform
        c.bootLoader = VZMacOSBootLoader()
        guard let cpus = system["CPUCount"] as? Int, let mib = system["MemorySize"] as? Int, cpus > 0, mib > 0 else { throw Fail("CPUCount/MemorySize required") }
        c.cpuCount = cpus; c.memorySize = UInt64(mib) << 20

        let graphics = VZMacGraphicsDeviceConfiguration()
        graphics.displays = try list("Display").map { d in
            guard let w = d["WidthPixels"] as? Int, let h = d["HeightPixels"] as? Int, let ppi = d["PixelsPerInch"] as? Int else { throw Fail("Display needs WidthPixels/HeightPixels/PixelsPerInch") }
            return VZMacGraphicsDisplayConfiguration(widthInPixels: w, heightInPixels: h, pixelsPerInch: ppi)
        }
        guard !graphics.displays.isEmpty else { throw Fail("At least one Display") }
        c.graphicsDevices = [graphics]

        switch virt["Keyboard"] as? String ?? "Disabled" {
        case "Generic": c.keyboards = [VZUSBKeyboardConfiguration()]
        case "Mac": c.keyboards = [VZMacKeyboardConfiguration()]
        case "Disabled": c.keyboards = []
        default: throw Fail("Unknown Keyboard")
        }
        switch virt["Pointer"] as? String ?? "Disabled" {
        case "Mouse": c.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
        case "Trackpad": c.pointingDevices = [VZMacTrackpadConfiguration()]
        case "Disabled": c.pointingDevices = []
        default: throw Fail("Unknown Pointer")
        }
        if virt["Entropy"] as? Bool ?? true { c.entropyDevices = [VZVirtioEntropyDeviceConfiguration()] }
        if virt["Balloon"] as? Bool ?? true { c.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()] }

        c.storageDevices = try list("Drive").map { d in
            let allowed: Set<String> = ["ImageName", "ReadOnly", "Nvme", "Identifier"]
            guard Set(d.keys).isSubset(of: allowed) else { throw Fail("External/unknown drive reference") }
            guard let ro = d["ReadOnly"] as? Bool else { throw Fail("Drive ReadOnly must be explicit") }
            let img = data.appendingPathComponent(try Bundle4.localName(d["ImageName"]))
            let att = try VZDiskImageStorageDeviceAttachment(url: img, readOnly: ro)
            if d["Nvme"] as? Bool == true { return VZNVMExpressControllerDeviceConfiguration(attachment: att) }
            return VZVirtioBlockDeviceConfiguration(attachment: att)
        }
        guard !c.storageDevices.isEmpty else { throw Fail("At least one Drive") }

        let nets = try list("Network")
        if !nets.isEmpty {
            guard allowNetwork else { throw Fail("Configuration has \(nets.count) network adapter(s); refusing without --allow-network") }
            c.networkDevices = try nets.map { n in
                guard n["Mode"] as? String == "Shared" else { throw Fail("Only Shared (NAT) network is supported for base setup") }
                let dev = VZVirtioNetworkDeviceConfiguration(); dev.attachment = VZNATNetworkDeviceAttachment()
                if let m = n["MacAddress"] as? String, let mac = VZMACAddress(string: m) { dev.macAddress = mac }
                return dev
            }
        }
        try c.validate()
        return c
    }
    func dict(_ k: String, in d: [String: Any]) throws -> [String: Any] { guard let v = d[k] as? [String: Any] else { throw Fail("Missing \(k)") }; return v }
}

// MARK: - create
func create(_ a: Args) {
    guard a.positional.count == 2, let ipsw = a.flags["ipsw"] else { die("usage: bbvm create <bundle.utm> --ipsw <file> ...") }
    let bundle = URL(fileURLWithPath: a.positional[1]).standardizedFileURL
    guard bundle.pathExtension == "utm", !FileManager.default.fileExists(atPath: bundle.path) else { die("Bundle must be a new .utm path") }
    let cpus = a.int("cpus", 4), mib = a.int("memory-mib", 6144), gib = a.int("disk-gib", 64)
    let width = a.int("width", 1440), height = a.int("height", 900)
    let sem = DispatchSemaphore(value: 0)
    var image: VZMacOSRestoreImage?; var loadError: Error?
    VZMacOSRestoreImage.load(from: URL(fileURLWithPath: ipsw)) { r in
        switch r { case .success(let i): image = i; case .failure(let e): loadError = e }
        sem.signal()
    }
    sem.wait()
    guard let img = image else { die("Restore image: \(loadError.map { "\($0)" } ?? "unknown")") }
    guard img.isSupported, let req = img.mostFeaturefulSupportedConfiguration, req.hardwareModel.isSupported else { die("Restore image unsupported on this host") }
    guard cpus >= req.minimumSupportedCPUCount, UInt64(mib) << 20 >= req.minimumSupportedMemorySize else { die("Below installer minimums: cpu \(req.minimumSupportedCPUCount), memory \(req.minimumSupportedMemorySize)") }
    let v = img.operatingSystemVersion
    let data = bundle.appendingPathComponent("Data", isDirectory: true)
    do {
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let disk = data.appendingPathComponent("disk-0.img")
        let fd = open(disk.path, O_CREAT | O_EXCL | O_WRONLY, 0o600)
        guard fd >= 0, ftruncate(fd, off_t(gib) << 30) == 0 else { die("Cannot create sparse disk") }
        close(fd)
        _ = try VZMacAuxiliaryStorage(creatingStorageAt: data.appendingPathComponent("AuxiliaryStorage"), hardwareModel: req.hardwareModel, options: [])
    } catch { die("Bundle creation failed: \(error)") }
    var network: [[String: Any]] = []
    if a.switches.contains("network") { network = [["Mode": "Shared", "MacAddress": VZMACAddress.randomLocallyAdministered().string]] }
    let plist: [String: Any] = [
        "Backend": "Apple", "ConfigurationVersion": 4,
        "Information": ["Name": a.flags["name"] ?? "BigBrain offline smoke base", "UUID": UUID().uuidString, "IconCustom": false,
                        "Notes": "Clean base for the BigBrain native smoke. Never holds a candidate."],
        "System": ["Architecture": "aarch64", "CPUCount": cpus, "MemorySize": mib, "Boot": ["OperatingSystem": "macOS"],
                   "MacPlatform": ["HardwareModel": req.hardwareModel.dataRepresentation, "MachineIdentifier": VZMacMachineIdentifier().dataRepresentation, "AuxiliaryStoragePath": "AuxiliaryStorage"]],
        "Virtualization": ["Audio": false, "Balloon": true, "Entropy": true, "Keyboard": "Generic", "Pointer": "Mouse", "ClipboardSharing": false],
        "Display": [["WidthPixels": width, "HeightPixels": height, "PixelsPerInch": 80, "DynamicResolution": false]],
        "Drive": [["ImageName": "disk-0.img", "ReadOnly": false, "Nvme": false, "Identifier": UUID().uuidString]],
        "Network": network, "Serial": [],
    ]
    let b = Bundle4(new: bundle, plist: plist)
    do { try b.save() } catch { die("Cannot write config.plist: \(error)") }
    emit(["phase": "created", "bundle": bundle.path, "os": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)", "build": img.buildVersion, "cpus": cpus, "memoryMiB": mib, "diskGiB": gib, "network": !network.isEmpty])

    let config: VZVirtualMachineConfiguration
    do { config = try b.vz(allowNetwork: true) } catch { die("Configuration invalid: \(error)") }
    let vm = VZVirtualMachine(configuration: config)
    let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: URL(fileURLWithPath: ipsw))
    var last = -1
    let obs = installer.progress.observe(\.fractionCompleted, options: [.new]) { p, _ in
        let pct = Int(p.fractionCompleted * 100)
        if pct / 5 != last / 5 { last = pct; emit(["phase": "installing", "percent": pct]) }
    }
    installer.install { r in
        obs.invalidate()
        switch r {
        case .success: emit(["phase": "installed", "bundle": bundle.path, "build": img.buildVersion, "vmState": "\(vm.state.rawValue)"]); exit(0)
        case .failure(let e): die("Install failed: \(e)", 1)
        }
    }
    RunLoop.main.run()
}

// MARK: - run
final class Runner: NSObject, NSApplicationDelegate, VZVirtualMachineDelegate {
    let bundle: Bundle4; let control: String; let statusPath: String; let allowNetwork: Bool
    var vm: VZVirtualMachine!; var window: NSWindow!; var view: VZVirtualMachineView!
    var size = CGSize(width: 1440, height: 900); var stateObs: NSKeyValueObservation?; var eventNumber = 1
    init(bundle: Bundle4, control: String, statusPath: String, allowNetwork: Bool) { self.bundle = bundle; self.control = control; self.statusPath = statusPath; self.allowNetwork = allowNetwork }

    func applicationDidFinishLaunching(_ n: Notification) {
        do {
            let config = try bundle.vz(allowNetwork: allowNetwork)
            if let d = (bundle.plist["Display"] as? [[String: Any]])?.first, let w = d["WidthPixels"] as? Int, let h = d["HeightPixels"] as? Int { size = CGSize(width: w, height: h) }
            vm = VZVirtualMachine(configuration: config)
        } catch { die("Configuration invalid: \(error)") }
        vm.delegate = self
        view = VZVirtualMachineView(frame: NSRect(origin: .zero, size: size))
        view.virtualMachine = vm
        view.capturesSystemKeys = true
        if #available(macOS 14.0, *) { view.automaticallyReconfiguresDisplay = false }
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "bbvm — \(bundle.plist["Information"].flatMap { ($0 as? [String: Any])?["Name"] as? String } ?? "guest")"
        window.contentView = view
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces]
        window.center(); window.orderFrontRegardless()
        window.makeFirstResponder(view)
        stateObs = vm.observe(\.state, options: [.new]) { [weak self] vm, _ in self?.writeStatus(); if vm.state == .stopped || vm.state == .error { self?.finish() } }
        writeStatus()
        startControl()
        vm.start { r in
            if case .failure(let e) = r { die("Start failed: \(e)", 1) }
            emit(["phase": "started", "control": self.control, "pid": Int(getpid())])
        }
    }
    func guestDidStop(_ vm: VZVirtualMachine) { emit(["phase": "guestDidStop"]); writeStatus(); finish() }
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError e: Error) { emit(["phase": "stoppedWithError", "error": "\(e)"]); writeStatus(); finish() }
    func finish() { DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.writeStatus(final: true); exit(0) } }

    func stateName() -> String {
        switch vm.state {
        case .stopped: return "stopped"; case .running: return "running"; case .paused: return "paused"; case .error: return "error"
        case .starting: return "starting"; case .pausing: return "pausing"; case .resuming: return "resuming"; case .stopping: return "stopping"
        case .saving: return "saving"; case .restoring: return "restoring"; @unknown default: return "unknown"
        }
    }
    func writeStatus(final: Bool = false) {
        let s: [String: Any] = ["pid": Int(getpid()), "state": final ? "exited" : stateName(), "control": control, "bundle": bundle.url.path,
                                "updated": ISO8601DateFormatter().string(from: Date()), "network": !((bundle.plist["Network"] as? [Any]) ?? []).isEmpty]
        if let d = try? JSONSerialization.data(withJSONObject: s, options: [.sortedKeys, .prettyPrinted]) { try? d.write(to: URL(fileURLWithPath: statusPath), options: .atomic) }
    }

    // Control socket: newline-delimited JSON requests, one JSON response per line.
    func startControl() {
        unlink(control)
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un(); addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(control.utf8CString); guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { die("Socket path too long") }
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) }) }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        guard withUnsafePointer(to: &addr, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, len) } }) == 0, listen(fd, 4) == 0 else { die("Cannot bind control socket") }
        chmod(control, 0o600)
        Thread.detachNewThread {
            while true {
                let client = accept(fd, nil, nil); if client < 0 { continue }
                Thread.detachNewThread { self.serve(client) }
            }
        }
    }
    func serve(_ fd: Int32) {
        defer { close(fd) }
        var buffer = Data(); var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &chunk, chunk.count); if n <= 0 { return }
            buffer.append(chunk, count: n)
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl); buffer.removeSubrange(buffer.startIndex...nl)
                var reply: [String: Any] = [:]
                DispatchQueue.main.sync { reply = self.handle(line) }
                var out = try! JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]); out.append(0x0A)
                _ = out.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
            }
        }
    }
    func handle(_ line: Data) -> [String: Any] {
        guard let req = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any], let cmd = req["cmd"] as? String else { return ["error": "bad request"] }
        func num(_ k: String) -> CGFloat? { (req[k] as? NSNumber).map { CGFloat(truncating: $0) } }
        do {
            switch cmd {
            case "state": return ["state": stateName(), "width": Int(size.width), "height": Int(size.height), "pid": Int(getpid())]
            case "screenshot":
                guard let path = req["path"] as? String else { return ["error": "path required"] }
                let (w, h, method) = try screenshot(to: path); return ["ok": true, "path": path, "width": w, "height": h, "method": method]
            case "move": guard let x = num("x"), let y = num("y") else { return ["error": "x,y"] }; mouse(.mouseMoved, x, y); return ["ok": true]
            case "click":
                guard let x = num("x"), let y = num("y") else { return ["error": "x,y"] }
                let right = req["button"] as? String == "right"; let count = (req["count"] as? Int) ?? 1
                mouse(.mouseMoved, x, y); usleep(60_000)
                for i in 1...count { mouse(right ? .rightMouseDown : .leftMouseDown, x, y, clicks: i); usleep(40_000); mouse(right ? .rightMouseUp : .leftMouseUp, x, y, clicks: i); usleep(60_000) }
                return ["ok": true]
            case "drag":
                guard let x1 = num("x1"), let y1 = num("y1"), let x2 = num("x2"), let y2 = num("y2") else { return ["error": "x1,y1,x2,y2"] }
                mouse(.mouseMoved, x1, y1); usleep(60_000); mouse(.leftMouseDown, x1, y1); usleep(80_000)
                for step in 1...10 { let t = CGFloat(step) / 10; mouse(.leftMouseDragged, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t); usleep(20_000) }
                mouse(.leftMouseUp, x2, y2); return ["ok": true]
            case "scroll":
                guard let x = num("x"), let y = num("y") else { return ["error": "x,y"] }
                let dy = num("dy") ?? -3, dx = num("dx") ?? 0
                mouse(.mouseMoved, x, y); usleep(40_000)
                if let e = scrollEvent(x, y, dx: dx, dy: dy) { view.scrollWheel(with: e) }; return ["ok": true]
            case "key":
                guard let combo = req["combo"] as? String else { return ["error": "combo"] }
                try pressCombo(combo); return ["ok": true]
            case "type":
                guard let text = req["text"] as? String else { return ["error": "text"] }
                let delay = UInt32((req["delayMs"] as? Int) ?? 12) * 1000
                for ch in text { try typeCharacter(ch); usleep(delay) }
                return ["ok": true, "typed": text.count]
            case "stop": try vm.requestStop(); return ["ok": true, "requested": "stop"]
            case "kill": vm.stop { _ in }; return ["ok": true, "requested": "kill"]
            default: return ["error": "unknown command \(cmd)"]
            }
        } catch { return ["error": "\(error)"] }
    }

    // Screenshot of the guest display as drawn by our own view.
    // A window dragged off-screen stops repainting; pull it back before every capture.
    func keepVisible() {
        guard let screen = window.screen ?? NSScreen.main else { return }
        if !screen.visibleFrame.contains(window.frame) { window.center() }
        window.orderFrontRegardless()
    }
    func screenshot(to path: String) throws -> (Int, Int, String) {
        keepVisible(); usleep(300_000)
        // Render our own view hierarchy at 1x (guest pixel == image pixel). Own-view rendering needs no TCC grant.
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { throw Fail("No bitmap rep") }
        rep.size = size
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { throw Fail("PNG encode failed") }
        try png.write(to: URL(fileURLWithPath: path), options: .atomic)
        return (rep.pixelsWide, rep.pixelsHigh, "view")
    }

    // Guest coordinates: origin top-left, in display pixels (the view is 1:1 with the display).
    func windowPoint(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x, y: size.height - y) }
    func mouse(_ type: NSEvent.EventType, _ x: CGFloat, _ y: CGFloat, clicks: Int = 1) {
        eventNumber += 1
        guard let e = NSEvent.mouseEvent(with: type, location: windowPoint(x, y), modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, eventNumber: eventNumber, clickCount: clicks, pressure: type == .leftMouseDown || type == .rightMouseDown ? 1 : 0) else { return }
        switch type {
        case .mouseMoved: view.mouseMoved(with: e)
        case .leftMouseDown: view.mouseDown(with: e)
        case .leftMouseUp: view.mouseUp(with: e)
        case .leftMouseDragged: view.mouseDragged(with: e)
        case .rightMouseDown: view.rightMouseDown(with: e)
        case .rightMouseUp: view.rightMouseUp(with: e)
        default: break
        }
    }
    func scrollEvent(_ x: CGFloat, _ y: CGFloat, dx: CGFloat, dy: CGFloat) -> NSEvent? {
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return nil }
        let p = windowPoint(x, y)
        cg.location = CGPoint(x: window.frame.origin.x + p.x, y: (NSScreen.screens.first?.frame.height ?? 0) - (window.frame.origin.y + p.y))
        return NSEvent(cgEvent: cg)
    }

    // US keyboard map: character -> (virtual keycode, needs shift)
    static let keymap: [Character: (UInt16, Bool)] = {
        var m: [Character: (UInt16, Bool)] = [:]
        let plain: [(String, UInt16)] = [("a",0),("s",1),("d",2),("f",3),("h",4),("g",5),("z",6),("x",7),("c",8),("v",9),("b",11),("q",12),("w",13),("e",14),("r",15),("y",16),("t",17),("1",18),("2",19),("3",20),("4",21),("6",22),("5",23),("=",24),("9",25),("7",26),("-",27),("8",28),("0",29),("]",30),("o",31),("u",32),("[",33),("i",34),("p",35),("\n",36),("l",37),("j",38),("'",39),("k",40),(";",41),("\\",42),(",",43),("/",44),("n",45),("m",46),(".",47),("\t",48),(" ",49),("`",50)]
        for (s, k) in plain { m[Character(s)] = (k, false); if s.first!.isLetter { m[Character(s.uppercased())] = (k, true) } }
        let shifted: [(String, String)] = [("!","1"),("@","2"),("#","3"),("$","4"),("%","5"),("^","6"),("&","7"),("*","8"),("(","9"),(")","0"),("_","-"),("+","="),("{","["),("}","]"),("|","\\"),(":",";"),("\"","'"),("<",","),(">","."),("?","/"),("~","`")]
        for (s, base) in shifted { m[Character(s)] = (m[Character(base)]!.0, true) }
        return m
    }()
    static let named: [String: UInt16] = ["return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117, "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111]
    // The view tracks modifier state from flagsChanged events and reads the device-dependent
    // left-key bits (IOKit NX_DEVICEL*KEYMASK); without them it never sees a modifier go down.
    static let lshift = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.shift.rawValue | 0x02)
    static let lcmd = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.command.rawValue | 0x08)
    static let lalt = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.option.rawValue | 0x20)
    static let lctrl = NSEvent.ModifierFlags(rawValue: NSEvent.ModifierFlags.control.rawValue | 0x01)
    static let modifiers: [String: (UInt16, NSEvent.ModifierFlags)] = ["cmd": (55, lcmd), "command": (55, lcmd), "shift": (56, lshift), "alt": (58, lalt), "option": (58, lalt), "ctrl": (59, lctrl), "control": (59, lctrl)]

    func keyEvent(_ type: NSEvent.EventType, code: UInt16, flags: NSEvent.ModifierFlags, chars: String) -> NSEvent? {
        NSEvent.keyEvent(with: type, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)
    }
    func press(code: UInt16, flags: NSEvent.ModifierFlags, chars: String) {
        if let d = keyEvent(.keyDown, code: code, flags: flags, chars: chars) { view.keyDown(with: d) }
        usleep(25_000)
        if let u = keyEvent(.keyUp, code: code, flags: flags, chars: chars) { view.keyUp(with: u) }
    }
    func modifier(_ code: UInt16, _ flags: NSEvent.ModifierFlags) {
        if let e = keyEvent(.flagsChanged, code: code, flags: flags, chars: "") { view.flagsChanged(with: e) }
        usleep(25_000)
    }
    func typeCharacter(_ ch: Character) throws {
        guard let (code, shift) = Runner.keymap[ch] else { throw Fail("No key for character \(String(ch).debugDescription)") }
        if shift { modifier(56, Runner.lshift) }
        press(code: code, flags: shift ? Runner.lshift : [], chars: String(ch))
        if shift { modifier(56, []) }
    }
    func pressCombo(_ combo: String) throws {
        let parts = combo.lowercased().split(separator: "+").map(String.init)
        guard let last = parts.last else { throw Fail("empty combo") }
        var flags: NSEvent.ModifierFlags = []; var mods: [(UInt16, NSEvent.ModifierFlags)] = []
        for p in parts.dropLast() { guard let m = Runner.modifiers[p] else { throw Fail("Unknown modifier \(p)") }; mods.append(m); flags.insert(m.1) }
        let code: UInt16
        if let n = Runner.named[last] { code = n } else if last.count == 1, let k = Runner.keymap[Character(last)] { code = k.0 } else { throw Fail("Unknown key \(last)") }
        var held: NSEvent.ModifierFlags = []
        for (c, f) in mods { held.insert(f); modifier(c, held) }
        press(code: code, flags: flags, chars: last.count == 1 ? last : "")
        for (c, f) in mods.reversed() { held.remove(f); modifier(c, held) }
    }
}

func run(_ a: Args) {
    guard a.positional.count == 2, let control = a.flags["control"], let status = a.flags["status"] else { die("usage: bbvm run <bundle.utm> --control <socket> --status <json> [--allow-network]") }
    let bundle: Bundle4
    do { bundle = try Bundle4(load: URL(fileURLWithPath: a.positional[1]).standardizedFileURL) } catch { die("Cannot load bundle: \(error)") }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let runner = Runner(bundle: bundle, control: control, statusPath: status, allowNetwork: a.switches.contains("allow-network"))
    app.delegate = runner
    signal(SIGTERM) { _ in exit(1) }
    app.run()
}

let args = Args(Array(CommandLine.arguments.dropFirst()))
switch args.positional.first {
case "create": create(args)
case "run": run(args)
default: die("usage: bbvm create|run ...")
}
