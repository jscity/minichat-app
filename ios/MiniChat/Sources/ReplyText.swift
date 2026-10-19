import SwiftUI

/// 回复的轻量 Markdown 渲染。系统的 CommonMark 解析在中文标点旁边认不出 `**加粗**`，
/// 所以自己处理最常见的几种：`**加粗**`、`` `代码` ``、`#` 标题（整行加粗）、`- ` 列表（换成 •）、``` 代码块围栏（隐藏）。
/// 流式输出时加粗还没闭合也能正常显示。
enum ReplyText {
    static func render(_ text: String, cursor: Bool) -> AttributedString {
        var result = AttributedString()
        let lines = text.components(separatedBy: "\n")
        for (index, raw) in lines.enumerated() {
            var line = Substring(raw)
            var heading = false
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if index < lines.count - 1 { continue }
                line = ""
            } else if let match = line.firstMatch(of: /^\s*#{1,6}\s+/) {
                line = line[match.range.upperBound...]
                heading = true
            } else if let match = line.firstMatch(of: /^(\s*)[-*+]\s+/) {
                line = match.output.1 + "• " + line[match.range.upperBound...]
            }
            var piece = inline(String(line))
            if heading { piece.inlinePresentationIntent = .stronglyEmphasized }
            result += piece
            if index < lines.count - 1 { result += AttributedString("\n") }
        }
        if cursor { result += AttributedString("▌") }
        return result
    }

    /// `**` 成对切换加粗，反引号切换等宽。
    private static func inline(_ line: String) -> AttributedString {
        var out = AttributedString()
        var bold = false
        var code = false
        var buffer = ""
        func flush() {
            guard !buffer.isEmpty else { return }
            var part = AttributedString(buffer)
            if bold { part.inlinePresentationIntent = .stronglyEmphasized }
            if code { part.font = .system(size: 16, design: .monospaced) }
            out += part
            buffer = ""
        }
        var rest = Substring(line)
        while !rest.isEmpty {
            if rest.hasPrefix("**") {
                flush()
                bold.toggle()
                rest = rest.dropFirst(2)
            } else if rest.hasPrefix("`") {
                flush()
                code.toggle()
                rest = rest.dropFirst()
            } else {
                buffer.append(rest.removeFirst())
            }
        }
        flush()
        return out
    }
}
