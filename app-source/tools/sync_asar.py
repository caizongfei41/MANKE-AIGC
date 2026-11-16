#!/usr/bin/env python3
"""In-place asar bundle sync.

Keeps the asar header length and packed data offsets unchanged.
Suitable for edits that do not increase the header JSON beyond its original
capacity (normal CSS/JS/HTML edits with same digit-count sizes).

Usage: python sync_asar.py <runtime_root>
"""
import argparse, hashlib, json, os, struct, sys

def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()

def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def block_hashes(data, bs):
    if bs <= 0:
        bs = 4 * 1024 * 1024
    return [sha_bytes(data[i:i + bs]) for i in range(0, len(data), bs)] or [sha_bytes(b'')]

def walk_entries(node, prefix=''):
    out = {}
    for name, info in (node.get('files') or {}).items():
        p = prefix + name
        if info.get('files') is not None:
            out.update(walk_entries(info, p + '/'))
        else:
            out[p] = info
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('runtime')
    args = ap.parse_args()
    rt = os.path.abspath(args.runtime)
    asar = os.path.join(rt, 'resources', 'app.asar')
    bundle = os.path.join(rt, 'resources', 'app.asar.unpacked', 'bundle')
    exe = os.path.join(rt, 'Manke.exe')

    raw = bytearray(open(asar, 'rb').read())
    idx = bytes(raw).find(b'{"files"')
    if idx < 0:
        raise SystemExit('asar header not found')
    old_len = struct.unpack('<I', bytes(raw[12:16]))[0]
    header = json.loads(bytes(raw[idx:idx + old_len]).decode('utf-8'))
    data_start = idx + old_len + 2
    entries = walk_entries(header)

    # regenerate integrity map, update unpacked entries
    files_map = {}
    total = 0
    for root, dirs, fs in os.walk(bundle):
        for name in fs:
            apath = os.path.join(root, name)
            rel = os.path.relpath(apath, bundle).replace('\\', '/')
            h = sha_file(apath)
            files_map[rel] = h
            total += os.path.getsize(apath)
            ent = entries.get('bundle/' + rel)
            if ent is not None:
                ent['size'] = os.path.getsize(apath)
                integ = ent.get('integrity') or {}
                if integ.get('hash') != h:
                    bs = int(integ.get('blockSize') or (4 * 1024 * 1024))
                    data = open(apath, 'rb').read()
                    integ.update({'algorithm': 'SHA256', 'hash': h, 'blockSize': bs, 'blocks': block_hashes(data, bs)})
                    ent['integrity'] = integ

    bi_obj = {'version': 1, 'algorithm': 'sha256', 'fileCount': len(files_map), 'totalBytes': total, 'files': files_map}
    bi_new = json.dumps(bi_obj, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    bi_ent = entries.get('bundle-integrity.json')
    if bi_ent is None:
        raise SystemExit('bundle-integrity.json entry missing')
    bi_size = int(bi_ent['size'])
    if len(bi_new) > bi_size:
        raise SystemExit(f'bundle-integrity too big: {len(bi_new)} > {bi_size}')
    bi_padded = bi_new + b' ' * (bi_size - len(bi_new))
    bi_off = int(bi_ent['offset'])
    raw[data_start + bi_off:data_start + bi_off + bi_size] = bi_padded
    bi_hash = sha_bytes(bi_padded)
    integ = bi_ent.get('integrity') or {}
    bs = int(integ.get('blockSize') or (4 * 1024 * 1024))
    integ.update({'algorithm': 'SHA256', 'hash': bi_hash, 'blockSize': bs, 'blocks': block_hashes(bi_padded, bs)})
    bi_ent['integrity'] = integ

    header_new = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if len(header_new) > old_len:
        raise SystemExit(f'header too big: {len(header_new)} > {old_len}; keep file size digit counts or rebuild asar')
    header_padded = header_new + b' ' * (old_len - len(header_new))
    raw[idx:idx + old_len] = header_padded

    open(asar, 'wb').write(raw)
    header_hash = sha_bytes(header_padded)
    ed = bytearray(open(exe, 'rb').read())
    marker = b'"resources\\\\app.asar","alg":"SHA256","value":"'
    p = bytes(ed).find(marker)
    if p >= 0:
        ed[p + len(marker):p + len(marker) + 64] = header_hash.encode('ascii')
        open(exe, 'wb').write(ed)
    print('patched', len(files_map), 'files; header', header_hash[:16], '; header used', len(header_new), '/', old_len)

if __name__ == '__main__':
    main()
