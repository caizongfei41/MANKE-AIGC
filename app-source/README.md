# MANKE-AIGC-App 可维护工程

基于 **漫客工作台 v2.10.79 / build 689 / glass_20261104** 安装包整理的本地可维护工程。

- 基线安装包：`D:\漫客工作台\漫客_安装程序_v2.10.79_glass_20261104.exe`
- 基线 SHA-256：`5263ccf6a38e42733957b9d4745c8425bdb541b20a4f37590b842a5715fa3ea8`
- 便携版：`D:\漫客工作台\漫客_便携版_v2.10.79_glass_20261104.7z`

## 目录

```
runtime/    可直接运行的完整程序（不含 data/backends），打包基线
  Manke.exe
  resources/app.asar
  resources/app.asar.unpacked/bundle/   ← 前端解包文件
src/asar/   从 app.asar 解包出的主进程/预加载/后端文件
  main.cjs
  preload.cjs
  server.mjs（在 bundle 内）
  bundle/   前端源码（压缩后的 JS/CSS/HTML，可直接改）
patches/    当前 UI/标签/LoRA 补丁源文件
tools/      解包、同步、构建、校验脚本
installer/  Inno Setup 模板与图标
dist/       构建输出
```

## 当前已包含的改动

- 玻璃拟态 UI、深/中灰/浅色三套主题
- 连线可见性（canvas 线宽/颜色）
- 节点标签自动聚焦、抓手模式自动切指针
- 素材库标签按素材 id 精确映射
- 素材库全选接入、提示词 @素材自动接入
- LoRA 多选（每个 LoRA 独立强度，串联 LoraLoader）

## 常用命令

```powershell
# 校验 asar 头、exe 清单、bundle-integrity
python tools/verify.py

# 把 src/asar/bundle 同步到 runtime，并更新 asar/清单
powershell -ExecutionPolicy Bypass -File tools/sync_source.ps1

# 构建安装包 / 便携包
powershell -ExecutionPolicy Bypass -File tools/build_installer.ps1
powershell -ExecutionPolicy Bypass -File tools/build_portable.ps1
```

`build_installer.ps1` 默认使用 `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`；`build_portable.ps1` 默认找系统 7-Zip，找不到会退回 `runtime\7z.exe`。Python 如不在 PATH，可加 `-Python <python.exe>`。

## 修改流程

1. 改 `src/asar/bundle/dist/**` 下的 CSS/JS/HTML；
2. 运行 `tools/sync_source.ps1`；
3. 运行 `tools/verify.py`，应显示 `ok= True`、`bundle mismatches: 0`；
4. 运行 `tools/build_installer.ps1` / `build_portable.ps1`。

## 限制

- `tools/sync_asar.py` 采用**原位头补丁**，保持 asar 头长度和数据偏移不变；因此编辑后文件大小/头部 JSON 不能超过原容量。若 header 超长，需要重建 asar 并重新签名。
- 主进程 `main.cjs`、`preload.cjs` 是打包进 asar 的 packed 文件，当前脚本只同步 `bundle/`（unpacked 文件）。改主进程需要额外的 asar 重打包流程。
- `runtime/data`、`runtime/backends` 不纳入工程；运行数据在安装目录的 `data/`，模型在 `backends/`。
- 工程里的前端 JS 是构建后的压缩代码，不是原始 React/TS 源工程。

## 备份

原始安装包请保留在 `D:\漫客工作台`，不要只依赖本目录。
