import AVFoundation
import SwiftUI
import UIKit
import WebRTC

@MainActor
final class CallController: ObservableObject {
    enum Phase: Equatable {
        case idle
        case connecting
        case live
        case failed(String)
    }

    enum Speaker {
        case nobody
        case user
        case assistant
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var speaker: Speaker = .nobody
    @Published private(set) var caption = ""
    @Published private(set) var notice: String?
    @Published private(set) var startedAt: Date?
    @Published var muted = false {
        didSet { client?.muted = muted }
    }

    private var client: RTCClient?
    private var server: Server?
    private var assistantLine = ""
    private var noticeTask: Task<Void, Never>?

    var inCall: Bool { phase == .connecting || phase == .live }

    func start() async {
        guard !inCall else { return }
        guard let server = Server.current() else {
            phase = .failed("Add your server in settings.")
            return
        }
        guard await AVAudioApplication.requestRecordPermission() else {
            phase = .failed("Microphone access is off. Turn it on in Settings.")
            return
        }
        phase = .connecting
        caption = ""
        self.server = server
        let client = RTCClient()
        client.onEvent = { [weak self] event in self?.handle(event) }
        client.onState = { [weak self] state in self?.handle(state) }
        self.client = client
        do {
            try RTCClient.activateAudio()
            let offer = try await client.offer()
            let answer = try await server.startCall(offer: offer)
            guard self.client === client else { return }
            try await client.answer(answer)
        } catch {
            guard self.client === client else { return }
            teardown()
            phase = .failed(error.localizedDescription)
        }
    }

    func end() {
        if let server { Task { await server.hangup() } }
        teardown()
        phase = .idle
    }

    private func teardown() {
        client?.close()
        client = nil
        RTCClient.deactivateAudio()
        speaker = .nobody
        startedAt = nil
        muted = false
        assistantLine = ""
        UIApplication.shared.isIdleTimerDisabled = false
    }

    private func handle(_ state: RTCPeerConnectionState) {
        switch state {
        case .connected where phase == .connecting:
            phase = .live
            startedAt = .now
            UIApplication.shared.isIdleTimerDisabled = true
        case .failed:
            teardown()
            phase = .failed("The call dropped.")
        case .closed where inCall:
            teardown()
            phase = .idle
        default:
            break
        }
    }

    private func handle(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "input_audio_buffer.speech_started":
            speaker = .user
        case "input_audio_buffer.speech_stopped":
            if speaker == .user { speaker = .nobody }
        case "conversation.item.input_audio_transcription.completed":
            if let transcript = event["transcript"] as? String, !transcript.isEmpty { caption = transcript }
        case "response.created":
            assistantLine = ""
        case "response.output_audio_transcript.delta":
            assistantLine += event["delta"] as? String ?? ""
            caption = assistantLine
        case "output_audio_buffer.started":
            speaker = .assistant
        case "output_audio_buffer.stopped", "output_audio_buffer.cleared":
            if speaker == .assistant { speaker = .nobody }
        case "response.function_call_arguments.done":
            delegated(event)
        case "conversation.item.added", "conversation.item.created":
            reported(event)
        case "error":
            if let error = event["error"] as? [String: Any], let message = error["message"] as? String { show(message) }
        default:
            break
        }
    }

    private func delegated(_ event: [String: Any]) {
        guard event["name"] as? String == "delegate",
              let raw = (event["arguments"] as? String)?.data(using: .utf8),
              let args = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
              let action = args["action"] as? String
        else { return }
        let name = args["name"] as? String ?? "a worker"
        switch action {
        case "start": show("Handed off to \(name)")
        case "message": show("Sent to \(name)")
        case "stop": show("Stopped \(name)")
        default: break
        }
    }

    private func reported(_ event: [String: Any]) {
        guard let item = event["item"] as? [String: Any], item["role"] as? String == "system",
              let content = item["content"] as? [[String: Any]],
              let text = content.first?["text"] as? String,
              text.contains("Tell the user the gist"),
              let match = text.firstMatch(of: #/^\[worker (\S+) (finished|failed)\]/#)
        else { return }
        show("\(match.1) \(match.2)")
    }

    private func show(_ message: String) {
        withAnimation(.spring(duration: 0.4)) { notice = message }
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.4)) { notice = nil }
        }
    }
}
