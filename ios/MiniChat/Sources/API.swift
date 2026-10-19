import Foundation

struct APIError: LocalizedError {
    let status: Int
    let code: String
    let message: String

    var errorDescription: String? { message }
}

/// 服务端流式回复里的事件（见 docs/api.md「消息（流式）」）。
enum StreamEvent {
    struct Start { let userMessageID: String; let userCreatedAt: Int64; let assistantID: String; let tier: String; let model: String }
    struct Done { let id: String; let status: String; let finishReason: String?; let firstTokenMs: Int?; let totalMs: Int?; let updatedAt: Int64? }

    case start(Start)
    case delta(String)
    case done(Done)
    case failed(code: String, message: String)
}

struct APIClient {
    let base: URL
    let token: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        config.waitsForConnectivity = false
        return URLSession(configuration: config)
    }()

    private func request(_ method: String, _ path: String, body: [String: Any]? = nil) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: base) else { throw APIError(status: 0, code: "bad_url", message: "服务器地址不正确") }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        return request
    }

    private static func failure(_ status: Int, _ data: Data) -> APIError {
        if let body = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
            return APIError(status: status, code: body.error.code, message: body.error.message)
        }
        return APIError(status: status, code: "http_\(status)", message: "服务器返回 \(status)")
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await call("GET", path)
    }

    func call<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        let (data, response) = try await Self.session.data(for: request(method, path, body: body))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.failure(status, data) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func delete(_ path: String) async throws {
        let (data, response) = try await Self.session.data(for: request("DELETE", path))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Self.failure(status, data) }
    }

    /// 发起流式请求。取消任务即断开连接，服务端会把已生成的部分存为 incomplete。
    func stream(_ path: String, body: [String: Any]) -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var urlRequest = try self.request("POST", path, body: body)
                    urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    urlRequest.timeoutInterval = 180
                    let (bytes, response) = try await Self.session.bytes(for: urlRequest)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        throw Self.failure(status, data)
                    }
                    // 服务端每个事件只有一行 data，所以按行读：先记下 event，再处理紧跟的 data。
                    var event = ""
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            event = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let json = Data(line.dropFirst(5).utf8)
                            if let parsed = Self.parse(event: event, json: json) { continuation.yield(parsed) }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func parse(event: String, json: Data) -> StreamEvent? {
        guard let object = try? JSONSerialization.jsonObject(with: json) as? [String: Any] else { return nil }
        switch event {
        case "start":
            let user = object["userMessage"] as? [String: Any]
            return .start(.init(
                userMessageID: user?["id"] as? String ?? "",
                userCreatedAt: (user?["createdAt"] as? NSNumber)?.int64Value ?? Clock.nowMs,
                assistantID: object["assistantMessageId"] as? String ?? UUID().uuidString,
                tier: object["tier"] as? String ?? "",
                model: object["model"] as? String ?? ""
            ))
        case "delta":
            return (object["text"] as? String).map(StreamEvent.delta)
        case "done":
            let message = object["message"] as? [String: Any] ?? [:]
            let conversation = object["conversation"] as? [String: Any]
            return .done(.init(
                id: message["id"] as? String ?? "",
                status: message["status"] as? String ?? "complete",
                finishReason: message["finishReason"] as? String,
                firstTokenMs: (message["firstTokenMs"] as? NSNumber)?.intValue,
                totalMs: (message["totalMs"] as? NSNumber)?.intValue,
                updatedAt: (conversation?["updatedAt"] as? NSNumber)?.int64Value
            ))
        case "error":
            return .failed(code: object["code"] as? String ?? "upstream_error", message: object["message"] as? String ?? "出错了，请重试")
        default:
            return nil
        }
    }
}
