# 当前补丁说明

## UI / 主题

- `src/asar/bundle/dist/assets/style-CFwmijmk.css`
  - 末尾追加玻璃拟态主题、三套主题变量、设置浮层、连线光晕、浅色模式修正。
- `src/asar/bundle/dist/index.html`
  - 注入标签自动聚焦、素材库标签映射、全选接入、@素材自动接入、LoRA 多选按钮。

## 素材库标签

- 通过 React fiber key（素材 id）精确映射素材卡与节点，不再按顺序猜。
- 卡片显示节点当前标题。
- 节点标签输入框自动 focus/select；抓手模式下双击标签自动切回指针。

## LoRA 多选

- 参数栏 `LoRA(n)` 小按钮，点击弹出面板。
- 每个 LoRA 独立强度，保存到 localStorage `mk.loras`。
- 生成时拦截 `/comfy/prompt`，把多个 `LoraLoaderModelOnly` 串联到模型链。

## 连线

- `dist/assets/CanvasPage-DGQJ4hHz.js`：canvas 连线线宽从 1.4/1.5 提到 3.2。
- CSS：`.acs-bulk-edges` 光晕与主题连线色。

## 原始补丁文件

`patches/` 下保留：

- `glass.css`
- `asset_tags.js`
- `lora.js`

它们是当前注入逻辑的可读副本；实际生效的是 `src/asar/bundle` 中的构建文件。
