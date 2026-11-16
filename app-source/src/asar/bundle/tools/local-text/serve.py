# ============================================================
# 本地小文本模型 后端 (2026-09-25)
#
# 用户口径: "能不能引入小一点的文本模型呢，另外完全摒弃掉API优化提示词的路子"。
#   → 这个进程就是"不用 API 的文本模型": 纯 CPU 跑一个 0.5B 级模型, 不占显存,
#     只服务一个用途 —— 提示词优化/翻译。
#
# 实测(本机 24 线程, Qwen2.5-0.5B-Instruct, fp32 + int8 动态量化):
#   加载 1.6s · 约 10~12 tok/s · 内存 ~1.2GB · 显存 0
#   一次 300 token 的改写 ≈ 25~35 秒 —— 比云端慢, 但零成本、零联网、隐私不出本机。
#
# 接口: OpenAI 兼容的极小子集(只要 chat/completions), 这样前端/服务端复用同一套调用。
#    GET  /health                → {ok, model, threads}
#    POST /v1/chat/completions   → {choices:[{message:{content}}]}  (支持 system+user)
#
# 模型目录: 环境变量 AICS_TEXT_MODEL 指到 HF 格式目录(含 config.json/model.safetensors/tokenizer*)。
#   缺模型时 /health 返回 ok=false 并带上"怎么装"的提示, 服务不会崩。
# ============================================================
import json
import os
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL_DIR = os.environ.get('AICS_TEXT_MODEL', '')
PORT = int(os.environ.get('AICS_TEXT_PORT', '8192'))
# 设备策略: auto = 显存够就上 GPU, 不够就退 CPU(默认); cpu / cuda 可强制
DEVICE_MODE = os.environ.get('AICS_TEXT_DEVICE', 'auto').lower()
# auto 模式下要求的最小空闲显存(GB): 0.5B fp16 约 1.2GB, 1.5B fp16 约 3.1GB+激活 ≈ 4.3GB
VRAM_NEED_GB = float(os.environ.get('AICS_TEXT_VRAM_GB', '4'))
# 空闲多久把模型从显存里放掉(秒); 0 = **常驻**(默认) —— 用户要求"提示词这个模型要常驻是最好的"
IDLE_UNLOAD_SEC = int(os.environ.get('AICS_TEXT_IDLE_SEC', '0'))
# 常驻意图: /preload 之后为真 —— 显存一空出来就自己把模型装回去(H3 停了以后)
_want_resident = os.environ.get('AICS_TEXT_RESIDENT', '1') != '0'

_model = None
_tok = None
_device = 'cpu'
_load_lock = threading.Lock()
_load_error = ''
_load_secs = 0.0
_last_used = 0.0


def _log(msg: str) -> None:
    print(f'[local-text] {msg}', flush=True)


def resolve_model_dir(root: str) -> str:
    """
    AICS_TEXT_MODEL 既可以给**具体模型目录**, 也可以给**模型根目录**(下面放了好几个版本)。
      只有一个版本时用户不用管目录名 —— 这里按"权重文件最大者优先"选:
      实测 0.5B 放进显卡也照样笨(复读/跑题), 1.5B 才是能用的下限, 所以要选大的那个而不是第一个。
    """
    if not root:
        return ''
    if os.path.exists(os.path.join(root, 'config.json')):
        return root
    best, best_size = '', -1
    try:
        for name in os.listdir(root):
            d = os.path.join(root, name)
            if not os.path.isdir(d) or not os.path.exists(os.path.join(d, 'config.json')):
                continue
            w = os.path.join(d, 'model.safetensors')
            size = os.path.getsize(w) if os.path.exists(w) else 0
            if size > best_size:
                best, best_size = d, size
        if best:
            _log(f'模型根目录里选中 {os.path.basename(best)}（权重 {best_size/1024**3:.2f}GB）')
    except Exception as e:  # noqa: BLE001
        _log(f'扫描模型目录失败: {e}')
    return best


def pick_device() -> str:
    """
    选设备 —— 这是"用显存载入"的关键:
      · 显存**够**才上 GPU: H3 跑起来时占 ~19.4/20GB, 这时候硬塞模型进去会把视频任务挤爆,
        所以按"当前空闲显存 ≥ AICS_TEXT_VRAM_GB"来判断, 不够就老老实实回 CPU;
      · 判断在**每次加载**时做(而不是进程启动时) —— 用户往往是"先写提示词(显存空着) → 再开 H3",
        正好落在 GPU 上; 之后 H3 起来时服务端会主动 POST /unload 让我们让位。
    """
    if DEVICE_MODE == 'cpu':
        return 'cpu'
    try:
        import torch
        if not torch.cuda.is_available():
            return 'cpu'
        if DEVICE_MODE == 'cuda':
            return 'cuda'
        free, _total = torch.cuda.mem_get_info(0)
        if free >= VRAM_NEED_GB * (1024 ** 3):
            return 'cuda'
        _log(f'空闲显存不足({free/1024**3:.1f}GB < {VRAM_NEED_GB}GB) → 这一轮用 CPU')
    except Exception as e:  # noqa: BLE001
        _log(f'探测显存失败, 用 CPU: {e}')
    return 'cpu'


def unload_model(reason: str = '') -> None:
    """把权重放掉(显存/内存都还回去) —— 让 H3 之类的重模型能拿到整张卡"""
    global _model, _tok, _device
    if _model is None:
        return
    _model = None
    _tok = None
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass
    _log(f'已释放模型{"（" + reason + "）" if reason else ""}')


def _idle_worker() -> None:
    """
    常驻看护线程 (2026-09-25):
      · 用户口径: "提示词这个模型要常驻是最好的" —— 所以默认**不因空闲卸载**;
      · 只有"别的重模型要用显存"时(服务端 POST /unload)才让位;
      · 让位之后, 这里每隔几秒看一眼**空闲显存**, 够就自动装回去(所以 H3 一停它自己就回来了)。
    """
    while True:
        time.sleep(10)
        if _model is not None and _device == 'cuda' and IDLE_UNLOAD_SEC > 0 and _last_used:
            if time.time() - _last_used > IDLE_UNLOAD_SEC:
                unload_model(f'空闲 {IDLE_UNLOAD_SEC}s 自动让出显存')
        elif _model is None and _want_resident and not _load_lock.locked():
            if pick_device() == 'cuda':
                load_model()


def load_model():
    """懒加载: 显存够就用 GPU(fp16), 否则 CPU(int8 动态量化)"""
    global _model, _tok, _load_error, _load_secs, _device, _last_used
    if _model is not None:
        return True
    with _load_lock:
        if _model is not None:
            return True
        mdir = resolve_model_dir(MODEL_DIR)
        if not mdir:
            _load_error = (f'没找到本地文本模型: {MODEL_DIR or "(未设置 AICS_TEXT_MODEL)"}'
                           '（需要 HF 格式目录: config.json + model.safetensors + tokenizer*）')
            return False
        try:
            t0 = time.time()
            import torch
            from transformers import AutoTokenizer, AutoModelForCausalLM
            _device = pick_device()
            if _device == 'cpu':
                torch.set_num_threads(max(2, (os.cpu_count() or 4) - 2))
            _tok = AutoTokenizer.from_pretrained(mdir)
            if _device == 'cuda':
                m = AutoModelForCausalLM.from_pretrained(mdir, dtype=torch.float16).to('cuda')
            else:
                m = AutoModelForCausalLM.from_pretrained(mdir, dtype=torch.float32)
            m.eval()
            if _device == 'cpu':
                try:
                    # int8 只量化 Linear 层, CPU 上稳且快; 失败就退回 fp32(不影响功能)
                    m = torch.ao.quantization.quantize_dynamic(m, {torch.nn.Linear}, dtype=torch.qint8)
                except Exception as e:  # noqa: BLE001
                    _log(f'int8 量化跳过: {e}')
            _model = m
            _load_secs = time.time() - t0
            globals()['_model_name'] = os.path.basename(mdir)
            _load_error = ''
            _last_used = time.time()
            if _device == 'cuda':
                free, _t = torch.cuda.mem_get_info(0)
                _log(f'模型就绪(GPU/fp16) {mdir} · 加载 {_load_secs:.1f}s · 剩显存 {free/1024**3:.1f}GB')
            else:
                _log(f'模型就绪(CPU/int8) {mdir} · 加载 {_load_secs:.1f}s · 线程 {torch.get_num_threads()}')
            return True
        except Exception as e:  # noqa: BLE001
            _load_error = f'加载失败: {e}'
            _log(_load_error)
            return False


def chat(messages, max_tokens=512, temperature=0.6):
    import torch
    global _last_used
    ids = _tok.apply_chat_template(messages, add_generation_prompt=True, tokenize=True, return_tensors='pt')
    if not torch.is_tensor(ids):
        ids = ids['input_ids']
    if _device == 'cuda':
        ids = ids.to('cuda')
    kwargs = dict(
        max_new_tokens=int(max_tokens),
        repetition_penalty=1.15,
        # ⚠️ 0.5B 这种小模型很容易"复读"(实测: 同一句循环到 max_tokens, 还占掉 38 秒)。
        #   禁掉 4-gram 重复是压住复读最有效的一招(比单纯调 repetition_penalty 稳)。
        no_repeat_ngram_size=4,
    )
    if temperature and temperature > 0.01:
        kwargs.update(do_sample=True, temperature=float(temperature), top_p=0.9)
    else:
        kwargs.update(do_sample=False)
    with torch.no_grad():
        out = _model.generate(ids, **kwargs)
    _last_used = time.time()
    text = _tok.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()
    # 小模型的两种"手抖"在这里统一修掉(实测 1.5B 两个都犯):
    #   ① 字段名写成 integrated\_multimodal\_description(转义下划线) —— 反斜杠是噪音;
    #   ② 字段名被"清理"成 integrated multimodal description(下划线变空格) —— H3 认的是下划线。
    for wrong in ('integrated_multimodal description', 'integrated multimodal description',
                  'Integrated Multimodal Description', 'integrated-multimodal-description'):
        text = text.replace(wrong, 'integrated_multimodal_description')
    text = text.replace('overall sound scape', 'overall_soundscape').replace('overall soundscape', 'overall_soundscape')
    text = text.replace('non diegetic music', 'non_diegetic_music').replace('non_diegetic music', 'non_diegetic_music')
    # 多参(Ref2VA)六段式同理 —— 实测 1.5B 会把下划线写成空格(retention analysis / detailed description)
    for wrong, right in (
        ('subject definitions', 'subject_definitions'), ('subject-definitions', 'subject_definitions'),
        ('retention analysis', 'retention_analysis'), ('retention-analysis', 'retention_analysis'),
        ('detailed description', 'detailed_description'), ('detailed-description', 'detailed_description'),
    ):
        text = text.replace(wrong, right).replace(wrong.replace(' ', '_'), right)
    return text.replace('\\_', '_').replace('\u200b', '')


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):  # 少刷屏, 但保留关键信息
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.startswith('/health'):
            ready = _model is not None
            free_gb = None
            try:
                import torch
                if torch.cuda.is_available():
                    free_gb = round(torch.cuda.mem_get_info(0)[0] / 1024 ** 3, 1)
            except Exception:  # noqa: BLE001
                pass
            self._json(200, {
                'ok': ready,
                'loading': _load_lock.locked(),
                'model': globals().get('_model_name') or (os.path.basename(MODEL_DIR.rstrip('\\/')) if MODEL_DIR else ''),
                'loadSecs': round(_load_secs, 2),
                'device': _device if ready else ('cuda' if DEVICE_MODE == 'cuda' else DEVICE_MODE),
                'vramFreeGB': free_gb,
                'detail': _load_error,
            })
            return
        self._json(404, {'ok': False, 'msg': 'not found'})

    def do_POST(self):  # noqa: N802
        # 服务端在拉起 H3/Krea2 之前会调它 —— 主动把显存让出去, 避免把视频任务挤爆
        if self.path.startswith('/unload'):
            unload_model('被其它后端请求让位')
            self._json(200, {'ok': True})
            return
        # 预加载(常驻): 应用启动 / 服务端拉起这一路之后调一次, 用户第一次点"优化"就不用等加载
        if self.path.startswith('/preload'):
            ok = load_model()
            self._json(200 if ok else 503, {'ok': ok, 'detail': _load_error, 'device': _device})
            return
        if not self.path.startswith('/v1/chat/completions'):
            self._json(404, {'ok': False, 'msg': 'not found'})
            return
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(n) or b'{}')
        except Exception as e:  # noqa: BLE001
            self._json(400, {'ok': False, 'msg': f'请求体不是 JSON: {e}'})
            return
        if not load_model():
            self._json(503, {'ok': False, 'msg': _load_error or '本地文本模型未就绪'})
            return
        msgs = req.get('messages') or ([{'role': 'user', 'content': req.get('prompt', '')}])
        try:
            t0 = time.time()
            text = chat(msgs, req.get('max_tokens', 512), req.get('temperature', 0.6))
            _log(f'生成 {len(text)} 字 · {time.time()-t0:.1f}s')
            self._json(200, {'choices': [{'message': {'role': 'assistant', 'content': text}}]})
        except Exception as e:  # noqa: BLE001
            self._json(500, {'ok': False, 'msg': f'生成失败: {e}'})


if __name__ == '__main__':
    _log(f'model={MODEL_DIR or "(未设置)"} port={PORT} device={DEVICE_MODE}(需 {VRAM_NEED_GB}GB 空闲显存) idle={IDLE_UNLOAD_SEC}s')
    threading.Thread(target=_idle_worker, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    srv.serve_forever()
