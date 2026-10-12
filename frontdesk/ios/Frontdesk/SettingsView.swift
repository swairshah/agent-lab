import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(Server.urlKey) private var serverURL = ""
    @State private var token = Keychain.token
    @State private var result: String?
    @State private var testing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://my-mac.tailnet.ts.net", text: $serverURL)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Server")
                } footer: {
                    Text("The address of `npm run web` on your computer, and its FRONTDESK_TOKEN.")
                }

                Section {
                    Button {
                        Task { await test() }
                    } label: {
                        HStack {
                            Text("Test connection")
                            Spacer()
                            if testing { ProgressView() }
                        }
                    }
                    .disabled(testing || serverURL.isEmpty)
                    if let result {
                        Text(result)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        Keychain.token = token
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func test() async {
        Keychain.token = token
        testing = true
        defer { testing = false }
        guard let server = Server.current() else {
            result = "Enter a full URL, starting with http:// or https://"
            return
        }
        do {
            let info = try await server.info()
            if info.frontend == "voice" {
                result = "Connected · \(info.models.voice) → \(info.models.opus), \(info.models.sol)"
            } else {
                result = "Connected, but this server runs the \(info.frontend) frontend. Start it with npm run web."
            }
        } catch {
            result = error.localizedDescription
        }
    }
}
