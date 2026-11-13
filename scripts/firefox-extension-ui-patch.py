#!/usr/bin/env python3
"""Patch only verified upstream Juggler actors in standard/optimized Gecko jars.

Preserves every untouched entry's local record and compressed bytes. Rewrites the
ZIP directory as a standard ZIP (also supported by Gecko). No extraction or code
execution occurs. This build-time tool fails closed on unrecognized source.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import struct
import sys
import tempfile
import zlib

PATCH_ID = 'gamebrowser-firefox-extension-ui-v1'
SOURCE_COMMIT = '7eeccbdf0b2c7562dce9d11175c35667b9025a7f'
EXPECTED = {
    'JugglerFrameChild.sys.mjs': ('0a16ab241b3f2373e2b1a6a703ad7e9ce573651752e5fc95e2ce00c8086d9dc3', '215a1dea5ab9e0fb99b1d6857745bebc53993fd2039b56b24900ac6a532d3088'),
}
GUARD = b"    if (this.document.documentURI.startsWith('moz-extension://'))\n      return;\n\n"
REPLACEMENT = b'    // GameBrowser: allow the existing Juggler actor to bind installed extension pages.\n    // Package identity and entrypoints remain checked by the local browser bridge.\n\n'
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_MODULE = 1024 * 1024

def sha(data):
    return hashlib.sha256(data).hexdigest()

def require(condition, message):
    if not condition:
        raise ValueError(message)

def u16(data, offset):
    return struct.unpack_from('<H', data, offset)[0]

def u32(data, offset):
    return struct.unpack_from('<I', data, offset)[0]

def parse(data):
    require(22 <= len(data) <= MAX_ARCHIVE, 'archive size is unsupported')
    end = -1
    for pos in range(len(data) - 22, max(-1, len(data) - 22 - 65535 - 1), -1):
        if data[pos:pos+4] == b'PK\x05\x06' and pos + 22 + u16(data, pos+20) == len(data):
            end = pos
            break
    require(end >= 0, 'archive end record missing')
    count, size, start = u16(data, end+10), u32(data, end+12), u32(data, end+16)
    require(not u16(data, end+4) and not u16(data, end+6) and u16(data, end+8) == count and 0 < count < 65535, 'multi-disk/ZIP64 archive is unsupported')
    require(size != 0xffffffff and start != 0xffffffff and start + size <= end, 'invalid directory bounds')
    optimized = start == 4 and data[4:8] == b'PK\x01\x02'
    require(start + size == end or (optimized and data[start+size:start+size+22] == data[end:end+22]), 'unknown archive layout')
    position, entries, names, spans = start, [], set(), []
    first_data = start + size + 22 + u16(data, end+20) if optimized else 0
    for _ in range(count):
        require(position + 46 <= start + size and data[position:position+4] == b'PK\x01\x02', 'invalid directory entry')
        length, extra, comment = u16(data, position+28), u16(data, position+30), u16(data, position+32)
        next_pos = position + 46 + length + extra + comment
        require(next_pos <= start + size, 'truncated directory entry')
        flags, method = u16(data, position+8), u16(data, position+10)
        crc, compressed, expanded = u32(data, position+16), u32(data, position+20), u32(data, position+24)
        offset = u32(data, position+42)
        require(not flags & 1 and method in (0, 8) and not u16(data, position+34) and max(compressed, expanded, offset) != 0xffffffff, 'unsupported archive encoding')
        require((u32(data, position+38) >> 16 & 0o170000) != stat.S_IFLNK, 'archive contains symbolic links')
        name_raw = data[position+46:position+46+length]
        name = name_raw.decode('utf-8')
        require(name and not name.startswith('/') and '\\' not in name and ':' not in name and '\0' not in name and all(part not in ('.', '..') for part in name.rstrip('/').split('/')), 'unsafe archive name')
        require(name.casefold() not in names, 'duplicate archive entry')
        names.add(name.casefold())
        require(offset + 30 <= len(data) and data[offset:offset+4] == b'PK\x03\x04', 'missing local entry')
        require(u16(data, offset+6) == flags and u16(data, offset+8) == method, 'entry encoding mismatch')
        local_length, local_extra = u16(data, offset+26), u16(data, offset+28)
        payload = offset + 30 + local_length + local_extra
        finish = payload + compressed
        require(local_length == length and data[offset+30:offset+30+length] == name_raw, 'entry filename mismatch')
        require(finish <= (end if optimized else start) and offset >= first_data, 'local entry bounds mismatch')
        if flags & 8:
            descriptor = finish + (4 if data[finish:finish+4] == b'PK\x07\x08' else 0)
            require(descriptor + 12 <= (end if optimized else start) and struct.unpack_from('<III', data, descriptor) == (crc, compressed, expanded), 'invalid data descriptor')
            finish = descriptor + 12
        else:
            require((u32(data, offset+14), u32(data, offset+18), u32(data, offset+22)) == (crc, compressed, expanded), 'local size/CRC mismatch')
        spans.append((offset, finish))
        entries.append({'name': name, 'central': data[position:next_pos], 'local': data[offset:finish], 'payload': data[payload:payload+compressed], 'flags': flags, 'method': method, 'size': expanded, 'crc': crc, 'offset': offset})
        position = next_pos
    require(position == start + size, 'directory length mismatch')
    ordered = sorted(spans)
    require(all(left[1] <= right[0] for left, right in zip(ordered, ordered[1:])), 'overlapping local entries')
    return entries, data[end+22:]

def contents(entry):
    require(entry['size'] <= MAX_MODULE, 'actor module exceeds its limit')
    if entry['method'] == 0:
        result = entry['payload']
    else:
        decoder = zlib.decompressobj(-15)
        result = decoder.decompress(entry['payload'], MAX_MODULE + 1)
        require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail, 'invalid compressed actor')
    require(len(result) == entry['size'] and zlib.crc32(result) & 0xffffffff == entry['crc'], 'actor size/CRC mismatch')
    return result

def rebuild(entries, replacements, comment):
    local, central, offset = [], [], 0
    for entry in sorted(entries, key=lambda value: value['offset']):
        record = entry['local']
        directory = bytearray(entry['central'])
        if entry['name'] in replacements:
            value = replacements[entry['name']]
            compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
            encoded = compressor.compress(value) + compressor.flush() if entry['method'] == 8 else value
            crc = zlib.crc32(value) & 0xffffffff
            header_size = 30 + u16(record, 26) + u16(record, 28)
            header = bytearray(record[:header_size])
            flags = entry['flags'] & ~8
            struct.pack_into('<H', header, 6, flags)
            struct.pack_into('<III', header, 14, crc, len(encoded), len(value))
            struct.pack_into('<H', directory, 8, flags)
            struct.pack_into('<III', directory, 16, crc, len(encoded), len(value))
            record = bytes(header) + encoded
        struct.pack_into('<I', directory, 42, offset)
        local.append(record)
        central.append(bytes(directory))
        offset += len(record)
    directory_bytes = b''.join(central)
    end = struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, len(entries), len(entries), len(directory_bytes), offset, len(comment))
    result = b''.join(local) + directory_bytes + end + comment
    require(len(result) <= MAX_ARCHIVE, 'patched archive exceeds its limit')
    return result

def patch(root, original_sources):
    root, original_sources = Path(root), Path(original_sources)
    require(root.is_dir() and not root.is_symlink(), 'engine root is not a regular directory')
    replacements = {}
    for name, (before, after) in EXPECTED.items():
        source = (original_sources / name).read_bytes()
        require(sha(source) == before and source.count(GUARD) == 1, 'checked-in actor source differs from pinned upstream')
        modified = source.replace(GUARD, REPLACEMENT)
        require(sha(modified) == after, 'actor patch output hash mismatch')
        replacements[name] = modified
    plans, found = [], set()
    for directory, directories, files in os.walk(root, followlinks=False):
        require(not any((Path(directory)/name).is_symlink() for name in directories + files), 'engine contains symbolic links')
        for filename in sorted(files):
            if filename not in ('omni.ja', 'juggler.jar'):
                continue
            archive = Path(directory) / filename
            require(archive.stat().st_size <= MAX_ARCHIVE, 'archive exceeds its limit')
            before = archive.read_bytes()
            entries, comment = parse(before)
            changed, modules = {}, []
            for entry in entries:
                basename = entry['name'].rsplit('/', 1)[-1]
                if basename not in EXPECTED:
                    continue
                expected_path = 'modules/juggler/' + basename
                require(filename == 'omni.ja', 'actor archive path is unexpected')
                require(entry['name'] == expected_path and basename not in found, 'actor path is unexpected or ambiguous')
                original = contents(entry)
                require(sha(original) == EXPECTED[basename][0], 'actor module does not match pinned upstream source')
                found.add(basename)
                changed[entry['name']] = replacements[basename]
                modules.append({'path': entry['name'], 'beforeSha256': sha(original), 'afterSha256': sha(changed[entry['name']])})
            if changed:
                after = rebuild(entries, changed, comment)
                verified, _ = parse(after)
                by_name = {entry['name']: entry for entry in verified}
                for entry in entries:
                    updated = by_name[entry['name']]
                    if entry['name'] in changed:
                        require(contents(updated) == changed[entry['name']], 'patched actor verification failed')
                    else:
                        require(updated['local'] == entry['local'] and updated['payload'] == entry['payload'], 'untouched archive entry changed')
                plans.append((archive, before, after, {'path': archive.relative_to(root).as_posix(), 'beforeSha256': sha(before), 'afterSha256': sha(after), 'modules': modules}))
    require(found == set(EXPECTED), 'the pinned actor module must be present exactly once')
    # Complete every validation before modifying any archive. Temporary originals
    # exist only for rollback; none are shipped as duplicate runtime resources.
    staged, replaced = [], []
    try:
        for archive, before, after, metadata in plans:
            require(archive.read_bytes() == before, 'archive changed before replacement')
            handle, temporary = tempfile.mkstemp(prefix='.stakemode-actor-', suffix='.tmp', dir=archive.parent)
            with os.fdopen(handle, 'wb') as output:
                output.write(after)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, stat.S_IMODE(archive.stat().st_mode))
            staged.append((archive, Path(temporary), before, metadata))
        for archive, temporary, before, metadata in staged:
            os.replace(temporary, archive)
            replaced.append((archive, before))
            require(sha(archive.read_bytes()) == metadata['afterSha256'], 'replaced archive hash mismatch')
    except BaseException:
        for archive, before in reversed(replaced):
            archive.write_bytes(before)
        raise
    finally:
        for _, temporary, _, _ in staged:
            temporary.unlink(missing_ok=True)
    return {'patchId': PATCH_ID, 'sourceRepository': 'https://github.com/aliasmode/aliasmode-firefox', 'sourceCommit': SOURCE_COMMIT, 'archives': [plan[3] for plan in plans]}

if __name__ == '__main__':
    try:
        require(len(sys.argv) == 3, 'expected engine directory and pinned source directory')
        print(json.dumps(patch(sys.argv[1], sys.argv[2]), separators=(',', ':')))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
