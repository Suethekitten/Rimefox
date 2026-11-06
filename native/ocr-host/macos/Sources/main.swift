// System OCR preview: Native Messaging protocol v1, Apple Vision, macOS 12+.
import Foundation
import CoreFoundation
import Vision
import ImageIO
import CoreGraphics
import Darwin

let componentVersion = "0.2.0-preview.2"
let protocolVersion = 1
let maxImageSide = 8192
let jobsLock = NSLock()
let writeLock = NSLock()
let workQueue = DispatchQueue(label: "rimefox.ocr.serial")
func validID(_ id: String) -> Bool { id.range(of: "^[A-Za-z0-9_-]{1,64}$", options: .regularExpression) != nil }
func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          number.doubleValue.isFinite, number.doubleValue.rounded(.towardZero) == number.doubleValue,
          abs(number.doubleValue) <= Double(Int32.max) else { return nil }
    return number.intValue
}
func errorResult(_ id: String, _ code: String, _ message: String) -> [String: Any] {
    ["v": 1, "id": id, "type": "result", "ok": false, "error": ["code": code, "message": message]]
}
func send(_ message: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: message) else { return }
    if data.count >= 1024 * 1024 {
        data = (try? JSONSerialization.data(withJSONObject: errorResult(message["id"] as? String ?? "r0", "too_large", "result exceeds 1 MB"))) ?? Data()
    }
    var length = UInt32(data.count).littleEndian
    writeLock.lock(); defer { writeLock.unlock() }
    FileHandle.standardOutput.write(Data(bytes: &length, count: 4))
    FileHandle.standardOutput.write(data)
}
func readExactly(_ count: Int) -> Data? {
    var data = Data()
    while data.count < count {
        let part = FileHandle.standardInput.readData(ofLength: count - data.count)
        if part.isEmpty { return nil }
        data.append(part)
    }
    return data
}
func osVersionString() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}
func supportedLanguages() -> [String] {
    let request = VNRecognizeTextRequest(); request.recognitionLevel = .accurate
    return (try? request.supportedRecognitionLanguages()) ?? []
}
func canonical(_ tag: String) -> String {
    let tag = tag.lowercased()
    if ["zh-cn", "zh-sg"].contains(tag) { return "zh-hans" }
    if ["zh-tw", "zh-hk", "zh-mo"].contains(tag) { return "zh-hant" }
    return tag
}
func visionLanguages(for requested: [String], supported: [String]) -> [String] {
    var result: [String] = []
    for tag in requested {
        let wanted = canonical(tag)
        let hit = supported.first { canonical($0) == wanted }
            ?? supported.first { canonical($0).hasPrefix(wanted + "-") }
        if let hit = hit, !result.contains(hit) { result.append(hit) }
    }
    return result
}
func helloResponse(_ id: String) -> [String: Any] {
    let languages = supportedLanguages()
    return ["v": 1, "id": id, "type": "hello",
        "component": ["version": componentVersion, "platform": "darwin", "protocols": [1]],
        "backends": [
            ["id": "system", "name": "Apple Vision", "version": osVersionString(),
             "model": "VNRecognizeTextRequest-accurate:" + componentVersion,
             "status": languages.isEmpty ? "language_unavailable" : "ready", "languages": languages],
            ["id": "paddle", "name": "PaddleOCR", "status": "engine_missing"]
        ]]
}
final class Job {
    let id: String
    var cancelled = false
    var replied = false
    var request: VNRecognizeTextRequest?
    init(_ id: String) { self.id = id }
}
var jobs: [String: Job] = [:]
func isCancelled(_ job: Job) -> Bool {
    jobsLock.lock(); defer { jobsLock.unlock() }; return job.cancelled
}
func finish(_ job: Job, _ message: [String: Any]) {
    jobsLock.lock()
    let reply = !job.replied && !job.cancelled
    job.replied = true
    jobsLock.unlock()
    if reply { send(message) }
}
func fail(_ job: Job, _ code: String, _ message: String) { finish(job, errorResult(job.id, code, message)) }
func recognize(_ message: [String: Any], _ job: Job) {
    defer { jobsLock.lock(); jobs[job.id] = nil; jobsLock.unlock() }
    if isCancelled(job) { return }
    let backend = message["backend"] as? String ?? ""
    if backend == "paddle" { fail(job, "engine_missing", "PaddleOCR is not part of this preview"); return }
    guard backend == "system", let image = message["image"] as? [String: Any],
          let mime = image["mime"] as? String, ["image/png", "image/jpeg"].contains(mime),
          let base64 = image["data"] as? String,
          let width = integer(image["width"]), let height = integer(image["height"]),
          width > 0, height > 0, width <= maxImageSide, height <= maxImageSide else {
        fail(job, "bad_request", "invalid image fields"); return
    }
    guard base64.count <= 32 * 1024 * 1024 else { fail(job, "too_large", "image exceeds base64 limit"); return }
    guard !base64.isEmpty, base64.count % 4 == 0, let bytes = Data(base64Encoded: base64),
          let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let actualWidth = props[kCGImagePropertyPixelWidth] as? Int,
          let actualHeight = props[kCGImagePropertyPixelHeight] as? Int,
          actualWidth == width, actualHeight == height,
          let type = CGImageSourceGetType(source) as String?,
          type == (mime == "image/png" ? "public.png" : "public.jpeg"),
          let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail(job, "bad_request", "decoded image differs from its dimensions or MIME type"); return
    }
    if isCancelled(job) { return }
    let supported = supportedLanguages()
    var requested: [String] = []
    if let raw = message["languages"] {
        guard let list = raw as? [String], list.count <= 8,
              list.allSatisfy({ $0.range(of: "^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$", options: .regularExpression) != nil }) else {
            fail(job, "bad_request", "invalid recognition languages"); return
        }
        requested = list
    }
    let preferences = requested.isEmpty ? ["zh-Hans", "zh-Hant", "en"] : requested
    let languages = visionLanguages(for: preferences, supported: supported)
    guard !languages.isEmpty else { fail(job, "language_unavailable", "no matching recognition language"); return }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = languages
    jobsLock.lock()
    job.request = request
    let cancelled = job.cancelled
    jobsLock.unlock()
    if cancelled { return }
    let started = Date()
    do { try VNImageRequestHandler(cgImage: cgImage, options: [:]).perform([request]) }
    catch { if !isCancelled(job) { fail(job, "internal", "Apple Vision failed: " + error.localizedDescription) }; return }
    if isCancelled(job) { return }
    var lines: [[String: Any]] = []
    var total = 0
    for observation in request.results ?? [] {
        guard let top = observation.topCandidates(1).first else { continue }
        total += top.string.utf16.count
        guard lines.count < 5000, top.string.utf16.count <= 4000, total <= 300000 else {
            fail(job, "too_large", "recognized text exceeds protocol limits"); return
        }
        let b = observation.boundingBox
        let w = Double(width), h = Double(height)
        let box: [Double] = [Double(b.minX) * w, (1.0 - Double(b.maxY)) * h,
                             Double(b.width) * w, Double(b.height) * h]
        let roundedBox: [Double] = box.map { ($0 * 100.0).rounded() / 100.0 }
        let line: [String: Any] = ["text": top.string, "confidence": Double(top.confidence), "box": roundedBox]
        lines.append(line)
    }
    finish(job, ["v": 1, "id": job.id, "type": "result", "ok": true, "backend": "system",
        "engine": ["name": "Apple Vision", "version": osVersionString(), "model": "VNRecognizeTextRequest-accurate:" + componentVersion],
        "durationMs": Int(Date().timeIntervalSince(started) * 1000), "lines": lines])
}
func enqueue(_ message: [String: Any], _ id: String) {
    jobsLock.lock()
    if jobs[id] != nil { jobsLock.unlock(); send(errorResult(id, "bad_request", "duplicate request id")); return }
    if jobs.count >= 8 { jobsLock.unlock(); send(errorResult(id, "busy", "recognition queue is full")); return }
    let job = Job(id); jobs[id] = job
    jobsLock.unlock()
    workQueue.async { recognize(message, job) }
}
func cancel(_ target: String) {
    jobsLock.lock()
    guard let job = jobs[target] else { jobsLock.unlock(); return }
    let reply = !job.replied
    job.cancelled = true; job.replied = true
    let request = job.request
    jobsLock.unlock()
    request?.cancel()
    if reply { send(errorResult(target, "cancelled", "cancelled")) }
}
func printJSON(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else { exit(1) }
    print(text)
}
let args = CommandLine.arguments
if args.contains("--version") { print("rimefox-ocr-host \(componentVersion) (protocol 1)"); exit(0) }
if args.contains("--languages") { print(supportedLanguages().joined(separator: "\n")); exit(0) }
if args.contains("--diagnose") {
    let languages = supportedLanguages()
    #if arch(arm64)
    let architecture = "arm64"
    #else
    let architecture = "x86_64"
    #endif
    printJSON(["version": componentVersion, "protocol": 1, "platform": "darwin", "architecture": architecture,
        "osVersion": osVersionString(), "languages": languages, "apiStatus": languages.isEmpty ? "language_unavailable" : "ready"])
    exit(0)
}
if let index = args.firstIndex(of: "--host-manifest") {
    guard args.count > index + 2 else { exit(2) }
    let path = args[index + 1], ids = Array(Set(args.dropFirst(index + 2))).sorted()
    guard path.hasPrefix("/"), !ids.isEmpty,
          ids.allSatisfy({ $0.range(of: "^[a-p]{32}$", options: .regularExpression) != nil }) else { exit(2) }
    printJSON(["name": "com.rimefox.ocr", "description": "Rimefox system OCR preview", "path": path,
        "type": "stdio", "allowed_origins": ids.map { "chrome-extension://\($0)/" }])
    exit(0)
}
signal(SIGPIPE, SIG_IGN)
while let header = readExactly(4) {
    let length = header.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }.littleEndian
    if length == 0 || length > 64 * 1024 * 1024 { break }
    guard let body = readExactly(Int(length)) else { break }
    guard let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else {
        send(errorResult("r0", "bad_request", "invalid JSON")); continue
    }
    let id = message["id"] as? String ?? "r0"
    guard validID(id) else { send(errorResult("r0", "bad_request", "invalid request id")); continue }
    guard integer(message["v"]) == 1 else { send(errorResult(id, "unsupported_protocol", "expected protocol 1")); continue }
    switch message["type"] as? String {
    case "hello": send(helloResponse(id))
    case "recognize": enqueue(message, id)
    case "cancel": cancel(message["target"] as? String ?? "")
    default: send(errorResult(id, "bad_request", "unknown message type"))
    }
}
// Browser disconnect ends the process, including any outstanding Vision request.
exit(0)
