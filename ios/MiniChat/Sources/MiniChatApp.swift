import SwiftUI

@main
struct MiniChatApp: App {
    @State private var store = ChatStore()

    var body: some Scene {
        WindowGroup {
            ChatView()
                .environment(store)
                .preferredColorScheme(.dark)
                .tint(Pip.text)
        }
    }
}
