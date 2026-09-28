import json
from pathlib import Path
import plistlib
import tempfile
import sys
import runner
import unittest
from unittest.mock import patch
import uuid
from runner import candidate, manifest, validate_config, check_vm, owned_clone, stopped, clone, preflight


def fixture():
    return {"Backend": "Apple", "ConfigurationVersion": 4,
            "Information": {"UUID": str(uuid.uuid4()), "Name": "Synthetic"},
            "System": {"Architecture": "aarch64", "Boot": {"OperatingSystem": "macOS"},
                       "MacPlatform": {"AuxiliaryStoragePath": "AuxiliaryStorage"}},
            "Virtualization": {"ClipboardSharing": False, "Audio": False}, "Network": [], "Serial": [],
            "Drive": [{"ImageName": "root.img", "ReadOnly": False}], "Display": []}


class OfflineGuards(unittest.TestCase):
    def test_preflight_resolves_directory_to_local_volume(self):
        with tempfile.TemporaryDirectory() as t, patch("runner.run", side_effect=["Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s5 1 1 1 1% /System/Volumes/Data", "1", "25769803776"]), patch("runner.subprocess.check_output", return_value=plistlib.dumps({"FilesystemType": "apfs"})) as diskutil, patch("runner.shutil.disk_usage", return_value=type("Usage", (), {"free": 22 * 1024**3})()):
            result = preflight(t)
            self.assertFalse(result["storageReady"])
            self.assertEqual(result["availableGiB"], 22)
            self.assertEqual(diskutil.call_args.args[0][-1], "/dev/disk3s5")

    def test_offline_schema_accepted(self):
        validate_config(fixture())

    def test_network_clipboard_shares_audio_and_external_disks_rejected(self):
        variations = [
            ("Network", [{"Mode": "Shared"}]), ("SharedDirectory", [{"Path": "/Users"}]),
            ("Serial", [{"Mode": "Tcp"}]), ("Backend", "QEMU"), ("ConfigurationVersion", 5),
            ("FutureShare", True),
            ("Virtualization", {"ClipboardSharing": True, "Audio": False}),
            ("Virtualization", {"ClipboardSharing": False, "Audio": True}),
            ("Virtualization", {"ClipboardSharing": False, "Audio": False, "Rosetta": True}),
        ]
        for key, value in variations:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                c = fixture(); c[key] = value; validate_config(c)
        for path in ("../root.img", "/dev/disk0", "", "..", "disk:name"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                c = fixture(); c["Drive"][0]["ImageName"] = path; validate_config(c)
        c = fixture(); c["Drive"][0]["Bookmark"] = b"opaque"
        with self.assertRaises(ValueError): validate_config(c)

    def test_missing_controls_fail_closed(self):
        for key in ("Network", "Serial", "Virtualization", "Drive"):
            c = fixture(); del c[key]
            with self.subTest(key=key), self.assertRaises(ValueError): validate_config(c)

    def test_vm_missing_disk_symlink_and_saved_state(self):
        with tempfile.TemporaryDirectory() as t:
            vm = Path(t) / "base.utm"; vm.mkdir(); (vm / "Data").mkdir()
            (vm / "config.plist").write_bytes(plistlib.dumps(fixture()))
            with self.assertRaises(ValueError): check_vm(vm)
            (vm / "Data/root.img").write_bytes(b"synthetic disk")
            (vm / "Data/AuxiliaryStorage").write_bytes(b"synthetic nvram")
            check_vm(vm)
            (vm / "Data/suspend.vmstate").write_bytes(b"state")
            with self.assertRaises(ValueError): check_vm(vm)
            (vm / "Data/suspend.vmstate").unlink()
            (vm / "Data/link").symlink_to("root.img")
            with self.assertRaises(ValueError): check_vm(vm)

    def test_clone_requires_headroom_before_copy(self):
        with tempfile.TemporaryDirectory() as t, patch("runner.preflight", return_value={"filesystem": "apfs", "availableBytes": 1}), patch("runner.run") as command:
            with self.assertRaises(ValueError): clone(t, t)
            command.assert_not_called()

    def test_clone_requires_disks_closed_and_no_driver(self):
        with tempfile.TemporaryDirectory() as t:
            vm = Path(t) / "base.utm"; (vm / "Data").mkdir(parents=True)
            (vm / "config.plist").write_bytes(plistlib.dumps(fixture()))
            (vm / "Data/root.img").write_bytes(b"synthetic"); (vm / "Data/AuxiliaryStorage").write_bytes(b"synthetic")
            stopped(vm)
            with open(vm / "Data/root.img", "rb"), self.assertRaises(ValueError):
                stopped(vm)
            with patch("runner.run", return_value="/x/bbvm run " + str(vm) + " --control c"), self.assertRaises(ValueError):
                stopped(vm)

    @unittest.skipUnless(sys.platform == "darwin", "Uses macOS clonefile via cp -c")
    def test_apfs_clone_mechanics_keep_base_and_change_only_new_uuid(self):
        with tempfile.TemporaryDirectory() as t:
            base = Path(t) / "base.utm"; base.mkdir(); (base / "Data").mkdir()
            original = fixture()
            (base / "config.plist").write_bytes(plistlib.dumps(original))
            (base / "Data/root.img").write_bytes(b"synthetic disk, not an OS image")
            (base / "Data/AuxiliaryStorage").write_bytes(b"synthetic nvram")
            with patch("runner.preflight", return_value={"filesystem": "apfs", "availableBytes": 30 * 1024**3}):
                receipt = clone(base, t)
            self.assertEqual(plistlib.loads((base / "config.plist").read_bytes()), original)
            cloned = check_vm(receipt["clone"])
            self.assertNotEqual(cloned["Information"]["UUID"], original["Information"]["UUID"])
            self.assertEqual(cloned["Network"], [])
            self.assertEqual((Path(receipt["clone"]) / "Data/root.img").read_bytes(), b"synthetic disk, not an OS image")

    def test_cleanup_receipt_cannot_point_to_base(self):
        with tempfile.TemporaryDirectory() as t:
            r = Path(t) / "receipt.json"
            path = str(Path(t) / ("bb-smoke-" + str(uuid.uuid4()) + ".utm"))
            r.write_text(json.dumps({"kind": "bigbrain-offline-clone-v1", "base": path, "clone": path}))
            with self.assertRaises(ValueError): owned_clone(r)


class CandidateGuards(unittest.TestCase):
    def test_package_change_and_escaping_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            app = Path(t) / "Candidate.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/Resources/resources/engine").mkdir(parents=True)
            (app / "Contents/MacOS/bigbrain-desktop").write_bytes(b"synthetic executable")
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleShortVersionString": "1"}))
            (app / "Contents/Resources/resources/engine/BUNDLE").write_text("synthetic bundle")
            import hashlib
            lock = Path(t) / "lock.json"
            lock.write_text(json.dumps({"executableSHA256": hashlib.sha256(b"synthetic executable").hexdigest(), "bundle": "synthetic bundle", "version": "1"}))
            candidate(app, lock)
            (app / "Contents/MacOS/bigbrain-desktop").write_bytes(b"changed")
            with self.assertRaises(ValueError): candidate(app, lock)
            (app / "escape").symlink_to(Path(t))
            with self.assertRaises(ValueError): manifest(app)


if __name__ == "__main__":
    unittest.main()
