import SwiftUI

struct Mood: Equatable {
    var colors: [Color]
    var tempo: Double
    var drift: Double
    var swell: Double

    static let idle = Mood(
        colors: [Color(white: 0.42), Color(white: 0.26), Color(white: 0.55)],
        tempo: 0.9, drift: 0.12, swell: 0.025
    )
    static let connecting = Mood(
        colors: [Color(red: 0.36, green: 0.42, blue: 1.0), Color(red: 0.55, green: 0.32, blue: 0.95), Color(red: 0.2, green: 0.62, blue: 1.0)],
        tempo: 3.2, drift: 1.4, swell: 0.04
    )
    static let listening = Mood(
        colors: [Color(red: 0.1, green: 0.78, blue: 0.74), Color(red: 0.16, green: 0.5, blue: 0.95), Color(red: 0.32, green: 0.36, blue: 0.9)],
        tempo: 1.3, drift: 0.35, swell: 0.035
    )
    static let user = Mood(
        colors: [Color(red: 0.3, green: 0.95, blue: 0.75), Color(red: 0.1, green: 0.8, blue: 0.9), Color(red: 0.2, green: 0.55, blue: 1.0)],
        tempo: 6.5, drift: 0.9, swell: 0.09
    )
    static let assistant = Mood(
        colors: [Color(red: 1.0, green: 0.55, blue: 0.3), Color(red: 0.98, green: 0.32, blue: 0.55), Color(red: 0.62, green: 0.35, blue: 1.0)],
        tempo: 4.6, drift: 0.75, swell: 0.11
    )
    static let muted = Mood(
        colors: [Color(red: 0.25, green: 0.35, blue: 0.4), Color(white: 0.22), Color(red: 0.2, green: 0.25, blue: 0.35)],
        tempo: 0.8, drift: 0.1, swell: 0.015
    )
}

struct Orb: View {
    let mood: Mood
    var size: CGFloat = 240

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let beat = (sin(t * mood.tempo) + 1) / 2
            ZStack {
                Circle()
                    .fill(mood.colors[0].opacity(0.35))
                    .blur(radius: size * 0.22)
                    .scaleEffect(1.1 + mood.swell * 2 * beat)

                ZStack {
                    Circle().fill(Color.black.opacity(0.6))
                    ForEach(0..<3, id: \.self) { index in
                        let angle = t * mood.drift + Double(index) * 2.094
                        Circle()
                            .fill(mood.colors[index % mood.colors.count])
                            .frame(width: size * 0.72, height: size * 0.72)
                            .offset(x: cos(angle) * size * 0.17, y: sin(angle * 1.3) * size * 0.17)
                            .blur(radius: size * 0.12)
                            .blendMode(.plusLighter)
                    }
                }
                .frame(width: size, height: size)
                .clipShape(Circle())
                .overlay(
                    Circle().strokeBorder(
                        LinearGradient(colors: [.white.opacity(0.4), .white.opacity(0.02)], startPoint: .topLeading, endPoint: .bottomTrailing),
                        lineWidth: 1
                    )
                )
                .overlay(
                    Ellipse()
                        .fill(LinearGradient(colors: [.white.opacity(0.22), .clear], startPoint: .top, endPoint: .bottom))
                        .frame(width: size * 0.55, height: size * 0.28)
                        .offset(y: -size * 0.28)
                        .blur(radius: 6)
                )
                .scaleEffect(0.94 + mood.swell * beat)
            }
            .frame(width: size, height: size)
        }
        .animation(.easeInOut(duration: 0.6), value: mood)
    }
}
