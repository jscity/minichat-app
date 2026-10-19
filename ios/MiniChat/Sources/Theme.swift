import AudioToolbox
import SwiftUI
import UIKit

/// Pip-Boy 绿色 CRT 风格。
enum Pip {
    static let background = Color(red: 0.012, green: 0.04, blue: 0.016)
    static let text = Color(red: 0.66, green: 1.0, blue: 0.66)
    static let bright = Color(red: 0.49, green: 1.0, blue: 0.54)
    static let dim = Color(red: 0.2, green: 0.5, blue: 0.24)
    static let line = Color(red: 0.11, green: 0.3, blue: 0.14)

    static func digits(_ size: CGFloat) -> Font {
        .system(size: size, weight: .heavy).width(.condensed).monospacedDigit()
    }

    static func label(_ size: CGFloat, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight).width(.condensed)
    }

    static func tap(_ style: UIImpactFeedbackGenerator.FeedbackStyle = .medium) {
        UIImpactFeedbackGenerator(style: style).impactOccurred()
    }

    enum Sound: String, CaseIterable {
        case key, micOn = "mic_on", micOff = "mic_off", send, type, done, success, error
    }

    /// 音效开关，设置页里切换；默认开。
    static var soundEnabled: Bool {
        get { UserDefaults.standard.object(forKey: "soundEnabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "soundEnabled") }
    }

    private static let soundIDs: [Sound: SystemSoundID] = {
        var ids: [Sound: SystemSoundID] = [:]
        for sound in Sound.allCases {
            guard let url = Bundle.main.url(forResource: sound.rawValue, withExtension: "wav") else { continue }
            var id: SystemSoundID = 0
            if AudioServicesCreateSystemSoundID(url as CFURL, &id) == noErr { ids[sound] = id }
        }
        return ids
    }()

    /// 系统音效通道：延迟低，静音开关打开时自动不响。音效文件由 tools/make_sounds.py 生成。
    static func play(_ sound: Sound) {
        guard soundEnabled, let id = soundIDs[sound] else { return }
        AudioServicesPlaySystemSound(id)
    }
}

extension View {
    func glow(_ on: Bool = true) -> some View {
        shadow(color: Pip.bright.opacity(on ? 0.55 : 0), radius: 3)
            .shadow(color: Pip.bright.opacity(on ? 0.25 : 0), radius: 10)
    }
}

/// 四角切角的矩形，模仿截图里的面板边框。
struct Chamfer: Shape {
    var cut: CGFloat = 12

    func path(in r: CGRect) -> Path {
        let c = min(cut, r.width / 4, r.height / 4)
        var p = Path()
        p.move(to: CGPoint(x: r.minX + c, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX - c, y: r.minY))
        p.addLine(to: CGPoint(x: r.maxX, y: r.minY + c))
        p.addLine(to: CGPoint(x: r.maxX, y: r.maxY - c))
        p.addLine(to: CGPoint(x: r.maxX - c, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX + c, y: r.maxY))
        p.addLine(to: CGPoint(x: r.minX, y: r.maxY - c))
        p.addLine(to: CGPoint(x: r.minX, y: r.minY + c))
        p.closeSubpath()
        return p
    }
}

/// 扫描线 + 暗角，盖在最上层，不拦截点击。
struct CRTOverlay: View {
    var body: some View {
        ZStack {
            Canvas { context, size in
                var y: CGFloat = 0
                while y < size.height {
                    context.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 1)), with: .color(.black.opacity(0.22)))
                    y += 3
                }
            }
            RadialGradient(colors: [.clear, .black.opacity(0.55)], center: .center, startRadius: 180, endRadius: 620)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

struct CRTBackground: View {
    var body: some View {
        ZStack {
            Pip.background
            RadialGradient(colors: [Pip.bright.opacity(0.07), .clear], center: .center, startRadius: 0, endRadius: 500)
        }
        .ignoresSafeArea()
    }
}

/// 截图里「取件码 /////」那种标签。
struct TagLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            Text(text)
                .font(Pip.label(17, weight: .heavy))
                .foregroundStyle(Pip.background)
                .padding(.horizontal, 12)
                .padding(.vertical, 3)
                .background(Pip.text, in: Chamfer(cut: 6))
            Text("/////")
                .font(Pip.label(17, weight: .black))
                .foregroundStyle(Pip.dim)
        }
    }
}

struct PipButtonStyle: ButtonStyle {
    var selected = false
    var cut: CGFloat = 8

    func makeBody(configuration: Configuration) -> some View {
        let lit = selected || configuration.isPressed
        configuration.label
            .foregroundStyle(lit ? Pip.background : Pip.text)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(lit ? Pip.text : Pip.bright.opacity(0.04), in: Chamfer(cut: cut))
            .overlay(Chamfer(cut: cut).stroke(Pip.dim, lineWidth: 1.5))
            .glow(!lit)
            .contentShape(Chamfer(cut: cut))
    }
}

struct Panel<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(12)
            .overlay(Chamfer(cut: 16).stroke(Pip.dim, lineWidth: 2))
            .overlay(Chamfer(cut: 16).stroke(Pip.bright.opacity(0.15), lineWidth: 6).blur(radius: 4))
    }
}
