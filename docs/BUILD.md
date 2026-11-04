# 构建与二次打包说明

本仓库不包含上游 TypeScript 源码，发布基线是打包后的 Electron 产物。下面是从发布基线重新打包/改品牌/出安装包的完整流程。

## 1. 基线结构

```
Manke.exe                       Electron 主程序（内嵌 asar 完整性清单）
resources/
├─ app.asar                     主进程 / preload / 激活内核 / 完整性清单
└─ app.asar.unpacked/
   └─ bundle/                   前端产物 + 本地服务 + 工具脚本（明文）
data/                           运行时数据（项目/画布/素材/密钥/激活标记）
backends/                       模型后端（模型包解压到这里）
```

`app.asar` 格式（本版本）：

```
[16 字节前缀][JSON header][2 字节 00 00][文件数据...]
```

- header 里每个文件都有 `integrity`（`algorithm/hash/blockSize/blocks`）；
- `bundle/**` 是 `unpacked: true`，内容在磁盘上，header 里记录其大小与 SHA-256；
- `bundle-integrity.json` 再对 `bundle/**` 做一次全量清单（1039 个文件）；
- `Manke.exe` 的 `.rdata` 里有一段
  `[{"file":"resources\\app.asar","alg":"SHA256","value":"<header 的 SHA-256>"}]`；
- 启动时 `runtime-guard.cjs` 校验 bundle 清单，运行中每 30 秒复查热文件。

> 改任何资源后，必须同步：文件大小 → header integrity → `bundle-integrity.json` → header 哈希 → exe 清单，否则启动报 `ASAR Integrity Violation` 或 `程序资源完整性校验失败`。

## 2. 环境

- Windows 10/11 x64
- Node.js 20+（仅用于脚本校验，不参与 Electron 运行）
- [Inno Setup 6](https://jrsoftware.org/isinfo.php)（编译安装包）
- 7-Zip 22+（便携包）

## 3. 解包与修改

1. 用安装包安装到隔离目录，或解压便携包；
2. `resources/app.asar` 可用 `@electron/asar` 或本仓库同款脚本解包；
3. 明文部分主要在 `resources/app.asar.unpacked/bundle/`：
   - `server.mjs`：本地 HTTP 服务
   - `dist/`：前端产物（`index.html`、`activate.html`、`assets/*`）
   - `tools/`：授权、机器码、模型、端口等工具
4. 修改后按第 1 节的链路重算哈希。

## 4. 品牌与激活改造点

| 位置 | 改动 |
|------|------|
| `main.cjs` | `APP_NAME='漫客'`、数据目录 `Manke`、窗口标题、密码门禁 |
| `preload.cjs` | 暴露 `passwordActivate` |
| `license-core.cjs` | 保留真实校验；放行由 `data/password-ok` 决定 |
| `tools/license.mjs` | `licenseStatus()` 返回已激活（界面与提示词包用） |
| `dist/activate.html` | 密码激活页（首次启动） |
| `dist/assets/*` | 品牌文案、`welcome` 顶栏、图标 |
| `dist/logo-*.png`、`favicon*`、`apple-touch-icon.png` | 品牌图标 |
| `package.json` / `version.json` / `版本信息.json` | 产品名、exe 名、版本元数据 |

激活实现（本仓库版本）：

1. 首次启动无 `data/password-ok` → 主进程加载 `/activate` 密码页；
2. 页面通过 `window.aics.passwordActivate(pw)` 调主进程 IPC；
3. 密码正确 → 写入 `data/password-ok` → 轮询检测到后进入主界面；
4. 删除 `data/password-ok` 可重新激活。

## 5. 安装包

模板见 [`installer/manke.iss`](../installer/manke.iss)。核心点：

- `DefaultDirName={sd}\Manke`
- `AppName=漫客`，快捷方式/卸载项均为「漫客」
- `[Files]` 包含程序文件，**排除** `data\`、`unins000.*`
- `[Run]` 启动 `{app}\Manke.exe`

编译：

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" .\installer\manke.iss
```

## 6. 便携包

见 [`scripts/build-portable.ps1`](../scripts/build-portable.ps1)：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build-portable.ps1 `
  -Source "C:\path\to\Manke" `
  -Output ".\漫客_便携版.7z"
```

脚本用 robocopy 排除 `data`、`backends`、`unins000.*`，再以 LZMA2 固实压缩。

## 7. 验收清单

- [ ] `Manke.exe` 启动不报完整性错误
- [ ] 全新数据目录首次启动出现密码页
- [ ] 错误密码被拒绝，`mankeaigc` 可进入主界面
- [ ] 顶栏为「M 图标 + 漫客」，无旧品牌/作者入口
- [ ] 模型目录识别正常（模型包体检）
- [ ] 安装包静默安装 + 卸载正常
- [ ] 便携包解压即用，`7z t` 通过

## 8. 说明

上游前端源码（React/TS）未随发行包提供，本仓库提供的是**发布基线的二次打包说明与脚本**；如需从零构建前端，需要上游仓库与对应 Electron 版本。
