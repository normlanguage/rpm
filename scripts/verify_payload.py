import hashlib
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inventory_tar(archive):
    entries = {}
    root_mode = None
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle:
            name = member.name.rstrip("/")
            parts = PurePosixPath(name).parts
            if not parts or parts[0] != "norm" or ".." in parts:
                raise ValueError(f"Unexpected release archive path: {member.name}")
            if name == "norm":
                if not member.isdir() or root_mode is not None:
                    raise ValueError("Invalid release archive root")
                root_mode = member.mode & 0o7777
                continue
            relative = PurePosixPath(*parts[1:]).as_posix()
            if relative in entries:
                raise ValueError(f"Duplicate release archive path: {relative}")
            if member.isdir():
                value = {"type": "directory", "mode": member.mode & 0o7777}
            elif member.issym():
                value = {"type": "symlink", "mode": member.mode & 0o7777, "target": member.linkname}
            elif member.isfile():
                digest = hashlib.sha256()
                with bundle.extractfile(member) as source:
                    for block in iter(lambda: source.read(1024 * 1024), b""):
                        digest.update(block)
                value = {"type": "file", "mode": member.mode & 0o7777, "sha256": digest.hexdigest()}
            else:
                raise ValueError(f"Unsupported release archive entry: {relative}")
            entries[relative] = value
    if root_mode is None or not entries:
        raise ValueError("Invalid release archive payload")
    return {"rootMode": root_mode, "entries": entries}


def inventory_tree(root):
    entries = {}
    for path in root.rglob("*"):
        mode = path.lstat().st_mode
        value = {"mode": stat.S_IMODE(mode)}
        if stat.S_ISDIR(mode):
            value["type"] = "directory"
        elif stat.S_ISLNK(mode):
            value.update(type="symlink", target=os.readlink(path))
        elif stat.S_ISREG(mode):
            value.update(type="file", sha256=sha256_file(path))
        else:
            raise ValueError(f"Unsupported RPM entry: {path}")
        entries[path.relative_to(root).as_posix()] = value
    return entries


def extract_rpm(package, destination):
    result = subprocess.run(
        ["bash", "-o", "pipefail", "-c", 'umask 000; rpm2cpio "$1" | cpio -idm --quiet', "bash", str(package)],
        cwd=destination,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return destination


def compare_payload(source, extracted):
    actual = inventory_tree(extracted)
    private = "usr/lib/normlang"
    source_entries = source["entries"]
    private_actual = {name.removeprefix(private + "/"): value for name, value in actual.items() if name.startswith(private + "/")}
    differences = {
        name: {"source": source_entries.get(name), "rpm": private_actual.get(name)}
        for name in sorted(source_entries.keys() | private_actual.keys())
        if source_entries.get(name) != private_actual.get(name)
    }
    wrapper = b'#!/bin/sh\nexec /usr/lib/normlang/bin/norm "$@"\n'
    expected_outer = {
        private: {"type": "directory", "mode": source["rootMode"]},
        "usr/bin/norm": {"type": "file", "mode": 0o755, "sha256": hashlib.sha256(wrapper).hexdigest()},
    }
    implicit_parents = {"usr", "usr/bin", "usr/lib"}
    allowed = set(expected_outer) | implicit_parents | {f"{private}/{name}" for name in source_entries}
    outer_differences = {
        name: {"expected": expected_outer.get(name), "rpm": actual.get(name)}
        for name in sorted((set(actual) - allowed) | {name for name, expected in expected_outer.items() if actual.get(name) != expected})
    }
    for name in implicit_parents:
        if actual.get(name, {}).get("type") != "directory":
            outer_differences[name] = {"expected": {"type": "directory"}, "rpm": actual.get(name)}
    return {
        "sourcePathCount": len(source_entries),
        "rpmPathCount": len(private_actual),
        "source": dict(sorted(source_entries.items())),
        "differences": differences,
        "outerDifferences": outer_differences,
    }


def require_exact_payload(report):
    if report["differences"] or report["outerDifferences"] or report.get("ownedDifferences"):
        raise ValueError(f"RPM payload differs from verified release archive: {len(report['differences'])} private paths, {len(report['outerDifferences'])} outer paths, {len(report.get('ownedDifferences', {}))} owned paths")


def verify_payload(archive, package, output):
    archive = Path(archive).resolve()
    package = Path(package).resolve()
    output = Path(output).resolve()
    source = inventory_tar(archive)
    with tempfile.TemporaryDirectory(prefix="norm-rpm-payload-") as directory:
        report = compare_payload(source, extract_rpm(package, Path(directory)))
    owned = subprocess.run(["rpm", "-qpl", str(package)], capture_output=True, text=True)
    if owned.returncode:
        raise RuntimeError(owned.stderr)
    owned_paths = owned.stdout.splitlines()
    expected_owned = {"/usr/bin/norm", "/usr/lib/normlang"} | {f"/usr/lib/normlang/{name}" for name in source["entries"]}
    actual_owned = set(owned_paths)
    report["ownedDifferences"] = {
        name: {"expected": name in expected_owned, "rpm": name in actual_owned}
        for name in sorted(expected_owned ^ actual_owned)
    }
    if len(owned_paths) != len(actual_owned):
        report["ownedDifferences"]["duplicate entries"] = {"expected": len(actual_owned), "rpm": len(owned_paths)}
    report = {
        "archive": archive.name,
        "archiveSha256": sha256_file(archive),
        "rpm": package.name,
        "rpmSha256": sha256_file(package),
        **report,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
    require_exact_payload(report)
    return report


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("Usage: verify_payload.py <release-tar.gz> <signed-rpm> <report.json>")
    result = verify_payload(*sys.argv[1:])
    print(json.dumps({key: result[key] for key in ("archiveSha256", "rpmSha256", "sourcePathCount", "rpmPathCount")}))
