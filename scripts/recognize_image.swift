// Offline OCR helper. Image bytes arrive on stdin; only recognized text leaves stdout.
import Foundation
import Vision
import ImageIO

func finish(_ value: [String: Any], status: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data)
    }
    exit(status)
}

let data = FileHandle.standardInput.readDataToEndOfFile()
guard !data.isEmpty, data.count <= 5 * 1024 * 1024,
      let source = CGImageSourceCreateWithData(data as CFData, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= 20000, height <= 20000,
      width * height <= 24_000_000 else {
    finish(["error": "invalid_image"], status: 1)
}
let orientation = CGImagePropertyOrientation(rawValue: (properties[kCGImagePropertyOrientation] as? UInt32) ?? 1) ?? .up
do {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let supported = try request.supportedRecognitionLanguages()
    let languages = ["ru-RU", "en-US", "kk-KZ"].filter { supported.contains($0) }
    request.recognitionLanguages = languages
    // Do not rewrite names, amounts, or unfamiliar Kazakh words with a dictionary.
    request.usesLanguageCorrection = false
    request.automaticallyDetectsLanguage = true
    let handler = VNImageRequestHandler(data: data, orientation: orientation, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    finish(["text": lines.joined(separator: "\n"), "languages": languages])
} catch {
    finish(["error": "recognition_failed"], status: 1)
}
