const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('aics', {
  /** 当前程序目录(向导第二屏要显示它; 主进程才知道真实路径) */
  appDir: () => ipcRenderer.invoke('aics:app-dir'),
  passwordActivate: (pw) => ipcRenderer.invoke('aics:password-activate', pw),

  /**
   * 授权状态（2026-10-28 122 P0-1）。
   * 打包态的权威判定在主进程 asar 内的 license-core；渲染层不再只信明文 `/api/license`。
   */
  licenseStatus: () => ipcRenderer.invoke('aics:license-status'),

  /** 打开 AutoDL.Art 登录窗口，扫码后保存网站登录态（force=true 时强制重新扫码） */
  autodlLogin: (opts) => ipcRenderer.invoke('aics:autodl-login', opts || {}),

  /** 当前 AutoDL 网站登录态是否已保存 */
  autodlStatus: () => ipcRenderer.invoke('aics:autodl-status'),

  /** 弹系统文件夹选择框。@returns 选中的路径; 用户取消返回 null */
  pickDir: () => ipcRenderer.invoke('aics:pick-dir'),

  /** 模型包目录专用选择框。@returns { canceled, dir, msg? } */
  pickModelsDir: (startDir = '') => ipcRenderer.invoke('aics:pick-models-dir', startDir),

  /** 批量下载：主进程只弹一次目录选择框，再把所有产物写入该目录。 */
  batchDownload: (items) => ipcRenderer.invoke('aics:batch-download', { items }),

  /** 把当前程序目录整个复制到 dest(主进程负责发进度)。@returns { ok, dest?, msg? } */
  moveTo: (dest) => ipcRenderer.invoke('aics:move-to', dest),

  /** 订阅搬家进度: { pct, copied, total, dest }。@returns 取消订阅的函数 */
  onMoveProgress: (cb) => {
    const h = (_e, p) => cb(p)
    ipcRenderer.on('aics:move-progress', h)
    return () => { try { ipcRenderer.off('aics:move-progress', h) } catch { /* ignore */ } }
  },

  /** 告诉主进程"首次运行向导走完了", 之后不再进向导 */
  finishFirstRun: () => ipcRenderer.invoke('aics:first-run-done'),

  /** 打开模型目录(装完引导用) */
  openModelsDir: () => ipcRenderer.invoke('aics:open-models-dir'),
})
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 