import SwiftUI
import UIKit

/// 设置：服务器地址和 Token 都用「从剪贴板粘贴」，不弹键盘。
struct SettingsView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var status = ""
    @State private var soundOn = Pip.soundEnabled

    var body: some View {
        ZStack {
            CRTBackground()
            VStack(spacing: 0) {
                HStack(spacing: 14) {
                    Text("SETTINGS").font(Pip.label(17, weight: .heavy))
                    Rectangle().fill(Pip.text).frame(height: 2).glow()
                    Button {
                        Pip.play(.key)
                        dismiss()
                    } label: {
                        Image(systemName: "xmark").font(.system(size: 22, weight: .bold))
                    }
                    .accessibilityLabel("关闭")
                }
                .foregroundStyle(Pip.text)
                .glow()
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                ScrollView {
                    VStack(spacing: 16) {
                        connection
                        sound
                        about
                    }
                    .padding(16)
                }
                .scrollIndicators(.hidden)
            }
            CRTOverlay()
        }
        .task { status = await store.checkConnection() }
    }

    private var connection: some View {
        Panel {
            VStack(alignment: .leading, spacing: 10) {
                TagLabel(text: "连接")
                Group {
                    Text("服务器  \(store.serverURL)")
                    Text("Token  \(store.token.isEmpty ? "未设置" : "••••" + store.token.suffix(4))")
                    Text("状态  \(status.isEmpty ? "…" : status)")
                }
                .font(Pip.label(15))
                .foregroundStyle(Pip.text)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                HStack(spacing: 8) {
                    Button { paste { store.serverURL = $0 } } label: { Text("粘贴地址").font(Pip.label(15, weight: .heavy)) }
                    Button { paste { store.token = $0 } } label: { Text("粘贴 Token").font(Pip.label(15, weight: .heavy)) }
                    Button {
                        Pip.play(.key)
                        Task { status = await store.checkConnection() }
                    } label: { Text("测试连接").font(Pip.label(15, weight: .heavy)) }
                }
                .buttonStyle(PipButtonStyle())
                HStack(spacing: 8) {
                    Button {
                        Pip.play(.key)
                        store.serverURL = "https://ai.home.xtvv.com"
                        Task { status = await store.checkConnection() }
                    } label: { Text("家庭服务器").font(Pip.label(15, weight: .heavy)) }
                        .buttonStyle(PipButtonStyle(selected: store.serverURL.contains("ai.home.xtvv.com")))
                    Button {
                        Pip.play(.key)
                        store.serverURL = "http://localhost:8790"
                        Task { status = await store.checkConnection() }
                    } label: { Text("本机调试").font(Pip.label(15, weight: .heavy)) }
                        .buttonStyle(PipButtonStyle(selected: store.serverURL.contains("localhost")))
                }
            }
            .glow()
        }
    }

    private var sound: some View {
        Panel {
            VStack(alignment: .leading, spacing: 10) {
                TagLabel(text: "声音")
                Button {
                    soundOn.toggle()
                    Pip.soundEnabled = soundOn
                    Pip.play(.key)
                } label: {
                    Text(soundOn ? "按键和打字音效：开" : "按键和打字音效：关").font(Pip.label(15, weight: .heavy))
                }
                .buttonStyle(PipButtonStyle(selected: soundOn))
                Text("手机静音时不会响。").font(Pip.label(14)).foregroundStyle(Pip.dim)
            }
            .glow()
        }
    }

    private var about: some View {
        Panel {
            VStack(alignment: .leading, spacing: 8) {
                TagLabel(text: "用法")
                Group {
                    Text("按住中间的键说话，松开发送；按住时上滑取消。")
                    Text("双击中间的键可以连续说，再单击发送。")
                    Text("想打字点左下角键盘。回复下面的「深入重答」用深入档重新回答。")
                    Text("会话列表里长按一条可以置顶、改名、归档、删除。")
                }
                .font(Pip.label(15))
                .foregroundStyle(Pip.text)
                let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
                let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
                Text("版本 \(version) (\(build))").font(Pip.label(13)).foregroundStyle(Pip.dim)
            }
            .glow()
        }
    }

    private func paste(_ apply: (String) -> Void) {
        Pip.play(.key)
        let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else {
            status = "剪贴板是空的"
            Pip.play(.error)
            return
        }
        apply(text)
        Task {
            status = await store.checkConnection()
            await store.refresh()
        }
    }
}
