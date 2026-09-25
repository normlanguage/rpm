import hashlib
import json
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

from verify_payload import compare_payload, extract_rpm, inventory_tar, require_exact_payload, verify_payload


fedora44 = os.name == "posix" and Path("/etc/os-release").exists() and {"ID=fedora", "VERSION_ID=44"}.issubset(set(Path("/etc/os-release").read_text().splitlines()))


@unittest.skipUnless(fedora44, "Fedora 44 integration test")
class PayloadVerificationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix="norm-rpm-payload-test-")
        cls.root = Path(cls.workspace.name)
        source = cls.root / "source" / "norm"
        (source / "bin").mkdir(parents=True)
        (source / "runtime" / "bin").mkdir(parents=True)
        (source / "lib").mkdir()
        (source / "bin" / "norm").write_text('#!/bin/sh\nprintf "norm 1.2.3\\n"\n')
        (source / "bin" / "norm").chmod(0o755)
        private_c = cls.root / "private.c"
        private_c.write_text("int norm_private(void) { return 1; }\n")
        subprocess.run(["cc", "-shared", "-fPIC", "-Wl,-soname,libnormprivate.so", "-o", str(source / "runtime" / "bin" / "libnormprivate.so"), str(private_c)], check=True)
        java_c = cls.root / "java.c"
        java_c.write_text("int norm_private(void); int main(void) { return norm_private() == 1 ? 0 : 1; }\n")
        subprocess.run(["cc", "-o", str(source / "runtime" / "bin" / "java"), str(java_c), "-L" + str(source / "runtime" / "bin"), "-lnormprivate", "-Wl,-rpath,$ORIGIN"], check=True)
        (source / "lib" / "compiler.jar").write_bytes(b"jar")
        (source / "lib" / "compiler-link.jar").symlink_to("compiler.jar")
        (source / "lib").chmod(0o2775)
        cls.source = source
        assets = cls.root / "assets"
        assets.mkdir()
        cls.archive = assets / "norm-v1.2.3-linux-x64.tar.gz"
        with tarfile.open(cls.archive, "w:gz") as bundle:
            bundle.add(source, arcname="norm")
        digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()
        (assets / "SHA256SUMS").write_text(f"{digest}  {cls.archive.name}\n")
        script = Path(__file__).resolve().parents[1] / "norm-tooling" / "cli/compiler/scripts/rpm-repository.mjs"
        result = subprocess.run(["node", str(script), "package", "1.2.3", str(assets), str(cls.root / "packages")], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        cls.package = Path(result.stdout.strip())

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def test_real_rpm_preserves_the_complete_private_tree(self):
        output = self.root / "valid.json"
        try:
            report = verify_payload(self.archive, self.package, output)
        except ValueError:
            self.fail(json.dumps(json.loads(output.read_text())["outerDifferences"], sort_keys=True))
        self.assertEqual(report["differences"], {})
        self.assertEqual(report["outerDifferences"], {})
        self.assertEqual(report["ownedDifferences"], {})
        self.assertEqual(report["sourcePathCount"], report["rpmPathCount"])
        self.assertEqual(report["source"]["lib"]["mode"], 0o2775)

    def test_rejects_an_unlisted_rpm_path(self):
        with tempfile.TemporaryDirectory() as directory:
            extracted = extract_rpm(self.package, Path(directory))
            extra = extracted / "etc" / "unexpected"
            extra.parent.mkdir()
            extra.write_text("unexpected")
            report = compare_payload(inventory_tar(self.archive), extracted)
            self.assertIn("etc/unexpected", report["outerDifferences"])
            with self.assertRaises(ValueError):
                require_exact_payload(report)

    def test_production_entry_rejects_different_release_bytes_and_keeps_report(self):
        with tempfile.TemporaryDirectory() as directory:
            altered = Path(directory) / "norm"
            shutil.copytree(self.source, altered, symlinks=True)
            (altered / "lib" / "compiler.jar").write_bytes(b"different")
            archive = Path(directory) / "different.tar.gz"
            with tarfile.open(archive, "w:gz") as bundle:
                bundle.add(altered, arcname="norm")
            output = Path(directory) / "rejection.json"
            with self.assertRaises(ValueError):
                verify_payload(archive, self.package, output)
            self.assertIn("lib/compiler.jar", json.loads(output.read_text())["differences"])

    def test_rejects_wrapper_content_and_mode_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            extracted = extract_rpm(self.package, Path(directory))
            wrapper = extracted / "usr/bin/norm"
            wrapper.write_text("#!/bin/sh\nexit 1\n")
            wrapper.chmod(0o700)
            report = compare_payload(inventory_tar(self.archive), extracted)
            self.assertIn("usr/bin/norm", report["outerDifferences"])
            with self.assertRaises(ValueError):
                require_exact_payload(report)

    def test_rejects_special_mode_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            extracted = extract_rpm(self.package, Path(directory))
            (extracted / "usr/lib/normlang/lib").chmod(0o775)
            report = compare_payload(inventory_tar(self.archive), extracted)
            self.assertIn("lib", report["differences"])
            with self.assertRaises(ValueError):
                require_exact_payload(report)


if __name__ == "__main__":
    unittest.main()
