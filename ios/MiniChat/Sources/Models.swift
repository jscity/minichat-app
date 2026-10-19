import Foundation

/// 与服务端 docs/api.md 对应的数据结构。时间都是毫秒时间戳。

struct Tier: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let model: String
}

struct TiersResponse: Codable {
    let `default`: String
    let tiers: [Tier]
}

struct Conversation: Codable, Identifiable, Hashable {
    let id: String
    var title: String
    var folder: String?
    var pinned: Bool
    var archived: Bool
    var tier: String
    let createdAt: Int64
    var updatedAt: Int64
    var preview: String

    /// 列表里显示的预览：去掉 Markdown 记号，合并换行。
    var plainPreview: String {
        preview.replacingOccurrences(of: #"\*\*|__|`|^#+\s*"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
    }
}

struct ConversationList: Codable {
    let items: [Conversation]
    let nextBefore: Int64?
}

struct ConversationDetail: Codable {
    let conversation: Conversation
    let messages: [Message]
}

struct Message: Codable, Identifiable, Hashable {
    enum Local: String, Codable {
        /// 已发出，还没收到服务端确认。
        case sending
        /// 回复正在流式生成。
        case streaming
        /// 网络失败，可以用同一个 clientMessageId 重试。
        case failed
    }

    var id: String
    let role: String
    var content: String
    var status: String
    var createdAt: Int64
    var clientMessageId: String?
    var replyTo: String?
    var tier: String?
    var model: String?
    var finishReason: String?
    var errorCode: String?
    var firstTokenMs: Int?
    var totalMs: Int?
    /// 只在本机存在的状态，服务端不返回。
    var local: Local?

    var isUser: Bool { role == "user" }
}

struct Me: Codable {
    struct User: Codable { let id: String; let name: String }
    let user: User
}

struct APIErrorBody: Codable {
    struct Detail: Codable { let code: String; let message: String }
    let error: Detail
}

enum Clock {
    static var nowMs: Int64 { Int64(Date.now.timeIntervalSince1970 * 1000) }

    /// 列表里的时间：今天显示时分，昨天显示「昨天」，更早显示月日。
    static func short(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return date.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits)) }
        if calendar.isDateInYesterday(date) { return "昨天" }
        return date.formatted(.dateTime.month(.defaultDigits).day()).replacingOccurrences(of: " ", with: "")
    }
}
