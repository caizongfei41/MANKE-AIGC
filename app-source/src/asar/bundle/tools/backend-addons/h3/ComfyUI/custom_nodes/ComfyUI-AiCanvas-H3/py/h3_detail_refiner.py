"""
H3 细节精修 (AiCanvas 自研)
===========================

问题
----
H3 用的是 Turbo LoRA(4~8 步)。步数少的时候, 噪声序列(σ)在**低噪段**往往只剩 1~2 个点:
    σ: 6.0 → 3.2 → 1.6 → 0.7 → 0.0        (5 步, 低噪段只有 0.7→0)
细节是在低噪段收尾的 —— 收尾只有一步, 高速运动的边缘就会"没磨平": 颗粒、马赛克、细碎闪烁。

做法
----
把**低噪尾巴**单独取出来, 按指定曲线重新铺成更多的点(多插 extra_steps 个), 其余(高噪头部)
一个点都不动。即"局部微雕加步", 不是整体加步数 —— 所以加的那一步只花在收尾上。

    σ: 6.0 → 3.2 → 1.6 │ 0.70 → 0.35 → 0.12 → 0.00      (extra_steps=2, cosine)
      └── 头部原样 ────┘ └──── 尾巴重新铺(更密, 末端更细) ────┘

三种曲线的差别(同一段 σ 区间里点的分布):
  · cosine(默认): 靠近 0 的地方点更密 → 收尾更细, 这是我们实测最有用的那条;
  · linear:       均匀铺开, 行为最好预测;
  · exponential:  点往前压(高噪那头更密), 一般不如 cosine。

安全约定
--------
  · extra_steps = 0 / 找不到低噪段 / 序列太短 → **原样返回**, 绝不改坏调度;
  · 结果的**终点 σ 与起点 σ 一律保持原值**(保证收敛点不变、衔接点不变);
  · 结果必须**严格递减**且点数不少于输入(重复/非递减的点会被剔掉, 免得采样器报错);
  · 只在 CPU 上算这几个数(几十个 float), 再搬回原设备/原 dtype。
"""

import math

import torch


class AiCanvasH3DetailRefiner:
    """低噪尾巴加密(细节精修)。插在「调度器 → 采样器」的 sigmas 线上。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "sigmas": ("SIGMAS", {
                    "tooltip": "原始噪声序列(BasicScheduler / ManualSigmas 的输出)。"
                }),
                "extra_steps": ("INT", {
                    "default": 1, "min": 0, "max": 8, "step": 1,
                    "tooltip": "在低噪尾巴里额外插几步; 0 = 原样返回(等于关掉)。",
                }),
                "start_at_sigma": ("FLOAT", {
                    "default": 0.7, "min": 0.0, "max": 20.0, "step": 0.01,
                    "tooltip": "从这个 σ 以下开始加密。H3 实测 0.6~0.9 最稳(填太大等于整段重铺)。",
                }),
                "spacing": (["cosine", "linear", "exponential"], {
                    "default": "cosine",
                    "tooltip": "尾巴上点的分布曲线。cosine = 靠近 0 更密(默认)。",
                }),
            }
        }

    RETURN_TYPES = ("SIGMAS",)
    RETURN_NAMES = ("sigmas",)
    FUNCTION = "refine"
    CATEGORY = "AiCanvas/H3"
    DESCRIPTION = (
        "H3 低噪细节精修: 把噪声序列的低噪尾巴按 cosine/linear/exponential 重新铺成更多点, "
        "专治高速运动画面的边缘颗粒与细碎闪烁。加的那几步只花在收尾段, 高噪头部与终点 σ 原样不动。"
    )

    def refine(self, sigmas, extra_steps, start_at_sigma, spacing):
        try:
            n_in = int(sigmas.numel())
        except Exception:                                          # noqa: BLE001
            return (sigmas,)
        extra = int(extra_steps)
        if extra <= 0 or n_in < 3:
            return (sigmas,)

        s = sigmas.detach().to(device="cpu", dtype=torch.float32).flatten().clone()

        # 尾巴起点 = 第一个 ≤ 阈值的点; 一个都没有 → 整段都在阈值之上, 不动
        below = (s <= float(start_at_sigma)).nonzero(as_tuple=False).flatten()
        if int(below.numel()) == 0:
            return (sigmas,)
        cut = int(below[0].item())
        # cut == 0 说明连第一个点都低于阈值(阈值填太大) → 头部为空, 不做;
        # cut >= n_in-1 说明尾巴只剩终点一个点 → 也没什么可加密的。
        if cut <= 0 or cut >= n_in - 1:
            return (sigmas,)

        head = s[:cut]                       # 高噪头部: 原样保留
        a = float(s[cut].item())             # 尾巴起点 σ(其之上最后一个点 = s[cut-1], 衔接不变)
        b = float(s[-1].item())              # 终点 σ(收敛点, 原样保留)
        tail_n = n_in - cut                  # 现有尾巴点数
        new_n = tail_n + extra               # 目标尾巴点数

        t = torch.linspace(0.0, 1.0, steps=new_n, dtype=torch.float32)
        if spacing == "exponential":
            k = 3.0
            w = (torch.exp(t * k) - 1.0) / (math.exp(k) - 1.0)     # 点往前压
        elif spacing == "linear":
            w = t
        else:                                                       # cosine(默认)
            w = (1.0 - torch.cos(t * math.pi)) / 2.0                # 两端平缓, 靠近 0 更密

        tail = a + (b - a) * w
        out = torch.cat([head, tail])

        # 只保留严格递减的点: 重复 σ 会让部分采样器直接报错(实测 KV 采样那条最容易踩)
        keep = [0]
        for i in range(1, int(out.numel())):
            if float(out[i].item()) < float(out[keep[-1]].item()):
                keep.append(i)
        if len(keep) < 2 or len(keep) < n_in:
            return (sigmas,)                                        # 结果反而变少就别改

        out = out[keep]
        # 一行可核查的输出: 后端日志里能直接看到"这次插了几步、σ 从哪开始密"
        print(
            f"[AiCanvas-H3] 细节精修: {n_in} → {int(out.numel())} 个 σ "
            f"(extra={extra}, σ≤{float(start_at_sigma):.2f}, {spacing})"
        )
        return (out.to(device=sigmas.device, dtype=sigmas.dtype),)


class AiCanvasH3DetailPlan:
    """
    只算"该插几步"的处方(不碰 sigmas) —— 给前端/队列做进度与预估用。

    为什么单独一个节点: 插了额外步数之后, 真实采样步数 = steps + extra;
    进度条按总步数报, 否则百分比会跳。前端可以先用同一份口径算好, 再决定要不要挂精修。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "steps": ("INT", {"default": 8, "min": 1, "max": 100, "step": 1}),
                "extra_steps": ("INT", {"default": 1, "min": 0, "max": 8, "step": 1}),
            }
        }

    RETURN_TYPES = ("INT", "INT")
    RETURN_NAMES = ("steps", "total_steps")
    FUNCTION = "plan"
    CATEGORY = "AiCanvas/H3"
    DESCRIPTION = "细节精修的步数处方: steps(原始) 与 total_steps(含额外步数), 供进度口径使用。"

    def plan(self, steps, extra_steps):
        base = max(1, int(steps))
        extra = max(0, int(extra_steps))
        return (base, base + extra)


NODE_CLASS_MAPPINGS = {
    "AiCanvasH3DetailRefiner": AiCanvasH3DetailRefiner,
    "AiCanvasH3DetailPlan": AiCanvasH3DetailPlan,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AiCanvasH3DetailRefiner": "H3 细节精修 · AiCanvas",
    "AiCanvasH3DetailPlan": "H3 细节精修步数 · AiCanvas",
}
