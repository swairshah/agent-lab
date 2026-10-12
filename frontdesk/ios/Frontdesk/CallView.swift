import SwiftUI

struct CallView: View {
    @EnvironmentObject private var call: CallController
    @AppStorage(Server.urlKey) private var serverURL = ""
    @State private var showSettings = false

    private var mood: Mood {
        switch call.phase {
        case .idle, .failed: return .idle
        case .connecting: return .connecting
        case .live:
            if call.muted { return .muted }
            switch call.speaker {
            case .user: return .user
            case .assistant: return .assistant
            case .nobody: return .listening
            }
        }
    }

    private var status: String {
        switch call.phase {
        case .idle: return "Tap to get on a call"
        case .connecting: return "Connecting…"
        case let .failed(message): return message
        case .live:
            if call.muted { return "Muted" }
            switch call.speaker {
            case .user: return "Listening"
            case .assistant: return "Speaking"
            case .nobody: return "On the line"
            }
        }
    }

    var body: some View {
        ZStack {
            background
            VStack(spacing: 0) {
                header
                Spacer()
                Button {
                    Task { await call.start() }
                } label: {
                    Orb(mood: mood)
                        .contentShape(Circle())
                }
                .buttonStyle(OrbButtonStyle())
                .disabled(call.inCall)
                .accessibilityLabel(call.inCall ? "Call in progress" : "Start call")

                Text(status)
                    .font(.system(.headline, design: .rounded))
                    .foregroundStyle(isFailure ? Color.red.opacity(0.85) : .white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .padding(.top, 36)
                    .padding(.horizontal, 32)
                    .contentTransition(.opacity)
                    .animation(.easeInOut(duration: 0.25), value: status)

                Text(call.caption)
                    .font(.system(.callout, design: .rounded))
                    .foregroundStyle(.white.opacity(0.55))
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .truncationMode(.head)
                    .frame(height: 66, alignment: .top)
                    .padding(.top, 10)
                    .padding(.horizontal, 32)
                    .opacity(call.inCall ? 1 : 0)

                Spacer()
                controls
                    .padding(.bottom, 28)
            }
            notice
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
        .sensoryFeedback(.impact(weight: .medium), trigger: call.phase)
        .onAppear { if serverURL.isEmpty { showSettings = true } }
    }

    private var isFailure: Bool {
        if case .failed = call.phase { return true }
        return false
    }

    private var background: some View {
        LinearGradient(
            colors: [mood.colors[0].opacity(0.22), Color(white: 0.04), Color.black],
            startPoint: .top,
            endPoint: .bottom
        )
        .ignoresSafeArea()
        .animation(.easeInOut(duration: 0.8), value: mood)
    }

    private var header: some View {
        HStack {
            Text("frontdesk")
                .font(.system(.title3, design: .rounded).weight(.semibold))
                .foregroundStyle(.white.opacity(0.9))
            if let startedAt = call.startedAt {
                Text(startedAt, style: .timer)
                    .font(.system(.subheadline, design: .rounded).monospacedDigit())
                    .foregroundStyle(.white.opacity(0.5))
                    .padding(.leading, 6)
            }
            Spacer()
            Button {
                showSettings = true
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.white.opacity(0.7))
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Settings")
        }
        .padding(.horizontal, 20)
        .padding(.top, 8)
    }

    private var controls: some View {
        HStack(spacing: 44) {
            RoundControl(
                symbol: call.muted ? "mic.slash.fill" : "mic.fill",
                tint: call.muted ? .white : .white.opacity(0.12),
                foreground: call.muted ? .black : .white,
                label: call.muted ? "Unmute" : "Mute"
            ) {
                call.muted.toggle()
            }
            RoundControl(symbol: "phone.down.fill", tint: Color(red: 0.95, green: 0.25, blue: 0.3), foreground: .white, label: "End call") {
                call.end()
            }
        }
        .opacity(call.inCall ? 1 : 0)
        .offset(y: call.inCall ? 0 : 30)
        .animation(.spring(duration: 0.45), value: call.inCall)
        .allowsHitTesting(call.inCall)
    }

    @ViewBuilder
    private var notice: some View {
        if let notice = call.notice {
            VStack {
                Label(notice, systemImage: "sparkles")
                    .font(.system(.subheadline, design: .rounded).weight(.medium))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.top, 64)
                Spacer()
            }
            .transition(.move(edge: .top).combined(with: .opacity))
        }
    }
}

private struct OrbButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(duration: 0.3), value: configuration.isPressed)
    }
}

private struct RoundControl: View {
    let symbol: String
    let tint: Color
    let foreground: Color
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(foreground)
                .frame(width: 68, height: 68)
                .background(tint, in: Circle())
        }
        .buttonStyle(OrbButtonStyle())
        .accessibilityLabel(label)
    }
}
