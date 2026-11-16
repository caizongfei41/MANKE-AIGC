# 构建与同步

## 环境

- Windows 10/11
- Python 3.10+
- Inno Setup 6（构建安装包）
- 7-Zip（构建便携包，或使用 `runtime\7z.exe`）

## 1. 同步前端

前端可直接改：

```
src/asar/bundle/dist/assets/style-CFwmijmk.css
src/asar/bundle/dist/assets/*.js
src/asar/bundle/dist/index.html
src/asar/bundle/dist/activate.html
```

改完执行：

```powershell
powershell -ExecutionPolicy Bypass -File tools/sync_source.ps1
python tools/verify.py
```

`sync_source.ps1` 会：

1. `src/asar/bundle` → `runtime/resources/app.asar.unpacked/bundle`
2. 调用 `tools/sync_asar.py` 原位更新：
   - `bundle-integrity.json`
   - asar 头里每个文件的 `size` / `integrity.hash` / `blocks`
   - `Manke.exe` 里的 asar 头 SHA-256 清单

### 原位补丁的限制

`sync_asar.py` 不改 asar 头长度和数据偏移，适合：

- CSS/JS/HTML 内容修改；
- 文件大小位数不变（例如 `9285` 还是 4 位）。

如果头部 JSON 超出原容量，会报：

```
header too big: ... > ...
```

此时需要改成重打包 asar，或把大文件放回 `app.asar.unpacked` 并调整 `unpacked` 标记。

## 2. 构建安装包

```powershell
powershell -ExecutionPolicy Bypass -File tools/build_installer.ps1
```

输出：`dist\漫客_安装程序_v2.10.79_rebuild.exe`

脚本会生成 `installer/build.iss`，源目录为 `runtime/`，自动排除 `data`、`backends`、卸载器。

## 3. 构建便携包

```powershell
powershell -ExecutionPolicy Bypass -File tools/build_portable.ps1
```

输出：`dist\漫客_便携版_v2.10.79_rebuild.7z`

## 4. 校验

```powershell
python tools/verify.py
```

检查：

- asar 头 SHA-256 与 `Manke.exe` 清单一致；
- `bundle-integrity.json` 的 fileCount/totalBytes；
- `runtime/.../bundle` 下每个文件的实际 SHA-256。

期望输出：

```
header    ... manifest ... ok= True
integrity 1039 files 100026785 bytes
bundle mismatches: 0
```

## 5. 主进程修改

`main.cjs`、`preload.cjs` 在 asar 内部（packed）。当前工具只同步 `bundle/` 目录。
修改主进程需要：

1. 用解包/重打包工具更新 asar 中的 packed 文件；
2. 重新生成 `bundle-integrity.json`；
3. 更新 asar 头和 exe 清单。

可以先在 `src/asar/main.cjs` 里改，再按上述步骤重打包。
