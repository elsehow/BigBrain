#!/usr/bin/env python3
"""Bounded VM preparation. No downloads, signing, user-account changes or broad host mounts.

Requires a separately provisioned, powered-off Apple macOS base in UTM's schema-4
bundle format, run by the bbvm driver (driver/). Commands fail closed on storage,
artifact or offline configuration mismatch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid

GIB = 1024 ** 3
PROVISION_GIB = 80  # Budget, not a claimed macOS minimum.
RUN_GIB = 20
LOCK = Path(__file__).with_name("candidate.json")


def require(ok, message):
    if not ok:
        raise ValueError(message)


def digest(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path, data):
    with Path(path).open("x") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def run(*args):
    return subprocess.run(list(map(str, args)), check=True, capture_output=True, text=True).stdout.strip()


def preflight(storage):
    storage = Path(storage).resolve(strict=True)
    # diskutil accepts device identifiers/mount points, not arbitrary directories.
    device = run("/bin/df", "-P", storage).splitlines()[-1].split()[0]
    require(re.fullmatch(r"/dev/disk\d+(s\d+)*", device), "Storage is not a local disk volume")
    info = plistlib.loads(subprocess.check_output(["/usr/sbin/diskutil", "info", "-plist", device]))
    free = shutil.disk_usage(storage).free
    return {
        "storage": str(storage), "macOS": platform.mac_ver()[0], "architecture": platform.machine(),
        "virtualization": run("/usr/sbin/sysctl", "-n", "kern.hv_support") == "1",
        "memoryBytes": int(run("/usr/sbin/sysctl", "-n", "hw.memsize")),
        "filesystem": info.get("FilesystemType"), "availableBytes": free,
        "availableGiB": round(free / GIB, 2), "provisionBudgetGiB": PROVISION_GIB,
        "storageReady": info.get("FilesystemType") == "apfs" and free >= PROVISION_GIB * GIB,
        "budgetNote": "Conservative restore/base/clone/headroom budget; not an OS minimum.",
    }


def manifest(app):
    app = Path(app).resolve(strict=True)
    require(app.is_dir() and app.suffix == ".app", "Expected a packaged .app directory")
    entries = []
    for directory, folders, files in os.walk(app, followlinks=False):
        for name in sorted(folders + files):
            p = Path(directory) / name
            mode = p.lstat().st_mode
            relative = p.relative_to(app).as_posix()
            entry = {"path": relative, "mode": stat.S_IMODE(mode)}
            if p.is_symlink():
                require(p.resolve().is_relative_to(app), f"Escaping artifact symlink: {relative}")
                entry.update(type="link", target=os.readlink(p))
            elif p.is_file():
                entry.update(type="file", bytes=p.stat().st_size, sha256=digest(p))
            elif p.is_dir():
                entry.update(type="directory")
            else:
                raise ValueError(f"Special file in artifact: {relative}")
            entries.append(entry)
    return sorted(entries, key=lambda x: x["path"])


def candidate(app, lock):
    app = Path(app).resolve(strict=True)
    expected = json.loads(Path(lock).read_text())
    # Inventory validates symlinks before any candidate file is followed.
    inventory = manifest(app)
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    bundle = (app / "Contents/Resources/resources/engine/BUNDLE").read_text()
    sha = digest(app / "Contents/MacOS/bigbrain-desktop")
    require(sha == expected["executableSHA256"], "Candidate executable does not match lock")
    require(bundle == expected["bundle"], "Candidate BUNDLE does not match lock")
    require(info["CFBundleShortVersionString"] == expected["version"], "Candidate version does not match lock")
    return {"expected": expected, "appName": app.name, "files": inventory,
            "inventorySHA256": hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()}


def local_name(value):
    return isinstance(value, str) and value not in ("", ".", "..") and Path(value).name == value and ":" not in value


def validate_config(config):
    allowed = {"Information", "System", "Virtualization", "SharedDirectory", "Display", "Drive", "Network", "Serial", "Backend", "ConfigurationVersion"}
    require(not set(config) - allowed, "Unknown UTM configuration fields; review schema first")
    require(config.get("Backend") == "Apple" and config.get("ConfigurationVersion") == 4, "Only pinned UTM Apple schema 4 is supported")
    require(config.get("Network") == [], "Remove every network adapter before boot")
    require(config.get("SharedDirectory", []) == [], "Host directory sharing must be empty")
    require(config.get("Serial") == [], "Serial host endpoints must be empty")
    devices = config.get("Virtualization", {})
    require(devices.get("Audio") is False, "Disable host audio/microphone devices")
    require(devices.get("ClipboardSharing") is False, "Explicitly disable shared clipboard")
    require(devices.get("Rosetta", False) is False, "Rosetta host sharing must be disabled")
    system = config.get("System", {})
    require(system.get("Architecture") == "aarch64", "Expected Apple Silicon guest")
    require(system.get("Boot", {}).get("OperatingSystem") == "macOS", "Expected macOS guest")
    uuid.UUID(config["Information"]["UUID"])
    drives = config.get("Drive", [])
    require(drives, "Missing internal guest disk")
    for drive in drives:
        require(not set(drive) - {"ImageName", "ReadOnly", "Nvme", "Identifier"}, "External or unknown drive reference")
        require(isinstance(drive.get("ReadOnly"), bool), "Explicit drive access mode required")
        require(local_name(drive.get("ImageName")), "All drives must be files inside the VM Data directory")
    aux = system.get("MacPlatform", {}).get("AuxiliaryStoragePath")
    require(local_name(aux), "Auxiliary storage must be internal")
    return config


def check_vm(vm):
    vm = Path(vm).resolve(strict=True)
    require(vm.suffix == ".utm", "Expected a .utm package")
    require(not any(p.is_symlink() for p in vm.rglob("*")), "VM package must not contain symlinks")
    config = validate_config(plistlib.loads((vm / "config.plist").read_bytes()))
    for drive in config["Drive"]:
        require((vm / "Data" / drive["ImageName"]).is_file(), "Referenced VM disk is missing")
    require((vm / "Data" / config["System"]["MacPlatform"]["AuxiliaryStoragePath"]).is_file(), "Missing auxiliary storage")
    # Suspended guests/snapshot restores could reinstate a formerly connected NIC.
    for path in vm.rglob("*"):
        require(not any(word in path.name.lower() for word in ("snapshot", "suspend", "savestate", ".vmstate", ".sav")), "Use a fully shut-down base without saved states/snapshots")
    return config


def stopped(vm):
    """Fail unless no process holds the VM's disks: a running guest (bbvm, UTM or
    anything else built on Virtualization.framework) keeps them open."""
    vm = Path(vm).resolve(strict=True)
    config = plistlib.loads((vm / "config.plist").read_bytes())
    files = [vm / "Data" / d["ImageName"] for d in config.get("Drive", [])]
    files.append(vm / "Data" / config["System"]["MacPlatform"]["AuxiliaryStoragePath"])
    holders = subprocess.run(["/usr/sbin/lsof", "-t", *map(str, files)], capture_output=True, text=True)
    require(holders.returncode == 1 and not holders.stdout.strip(), "VM must be fully stopped (its disks are open)")
    listing = run("/bin/ps", "-axww", "-o", "command=")
    # Match the executable, not any argument: a shell whose script merely mentions bbvm is not a driver.
    drivers = [line for line in listing.splitlines() if line.split() and Path(line.split()[0]).name.startswith("bbvm")]
    require(not any(vm.name in line for line in drivers), "A bbvm process still names this VM")


def raw_image(source, dest):
    # Virtualization.framework attaches raw (or ASIF) images only; UDTO is hdiutil's raw format.
    require(not dest.exists(), "Disk image already present")
    stem = dest.with_suffix("")
    run("/usr/bin/hdiutil", "convert", source, "-format", "UDTO", "-o", stem)
    stem.with_suffix(".cdr").rename(dest)
    return digest(dest)


def add_output(path, config, size_gib=2):
    # A blank, guest-writable HFS+ disk: the only way evidence leaves the guest.
    dest = path / "Data/bb-output.img"
    scratch = path / "Data/bb-output-seed.dmg"
    run("/usr/bin/hdiutil", "create", "-size", f"{size_gib}g", "-fs", "HFS+", "-volname", "BB_SMOKE_OUT", "-layout", "GPTSPUD", scratch)
    raw_image(scratch, dest)
    scratch.unlink()
    config["Drive"].append({"ImageName": dest.name, "ReadOnly": False, "Nvme": False, "Identifier": str(uuid.uuid4()).upper()})
    return {"outputImage": dest.name}


def clone(base, storage, transfer_path=None):
    base = Path(base).resolve(strict=True)
    storage = Path(storage).resolve(strict=True)
    facts = preflight(storage)
    require(facts["filesystem"] == "apfs", "Clone storage must be APFS")
    require(facts["availableBytes"] >= RUN_GIB * GIB, "Need at least 20 GiB free clone-run headroom")
    require(base.stat().st_dev == storage.stat().st_dev, "Base and clone must share an APFS volume for copy-on-write")
    config = check_vm(base)
    stopped(base)
    token = str(uuid.uuid4())
    dest = storage / ("bb-smoke-" + token + ".utm")
    require(not dest.exists(), "Clone destination exists")
    # -c requests clonefile; no fallback to a space-consuming full copy.
    run("/bin/cp", "-cR", base, dest)
    config["Information"]["UUID"] = str(uuid.uuid4()).upper()
    config["Information"]["Name"] = "BigBrain offline smoke " + token
    input_record = add_input(dest, config, transfer_path) if transfer_path else {}
    if transfer_path:
        input_record.update(add_output(dest, config))
    (dest / "config.plist").write_bytes(plistlib.dumps(config))
    check_vm(dest)
    check_vm(base)
    stopped(base)
    receipt = {"kind": "bigbrain-offline-clone-v1", "base": str(base), "clone": str(dest),
               "uuid": config["Information"]["UUID"], "configSHA256": digest(dest / "config.plist"),
               "coverage": "Prepared only; not booted or guest-validated", **input_record}
    write_json(storage / (dest.name + ".receipt.json"), receipt)
    return receipt


def transfer(app, lock, storage):
    storage = Path(storage).resolve(strict=True)
    record = candidate(app, lock)
    size = sum(f.get("bytes", 0) for f in record["files"])
    require(shutil.disk_usage(storage).free >= RUN_GIB * GIB + 3 * size, "Insufficient transfer staging/headroom")
    dest = storage / ("bb-transfer-" + str(uuid.uuid4()))
    dest.mkdir(mode=0o700)
    payload = dest / "payload"
    payload.mkdir()
    run("/usr/bin/ditto", Path(app).resolve(), payload / record["appName"])
    require(candidate(payload / record["appName"], lock) == record, "Copied artifact differs")
    write_json(payload / "candidate-manifest.json", record)
    guest = Path(__file__).with_name("guest")
    fixture_hashes = {}
    for name in ("launch.command", "verify-artifact.ts", "containment.sh", "collect.sh", "acceptance-fixture.sh"):
        shutil.copy2(guest / name, payload / name)
        fixture_hashes[name] = digest(payload / name)
    for name in ("launch.command", "containment.sh", "collect.sh", "acceptance-fixture.sh"):
        (payload / name).chmod(0o755)
    # No home share, credentials, source checkout, or unrelated fixture paths.
    image = dest / "candidate.dmg"
    run("/usr/bin/hdiutil", "create", "-srcfolder", payload, "-format", "UDRO", "-volname", "BB_SMOKE_INPUT", image)
    run("/usr/bin/hdiutil", "verify", image)
    result = {"image": str(image), "sha256": digest(image), "candidate": record["expected"],
              "inventorySHA256": record["inventorySHA256"], "bytes": image.stat().st_size, "fixtureSHA256": fixture_hashes,
              "attachmentRequirement": "ReadOnly=true; internal disk copy in disposable clone only"}
    write_json(dest / "transfer.json", result)
    return result


def owned_clone(receipt_path):
    receipt = json.loads(Path(receipt_path).read_text())
    require(receipt.get("kind") == "bigbrain-offline-clone-v1", "Not a harness clone receipt")
    path = Path(receipt["clone"])
    require(path.name.startswith("bb-smoke-") and path.suffix == ".utm", "Not a generated clone path")
    uuid.UUID(path.stem.removeprefix("bb-smoke-"))
    require(path.resolve() == path and path != Path(receipt["base"]), "Invalid clone location")
    config = check_vm(path)
    require(config["Information"]["UUID"] == receipt["uuid"], "Clone identity changed")
    require(digest(path / "config.plist") == receipt["configSHA256"], "Clone configuration changed; inspect before proceeding")
    return receipt, path, config


def add_input(path, config, transfer_path):
    # Called while creating a NEW clone, before UTM can cache its configuration.
    transfer = json.loads(Path(transfer_path).read_text())
    image = Path(transfer["image"]).resolve(strict=True)
    require(digest(image) == transfer["sha256"], "Transfer image changed")
    require(shutil.disk_usage(path).free >= RUN_GIB * GIB + image.stat().st_size, "Insufficient input-disk headroom")
    dest = path / "Data/bb-candidate.img"
    raw = raw_image(image, dest)
    dest.chmod(0o400)
    config["Drive"].append({"ImageName": dest.name, "ReadOnly": True, "Nvme": False, "Identifier": str(uuid.uuid4()).upper()})
    return {"transferSHA256": transfer["sha256"], "inputSHA256": raw, "candidate": transfer["candidate"],
            "inventorySHA256": transfer["inventorySHA256"], "fixtureSHA256": transfer["fixtureSHA256"]}


def boot(receipt_path, driver):
    receipt, path, config = owned_clone(receipt_path)
    require("inputSHA256" in receipt, "Attach a verified candidate first")
    require(digest(path / "Data/bb-candidate.img") == receipt["inputSHA256"], "Input disk changed")
    stopped(path)
    run_dir = path.with_name(path.name + ".run")
    run_dir.mkdir(mode=0o700)
    # sun_path is 104 bytes; a worktree-deep path overflows it, so the socket lives in a private /tmp dir.
    control, status = Path(tempfile.mkdtemp(prefix="bbvm-", dir="/tmp")) / "control.sock", run_dir / "status.json"
    log = (run_dir / "driver.log").open("x")
    # Never --allow-network: the driver refuses a configuration with any NIC.
    process = subprocess.Popen([str(driver), "run", str(path), "--control", str(control), "--status", str(status)],
                               stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    deadline = time.time() + 60
    while time.time() < deadline and process.poll() is None:
        try:
            if json.loads(status.read_text()).get("state") == "running":
                break
        except (OSError, ValueError):
            pass
        time.sleep(1)
    require(process.poll() is None, f"Driver exited; see {run_dir / 'driver.log'}")
    # A running VM is NOT evidence of an isolated guest or an app pass.
    return {"driverPid": process.pid, "control": str(control), "status": str(status), "configSHA256": receipt["configSHA256"],
            "nativeSmokePassed": False, "next": "Guest containment check, then native GUI smoke"}


def export(receipt_path, evidence):
    receipt, path, config = owned_clone(receipt_path)
    stopped(path)
    evidence = Path(evidence)
    evidence.mkdir(parents=True, exist_ok=False)
    image = path / "Data" / receipt["outputImage"]
    mount = Path(run("/usr/bin/mktemp", "-d", "/tmp/bb-smoke-out.XXXXXX"))
    # Read-only, not shown in Finder, not spotlight-indexed; guest-written content is only copied.
    run("/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-noautoopen", "-imagekey", "diskimage-class=CRawDiskImage",
        "-mountpoint", mount, image)
    try:
        # Only the evidence tree: the guest's own .Spotlight-V100/.Trashes are unreadable here.
        run("/usr/bin/ditto", "--norsrc", "--noextattr", "--noacl", mount / "evidence", evidence / "guest")
    finally:
        run("/usr/bin/hdiutil", "detach", mount)
        mount.rmdir()
    return {"evidence": str(evidence), "outputImageSHA256": digest(image)}


def cleanup(receipt_path):
    receipt, path, config = owned_clone(receipt_path)
    stopped(path)
    # Remove only this receipt's validated, generated clone (never the base, never by pattern).
    require(Path(receipt["base"]).resolve() != path and path.parent == Path(receipt_path).resolve().parent, "Clone is not beside its receipt")
    shutil.rmtree(path)
    run_dir = path.with_name(path.name + ".run")
    return {"deletedClone": str(path), "preservedBase": receipt["base"], "receipt": str(receipt_path),
            "driverRunLogs": str(run_dir) if run_dir.exists() else None}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    p = sub.add_parser("preflight"); p.add_argument("storage")
    p = sub.add_parser("candidate"); p.add_argument("app"); p.add_argument("--lock", default=str(LOCK))
    p = sub.add_parser("check-vm"); p.add_argument("vm")
    p = sub.add_parser("clone"); p.add_argument("base"); p.add_argument("storage"); p.add_argument("--transfer")
    p = sub.add_parser("transfer"); p.add_argument("app"); p.add_argument("storage"); p.add_argument("--lock", default=str(LOCK))
    p = sub.add_parser("boot"); p.add_argument("receipt"); p.add_argument("--driver", required=True)
    p = sub.add_parser("export"); p.add_argument("receipt"); p.add_argument("evidence")
    p = sub.add_parser("cleanup"); p.add_argument("receipt")
    args = parser.parse_args()
    try:
        if args.action == "preflight":
            result = preflight(args.storage)
        elif args.action == "candidate":
            result = candidate(args.app, args.lock)
        elif args.action == "check-vm":
            result = {"configuration": check_vm(args.vm), "scope": "Static check only; not proof of running-guest isolation"}
        elif args.action == "clone":
            result = clone(args.base, args.storage, args.transfer)
        elif args.action == "transfer":
            result = transfer(args.app, args.lock, args.storage)
        elif args.action == "boot":
            result = boot(args.receipt, args.driver)
        elif args.action == "export":
            result = export(args.receipt, args.evidence)
        else:
            result = cleanup(args.receipt)
        print(json.dumps(result, indent=2, default=lambda obj: "<binary platform identity>"))
        if args.action == "preflight" and not result["storageReady"]:
            return 2
    except (ValueError, OSError, subprocess.CalledProcessError, KeyError) as error:
        print(json.dumps({"error": str(error), "action": args.action}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
