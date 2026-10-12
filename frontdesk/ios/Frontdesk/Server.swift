import Foundation
import Security

struct ServerInfo: Decodable {
    struct Models: Decodable {
        let voice: String
        let opus: String
        let sol: String
    }

    let frontend: String
    let models: Models
}

enum ServerError: LocalizedError {
    case status(Int, String)

    var errorDescription: String? {
        switch self {
        case .status(401, _): return "The server rejected the token."
        case let .status(code, message): return message.isEmpty ? "Server error \(code)." : message
        }
    }
}

struct Server {
    static let urlKey = "serverURL"

    let base: URL
    let token: String

    static func current() -> Server? {
        let raw = (UserDefaults.standard.string(forKey: urlKey) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: raw), let scheme = url.scheme, ["http", "https"].contains(scheme), url.host() != nil else {
            return nil
        }
        return Server(base: url, token: Keychain.token)
    }

    func info() async throws -> ServerInfo {
        let data = try await send(request("api/info"))
        return try JSONDecoder().decode(ServerInfo.self, from: data)
    }

    func startCall(offer: String) async throws -> String {
        var request = request("api/voice/session", method: "POST")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(offer.utf8)
        request.timeoutInterval = 30
        return String(decoding: try await send(request), as: UTF8.self)
    }

    func hangup() async {
        _ = try? await send(request("api/voice/hangup", method: "POST"))
    }

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 10
        if !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw ServerError.status(code, message ?? "")
        }
        return data
    }
}

enum Keychain {
    private static var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "frontdesk",
            kSecAttrAccount as String: "token",
        ]
    }

    static var token: String {
        get {
            var lookup = query
            lookup[kSecReturnData as String] = true
            lookup[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            guard SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess, let data = result as? Data else {
                return ""
            }
            return String(decoding: data, as: UTF8.self)
        }
        set {
            SecItemDelete(query as CFDictionary)
            guard !newValue.isEmpty else { return }
            var item = query
            item[kSecValueData as String] = Data(newValue.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}
