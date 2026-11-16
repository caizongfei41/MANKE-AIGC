"""
AiCanvas · H3 自研节点(版本库受管副本)
=====================================

投放位置: backends/h3/payload/backend/ComfyUI-H3/ComfyUI/custom_nodes/ComfyUI-AiCanvas-H3/
同步方式: node tools/sync-h3-nodes.mjs   (改这里 → 再同步到后端; 别只改后端那份)

包含(纯自研, 不依赖任何第三方库):
  · H3 细节精修 (AiCanvasH3DetailRefiner) —— 在**低噪尾巴**加密采样步,
    专治高速运动画面里"边缘颗粒 / 细碎闪烁"(根因是低噪步数不够: turbo LoRA 4~8 步时尾巴只剩 1~2 个点)。
  · H3 细节精修步数 (AiCanvasH3DetailPlan) —— 只吐"要插几步"的处方, 给前端/队列对齐进度口径。

加载方式: 遍历本目录 py/ 下的 .py, 谁出错只跳过谁(其余照旧加载), 并打印原因。
"""

import importlib.util
import os
import traceback

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_PY_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "py")

if os.path.isdir(_PY_DIR):
    for _fn in sorted(os.listdir(_PY_DIR)):
        if not _fn.endswith(".py") or _fn.startswith("_"):
            continue
        _path = os.path.join(_PY_DIR, _fn)
        try:
            _spec = importlib.util.spec_from_file_location(f"aicanvas_h3_{_fn[:-3]}", _path)
            _mod = importlib.util.module_from_spec(_spec)
            _spec.loader.exec_module(_mod)
            NODE_CLASS_MAPPINGS.update(getattr(_mod, "NODE_CLASS_MAPPINGS", {}) or {})
            NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_mod, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})
        except Exception as _e:                                    # noqa: BLE001
            print(f"[AiCanvas-H3] 节点文件加载失败, 已跳过: {_fn} — {_e}")
            traceback.print_exc()
else:
    print(f"[AiCanvas-H3] 找不到 py 目录: {_PY_DIR}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
