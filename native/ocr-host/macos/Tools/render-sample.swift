// 开发工具：用 CoreText 把一段已知文字画成 8 位灰度 PNG（不隔行），作为 OCR 测试夹具 / 扫描 PDF 样本的图像。
// 用法：swift Tools/render-sample.swift <输出.png>
import Foundation
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "ocr-sample.png"
let width = 1200, height = 700
let gray = CGColorSpaceCreateDeviceGray()
guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                          space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue) else { fatalError("context") }
ctx.setFillColor(gray: 1, alpha: 1)
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

let lines = [
  ("凛狐扫描页识别测试", 56.0),
  ("这是一段用于验证本机文字识别的中文。", 40.0),
  ("扫描图像只在本机识别，不上传。", 40.0),
  ("Rimefox OCR sample page 2026", 40.0),
  ("Local recognition keeps scans private.", 40.0)
]
var y = Double(height) - 110
for (text, size) in lines {
  let font = CTFontCreateWithName("PingFang SC" as CFString, size, nil)
  let attrs: [NSAttributedString.Key: Any] = [.init(kCTFontAttributeName as String): font,
                                              .init(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1)]
  let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attrs))
  ctx.textPosition = CGPoint(x: 80, y: y)
  CTLineDraw(line, ctx)
  y -= size * 2.0
}
guard let image = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { fatalError("dest") }
CGImageDestinationAddImage(dest, image, [kCGImagePropertyPNGInterlaceType: 0] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { fatalError("write") }
print(out)
