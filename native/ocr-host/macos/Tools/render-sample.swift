// 开发工具：用 CoreText 把一段已知文字画成 8 位灰度 PNG（不隔行），作为 OCR 测试夹具 / 扫描 PDF 样本的图像。
// 用法：
//   swift Tools/render-sample.swift <输出.png>
//       中英混排的正向夹具（test/fixtures/ocr-sample.png）
//   swift Tools/render-sample.swift --tilt <角度> --json <墨迹.json> <输出.png>
//       整页绕中心逆时针旋转若干度的英文夹具（test/fixtures/ocr-tilted.png），模拟放歪的扫描件；
//       JSON 记录每行墨迹在原图里的四个角（左上原点、像素），测试据此断言识别框盖住整行墨迹。
//       只用英文：Windows CI 只有英文 OCR 语言，同一夹具可在两个平台上验证。
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

var args = Array(CommandLine.arguments.dropFirst())
var tilt = 0.0
var jsonOut: String?
while let first = args.first, first.hasPrefix("--") {
  args.removeFirst()
  if first == "--tilt", let v = args.first, let d = Double(v) { tilt = d; args.removeFirst() }
  else if first == "--json", let v = args.first { jsonOut = v; args.removeFirst() }
  else { fatalError("unknown option " + first) }
}
let out = args.first ?? "ocr-sample.png"
let tilted = tilt != 0
let width = tilted ? 1600 : 1200, height = tilted ? 900 : 700
let gray = CGColorSpaceCreateDeviceGray()
guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                          space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { fatalError("context") }
ctx.setFillColor(gray: 1, alpha: 1)
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

let lines: [(String, Double)] = tilted ? [
  ("Tilted scan recognition sample", 52.0),
  ("Long lines on a slightly rotated page drift across the box", 38.0),
  ("so the left end sits lower than the right end of the line.", 38.0),
  ("Every recognized box must cover the whole line of ink.", 38.0),
  ("Rimefox OCR tilted fixture 2026", 38.0)
] : [
  ("凛狐扫描页识别测试", 56.0),
  ("这是一段用于验证本机文字识别的中文。", 40.0),
  ("扫描图像只在本机识别，不上传。", 40.0),
  ("Rimefox OCR sample page 2026", 40.0),
  ("Local recognition keeps scans private.", 40.0)
]

// CoreGraphics 坐标原点在左下；旋转绕页面中心，角度为正时逆时针（左端低、右端高）。
let center = CGPoint(x: Double(width) / 2, y: Double(height) / 2)
let theta = tilt * Double.pi / 180
func rotated(_ p: CGPoint) -> [Double] {
  let dx = Double(p.x - center.x), dy = Double(p.y - center.y)
  let x = Double(center.x) + dx * cos(theta) - dy * sin(theta)
  let y = Double(center.y) + dx * sin(theta) + dy * cos(theta)
  return [(x * 100).rounded() / 100, ((Double(height) - y) * 100).rounded() / 100] // 转成左上原点
}

if tilted {
  ctx.translateBy(x: center.x, y: center.y)
  ctx.rotate(by: CGFloat(theta))
  ctx.translateBy(x: -center.x, y: -center.y)
}
var ink: [[String: Any]] = []
var y = Double(height) - (tilted ? 150 : 110)
for (text, size) in lines {
  let font = CTFontCreateWithName((tilted ? "Helvetica" : "PingFang SC") as CFString, size, nil)
  let attrs: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): font,
                                              .init(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
  let x = tilted ? 120.0 : 80.0
  ctx.textPosition = .zero
  let b = CTLineGetImageBounds(line, ctx) // 相对文字原点的墨迹范围（未旋转）
  ctx.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(line, ctx)
  let x0 = x + Double(b.minX), x1 = x + Double(b.maxX), y0 = y + Double(b.minY), y1 = y + Double(b.maxY)
  ink.append(["text": text, "corners": [CGPoint(x: x0, y: y1), CGPoint(x: x1, y: y1), CGPoint(x: x1, y: y0), CGPoint(x: x0, y: y0)].map(rotated)])
  y -= size * 2.0
}
guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("dest") }
CGImageDestinationAddImage(dest, image, [kCGImagePropertyPNGInterlaceType: 0] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { fatalError("write") }
if let jsonOut {
  let doc: [String: Any] = ["width": width, "height": height, "tiltDegrees": tilt, "lines": ink]
  let data = try JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: URL(fileURLWithPath: jsonOut))
}
print(out)
