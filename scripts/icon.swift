// Generates the ChessNext app icon: dark rounded square + gold knight glyph.
// Usage: swift icon.swift <output.png> [size]
import AppKit

let size = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2])! : 512
let output = CommandLine.arguments[1]

let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()

// background: dark slate, rounded
NSColor(calibratedRed: 0.06, green: 0.08, blue: 0.10, alpha: 1.0).setFill()
NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: size, height: size),
             xRadius: CGFloat(size) * 0.18, yRadius: CGFloat(size) * 0.18).fill()

// subtle inner border accent
NSColor(calibratedRed: 0.83, green: 0.65, blue: 0.36, alpha: 0.35).setStroke()
let border = NSBezierPath(roundedRect: NSRect(x: CGFloat(size) * 0.05, y: CGFloat(size) * 0.05,
                                              width: CGFloat(size) * 0.9, height: CGFloat(size) * 0.9),
                          xRadius: CGFloat(size) * 0.14, yRadius: CGFloat(size) * 0.14)
border.lineWidth = CGFloat(size) * 0.012
border.stroke()

// gold knight glyph
let fontSize = CGFloat(size) * 0.62
let font = NSFont(name: "Apple Symbols", size: fontSize) ?? NSFont.systemFont(ofSize: fontSize)
let attrs: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: NSColor(calibratedRed: 0.83, green: 0.65, blue: 0.36, alpha: 1.0)
]
let str = NSAttributedString(string: "\u{265E}", attributes: attrs) // ♞
let strSize = str.size()
str.draw(at: NSPoint(x: (CGFloat(size) - strSize.width) / 2,
                     y: (CGFloat(size) - strSize.height) / 2 - CGFloat(size) * 0.04))

img.unlockFocus()

guard let tiff = img.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let png = rep.representation(using: .png, properties: [:]) else {
    fputs("failed to render PNG\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: output))
print("wrote \(output) (\(size)x\(size))")
