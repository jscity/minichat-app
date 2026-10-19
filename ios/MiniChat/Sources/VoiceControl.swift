import Foundation
import Observation
import SwiftUI

/// 语音键的手势逻辑（沿用「取件码」的手感）：
/// - 按住说话，松开发送；按下那一刻就开始收音，不等手势判定。
/// - 按住时往上滑超过一段距离，松开就取消，不发送。
/// - 快速双击进入连续输入；连续输入中单击（或双击）发送并退出。
/// - 单击一下（不按住）不算输入，丢弃并提示用法。
/// - 连续输入 60 秒没听到内容自动结束并发送已说的内容。
@MainActor
@Observable
final class VoiceControl {
    enum Mode { case idle, holding, tapPending, continuous }

    private(set) var mode: Mode = .idle
    /// 按住时已上滑到取消区。
    private(set) var willCancel = false
    /// 这一轮已经确定的文字；正在识别的部分在 `speech.partial`。
    private(set) var transcript = ""
    let speech = SpeechService()
    /// 说完要发送的文字。
    var onSubmit: ((String) -> Void)?
    /// 需要提示时回调（误触、没听清、自动结束）。
    var onHint: ((String) -> Void)?

    var isActive: Bool { mode != .idle || speech.isActive }
    var liveText: String { transcript + speech.partial }

    static let cancelDistance: CGFloat = 70
    private static let holdThreshold = 0.3
    private static let doubleTapWindow = 0.3
    private static let idleTimeout = 60.0

    private var downAt = Date.distantPast
    private var ignoreTouchesUntil = Date.distantPast
    private var tapTimer: Task<Void, Never>?
    private var idleWatch: Task<Void, Never>?

    init() {
        speech.onFinal = { [weak self] text in self?.transcript += text }
    }

    func touchDown() {
        let now = Date.now
        guard now >= ignoreTouchesUntil else { return }
        switch mode {
        case .idle:
            mode = .holding
            willCancel = false
            downAt = now
            begin()
        case .tapPending:
            // 第二下：进入连续输入，刚才开始的收音继续
            tapTimer?.cancel()
            mode = .continuous
            Pip.tap(.heavy)
            Pip.play(.micOn)
            watchIdle()
        case .continuous:
            // 连续输入中单击：发送并退出；吞掉紧跟着的第二下，双击也只算一次
            ignoreTouchesUntil = now.addingTimeInterval(0.4)
            commit()
        case .holding:
            break
        }
    }

    /// 按住时手指的竖向位移（向上为负）。
    func drag(_ dy: CGFloat) {
        guard mode == .holding else { return }
        let cancel = dy < -Self.cancelDistance
        if cancel != willCancel {
            willCancel = cancel
            Pip.tap(.light)
        }
    }

    func touchUp() {
        guard mode == .holding else { return }
        if willCancel {
            discard(hint: "已取消")
        } else if Date.now.timeIntervalSince(downAt) >= Self.holdThreshold {
            commit()
        } else {
            mode = .tapPending
            tapTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(Self.doubleTapWindow))
                guard !Task.isCancelled, let self, self.mode == .tapPending else { return }
                self.discard(hint: "按住说话，松开发送；双击可连续说")
            }
        }
    }

    /// 离开页面、进入后台时调用：丢弃，不发送半句话。
    func end() {
        guard mode != .idle || speech.isActive else { return }
        discard(hint: nil)
    }

    private func begin() {
        Pip.tap()
        Pip.play(.micOn)
        transcript = ""
        Task { [weak self] in
            guard let self else { return }
            await self.speech.start(hints: ["小红"])
            // 启动失败（没权限、模型不可用等）时复位
            if self.speech.phase == .idle, self.mode != .idle {
                self.mode = .idle
                self.idleWatch?.cancel()
            }
        }
    }

    private func commit() {
        tapTimer?.cancel()
        idleWatch?.cancel()
        mode = .idle
        willCancel = false
        Pip.play(.micOff)
        Task {
            await speech.stop()
            let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            transcript = ""
            if text.isEmpty { onHint?("没听清，再说一次") } else { onSubmit?(text) }
        }
    }

    private func discard(hint: String?) {
        tapTimer?.cancel()
        idleWatch?.cancel()
        mode = .idle
        willCancel = false
        Task {
            await speech.cancel()
            transcript = ""
        }
        if let hint {
            Pip.play(.error)
            onHint?(hint)
        }
    }

    private func watchIdle() {
        idleWatch?.cancel()
        idleWatch = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard let self, self.mode == .continuous else { return }
                if Date.now.timeIntervalSince(self.speech.lastActivity) > Self.idleTimeout {
                    self.onHint?("一分钟没听到内容，已结束")
                    self.commit()
                    return
                }
            }
        }
    }
}

extension View {
    /// 把语音键手势挂到任意视图上：按下立即触发，不经过按钮的点击判定。
    func voiceGesture(_ control: VoiceControl) -> some View {
        modifier(VoiceGesture(control: control))
    }
}

private struct VoiceGesture: ViewModifier {
    let control: VoiceControl
    @State private var pressing = false

    func body(content: Content) -> some View {
        content.gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { value in
                    if !pressing {
                        pressing = true
                        control.touchDown()
                    }
                    control.drag(value.translation.height)
                }
                .onEnded { _ in
                    pressing = false
                    control.touchUp()
                }
        )
    }
}
