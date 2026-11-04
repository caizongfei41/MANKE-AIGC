# 模型包（夸克网盘）

模型包与程序分开下载、分开安装。程序升级不需要重新下载模型。

## 下载

- 链接：https://pan.quark.cn/s/241930f81fc9
- 分享口令：`/~8a763c40Ng~/`
- 打开夸克 APP 或浏览器访问链接保存后下载。

## 包清单

| 文件 | 层 | 大小（字节） | SHA-256 |
|------|----|--------------|---------|
| `漫客_模型包_video_v1.2.0.7z` | 视频（H3） | 64,585,988,356 | `a16577a9b5e9768a9a9105b995cc821517c8c80c95ca2852399a6ab8d6ed798e` |
| `漫客_模型包_video_v1.1.0.7z` | 视频（H3，旧版） | 63,561,052,533 | `467140107e89a3a57cee3802d6938d1d702b28919b355aa399597e66b1e9ee9b` |
| `漫客_模型包_image_v1.1.0.7z` | 生图（Krea2） | 45,856,050,766 | `a7eaff5b4fee64a4d9712c6f2ffe0f3986476c882dd598ea45a4a57ded753a3b` |
| `漫客_模型包_qwen_v1.1.0.7z` | 生图（Qwen，可选） | 36,278,795,405 | `bc1278e031698ae6ad5375d9e4d580bdf3b932089a9e4c646109234205d4a42c` |
| `漫客_模型包_voice_v1.1.0.7z` | 语音（IndexTTS） | 13,182,037,386 | `2396a902916cf9e0825819088b4c85039a15cd3785c12860f8ebf36b614d152c` |

> 校验值同时用于软件内的「模型包体检」；文件名保持 `漫客_模型包_<层>_v*.7z` 即可被识别。

## 安装

1. 解压对应的 `.7z`（建议用 7-Zip / NanaZip，勿用会改文件名的解压工具）；
2. 把解压后的顶层目录移动到程序目录的 `backends\` 下：

   | 包内顶层目录 | 目标位置 |
   |--------------|----------|
   | `h3\`（内含 `payload\backend\ComfyUI-H3\`） | `程序目录\backends\h3\` |
   | `comfyui-kear2\` | `程序目录\backends\comfyui-kear2\` |
   | `indextts-tts\` | `程序目录\backends\indextts-tts\` |
   | `comfyui-qwen\`（可选） | `程序目录\backends\comfyui-qwen\` |

3. 模型不在程序目录也可以：双击 `set-models-dir.bat`，选择模型根目录；
4. 启动程序 → 「配置与启动」→ 对应后端卡片点启动。

## 校验

在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-models.ps1 -Path "D:\你的模型包目录"
```

脚本会按上表逐个比对 SHA-256，输出 OK / MISMATCH。

## 常见问题

- **解压报 CRC Failed**：优先重新拷贝/重新下载，不要断点续传；拷完先用上面的脚本校验；
- **软件里显示未登记版本**：说明模型目录里缺少 `models.manifest.json` 或清单损坏，功能一般仍可用，但无法做版本契约校验；
- **模型包能混用吗**：按层安装即可；视频/生图/语音互不依赖，Qwen 为可选附加。

## 自动校验（GitHub Actions）

工作流：[`.github/workflows/verify-models.yml`](../.github/workflows/verify-models.yml)

- **每次 push / PR**：校验 [`models/models.manifest.json`](../models/models.manifest.json) 与本文档表格是否一致（名称、大小、SHA-256），并检查 README/本文档仍包含网盘链接与口令；
- **手动触发**：在 Actions 页面选择 `verify-models` → `Run workflow`，指定模型包目录，由带 `self-hosted, windows, models` 标签的 runner 对本地 `.7z` 逐文件计算 SHA-256（大文件不适合上传到托管 runner）；
- **单一事实源**：新增/更换模型包时，同时修改 `models/models.manifest.json` 与本文档表格，CI 会拦截不一致。
