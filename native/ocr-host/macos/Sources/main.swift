// 凛狐 OCR 连接器（macOS）：Native Messaging 宿主，实现 docs/OCR-INTERFACE.md §3 的协议 v1。
// 系统 OCR 后端使用 Apple Vision（VNRecognizeTextRequest）；PaddleOCR 引擎包尚未提供，如实报告 engine_missing。
// stdout 只写协议帧；调试信息写 stderr。
import Foundation
import Vision
import ImageIO
import CoreGraphics

let componentVersion = "0.1.0"
let protocolVersion = 1
let maxHostMessageBytes = 1024 * 1024
let maxImageSide = 8192

// MARK: - 帧读写

let writeLock = NSLock()

func send(_ object: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
    if data.count > maxHostMessageBytes {
        let id = object["id"] as? String ?? "r0"
        let fallback: [String: Any] = ["v": protocolVersion, "id": id, "type": "result", "ok": false,
                                       "error": ["code": "too_large", "message": "result exceeds 1 MB"]]
        data = (try? JSONSerialization.data(withJSONObject: fallback, options: [])) ?? Data()
    }
    var length = UInt32(data.count).littleEndian // macOS 上的 Chrome / Edge 都是小端
    writeLock.lock()
    defer { writeLock.unlock() }
    let header = Data(bytes: &length, count: 4)
    FileHandle.standardOutput.write(header)
    FileHandle.standardOutput.write(data)
}

func log(_ text: String) {
    FileHandle.standardError.write(("[rimefox-ocr] " + text + "\n").data(using: .utf8)!)
}

func readExactly(_ count: Int) -> Data? {
    var buffer = Data()
    while buffer.count < count {
        let chunk = FileHandle.standardInput.readData(ofLength: count - buffer.count)
        if chunk.isEmpty { return nil } // EOF：浏览器关闭了端口
        buffer.append(chunk)
    }
    return buffer
}

func readMessage() -> [String: Any]? {
    guard let header = readExactly(4) else { return nil }
    let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
    if length == 0 || length > 64 * 1024 * 1024 { return nil }
    guard let body = readExactly(Int(length)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: body, options: [])) as? [String: Any]
}

func errorResult(_ id: String, _ code: String, _ message: String) -> [String: Any] {
    return ["v": protocolVersion, "id": id, "type": "result", "ok": false, "error": ["code": code, "message": message]]
}

// MARK: - Vision

func supportedLanguages() -> [String] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    return (try? request.supportedRecognitionLanguages()) ?? [] // 最低 macOS 12，见 build.sh
}

// 扩展传 BCP 47（zh-Hans / zh-Hant / en …）；Vision 用 en-US、ja-JP 等。按前缀匹配到 Vision 支持的标签。
func visionLanguages(for requested: [String], supported: [String]) -> [String] {
    var out: [String] = []
    for tag in requested {
        let lower = tag.lowercased()
        if let exact = supported.first(where: { $0.lowercased() == lower }) {
            if !out.contains(exact) { out.append(exact) }
            continue
        }
        let base = lower.split(separator: "-").first.map(String.init) ?? lower
        if let hit = supported.first(where: { $0.lowercased().hasPrefix(base + "-") || $0.lowercased() == base }) {
            if !out.contains(hit) { out.append(hit) }
        }
    }
    return out
}

func osVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion)"
}

func helloResponse(_ id: String) -> [String: Any] {
    let langs = supportedLanguages()
    var system: [String: Any] = ["id": "system", "name": "Apple Vision", "version": osVersionString(), "languages": langs]
    system["status"] = langs.isEmpty ? "unsupported" : "ready"
    let paddle: [String: Any] = ["id": "paddle", "status": "engine_missing", "name": "PaddleOCR",
                                 "message": "PaddleOCR engine pack is not installed"]
    return [
        "v": protocolVersion, "id": id, "type": "hello",
        "component": ["version": componentVersion, "platform": "darwin", "protocols": [protocolVersion]],
        "backends": [system, paddle]
    ]
}

final class Job {
    let id: String
    var request: VNRecognizeTextRequest?
    var cancelled = false
    init(id: String) { self.id = id }
}

let jobsLock = NSLock()
var jobs: [String: Job] = [:]
let workQueue = DispatchQueue(label: "rimefox.ocr.work") // 串行：一次只识别一张图

func recognize(_ message: [String: Any]) {
    let id = message["id"] as? String ?? "r0"
    guard (message["backend"] as? String) == "system" else {
        send(errorResult(id, "engine_missing", "PaddleOCR engine pack is not installed"))
        return
    }
    guard let image = message["image"] as? [String: Any],
          let base64 = image["data"] as? String,
          let width = image["width"] as? Int, let height = image["height"] as? Int,
          width > 0, height > 0, width <= maxImageSide, height <= maxImageSide,
          let data = Data(base64Encoded: base64),
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        send(errorResult(id, "bad_request", "invalid image"))
        return
    }
    let supported = supportedLanguages()
    let requested = (message["languages"] as? [String]) ?? []
    var languages = visionLanguages(for: requested, supported: supported)
    if !requested.isEmpty && languages.isEmpty {
        send(errorResult(id, "language_unavailable", "none of the requested languages is supported"))
        return
    }
    if languages.isEmpty {
        // 未指定语言：中文优先，同时识别英文。Vision 中文模型本身也能识别拉丁字母。
        languages = visionLanguages(for: ["zh-Hans", "zh-Hant", "en"], supported: supported)
    }

    let job = Job(id: id)
    jobsLock.lock(); jobs[id] = job; jobsLock.unlock()

    workQueue.async {
        defer { jobsLock.lock(); jobs[id] = nil; jobsLock.unlock() }
        if job.cancelled { return }
        let started = Date()
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = languages
        job.request = request
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            if job.cancelled { return }
            send(errorResult(id, "internal", error.localizedDescription))
            return
        }
        if job.cancelled { return }
        let w = Double(cgImage.width)
        let h = Double(cgImage.height)
        var lines: [[String: Any]] = []
        for observation in request.results ?? [] {
            guard let top = observation.topCandidates(1).first else { continue }
            let box = observation.boundingBox // 归一化，原点左下
            let x = Double(box.minX) * w
            let y = (1.0 - Double(box.maxY)) * h
            lines.append([
                "text": top.string,
                "confidence": Double(top.confidence),
                "box": [x, y, Double(box.width) * w, Double(box.height) * h].map { ($0 * 100).rounded() / 100 }
            ])
        }
        let elapsed = Int(Date().timeIntervalSince(started) * 1000)
        send([
            "v": protocolVersion, "id": id, "type": "result", "ok": true, "backend": "system",
            "engine": ["name": "Apple Vision", "version": osVersionString(), "model": "VNRecognizeTextRequest-accurate", "device": ""],
            "durationMs": elapsed,
            "lines": lines
        ])
    }
}

func cancel(_ message: [String: Any]) {
    guard let target = message["target"] as? String else { return }
    jobsLock.lock()
    let job = jobs[target]
    jobsLock.unlock()
    guard let job = job else { return }
    job.cancelled = true
    job.request?.cancel()
    send(errorResult(target, "cancelled", "cancelled"))
}

// MARK: - 主循环

if CommandLine.arguments.contains("--version") {
    print("rimefox-ocr-host \(componentVersion) (protocol \(protocolVersion))")
    exit(0)
}
if CommandLine.arguments.contains("--languages") {
    print(supportedLanguages().joined(separator: "\n"))
    exit(0)
}

log("started \(componentVersion)")
while let message = readMessage() {
    let id = message["id"] as? String ?? "r0"
    guard (message["v"] as? Int) == protocolVersion else {
        send(errorResult(id, "unsupported_protocol", "expected protocol \(protocolVersion)"))
        continue
    }
    switch message["type"] as? String {
    case "hello": send(helloResponse(id))
    case "recognize": recognize(message)
    case "cancel": cancel(message)
    default: send(errorResult(id, "bad_request", "unknown message type"))
    }
}
// stdin 关闭：等在途识别写完再退出（浏览器已断开时写失败也无妨）
workQueue.sync {}
exit(0)
