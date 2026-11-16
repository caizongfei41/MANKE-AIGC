"""
FG AiCanvas · 后端安装身份端点 (v1)
====================================

只做一件事: 让本机程序确认“端口上的这个后端确实是当前这次安装拉起的”。

为什么需要它:
  客户机器上经常还有别的 ComfyUI / 旧版 AiCanvas。旧 H3 同样会回答 H3 专用节点，
  单凭节点名无法区分它扫描的是哪一份模型目录。程序把本次安装的实例 ID、程序版本、
  模型契约号通过环境变量交给后端；这里原样回报，供程序做严格比对。

不写文件、不读模型、不参与生成；环境变量只由本程序的受管启动器传入。
"""

import os

from aiohttp import web

try:
    from server import PromptServer
except Exception:  # ComfyUI 版本差异：没有 route 宿主时保持节点可加载
    PromptServer = None


def _identity_payload():
    return {
        "ok": True,
        "product": "FG AiCanvas",
        "markerVersion": 1,
        "instanceId": str(os.environ.get("AICS_INSTANCE_ID", "")),
        "programVersion": str(os.environ.get("AICS_PROGRAM_VERSION", "")),
        "build": str(os.environ.get("AICS_BUILD", "")),
        "modelApiVersion": str(os.environ.get("AICS_MODEL_API_VERSION", "")),
        "backendsRoot": str(os.environ.get("AICS_BACKENDS_ROOT", "")),
        "pid": os.getpid(),
    }


if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    try:
        @PromptServer.instance.routes.get("/aics/identity")
        async def aics_identity(_request):
            return web.json_response(_identity_payload())
    except Exception as exc:  # noqa: BLE001
        print(f"[AiCanvas-Identity] route registration failed: {exc}")


NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
