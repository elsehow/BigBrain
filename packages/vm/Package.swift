// swift-tools-version:5.5
// bigbrain-vm: boots one desktop's machine with Virtualization.framework and
// bridges its vsock ports to two Unix sockets. Nothing else (the plan's D2).
import PackageDescription

let package = Package(
    name: "bigbrain-vm",
    platforms: [.macOS(.v12)],
    targets: [
        .executableTarget(
            name: "bigbrain-vm",
            path: "Sources/bigbrain-vm",
            linkerSettings: [.linkedFramework("Virtualization")]
        ),
    ]
)
