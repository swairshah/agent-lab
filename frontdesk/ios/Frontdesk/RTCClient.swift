import AVFoundation
import Foundation
import WebRTC

enum RTCClientError: LocalizedError {
    case setup

    var errorDescription: String? { "Could not set up the audio connection." }
}

final class RTCClient: NSObject {
    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    var onEvent: (@MainActor ([String: Any]) -> Void)?
    var onState: (@MainActor (RTCPeerConnectionState) -> Void)?

    var muted = false {
        didSet { track?.isEnabled = !muted }
    }

    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var track: RTCAudioTrack?
    private let lock = NSLock()
    private var gathering: CheckedContinuation<Void, Never>?

    static func activateAudio() throws {
        let configuration = RTCAudioSessionConfiguration.webRTC()
        configuration.category = AVAudioSession.Category.playAndRecord.rawValue
        configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
        configuration.categoryOptions = [.defaultToSpeaker, .allowBluetooth]
        RTCAudioSessionConfiguration.setWebRTC(configuration)
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try session.setConfiguration(configuration, active: true)
    }

    static func deactivateAudio() {
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        try? session.setActive(false)
    }

    func offer() async throws -> String {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw RTCClientError.setup
        }
        self.peer = peer

        let track = Self.factory.audioTrack(with: Self.factory.audioSource(with: constraints), trackId: "mic")
        peer.add(track, streamIds: ["frontdesk"])
        self.track = track

        channel = peer.dataChannel(forLabel: "oai-events", configuration: RTCDataChannelConfiguration())
        channel?.delegate = self

        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { description, error in
                if let description {
                    continuation.resume(returning: description)
                } else {
                    continuation.resume(throwing: error ?? RTCClientError.setup)
                }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        await waitForCandidates(timeout: 2)
        return peer.localDescription?.sdp ?? offer.sdp
    }

    func answer(_ sdp: String) async throws {
        guard let peer else { throw RTCClientError.setup }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: sdp)) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func close() {
        channel?.close()
        peer?.close()
        channel = nil
        peer = nil
        track = nil
        finishGathering()
    }

    private func waitForCandidates(timeout: TimeInterval) async {
        if peer?.iceGatheringState == .complete { return }
        await withCheckedContinuation { continuation in
            lock.lock()
            gathering = continuation
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { self.finishGathering() }
        }
    }

    private func finishGathering() {
        lock.lock()
        let continuation = gathering
        gathering = nil
        lock.unlock()
        continuation?.resume()
    }

    private func emit(_ event: [String: Any]) {
        Task { @MainActor in self.onEvent?(event) }
    }
}

extension RTCClient: RTCPeerConnectionDelegate {
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}

    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        if newState == .complete { finishGathering() }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        Task { @MainActor in self.onState?(newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}

extension RTCClient: RTCDataChannelDelegate {
    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let event = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
        emit(event)
    }
}
