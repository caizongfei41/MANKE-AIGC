# MANKE-AIGC 本地画布

漫客 AIGC 本地无限画布 —— 把视频、图片、语音的本地生成能力放进一张可自由编排的画布。

- 当前版本：**v2.10.79**（build 689）
- 形态：Windows 桌面应用（安装版 / 便携版）
- 模型：与程序分离发布，按需下载（见 [模型包说明](docs/MODELS.md)）
- 激活：**密码激活**，首次启动输入密码即可（见 [激活说明](docs/ACTIVATION.md)）

## 快速开始

1. 获取程序包（安装版或便携版，见 [发布说明](docs/RELEASE.md)）；
2. 首次启动输入激活密码：
   ```
   mankeaigc
   ```
3. 解压模型包，把 `h3`、`comfyui-kear2`、`indextts-tts`（可选 `comfyui-qwen`）放进程序目录的 `backends\`；
4. 双击 `set-models-dir.bat` 指向模型目录（模型也可以放在其他盘）；
5. 打开软件 → 「配置与启动」→ 按需启动后端，即可开始创作。

## 模型网盘

夸克网盘（模型包约 160 GB，按层下载）：

> 链接：https://pan.quark.cn/s/241930f81fc9
>
> 分享口令：`/~8a763c40Ng~/`

打开夸克 APP 或浏览器访问链接即可保存/下载。

模型包清单、SHA-256 校验值、放置方式见 **[docs/MODELS.md](docs/MODELS.md)**。

## 仓库结构

```
MANKE-AIGC/
├─ README.md
├─ .gitignore
├─ docs/
│  ├─ MODELS.md        # 模型包下载、校验、安装
│  ├─ ACTIVATION.md    # 密码激活与重置
│  └─ RELEASE.md       # 程序包、版本与校验值
└─ scripts/
   └─ verify-models.ps1  # 模型包 SHA-256 校验脚本
```

## 说明

- 本仓库不存放程序二进制与模型文件（体积过大），只保留文档、校验值与脚本；
- 模型包与程序包分开更新：换程序不用重新下模型，换模型也不用重装程序；
- 数据默认保存在程序目录 `data\`（项目、画布、素材、密钥、登录态），备份该目录即可迁移。
