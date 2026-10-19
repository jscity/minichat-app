// 生成 App 图标：Pip-Boy 绿底上一个发光的「红」字，加切角边框和扫描线（风格同「取件码」图标）。
// 运行：swift tools/make_icon.swift Sources/Assets.xcassets/AppIcon.appiconset/icon.png
// 输出不带透明通道（App 图标不能有 alpha）。
import AppKit

let output = URL(fileURLWithPath: CommandLine.arguments[1])
let size = 1024
let full = NSRect(x: 0, y: 0, width: size, height: size)
// 不带 alpha 的位图上下文
let cg = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                   space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
NSGraphicsContext.current = NSGraphicsContext(cgContext: cg, flipped: false)
let pip = NSColor(red: 0.66, green: 1, blue: 0.66, alpha: 1)
NSColor(red: 0.012, green: 0.04, blue: 0.016, alpha: 1).setFill()
full.fill()
NSGradient(colors: [NSColor(red: 0.49, green: 1, blue: 0.54, alpha: 0.18), NSColor(red: 0.012, green: 0.04, blue: 0.016, alpha: 1)])!
    .draw(in: full, relativeCenterPosition: .zero)

// 「红」字，两层阴影做 CRT 发光
let font = NSFont.systemFont(ofSize: 600, weight: .black)
let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: pip]
let glyph = NSAttributedString(string: "红", attributes: attrs)
let bounds = glyph.boundingRect(with: full.size, options: [.usesLineFragmentOrigin, .usesFontLeading])
let origin = NSPoint(x: (CGFloat(size) - bounds.width) / 2, y: (CGFloat(size) - bounds.height) / 2 - 10)
cg.saveGState()
cg.setShadow(offset: .zero, blur: 50, color: pip.withAlphaComponent(0.7).cgColor)
glyph.draw(at: origin)
cg.setShadow(offset: .zero, blur: 12, color: pip.withAlphaComponent(0.9).cgColor)
glyph.draw(at: origin)
cg.restoreGState()

// 切角边框
let inset: CGFloat = 64, cut: CGFloat = 110
let r = full.insetBy(dx: inset, dy: inset)
let frame = NSBezierPath()
frame.move(to: NSPoint(x: r.minX + cut, y: r.minY)); frame.line(to: NSPoint(x: r.maxX - cut, y: r.minY))
frame.line(to: NSPoint(x: r.maxX, y: r.minY + cut)); frame.line(to: NSPoint(x: r.maxX, y: r.maxY - cut))
frame.line(to: NSPoint(x: r.maxX - cut, y: r.maxY)); frame.line(to: NSPoint(x: r.minX + cut, y: r.maxY))
frame.line(to: NSPoint(x: r.minX, y: r.maxY - cut)); frame.line(to: NSPoint(x: r.minX, y: r.minY + cut)); frame.close()
frame.lineWidth = 16
cg.saveGState()
cg.setShadow(offset: .zero, blur: 28, color: pip.withAlphaComponent(0.8).cgColor)
pip.withAlphaComponent(0.85).setStroke()
frame.stroke()
cg.restoreGState()

// 扫描线
NSColor.black.withAlphaComponent(0.18).setFill()
for y in stride(from: 0, to: size, by: 8) { NSRect(x: 0, y: y, width: size, height: 3).fill() }
NSGraphicsContext.current = nil
try! NSBitmapImageRep(cgImage: cg.makeImage()!).representation(using: .png, properties: [:])!.write(to: output)
print("icon written")
