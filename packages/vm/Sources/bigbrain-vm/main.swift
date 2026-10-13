// bigbrain-vm: one desktop's machine (docs/plans/2026-10-12-contained-desktops.md, D2).
//
// Reads one line of JSON config on stdin, boots the machine with
// Virtualization.framework, and bridges:
//   guestSocket  (a Unix socket it listens on)  -> the guest's vsock port 7470
//   the guest's connections to vsock port 7471  -> egressSocket (the engine listens)
// It reports its state on stdout as JSON lines ({"state": "starting" |
// "running" | "stopped" | "failed", ...}) and interprets nothing the guest
// says. After the config, stdin carries "stop" (power off now); stdin
// closing, SIGTERM or SIGINT do the same, so the machine never outlives the
// engine. The engine asks the guest to shut down first (PROTOCOL.md, shutdown).
//
//   bigbrain-vm               boot, from the config on stdin
//   bigbrain-vm --dump-config the devices the config makes, as JSON, without booting
//
// The machine gets a disk, vsock, a console, entropy and a balloon: no
// network device and no shared folder (the plan's I4).

import Darwin
import Foundation
@preconcurrency import Virtualization

struct Config: Decodable {
    let kernel: String
    let initramfs: String
    let cmdline: String
    let cpus: Int
    let memoryMiB: UInt64
    let disk: String
    let console: String
    let guestSocket: String
    let egressSocket: String
    let balloon: Bool?
}

let guestPort: UInt32 = 7470
let egressPort: UInt32 = 7471

let stdoutLock = NSLock()
func say(_ fields: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]) else { return }
    stdoutLock.lock()
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    stdoutLock.unlock()
}

func fail(_ message: String) -> Never {
    say(["state": "failed", "error": message])
    exit(1)
}

func errnoText() -> String { String(cString: strerror(errno)) }

// MARK: - configuration

/// The machine's configuration; validated unless only described (a Mac that can't virtualize, such as CI's, refuses validation).
func configuration(_ c: Config, validate: Bool = true) throws -> VZVirtualMachineConfiguration {
    let boot = VZLinuxBootLoader(kernelURL: URL(fileURLWithPath: c.kernel))
    boot.initialRamdiskURL = URL(fileURLWithPath: c.initramfs)
    boot.commandLine = c.cmdline

    let vm = VZVirtualMachineConfiguration()
    vm.bootLoader = boot
    vm.cpuCount = max(VZVirtualMachineConfiguration.minimumAllowedCPUCount, min(c.cpus, VZVirtualMachineConfiguration.maximumAllowedCPUCount))
    let bytes = c.memoryMiB * 1024 * 1024
    vm.memorySize = max(VZVirtualMachineConfiguration.minimumAllowedMemorySize, min(bytes, VZVirtualMachineConfiguration.maximumAllowedMemorySize))

    let disk = try VZDiskImageStorageDeviceAttachment(url: URL(fileURLWithPath: c.disk), readOnly: false)
    vm.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: disk)]

    if !FileManager.default.fileExists(atPath: c.console) {
        FileManager.default.createFile(atPath: c.console, contents: nil)
    }
    guard let log = FileHandle(forWritingAtPath: c.console) else { throw NSError(domain: "bigbrain-vm", code: 1, userInfo: [NSLocalizedDescriptionKey: "can't write \(c.console)"]) }
    log.seekToEndOfFile()
    let console = VZVirtioConsoleDeviceSerialPortConfiguration()
    console.attachment = VZFileHandleSerialPortAttachment(fileHandleForReading: nil, fileHandleForWriting: log)
    vm.serialPorts = [console]

    vm.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    if c.balloon ?? true {
        vm.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]
    }
    vm.socketDevices = [VZVirtioSocketDeviceConfiguration()]
    // said explicitly, so a reader (and --dump-config) sees there are none
    vm.networkDevices = []
    vm.directorySharingDevices = []

    if validate { try vm.validate() }
    return vm
}

/// Every device array the configuration has, by kind and count: what I4's test checks.
func describe(_ vm: VZVirtualMachineConfiguration) -> [String: Any] {
    var devices: [String: Int] = [
        "block": vm.storageDevices.count,
        "network": vm.networkDevices.count,
        "console": vm.serialPorts.count,
        "entropy": vm.entropyDevices.count,
        "balloon": vm.memoryBalloonDevices.count,
        "vsock": vm.socketDevices.count,
        "directorySharing": vm.directorySharingDevices.count,
        "graphics": vm.graphicsDevices.count,
        "keyboard": vm.keyboards.count,
        "pointing": vm.pointingDevices.count,
        "audio": vm.audioDevices.count,
    ]
    devices = devices.filter { $0.value > 0 }
    return ["devices": devices, "cpus": vm.cpuCount, "memoryMiB": vm.memorySize / 1024 / 1024]
}

// MARK: - Unix sockets

func socketAddress(_ path: String) -> sockaddr_un {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: addr.sun_path)
    if bytes.count >= capacity { fail("socket path is \(bytes.count) bytes, over the \(capacity - 1)-byte limit: \(path)") }
    withUnsafeMutableBytes(of: &addr.sun_path) { buf in
        for (i, b) in bytes.enumerated() { buf[i] = b }
        buf[bytes.count] = 0
    }
    return addr
}

func unixListen(_ path: String) -> Int32 {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { fail("socket: \(errnoText())") }
    var addr = socketAddress(path)
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    if bound != 0 { fail("bind \(path): \(errnoText())") }
    chmod(path, 0o600)
    if listen(fd, 64) != 0 { fail("listen \(path): \(errnoText())") }
    return fd
}

func unixConnect(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    if fd < 0 { return nil }
    var addr = socketAddress(path)
    let connected = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    if connected != 0 {
        close(fd)
        return nil
    }
    return fd
}

/// Copy bytes both ways between two descriptors until both directions end;
/// each direction's end closes the other side's writing half. Then `done`.
func bridge(_ a: Int32, _ b: Int32, done: @escaping () -> Void) {
    let group = DispatchGroup()
    for (from, to) in [(a, b), (b, a)] {
        group.enter()
        Thread.detachNewThread {
            var buf = [UInt8](repeating: 0, count: 256 * 1024)
            copying: while true {
                let n = buf.withUnsafeMutableBytes { read(from, $0.baseAddress, $0.count) }
                if n < 0 && errno == EINTR { continue }
                if n <= 0 { break }
                var off = 0
                while off < n {
                    let w = buf.withUnsafeBytes { write(to, $0.baseAddress! + off, n - off) }
                    if w < 0 && errno == EINTR { continue }
                    if w <= 0 { break copying }
                    off += w
                }
            }
            shutdown(to, SHUT_WR)
            group.leave()
        }
    }
    group.notify(queue: .global(), execute: done)
}

// MARK: - the machine

/// The guest's connections to the host's port 7471, each joined to the engine's egress socket.
final class Egress: NSObject, VZVirtioSocketListenerDelegate {
    let path: String
    init(path: String) { self.path = path }

    func listener(_ listener: VZVirtioSocketListener, shouldAcceptNewConnection connection: VZVirtioSocketConnection, from socketDevice: VZVirtioSocketDevice) -> Bool {
        guard let fd = unixConnect(path) else { return false }
        // the connection owns its descriptor and closes it when closed; it lives until the bridge is done
        bridge(connection.fileDescriptor, fd) {
            connection.close()
            close(fd)
        }
        return true
    }
}

final class Watcher: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        say(["state": "stopped"])
        exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fail("the machine stopped: \(error.localizedDescription)")
    }
}

signal(SIGPIPE, SIG_IGN)
let arguments = Array(CommandLine.arguments.dropFirst())
guard let line = readLine(strippingNewline: true), let data = line.data(using: .utf8) else { fail("no config on stdin") }
let config: Config
do { config = try JSONDecoder().decode(Config.self, from: data) } catch { fail("the config is not valid: \(error)") }

let vmConfig: VZVirtualMachineConfiguration
do { vmConfig = try configuration(config, validate: arguments != ["--dump-config"]) } catch { fail("the configuration is refused: \(error.localizedDescription)") }

if arguments == ["--dump-config"] {
    guard let out = try? JSONSerialization.data(withJSONObject: describe(vmConfig), options: [.sortedKeys]) else { fail("can't describe the configuration") }
    FileHandle.standardOutput.write(out)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
} else if !arguments.isEmpty {
    FileHandle.standardError.write("usage: bigbrain-vm [--dump-config] < config.json\n".data(using: .utf8)!)
    exit(2)
}

let queue = DispatchQueue(label: "bigbrain-vm.machine")
let machine = VZVirtualMachine(configuration: vmConfig, queue: queue)
let watcher = Watcher()
let egress = Egress(path: config.egressSocket)
let egressListener = VZVirtioSocketListener()
egressListener.delegate = egress

/// Power off now (the guest has synced, or the engine is gone) and exit.
func stopNow(_ why: String) {
    queue.async {
        if machine.canStop {
            machine.stop { _ in
                say(["state": "stopped", "reason": why])
                exit(0)
            }
        } else {
            say(["state": "stopped", "reason": why])
            exit(0)
        }
    }
}

var signals: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
    source.setEventHandler { stopNow("signal \(sig)") }
    source.resume()
    signals.append(source)
}

/// Accept on guest.sock forever; each connection becomes a fresh vsock connection to the guest.
func serveGuestSocket(_ device: VZVirtioSocketDevice) {
    let listening = unixListen(config.guestSocket)
    Thread.detachNewThread {
        while true {
            let client = accept(listening, nil, nil)
            if client < 0 {
                if errno == EINTR || errno == ECONNABORTED { continue }
                fail("accept on \(config.guestSocket): \(errnoText())")
            }
            queue.async {
                device.connect(toPort: guestPort) { result in
                    switch result {
                    case .success(let connection):
                        bridge(connection.fileDescriptor, client) {
                            connection.close()
                            close(client)
                        }
                    case .failure:
                        // the guest isn't listening yet, or is gone: the engine sees the close and retries
                        close(client)
                    }
                }
            }
        }
    }
}

say(["state": "starting"])
queue.async {
    machine.delegate = watcher
    machine.start { result in
        switch result {
        case .failure(let error):
            fail("the machine did not start: \(error.localizedDescription)")
        case .success:
            guard let device = machine.socketDevices.first as? VZVirtioSocketDevice else { fail("the machine has no vsock device") }
            device.setSocketListener(egressListener, forPort: egressPort)
            serveGuestSocket(device)
            say(["state": "running"])
        }
    }
}

// the engine's commands; its going away stops the machine
Thread.detachNewThread {
    while let command = readLine(strippingNewline: true) {
        switch command.trimmingCharacters(in: .whitespaces) {
        case "stop": stopNow("asked")
        case "": continue
        default: say(["warning": "unknown command"])
        }
    }
    stopNow("the engine closed stdin")
}

dispatchMain()
