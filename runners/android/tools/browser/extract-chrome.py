#!/usr/bin/env python3
"""Bounded extraction of a verified CfT ZIP into a new private directory.

No archive path, link or file mode is trusted. Framework symlinks are created
only after regular files, and must resolve to another entry inside the bundle.
"""
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import stat
import sys
import unicodedata
import zipfile

MAX_ENTRIES = 50000
MAX_TOTAL = 2 * 1024 * 1024 * 1024
MAX_FILE = 1024 * 1024 * 1024


def refuse():
    raise ValueError('chrome_archive_unsafe')


def safe_name(name, prefix):
    if not name or any(ord(c) < 32 or ord(c) == 127 for c in name):
        refuse()
    if '\\' in name or ':' in name or name.startswith('/'):
        refuse()
    parts = name.rstrip('/').split('/')
    if any(part in ('', '.', '..') for part in parts) or parts[0] != prefix:
        refuse()
    return '/'.join(parts)


def extract(archive, destination, platform):
    if platform not in ('mac-arm64', 'mac-x64'):
        refuse()
    destination = Path(destination)
    if destination.is_symlink() or not destination.is_dir() or any(destination.iterdir()):
        refuse()
    root = destination.resolve()
    prefix = 'chrome-' + platform
    entries, links, folded = {}, {}, set()
    total = 0
    with zipfile.ZipFile(archive) as source:
        infos = source.infolist()
        if not infos or len(infos) > MAX_ENTRIES:
            refuse()
        for info in infos:
            name = safe_name(info.orig_filename, prefix)
            key = unicodedata.normalize('NFC', name).casefold()
            if key in folded or info.flag_bits & 1 or info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                refuse()
            folded.add(key)
            mode = info.external_attr >> 16
            kind = stat.S_IFMT(mode)
            if info.is_dir():
                if kind not in (0, stat.S_IFDIR) or info.file_size:
                    refuse()
                kind = stat.S_IFDIR
            elif kind not in (0, stat.S_IFREG, stat.S_IFLNK):
                refuse()
            else:
                kind = kind or stat.S_IFREG
            if info.file_size > MAX_FILE:
                refuse()
            total += info.file_size
            if total > MAX_TOTAL:
                refuse()
            entries[name] = (info, kind, mode)
            if kind == stat.S_IFLNK:
                if info.file_size > 4096:
                    refuse()
                target = source.read(info).decode('utf-8')
                if not target or target.startswith('/') or '\\' in target or ':' in target or any(ord(c) < 32 or ord(c) == 127 for c in target):
                    refuse()
                links[name] = target

        # Reject archive writes through links and files masquerading as directories.
        for name in entries:
            for parent in PurePosixPath(name).parents:
                item = entries.get(str(parent))
                if item and item[1] != stat.S_IFDIR:
                    refuse()
        implicit_dirs = {str(parent) for name in entries for parent in PurePosixPath(name).parents}

        def resolve_link(name):
            current, seen = name, set()
            while True:
                if current in seen:
                    refuse()
                seen.add(current)
                parts = current.split('/')
                replaced = False
                for count in range(1, len(parts) + 1):
                    candidate = '/'.join(parts[:count])
                    if candidate in links:
                        current = posixpath.normpath(posixpath.join(posixpath.dirname(candidate), links[candidate], *parts[count:]))
                        if not current.startswith(prefix + '/'):
                            refuse()
                        replaced = True
                        break
                if not replaced:
                    if current not in entries and current not in implicit_dirs:
                        refuse()
                    return current
                if len(seen) > len(links) + 1:
                    refuse()

        for name in links:
            resolve_link(name)

        actual_total = 0
        for name, (info, kind, mode) in entries.items():
            target = root.joinpath(*name.split('/'))
            if kind == stat.S_IFLNK:
                continue
            if kind == stat.S_IFDIR:
                target.mkdir(parents=True, exist_ok=True, mode=0o755)
                continue
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            descriptor = os.open(target, flags, 0o600)
            count = 0
            with os.fdopen(descriptor, 'wb') as output, source.open(info) as data:
                while True:
                    block = data.read(1024 * 1024)
                    if not block:
                        break
                    count += len(block)
                    actual_total += len(block)
                    if count > info.file_size or count > MAX_FILE or actual_total > MAX_TOTAL:
                        refuse()
                    output.write(block)
            if count != info.file_size:
                refuse()
            target.chmod(0o755 if mode & 0o111 else 0o644)
        # Nothing writes through these links after this point.
        for name, target in links.items():
            link = root.joinpath(*name.split('/'))
            link.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            os.symlink(target, link)
        for name in links:
            link = root.joinpath(*name.split('/'))
            if not link.resolve(strict=True).is_relative_to(root):
                refuse()
    return {'files': len(entries), 'uncompressedBytes': total, 'symlinks': len(links)}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            refuse()
        print(json.dumps(extract(*sys.argv[1:])))
    except Exception:
        print('chrome_archive_unsafe', file=sys.stderr)
        sys.exit(1)
