#!/usr/bin/env python3
"""Verify asar header hash, exe manifest and bundle-integrity.json."""
import hashlib, json, os, struct, sys

def sha(b): return hashlib.sha256(b).hexdigest()

def main():
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(__file__)))
    rt = os.path.join(root, 'runtime')
    asar = os.path.join(rt, 'resources', 'app.asar')
    exe = os.path.join(rt, 'Manke.exe')
    bundle = os.path.join(rt, 'resources', 'app.asar.unpacked', 'bundle')
    data = open(asar, 'rb').read()
    idx = data.find(b'{"files"')
    L = struct.unpack('<I', data[12:16])[0]
    header = json.loads(data[idx:idx + L].decode('utf-8'))
    header_hash = sha(data[idx:idx + L])
    ed = open(exe, 'rb').read()
    marker = b'"resources\\\\app.asar","alg":"SHA256","value":"'
    p = ed.find(marker)
    manifest = ed[p + len(marker):p + len(marker) + 64].decode('ascii') if p >= 0 else ''
    print('header   ', header_hash[:16], 'manifest', manifest[:16], 'ok=', header_hash == manifest)

    # locate packed bundle-integrity.json
    def walk(node, prefix=''):
        for name, info in (node.get('files') or {}).items():
            pth = prefix + name
            if info.get('files') is not None:
                yield from walk(info, pth + '/')
            else:
                yield pth, info
    ent = dict(walk(header))['bundle-integrity.json']
    off = idx + L + 2 + int(ent['offset'])
    bi = data[off:off + int(ent['size'])].rstrip(b' ')
    obj = json.loads(bi.decode('utf-8'))
    print('integrity', obj.get('fileCount'), 'files', obj.get('totalBytes'), 'bytes')
    bad = 0
    for rel, expected in obj.get('files', {}).items():
        path = os.path.join(bundle, rel.replace('/', os.sep))
        if not os.path.isfile(path):
            print('MISSING', rel); bad += 1; continue
        h = sha(open(path, 'rb').read())
        if h != expected:
            print('BAD', rel); bad += 1
    print('bundle mismatches:', bad)
    raise SystemExit(0 if header_hash == manifest and bad == 0 else 1)

if __name__ == '__main__':
    main()
