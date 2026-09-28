// Read-only Apple-framework compatibility probe for a downloaded official IPSW.
import Foundation
import Virtualization

guard CommandLine.arguments.count == 2 else {
    fputs("usage: restore-info /path/to/official.ipsw\n", stderr)
    exit(2)
}
let file = URL(fileURLWithPath: CommandLine.arguments[1])
VZMacOSRestoreImage.load(from: file) { result in
    do {
        let image = try result.get()
        let v = image.operatingSystemVersion
        let req = image.mostFeaturefulSupportedConfiguration
        let report: [String: Any] = [
            "os": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)",
            "build": image.buildVersion,
            "supported": image.isSupported,
            "minimumCPU": req?.minimumSupportedCPUCount ?? 0,
            "minimumMemoryBytes": req?.minimumSupportedMemorySize ?? 0,
            "hardwareModelSupported": req?.hardwareModel.isSupported ?? false,
            "scope": "Metadata compatibility only; installer acceptance and guest boot are separate checks"
        ]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        exit(image.isSupported && req != nil ? 0 : 1)
    } catch {
        fputs("\(error)\n", stderr)
        exit(1)
    }
}
RunLoop.main.run()
