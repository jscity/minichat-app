import SwiftUI

/// 会话列表：置顶在前，按最近更新排序。点一条打开；右滑归档，左滑删除；长按置顶、改名、归档、删除。
/// 底部「已归档」进入归档列表：右滑取消归档，左滑删除，点开照常查看。
struct ConversationListView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var showingArchived: Bool
    @State private var renaming: Conversation?
    @State private var newTitle = ""
    @State private var deleting: Conversation?

    private static let deleteRed = Color(red: 0.62, green: 0.16, blue: 0.12)

    init(archived: Bool = false) {
        _showingArchived = State(initialValue: archived)
    }

    var body: some View {
        ZStack {
            CRTBackground()
            VStack(spacing: 0) {
                header
                List {
                    if showingArchived {
                        archivedRows
                    } else {
                        activeRows
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .scrollIndicators(.hidden)
                .refreshable {
                    if showingArchived { await store.loadArchived() } else { await store.refresh() }
                }
            }
            CRTOverlay()
        }
        .task { await store.loadArchived() }
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
            if let deleting, !deleting.archived, !showingArchived {
                Button("改为归档") {
                    store.archive(deleting.id)
                    self.deleting = nil
                }
            }
            Button("取消", role: .cancel) { deleting = nil }
        }
    }

    private var header: some View {
        HStack(spacing: 14) {
            if showingArchived {
                Button {
                    Pip.play(.key)
                    showingArchived = false
                } label: {
                    Image(systemName: "chevron.left").font(.system(size: 22, weight: .bold))
                }
                .accessibilityLabel("返回会话列表")
            }
            Text(showingArchived ? "ARCHIVE" : "CHATS").font(Pip.label(17, weight: .heavy))
            Text("\(showingArchived ? store.archived.count : store.sortedConversations.count)").font(Pip.label(17, weight: .heavy))
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

    // MARK: 会话

    @ViewBuilder
    private var activeRows: some View {
        Button {
            Pip.play(.key)
            store.newChat()
            dismiss()
        } label: {
            Label("新对话", systemImage: "plus").font(Pip.label(17, weight: .heavy))
        }
        .buttonStyle(PipButtonStyle())
        .pipRow()

        ForEach(store.sortedConversations) { conversation in
            row(conversation)
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button {
                        Pip.play(.key)
                        store.archive(conversation.id)
                    } label: { Label("归档", systemImage: "archivebox") }
                    .tint(Pip.dim)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button { deleting = conversation } label: { Label("删除", systemImage: "trash") }
                        .tint(Self.deleteRed)
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

        if store.sortedConversations.isEmpty {
            Text("还没有会话").font(Pip.label(16)).foregroundStyle(Pip.dim)
                .frame(maxWidth: .infinity).padding(.top, 30).pipRow()
        }

        Button {
            Pip.play(.key)
            showingArchived = true
            Task { await store.loadArchived() }
        } label: {
            HStack {
                Image(systemName: "archivebox")
                Text("已归档 \(store.archived.count)").font(Pip.label(16, weight: .heavy))
                Spacer()
                Image(systemName: "chevron.right")
            }
            .foregroundStyle(Pip.dim)
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
        }
        .pipRow()
        Text("右滑归档 · 左滑删除 · 长按更多").font(Pip.label(13)).foregroundStyle(Pip.dim)
            .frame(maxWidth: .infinity).pipRow()
    }

    // MARK: 归档

    @ViewBuilder
    private var archivedRows: some View {
        ForEach(store.archived) { conversation in
            row(conversation)
                .swipeActions(edge: .leading, allowsFullSwipe: true) {
                    Button {
                        Pip.play(.key)
                        store.unarchive(conversation.id)
                    } label: { Label("取消归档", systemImage: "tray.and.arrow.up") }
                    .tint(Pip.dim)
                }
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    Button { deleting = conversation } label: { Label("删除", systemImage: "trash") }
                        .tint(Self.deleteRed)
                }
                .contextMenu {
                    Button("取消归档", systemImage: "tray.and.arrow.up") { store.unarchive(conversation.id) }
                    Button("删除", systemImage: "trash", role: .destructive) { deleting = conversation }
                }
        }
        if store.archived.isEmpty {
            Text("没有归档的会话").font(Pip.label(16)).foregroundStyle(Pip.dim)
                .frame(maxWidth: .infinity).padding(.top, 30).pipRow()
        } else {
            Text("右滑取消归档 · 左滑删除").font(Pip.label(13)).foregroundStyle(Pip.dim)
                .frame(maxWidth: .infinity).pipRow()
        }
    }

    // MARK: 行

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
        .background(selected ? Pip.bright.opacity(0.08) : Pip.background, in: Chamfer(cut: 10))
        .overlay(Chamfer(cut: 10).stroke(selected ? Pip.text : Pip.dim, lineWidth: 1.5))
        .glow(selected)
        .contentShape(Chamfer(cut: 10))
        .onTapGesture {
            Pip.play(.key)
            store.open(conversation.id)
            dismiss()
        }
        .pipRow()
    }
}

private extension View {
    /// List 行去掉系统的背景、分隔线和默认边距，保持 Pip-Boy 的样子。
    func pipRow() -> some View {
        listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
    }
}
