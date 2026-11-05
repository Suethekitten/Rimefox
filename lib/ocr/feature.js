// OCR 界面开关。接口、后台路由、设置页区块与阅读器识别流程都已就绪；
// 在本地组件通过 PDF-HANDOFF §5.3 第 1 步（含签名安装包）之前不对用户显示。
// 打开前须补齐 docs/OCR-INTERFACE.md §8 的清单。本地联调见同文档 §7。
export const OCR_UI_ENABLED = false;

// 已发布的本地组件安装包：{ macos: { connector: url, paddle: url }, windows: {...} }。
// 只放官方发布地址（GitHub Release 资产）；为空时设置页说明「安装包尚未发布」，下载按钮不可用。
// 扩展只在用户点击「下载」后打开该地址，不静默下载或执行安装程序。
export const OCR_COMPONENT_RELEASES = {};
