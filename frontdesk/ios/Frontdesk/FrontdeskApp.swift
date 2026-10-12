import SwiftUI

@main
struct FrontdeskApp: App {
    @StateObject private var call = CallController()

    var body: some Scene {
        WindowGroup {
            CallView()
                .environmentObject(call)
                .preferredColorScheme(.dark)
        }
    }
}
