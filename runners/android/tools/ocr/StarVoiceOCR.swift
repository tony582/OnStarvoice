// StarVoice local OCR helper (macOS Vision). No network, no model service.
// Protocol: one JSON request per stdin line {"id": "...", "path": "/abs.png", "roi": [x, y, w, h]?};
// one JSON reply per stdout line {"id": "...", "ok": true, "ms": 512, "width": 1080, "height": 2242,
// "rows": [{"text", "conf", "x", "y", "w", "h"}]} in image pixels, top-left origin. Requests run concurrently
// (at most --concurrency, default 3); replies may come back out of order. EOF on stdin ends the process.
import Foundation
import Vision
import ImageIO

let arguments = CommandLine.arguments
var concurrency = 3
if let index = arguments.firstIndex(of: "--concurrency"), index + 1 < arguments.count, let value = Int(arguments[index + 1]) {
  concurrency = max(1, min(6, value))
}
if arguments.contains("--version") { print("starvoice-ocr 1"); exit(0) }

let output = DispatchQueue(label: "starvoice.ocr.output")
let slots = DispatchSemaphore(value: concurrency)
let group = DispatchGroup()

func reply(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
        let line = String(data: data, encoding: .utf8) else { return }
  output.sync { FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!) }
}

func recognize(id: String, path: String, roi: [Double]?) {
  let started = Date()
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    reply(["id": id, "ok": false, "error": "image_unreadable"]); return
  }
  let width = Double(image.width), height = Double(image.height)
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  request.usesLanguageCorrection = false
  if let roi = roi, roi.count == 4, roi[2] > 0, roi[3] > 0 {
    // Vision regions are normalized with a bottom-left origin.
    let x = max(0, min(1, roi[0] / width)), w = max(0, min(1 - x, roi[2] / width))
    let top = max(0, min(1, roi[1] / height)), h = max(0, min(1 - top, roi[3] / height))
    request.regionOfInterest = CGRect(x: x, y: 1 - top - h, width: w, height: h)
  }
  do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
  } catch {
    reply(["id": id, "ok": false, "error": "recognition_failed"]); return
  }
  let region = request.regionOfInterest
  var rows: [[String: Any]] = []
  for observation in request.results ?? [] {
    guard let top = observation.topCandidates(1).first else { continue }
    // Boxes are normalized to the region of interest; map them back to whole-image pixels.
    let box = observation.boundingBox
    let minX = region.minX + box.minX * region.width, maxY = region.minY + box.maxY * region.height
    rows.append(["text": top.string, "conf": Double(top.confidence),
      "x": Int((minX * width).rounded()), "y": Int(((1 - maxY) * height).rounded()),
      "w": Int((box.width * region.width * width).rounded()), "h": Int((box.height * region.height * height).rounded())])
  }
  reply(["id": id, "ok": true, "ms": Int(Date().timeIntervalSince(started) * 1000),
    "width": Int(width), "height": Int(height), "rows": rows])
}

// Vision needs a live main run loop: a main thread blocked in readLine() made each request take ~44 s
// (measured 2026-11-05). Requests are read on a background thread; the main thread only runs dispatchMain().
let reader = Thread {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let id = object["id"] as? String, let path = object["path"] as? String else {
      reply(["id": "", "ok": false, "error": "invalid_request"]); continue
    }
    let roi = (object["roi"] as? [NSNumber])?.map { $0.doubleValue }
    slots.wait()
    group.enter()
    DispatchQueue.global(qos: .userInitiated).async {
      recognize(id: id, path: path, roi: roi)
      slots.signal()
      group.leave()
    }
  }
  group.notify(queue: .main) { exit(0) }
}
reader.start()
dispatchMain()
