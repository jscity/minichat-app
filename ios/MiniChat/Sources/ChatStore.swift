import Foundation
import Observation

/// 会话列表、当前会话的消息、发送与流式接收。服务器为准，本机 JSON 只做缓存，打开 App 先显示缓存。
@MainActor
@Observable
final class ChatStore {
    enum Connection: Equatable { case unknown, online, offline, unauthorized, notConfigured }

    private(set) var conversations: [Conversation] = []
    private(set) var messages: [String: [Message]] = [:]
    private(set) var tiers: [Tier] = [Tier(id: "fast", label: "快速", model: "")]
    private(set) var defaultTier = "fast"
    private(set) var connection: Connection = .unknown
    private(set) var userName: String?
    /// 当前会话；nil 表示「新对话」，发第一条消息时才在服务器上创建。
    private(set) var currentID: String?
    /// 新对话时选的档位；已有会话用会话自己的 tier。
    private(set) var draftTier = "fast"
    private(set) var isGenerating = false
    /// 每收到一段回复文字 +1，界面用它滚动到底部、播放打字声。
    private(set) var tick = 0
    /// 需要提示用户的一句话（出错、断网等），界面显示后清空。
    var notice: String?

    var serverURL: String {
        didSet { UserDefaults.standard.set(serverURL, forKey: "serverURL") }
    }
    var token: String {
        didSet { UserDefaults.standard.set(token, forKey: "token") }
    }

    private var streamTask: Task<Void, Never>?
    private let cacheURL = URL.applicationSupportDirectory.appending(path: "minichat-cache.json")

    private struct Cache: Codable {
        var conversations: [Conversation]
        var messages: [String: [Message]]
        var tiers: [Tier]
        var defaultTier: String
    }

    init() {
        serverURL = UserDefaults.standard.string(forKey: "serverURL")
            ?? Bundle.main.object(forInfoDictionaryKey: "MiniChatServer") as? String
            ?? "https://ai.home.xtvv.com"
        token = UserDefaults.standard.string(forKey: "token") ?? ""
        if let data = try? Data(contentsOf: cacheURL), let cache = try? JSONDecoder().decode(Cache.self, from: data) {
            conversations = cache.conversations
            // 上次没收完的流式回复，打开时按中断显示；刷新会话时以服务器为准。
            messages = cache.messages.mapValues { list in
                list.map { message in
                    var message = message
                    if message.local == .streaming || message.local == .sending { message.local = message.isUser ? .failed : nil }
                    return message
                }
            }
            if !cache.tiers.isEmpty { tiers = cache.tiers }
            defaultTier = cache.defaultTier
            draftTier = cache.defaultTier
        }
    }

    // MARK: 视图用

    var current: Conversation? { currentID.flatMap { id in conversations.first { $0.id == id } } }
    var currentMessages: [Message] { currentID.flatMap { messages[$0] } ?? [] }
    var currentTier: String { current?.tier ?? draftTier }
    var sortedConversations: [Conversation] {
        conversations.filter { !$0.archived }.sorted { ($0.pinned ? 1 : 0, $0.updatedAt) > ($1.pinned ? 1 : 0, $1.updatedAt) }
    }

    func tierLabel(_ id: String?) -> String {
        guard let id else { return "" }
        return tiers.first { $0.id == id }?.label ?? id
    }

    var hasDeepTier: Bool { tiers.contains { $0.id == "deep" } }

    private var client: APIClient? {
        guard !token.isEmpty, let url = URL(string: serverURL.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
        return APIClient(base: url, token: token)
    }

    // MARK: 同步

    /// 拉取档位和会话列表；打开 App、回到前台、下拉刷新时调用。
    func refresh() async {
        guard let client else { connection = .notConfigured; return }
        do {
            async let tiersResult: TiersResponse = client.get("/api/tiers")
            async let listResult: ConversationList = client.get("/api/conversations?limit=200")
            let (t, list) = try await (tiersResult, listResult)
            tiers = t.tiers
            defaultTier = t.default
            if currentID == nil, !tiers.contains(where: { $0.id == draftTier }) { draftTier = t.default }
            // 正在生成的会话保留本地版本，其余以服务器为准。
            conversations = list.items
            connection = .online
            if let id = currentID, !isGenerating { await loadMessages(id) }
            save()
        } catch {
            handle(error)
        }
    }

    func checkConnection() async -> String {
        guard let client else { connection = .notConfigured; return "还没有填 Token" }
        do {
            let me: Me = try await client.get("/api/me")
            userName = me.user.name
            connection = .online
            return "已连接：\(me.user.name)"
        } catch {
            handle(error)
            return error.localizedDescription
        }
    }

    private func loadMessages(_ id: String) async {
        guard let client else { return }
        do {
            let detail: ConversationDetail = try await client.get("/api/conversations/\(id)")
            // 加载期间开始了新的生成，就不要覆盖本地的流式内容。
            guard !(isGenerating && currentID == id) else { return }
            messages[id] = detail.messages
            upsert(detail.conversation)
            save()
        } catch let error as APIError where error.status == 404 {
            conversations.removeAll { $0.id == id }
            messages[id] = nil
            if currentID == id { currentID = nil }
            save()
        } catch {
            handle(error)
        }
    }

    private func handle(_ error: Error) {
        if let error = error as? APIError {
            if error.status == 401 { connection = .unauthorized; notice = "Token 无效，请到设置里重新粘贴" }
            else { notice = error.message }
        } else if (error as? URLError)?.code == .cancelled || error is CancellationError {
            return
        } else {
            connection = .offline
            notice = "连不上服务器，请检查网络"
        }
    }

    // MARK: 会话

    func open(_ id: String) {
        guard id != currentID else { return }
        stop()
        currentID = id
        Task { await loadMessages(id) }
    }

    func newChat() {
        stop()
        currentID = nil
        draftTier = defaultTier
    }

    func setTier(_ id: String) {
        guard tiers.contains(where: { $0.id == id }) else { return }
        guard let conversation = current else { draftTier = id; return }
        update(conversation.id, fields: ["tier": id]) { $0.tier = id }
    }

    func rename(_ id: String, to title: String) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        update(id, fields: ["title": title]) { $0.title = title }
    }

    func togglePin(_ id: String) {
        guard let conversation = conversations.first(where: { $0.id == id }) else { return }
        update(id, fields: ["pinned": !conversation.pinned]) { $0.pinned.toggle() }
    }

    func archive(_ id: String) {
        update(id, fields: ["archived": true]) { $0.archived = true }
        if currentID == id { newChat() }
    }

    func delete(_ id: String) {
        conversations.removeAll { $0.id == id }
        messages[id] = nil
        if currentID == id { newChat() }
        save()
        guard let client else { return }
        Task {
            do { try await client.delete("/api/conversations/\(id)") } catch { handle(error) }
        }
    }

    /// 先改本地再发请求；失败时以服务器为准重新拉取。
    private func update(_ id: String, fields: [String: Any], local: (inout Conversation) -> Void) {
        if let index = conversations.firstIndex(where: { $0.id == id }) {
            local(&conversations[index])
            save()
        }
        guard let client else { return }
        Task {
            do {
                let updated: Conversation = try await client.call("PATCH", "/api/conversations/\(id)", body: fields)
                upsert(updated)
                save()
            } catch {
                handle(error)
                await refresh()
            }
        }
    }

    private func upsert(_ conversation: Conversation) {
        if let index = conversations.firstIndex(where: { $0.id == conversation.id }) {
            conversations[index] = conversation
        } else {
            conversations.insert(conversation, at: 0)
        }
    }

    // MARK: 发消息

    func send(_ text: String) {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, !isGenerating else { return }
        guard let client else { notice = "先到设置里粘贴 Token"; connection = .notConfigured; return }
        let clientID = UUID().uuidString
        let tier = currentTier
        isGenerating = true
        streamTask = Task {
            var conversationID = currentID
            if conversationID == nil {
                do {
                    let created: Conversation = try await client.call("POST", "/api/conversations", body: ["tier": tier])
                    upsert(created)
                    currentID = created.id
                    conversationID = created.id
                } catch {
                    handle(error)
                    isGenerating = false
                    return
                }
            }
            guard let id = conversationID else { return }
            let user = Message(id: "local-\(clientID)", role: "user", content: content, status: "complete",
                               createdAt: Clock.nowMs, clientMessageId: clientID, local: .sending)
            messages[id, default: []].append(user)
            await run(id: id, path: "/api/conversations/\(id)/messages",
                      body: ["content": content, "clientMessageId": clientID, "tier": tier], userLocalID: user.id, replacing: nil)
        }
    }

    /// 网络失败的消息用同一个 clientMessageId 重发，服务端不会产生重复消息。
    func retry(_ message: Message) {
        guard message.isUser, let clientID = message.clientMessageId, let id = currentID, !isGenerating, client != nil else { return }
        isGenerating = true
        if let index = messages[id]?.firstIndex(where: { $0.id == message.id }) { messages[id]?[index].local = .sending }
        messages[id]?.removeAll { $0.replyTo == message.id }
        streamTask = Task {
            await run(id: id, path: "/api/conversations/\(id)/messages",
                      body: ["content": message.content, "clientMessageId": clientID, "tier": currentTier], userLocalID: message.id, replacing: nil)
        }
    }

    /// 用指定档位（默认「深入」）重新回答最后一条用户消息，替换原回答。
    func regenerate(tier: String = "deep") {
        guard let id = currentID, !isGenerating, client != nil,
              let lastUser = currentMessages.last(where: \.isUser) else { return }
        let old = currentMessages.last(where: { !$0.isUser && ($0.replyTo == lastUser.id || $0.replyTo == nil) })
        isGenerating = true
        streamTask = Task {
            await run(id: id, path: "/api/conversations/\(id)/regenerate", body: ["tier": tier], userLocalID: lastUser.id, replacing: old?.id)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// 读流式回复。`replacing`：深入重答时要替换的旧回答，收到第一段文字时才移除，失败时保留。
    private func run(id: String, path: String, body: [String: Any], userLocalID: String, replacing oldID: String?) async {
        guard let client else { isGenerating = false; return }
        var assistantID: String?
        var userID = userLocalID
        var removedOld = false

        func indexOf(_ messageID: String?) -> Int? {
            guard let messageID else { return nil }
            return messages[id]?.firstIndex { $0.id == messageID }
        }

        do {
            for try await event in client.stream(path, body: body) {
                switch event {
                case .start(let start):
                    if let index = indexOf(userID) {
                        messages[id]?[index].id = start.userMessageID
                        messages[id]?[index].createdAt = start.userCreatedAt
                        messages[id]?[index].local = nil
                    }
                    userID = start.userMessageID
                    assistantID = start.assistantID
                    let reply = Message(id: start.assistantID, role: "assistant", content: "", status: "complete",
                                        createdAt: Clock.nowMs, replyTo: start.userMessageID, tier: start.tier, model: start.model, local: .streaming)
                    // 深入重答时旧回答先保留，第一段文字到了再移除（见 delta）。
                    messages[id, default: []].append(reply)
                case .delta(let text):
                    if let oldID, !removedOld {
                        messages[id]?.removeAll { $0.id == oldID }
                        removedOld = true
                    }
                    if let index = indexOf(assistantID) { messages[id]?[index].content += text }
                    tick += 1
                case .done(let done):
                    if let index = indexOf(assistantID) {
                        messages[id]?[index].status = done.status
                        messages[id]?[index].finishReason = done.finishReason
                        messages[id]?[index].firstTokenMs = done.firstTokenMs
                        messages[id]?[index].totalMs = done.totalMs
                        messages[id]?[index].local = nil
                        let preview = messages[id]?[index].content ?? ""
                        if let conversation = conversations.firstIndex(where: { $0.id == id }) {
                            conversations[conversation].preview = String(preview.prefix(60))
                            if let updatedAt = done.updatedAt { conversations[conversation].updatedAt = updatedAt }
                        }
                    }
                    Pip.play(.done)
                case .failed(_, let message):
                    if let index = indexOf(assistantID) {
                        if removedOld || oldID == nil {
                            messages[id]?[index].status = "error"
                            messages[id]?[index].local = nil
                        } else {
                            messages[id]?.remove(at: index)
                        }
                    }
                    notice = message
                    Pip.play(.error)
                }
            }
        } catch {
            let cancelled = Task.isCancelled || (error as? URLError)?.code == .cancelled || error is CancellationError
            if let index = indexOf(assistantID) {
                let empty = messages[id]?[index].content.isEmpty ?? true
                if empty && oldID != nil && !removedOld {
                    messages[id]?.remove(at: index)
                } else {
                    messages[id]?[index].status = cancelled ? "incomplete" : "error"
                    messages[id]?[index].local = nil
                }
            } else if !cancelled, let index = indexOf(userID) {
                // 还没收到服务端确认：标成发送失败，可以点重试。
                messages[id]?[index].local = .failed
            }
            if !cancelled {
                handle(error)
                Pip.play(.error)
            }
        }
        // 新会话的第一条回复后，服务端会在后台生成标题，过几秒拉一次列表。
        let needsTitle = messages[id]?.filter(\.isUser).count == 1
        isGenerating = false
        streamTask = nil
        save()
        if needsTitle {
            Task {
                try? await Task.sleep(for: .seconds(6))
                if !isGenerating { await refresh() }
            }
        }
    }

    // MARK: 缓存

    private func save() {
        let cache = Cache(conversations: conversations, messages: messages, tiers: tiers, defaultTier: defaultTier)
        guard let data = try? JSONEncoder().encode(cache) else { return }
        try? FileManager.default.createDirectory(at: cacheURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: cacheURL, options: .atomic)
    }
}
