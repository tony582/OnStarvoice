#!/usr/bin/env python3
"""Read-only input audit; writes metadata only to a new output directory.

No build, browser, server, network, archive extraction, or source edits.
Requires Python 3.10+ standard library and a local git repository.
"""

import argparse
import difflib
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def read_tree(root):
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Symlink requires separate review: {path}")
        if path.is_file():
            result[path.relative_to(root).as_posix()] = path.read_bytes()
    return result


def read_commit(repo, revision):
    sha = git(repo, "rev-parse", "--verify", revision + "^{commit}").decode().strip()
    paths = git(repo, "ls-tree", "-r", "--name-only", "-z", sha).decode().split("\0")
    # Mirrors the production copy allowlist without running either build script.
    paths = [p for p in paths if p in {
        "manifest.json", "background.js", "content-loader.js", "content-v2.js"
    } or p.startswith(("images/", "sidebar/", "utils/"))]
    paths = [p for p in paths if Path(p).name != ".DS_Store"]
    result = {p: git(repo, "show", f"{sha}:{p}") for p in sorted(paths)}
    return sha, result


def inventory(files):
    rows = [{"path": p, "bytes": len(data), "sha256": digest(data)}
            for p, data in sorted(files.items())]
    # Canonical UTF-8 JSON array; no indentation, spaces, or trailing newline.
    encoded = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()
    return {"files": rows, "file_count": len(rows),
            "total_bytes": sum(r["bytes"] for r in rows),
            "inventory_sha256": digest(encoded)}


def compare(left, right):
    return [{"path": p,
             "status": "only_left" if p not in right else "only_right" if p not in left
             else "identical" if left[p] == right[p] else "different",
             "left_sha256": digest(left[p]) if p in left else None,
             "right_sha256": digest(right[p]) if p in right else None}
            for p in sorted(set(left) | set(right))]


def summary(rows):
    return {status: sum(r["status"] == status for r in rows)
            for status in ("identical", "different", "only_left", "only_right")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--base", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--snapshot", type=Path, required=True)
    parser.add_argument("--original-snapshot", type=Path, required=True)
    parser.add_argument("--media-package", type=Path, required=True)
    parser.add_argument("--original-media-package", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    for source in (args.snapshot, args.original_snapshot):
        if output.is_relative_to(source.resolve()):
            parser.error("Output cannot be inside either input snapshot.")
    if args.output.exists():
        parser.error("Output must be a new directory; existing evidence is never overwritten.")

    snapshot = read_tree(args.snapshot)
    if snapshot != read_tree(args.original_snapshot):
        raise ValueError("Delivery evidence copy differs from original")
    raw_package = args.media_package.read_bytes()
    if raw_package != args.original_media_package.read_bytes():
        raise ValueError("MediaClaw evidence copy differs from original")
    with zipfile.ZipFile(io.BytesIO(raw_package)) as archive:
        entries = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len({entry.filename for entry in entries}) != len(entries):
            raise ValueError("Duplicate archive paths require separate review")
        media = {entry.filename: archive.read(entry) for entry in entries}
    base_sha, base = read_commit(args.repo, args.base)
    candidate_sha, candidate = read_commit(args.repo, args.candidate)
    base_parity = compare(base, snapshot)
    candidate_parity = compare(candidate, snapshot)
    media_parity = compare(media, snapshot)

    similarities = []
    for path in sorted(set(media) & set(snapshot)):
        if not path.endswith(".js"):
            continue
        left = media[path].decode("utf-8", errors="replace").splitlines()
        right = snapshot[path].decode("utf-8", errors="replace").splitlines()
        matcher = difflib.SequenceMatcher(None, left, right, autojunk=False)
        matched = sum(block.size for block in matcher.get_matching_blocks())
        denominator = len(left) + len(right)
        similarities.append({"path": path, "media_lines": len(left),
                             "starvoice_lines": len(right), "matched_lines": matched,
                             "ratio": 2 * matched / denominator if denominator else 1,
                             "byte_identical": media[path] == snapshot[path]})
    similarities.sort(key=lambda row: (-row["ratio"], row["path"]))
    brand_findings = []
    pattern = re.compile(r"media[ _-]?claw|社媒虾", re.I)
    for path, data in sorted(snapshot.items()):
        if Path(path).suffix not in {".js", ".json", ".html", ".css", ".md", ".txt", ".svg"}:
            continue
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            matches = sorted(set(m.group(0) for m in pattern.finditer(line)))
            if matches:
                brand_findings.append({"path": path, "line": number, "terms": matches})

    report = {
        "schema_version": 1,
        "evidence_scope": "Local files and git objects only; no production or browser verification",
        "method": {
            "inventory": "SHA-256 of sorted UTF-8 JSON rows (path, bytes, sha256), compact separators, no trailing newline",
            "similarity": "Same-path JS only; difflib.SequenceMatcher on splitlines(), autojunk=False; 2*matched/(left+right)",
            "limitations": ["Not a whole-product or legal similarity score", "No fuzzy comparison across renamed paths",
                            "No image perceptual comparison or source ownership conclusion",
                            "Git source projection is not execution of the build or proof of production deployment"]},
        "base_commit": base_sha, "candidate_commit": candidate_sha,
        "media_package_sha256": digest(raw_package), "media_package_bytes": len(raw_package),
        "manifests": {label: {k: json.loads(files["manifest.json"])[k]
                              for k in ("name", "version", "description")}
                      for label, files in (("base", base), ("candidate", candidate),
                                           ("snapshot", snapshot), ("media", media))},
        "inventories": {label: inventory(files) for label, files in (
            ("base", base), ("candidate", candidate), ("snapshot", snapshot), ("media", media))},
        "base_to_snapshot": {"summary": summary(base_parity), "files": base_parity},
        "candidate_to_snapshot": {"summary": summary(candidate_parity), "files": candidate_parity},
        "media_to_snapshot": {"summary": summary(media_parity), "files": media_parity},
        "same_path_js_similarity": similarities,
        "brand_findings": brand_findings,
        "original_copy_equal_before_and_after": False,
    }
    # Detect concurrent changes before accepting the evidence.
    if snapshot != read_tree(args.original_snapshot) or raw_package != args.original_media_package.read_bytes():
        raise ValueError("Original inputs changed during the audit; no report written")
    report["original_copy_equal_before_and_after"] = True
    args.output.mkdir(parents=True, exist_ok=False)
    with (args.output / "snapshot-audit.json").open("x", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    with (args.output / "similarity.tsv").open("x", encoding="utf-8") as handle:
        handle.write("path\tmedia_lines\tstarvoice_lines\tmatched_lines\tratio\tbyte_identical\n")
        for row in similarities:
            handle.write(f"{row['path']}\t{row['media_lines']}\t{row['starvoice_lines']}\t"
                         f"{row['matched_lines']}\t{row['ratio']:.8f}\t{row['byte_identical']}\n")
    print(json.dumps({"base": base_sha, "candidate": candidate_sha,
                      "base_parity": summary(base_parity), "candidate_parity": summary(candidate_parity),
                      "snapshot": inventory(snapshot)["inventory_sha256"],
                      "same_path_js": len(similarities),
                      "identical_js": sum(row["byte_identical"] for row in similarities),
                      "brand_findings": brand_findings,
                      "report_sha256": digest((args.output / "snapshot-audit.json").read_bytes())}, ensure_ascii=False))


if __name__ == "__main__":
    main()
