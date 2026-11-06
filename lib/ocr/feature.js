// System OCR preview. Distribution/acceptance status is documented in native/ocr-host/README.md.
export const OCR_UI_ENABLED = true;
// Keep protocol support for future engines, but never select unavailable preview backends.
export function systemOcrPreviewChoice(value) { return value === 'off' ? 'off' : 'system'; }

// 本地组件发布元数据：{ macos | windows: { connector: url, sha256, downloadBytes, diskBytes } }。
// 指向本版本标签的平台：ZIP 已提交在 release-assets/ocr/ 时由 Release 工作流校验后自动附加；否则发布保留草稿等手动上传。
// 只放官方发布地址（GitHub Release 资产）；为空时设置页说明「安装包尚未发布」，下载按钮不可用。
// 扩展只在用户点击「下载」后打开该地址，不静默下载或执行安装程序。
export const OCR_COMPONENT_RELEASES = {
  "macos": {
    "connector": "https://github.com/Suethekitten/Rimefox/releases/download/v0.17.2/Rimefox-OCR-0.2.0-preview.2-macos-universal.zip",
    "sha256": "c0fd3751847aac93bb904c2edf599fef604fade7d93f2db0ed2b6e07e0bc0e5c",
    "downloadBytes": 108726,
    "diskBytes": 323988
  },
  "windows": {
    "connector": "https://github.com/Suethekitten/Rimefox/releases/download/v0.17.5/Rimefox-OCR-0.2.0-preview.2-windows-x64.zip",
    "sha256": "62b86ebcb6314480f131d0a7103d6281c12d4a4e253b5218d35f38f706f7c7db",
    "downloadBytes": 36697008,
    "diskBytes": 93050372
  }
};

// An unpublished or unverified asset must never become a clickable download.
export function verifiedOcrRelease(entry) {
  return entry && typeof entry.connector === 'string'
    && /^https:\/\/github\.com\/Suethekitten\/Rimefox\/releases\/download\/[^/]+\/[^/?#]+$/.test(entry.connector)
    && /^[a-f0-9]{64}$/i.test(entry.sha256 || '') ? entry : null;
}
