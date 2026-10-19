import SwiftUI
import UIKit

/// 主界面：打开就是新对话，按住中间的键说话。左上角进会话列表，右上角设置。
struct ChatView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @State private var voice = VoiceControl()
    @State private var showList = false
    @State private var showSettings = false
    @State private var typing = false
    @State private var draft = ""
    @FocusState private var fieldFocused: Bool
    @State private var toast: String?
    @State private var toastID = 0
    @State private var lastTypeSound = Date.distantPast

    var body: some View {
        ZStack {
            CRTBackground()
            VStack(spacing: 0) {
                header
                tierBar
                messageList
                if voice.isActive { voicePanel }
                statusLine
                bottomBar
            }
            CRTOverlay()
        }
        .fullScreenCover(isPresented: $showList) { ConversationListView() }
        .fullScreenCover(isPresented: $showSettings) { SettingsView() }
        .onAppear {
            voice.onSubmit = { text in
                Pip.play(.send)
                store.send(text)
            }
            voice.onHint = { show($0) }
        }
        .task { await voice.speech.warmUp() }
        .task {
            await store.refresh()
            #if DEBUG
            // 模拟器截图用：启动参数 -debugOpen <会话id> / -debugSend <文字> / -debugShow list|settings|typing
            let defaults = UserDefaults.standard
            if let id = defaults.string(forKey: "debugOpen") { store.open(id) }
            if let text = defaults.string(forKey: "debugSend") { store.send(text) }
            switch defaults.string(forKey: "debugShow") {
            case "list": showList = true
            case "settings": showSettings = true
            case "typing": typing = true
            default: break
            }
            #endif
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await store.refresh() }
            } else if phase == .background {
                voice.end()
            }
        }
        .onChange(of: voice.speech.message) { _, message in
            if let message { show(message) }
        }
        .onChange(of: store.notice) { _, notice in
            if let notice {
                show(notice)
                store.notice = nil
            }
        }
        .onChange(of: store.tick) {
            // 回复逐字出现时的打字声，最多每 90 毫秒一下。
            if Date.now.timeIntervalSince(lastTypeSound) > 0.09 {
                lastTypeSound = .now
                Pip.play(.type)
            }
        }
    }

    // MARK: 顶部

    private var header: some View {
        HStack(spacing: 14) {
            Button {
                Pip.play(.key)
                showList = true
            } label: {
                Image(systemName: "list.bullet").font(.system(size: 22, weight: .bold))
            }
            .accessibilityLabel("会话列表")
            Text(store.current?.title ?? "新对话")
                .font(Pip.label(19, weight: .heavy))
                .lineLimit(1)
            Rectangle().fill(Pip.text).frame(height: 2).glow()
            Button {
                Pip.play(.key)
                voice.end()
                store.newChat()
                typing = false
            } label: {
                Image(systemName: "plus").font(.system(size: 22, weight: .bold))
            }
            .accessibilityLabel("新对话")
            Button {
                Pip.play(.key)
                showSettings = true
            } label: {
                Image(systemName: "gearshape.fill").font(.system(size: 20))
            }
            .accessibilityLabel("设置")
        }
        .foregroundStyle(Pip.text)
        .glow()
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 8)
    }

    private var tierBar: some View {
        HStack(spacing: 8) {
            ForEach(store.tiers) { tier in
                Button {
                    Pip.tap(.light)
                    Pip.play(.key)
                    store.setTier(tier.id)
                } label: {
                    Text(tier.label).font(Pip.label(15, weight: .heavy))
                }
                .buttonStyle(PipButtonStyle(selected: store.currentTier == tier.id, cut: 6))
                .disabled(store.isGenerating)
            }
        }
        .padding(.horizontal, 18)
        .padding(.bottom, 6)
    }

    // MARK: 消息

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if store.currentMessages.isEmpty { emptyState }
                    ForEach(store.currentMessages) { message in
                        MessageRow(message: message,
                                   isLastReply: message.id == store.currentMessages.last(where: { !$0.isUser })?.id,
                                   onRetry: { store.retry(message) },
                                   onDeep: { store.regenerate(tier: "deep") })
                            .id(message.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
            .scrollIndicators(.hidden)
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: store.tick) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: store.currentMessages.count) {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .task(id: store.currentID) {
                // 切换会话后消息是异步加载的，稍等一下再滚到底，懒加载的长列表才能定位准。
                for delay in [0.05, 0.4] {
                    try? await Task.sleep(for: .seconds(delay))
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Text("小红").font(.system(size: 64, weight: .black).width(.condensed))
            Text(store.token.isEmpty ? "先到右上角设置里粘贴 Token" : "按住下面的键说话，松开就发出去")
                .font(Pip.label(17))
            Text("双击可以连续说 · 上滑取消").font(Pip.label(14)).foregroundStyle(Pip.dim)
        }
        .foregroundStyle(Pip.text)
        .glow()
        .frame(maxWidth: .infinity)
        .padding(.top, 100)
    }

    /// 说话时显示正在识别的文字。
    private var voicePanel: some View {
        let text = voice.liveText
        return Text(text.isEmpty ? (voice.speech.phase == .starting ? "准备中…" : "正在听…") : "▌" + text)
            .font(Pip.label(18))
            .foregroundStyle(voice.willCancel ? Pip.dim : Pip.text)
            .glow(!voice.willCancel)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay(Chamfer(cut: 10).stroke(voice.willCancel ? Pip.dim : Pip.text, lineWidth: 1.5))
            .padding(.horizontal, 16)
            .padding(.bottom, 4)
    }

    private var statusLine: some View {
        Text(statusText)
            .font(Pip.label(15))
            .foregroundStyle(Pip.text)
            .glow()
            .lineLimit(1)
            .padding(.horizontal, 20)
            .frame(height: 24)
    }

    private var statusText: String {
        if voice.mode == .holding { return voice.willCancel ? "松开取消" : "松开发送 · 上滑取消" }
        if voice.mode == .continuous { return "连续说话中 · 单击发送" }
        if let toast { return toast }
        if store.isGenerating { return "小红正在回复 · 点 ■ 停止" }
        switch store.connection {
        case .offline: return "离线 · 显示的是本机缓存"
        case .unauthorized: return "Token 无效"
        case .notConfigured: return "未连接服务器"
        default: return " "
        }
    }

    // MARK: 底部

    @ViewBuilder
    private var bottomBar: some View {
        if typing {
            HStack(spacing: 10) {
                TextField("", text: $draft, prompt: Text("打字…").foregroundStyle(Pip.dim), axis: .vertical)
                    .font(Pip.label(18, weight: .semibold))
                    .foregroundStyle(Pip.text)
                    .lineLimit(1...5)
                    .focused($fieldFocused)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .overlay(Chamfer(cut: 8).stroke(Pip.dim, lineWidth: 1.5))
                    .submitLabel(.send)
                Button {
                    sendDraft()
                } label: {
                    Image(systemName: store.isGenerating ? "stop.fill" : "arrow.up")
                        .font(.system(size: 20, weight: .black))
                        .frame(width: 46, height: 46)
                }
                .buttonStyle(PipButtonStyle(cut: 8))
                .frame(width: 52)
                Button {
                    Pip.play(.key)
                    fieldFocused = false
                    typing = false
                } label: {
                    Image(systemName: "mic.fill").font(.system(size: 22, weight: .bold)).frame(width: 40, height: 46)
                }
                .foregroundStyle(Pip.text)
                .accessibilityLabel("改用语音")
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .glow()
            .onAppear { fieldFocused = true }
        } else {
            HStack {
                Button {
                    Pip.play(.key)
                    voice.end()
                    typing = true
                } label: {
                    Image(systemName: "keyboard").font(.system(size: 24))
                        .frame(width: 90, height: 60, alignment: .leading)
                }
                .foregroundStyle(Pip.text)
                .glow()
                .accessibilityLabel("改用打字")
                Spacer()
                if store.isGenerating {
                    StopButton { store.stop() }
                } else {
                    MicButton(voice: voice)
                }
                Spacer()
                Button {
                    Pip.play(.key)
                    showList = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "text.bubble").font(.system(size: 22))
                        Text("\(store.sortedConversations.count)").font(Pip.label(16, weight: .heavy))
                    }
                    .frame(width: 90, height: 60, alignment: .trailing)
                }
                .foregroundStyle(Pip.text)
                .glow()
                .accessibilityLabel("会话列表")
            }
            .padding(.horizontal, 22)
            // 离屏幕底边远一点：贴近底边的触摸会被系统的主屏手势延迟识别，按下会慢半拍。
            .padding(.bottom, 24)
        }
    }

    private func sendDraft() {
        if store.isGenerating {
            store.stop()
            return
        }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        Pip.play(.send)
        store.send(text)
        draft = ""
    }

    private func show(_ text: String) {
        toast = text
        toastID += 1
        let id = toastID
        Task {
            try? await Task.sleep(for: .seconds(4))
            if toastID == id { toast = nil }
        }
    }
}

/// 一条消息。用户的话靠右放在切角框里；小红的回复靠左，像终端输出。
struct MessageRow: View {
    @Environment(ChatStore.self) private var store
    let message: Message
    let isLastReply: Bool
    let onRetry: () -> Void
    let onDeep: () -> Void

    var body: some View {
        if message.isUser { userBubble } else { reply }
    }

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(message.content)
                .font(Pip.label(18, weight: .semibold))
                .foregroundStyle(Pip.text)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Pip.bright.opacity(0.06), in: Chamfer(cut: 8))
                .overlay(Chamfer(cut: 8).stroke(Pip.dim, lineWidth: 1.5))
            if message.local == .failed {
                Button("发送失败 · 点这里重试", action: onRetry)
                    .font(Pip.label(14, weight: .heavy))
                    .foregroundStyle(Pip.bright)
            } else if message.local == .sending {
                Text("发送中…").font(Pip.label(13)).foregroundStyle(Pip.dim)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 48)
        .glow()
    }

    private var reply: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text("小红 >").font(Pip.label(13, weight: .heavy))
                if let tier = message.tier, tier != "fast" {
                    Text(store.tierLabel(tier)).font(Pip.label(12, weight: .heavy))
                        .foregroundStyle(Pip.background)
                        .padding(.horizontal, 6)
                        .background(Pip.dim, in: Chamfer(cut: 3))
                }
            }
            .foregroundStyle(Pip.dim)
            Text(rendered)
                .font(.system(size: 17, weight: .regular))
                .lineSpacing(4)
                .foregroundStyle(Pip.text)
                .textSelection(.enabled)
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .glow()
        .contextMenu {
            Button("复制") { UIPasteboard.general.string = message.content }
        }
    }

    /// 流式时末尾加光标。
    private var rendered: AttributedString {
        ReplyText.render(message.content, cursor: message.local == .streaming)
    }

    @ViewBuilder
    private var footer: some View {
        let note: String? = switch (message.status, message.finishReason) {
        case ("incomplete", _): "（已中断）"
        case ("error", _): "（出错了，没说完）"
        case (_, "length"): "（回答较长，已截断）"
        default: nil
        }
        if note != nil || (isLastReply && message.local == nil && !store.isGenerating) {
            HStack(spacing: 12) {
                if let note { Text(note).font(Pip.label(14)).foregroundStyle(Pip.dim) }
                Spacer()
                if isLastReply, message.local == nil, !store.isGenerating, store.hasDeepTier {
                    Button {
                        Pip.play(.key)
                        onDeep()
                    } label: {
                        Text(message.tier == "deep" ? "再深入答一次" : "深入重答").font(Pip.label(14, weight: .heavy))
                    }
                    .buttonStyle(PipButtonStyle(cut: 5))
                    .frame(width: 120)
                }
            }
        }
    }
}

/// 中间的语音键：按住说话；双击连续输入，再单击发送。手势逻辑见 VoiceControl。
struct MicButton: View {
    let voice: VoiceControl
    @State private var pulse = false

    var body: some View {
        let lit = voice.isActive && !voice.willCancel
        let continuous = voice.mode == .continuous
        ZStack {
            Circle()
                .fill(lit ? Pip.text : Pip.bright.opacity(0.05))
                .overlay(Circle().stroke(Pip.dim, lineWidth: 2))
            if continuous {
                Circle().stroke(Pip.text, lineWidth: 2).padding(-8)
                    .scaleEffect(pulse ? 1.1 : 1)
                    .opacity(pulse ? 0.3 : 1)
                    .animation(.easeInOut(duration: 0.8).repeatForever(), value: pulse)
                    .onAppear { pulse = true }
                    .onDisappear { pulse = false }
            } else if lit {
                Circle().stroke(Pip.text.opacity(0.6), lineWidth: 2).padding(-7)
            }
            Image(systemName: voice.willCancel ? "xmark" : continuous ? "waveform" : "mic.fill")
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(lit ? Pip.background : Pip.text)
        }
        .frame(width: 78, height: 78)
        .glow()
        .scaleEffect(voice.mode == .holding ? 0.94 : 1)
        .animation(.easeOut(duration: 0.1), value: voice.mode)
        .contentShape(Circle())
        .voiceGesture(voice)
        .accessibilityLabel(continuous ? "连续说话中，单击发送" : "按住说话，松开发送")
    }
}

/// 回复生成中，语音键变成停止键。
struct StopButton: View {
    let action: () -> Void

    var body: some View {
        Button {
            Pip.tap()
            Pip.play(.key)
            action()
        } label: {
            ZStack {
                Circle().fill(Pip.bright.opacity(0.05)).overlay(Circle().stroke(Pip.text, lineWidth: 2))
                Image(systemName: "stop.fill").font(.system(size: 26, weight: .bold)).foregroundStyle(Pip.text)
            }
            .frame(width: 78, height: 78)
            .glow()
        }
        .accessibilityLabel("停止回复")
    }
}
