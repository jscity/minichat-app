import SwiftUI

/// 会话列表：置顶在前，按最近更新排序。点一条打开；长按置顶、改名、归档、删除。
struct ConversationListView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var renaming: Conversation?
    @State private var newTitle = ""
    @State private var deleting: Conversation?

    var body: some View {
        ZStack {
            CRTBackground()
            VStack(spacing: 0) {
                header
                ScrollView {
                    LazyVStack(spacing: 10) {
                        Button {
                            Pip.play(.key)
                            store.newChat()
                            dismiss()
                        } label: {
                            Label("新对话", systemImage: "plus").font(Pip.label(17, weight: .heavy))
                        }
                        .buttonStyle(PipButtonStyle())
                        ForEach(store.sortedConversations) { conversation in
                            row(conversation)
                        }
                        if store.sortedConversations.isEmpty {
                            Text("还没有会话").font(Pip.label(16)).foregroundStyle(Pip.dim).padding(.top, 40)
                        }
                    }
                    .padding(16)
                }
                .scrollIndicators(.hidden)
                .refreshable { await store.refresh() }
            }
            CRTOverlay()
        }
        .alert("改名", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("标题", text: $newTitle)
            Button("取消", role: .cancel) { renaming = nil }
            Button("保存") {
                if let renaming { store.rename(renaming.id, to: newTitle) }
                renaming = nil
            }
        }
        .confirmationDialog("删除后不能恢复。只是不想看到可以归档。", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible) {
            Button("删除「\(deleting?.title ?? "")」", role: .destructive) {
                if let deleting { store.delete(deleting.id) }
                Pip.play(.error)
                deleting = nil
            }
            Button("归档") {
                if let deleting { store.archive(deleting.id) }
                deleting = nil
            }
            Button("取消", role: .cancel) { deleting = nil }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            Text("CHATS").font(Pip.label(17, weight: .heavy))
            Text("\(store.sortedConversations.count)").font(Pip.label(17, weight: .heavy))
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
    }

    private func row(_ conversation: Conversation) -> some View {
        let selected = conversation.id == store.currentID
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                if conversation.pinned { Image(systemName: "pin.fill").font(.system(size: 13)) }
                Text(conversation.title).font(Pip.label(18, weight: .heavy)).lineLimit(1)
                Spacer()
                Text(Clock.short(conversation.updatedAt)).font(Pip.label(13)).foregroundStyle(Pip.dim)
            }
            if !conversation.plainPreview.isEmpty {
                Text(conversation.plainPreview).font(Pip.label(14)).foregroundStyle(Pip.dim).lineLimit(2)
            }
        }
        .foregroundStyle(Pip.text)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Pip.bright.opacity(0.08) : .clear, in: Chamfer(cut: 10))
        .overlay(Chamfer(cut: 10).stroke(selected ? Pip.text : Pip.dim, lineWidth: 1.5))
        .glow(selected)
        .contentShape(Chamfer(cut: 10))
        .onTapGesture {
            Pip.play(.key)
            store.open(conversation.id)
            dismiss()
        }
        .contextMenu {
            Button(conversation.pinned ? "取消置顶" : "置顶", systemImage: "pin") { store.togglePin(conversation.id) }
            Button("改名", systemImage: "pencil") {
                newTitle = conversation.title
                renaming = conversation
            }
            Button("归档", systemImage: "archivebox") { store.archive(conversation.id) }
            Button("删除", systemImage: "trash", role: .destructive) { deleting = conversation }
        }
    }
}
