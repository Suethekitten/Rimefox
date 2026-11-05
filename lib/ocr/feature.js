// System OCR preview. Distribution/acceptance status is documented in native/ocr-host/README.md.
export const OCR_UI_ENABLED = true;
// Keep protocol support for future engines, but never select unavailable preview backends.
export function systemOcrPreviewChoice(value) { return value === 'off' ? 'off' : 'system'; }

// 本地组件发布元数据：{ windows: { connector: url, sha256, downloadBytes, diskBytes } }。
// 只放官方发布地址（GitHub Release 资产）；为空时设置页说明「安装包尚未发布」，下载按钮不可用。
// 扩展只在用户点击「下载」后打开该地址，不静默下载或执行安装程序。
export const OCR_COMPONENT_RELEASES = {
  "windows": {
    "connector": "https://github.com/Suethekitten/Rimefox/releases/download/v0.17.0/Rimefox-OCR-0.2.0-preview.1-windows-x64.zip",
    "sha256": "864ada187e900fd89709cefc25a7fb900f81cd3fa712e48f0906d5eaeaf4be0e",
    "downloadBytes": 36715487,
    "diskBytes": 93065313
  }
};

// An unpublished or unverified asset must never become a clickable download.
export function verifiedOcrRelease(entry) {
  return entry && typeof entry.connector === 'string'
    && /^https:\/\/github\.com\/Suethekitten\/Rimefox\/releases\/download\/[^/]+\/[^/?#]+$/.test(entry.connector)
    && /^[a-f0-9]{64}$/i.test(entry.sha256 || '') ? entry : null;
}
