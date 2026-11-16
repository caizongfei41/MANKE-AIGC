import json, os, sys, shutil

def extract(asar_path, out_dir, unpacked_dir=None):
    data = open(asar_path, 'rb').read()
    idx = data.find(b'{"files"')
    if idx < 0:
        raise SystemExit('asar header not found')
    text = data[idx:].decode('utf-8', errors='ignore')
    dec = json.JSONDecoder()
    obj, end = dec.raw_decode(text)
    data_start = idx + end + 2
    os.makedirs(out_dir, exist_ok=True)

    def walk(node, rel):
        for name, info in (node.get('files') or {}).items():
            child_rel = os.path.join(rel, name)
            out_path = os.path.join(out_dir, child_rel)
            if info.get('files') is not None:
                os.makedirs(out_path, exist_ok=True)
                walk(info, child_rel)
            elif info.get('unpacked'):
                src = os.path.join(unpacked_dir or '', child_rel)
                if os.path.isfile(src):
                    os.makedirs(os.path.dirname(out_path), exist_ok=True)
                    shutil.copy2(src, out_path)
                else:
                    print('missing unpacked:', child_rel)
            else:
                off = int(info.get('offset', 0))
                size = int(info.get('size', 0))
                os.makedirs(os.path.dirname(out_path), exist_ok=True)
                with open(out_path, 'wb') as f:
                    f.write(data[data_start + off: data_start + off + size])

    walk(obj, '')
    print('extracted to', out_dir)

if __name__ == '__main__':
    if len(sys.argv) < 4:
        print('usage: extract_asar.py APP.ASAR OUT_DIR UNPACKED_DIR')
        raise SystemExit(1)
    extract(sys.argv[1], sys.argv[2], sys.argv[3])
