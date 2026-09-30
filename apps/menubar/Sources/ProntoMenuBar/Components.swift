import AppKit
import ProntoMenuBarKit
import SwiftUI

/// The menu bar icon. Normal/paused use template images so they follow the
/// menu bar appearance; attention/error use a tinted symbol.
struct MenuBarLabel: View {
    let icon: MenuBarIcon

    var body: some View {
        Image(nsImage: Self.image(for: icon))
            .accessibilityLabel(icon.accessibilityLabel)
    }

    static func image(for icon: MenuBarIcon) -> NSImage {
        let base = NSImage(systemSymbolName: icon.symbolName, accessibilityDescription: icon.accessibilityLabel)
            ?? NSImage(systemSymbolName: "ellipsis.bubble", accessibilityDescription: icon.accessibilityLabel)!
        let size = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        switch icon.tint {
        case .none:
            let symbol = base.withSymbolConfiguration(size) ?? base
            let image = icon.dimmed ? dimmed(symbol, alpha: 0.45) : symbol
            image.isTemplate = true
            image.accessibilityDescription = icon.accessibilityLabel
            return image
        case .warning, .error:
            let color: NSColor = icon.tint == .error ? .systemRed : .systemOrange
            let config = size.applying(.init(paletteColors: [color]))
            let image = base.withSymbolConfiguration(config) ?? base
            image.isTemplate = false
            image.accessibilityDescription = icon.accessibilityLabel
            return image
        }
    }

    private static func dimmed(_ image: NSImage, alpha: CGFloat) -> NSImage {
        NSImage(size: image.size, flipped: false) { rect in
            image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: alpha)
            return true
        }
    }
}

extension StatusTone {
    var color: Color {
        switch self {
        case .ok: return .green
        case .pending: return .yellow
        case .warning: return .orange
        case .error: return .red
        case .inactive: return .secondary
        }
    }
}

/// Corner radii follow macOS 26: rounder, continuous, and concentric with the panel.
enum PanelMetrics {
    static let width: CGFloat = 356
    static let inset: CGFloat = 10
    static let cardRadius: CGFloat = 14
    static let rowRadius: CGFloat = 9
}

extension View {
    /// A Control Center–style grouped module inside the panel.
    func panelCard() -> some View {
        background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: PanelMetrics.cardRadius, style: .continuous))
    }

    /// Liquid Glass buttons on macOS 26, bordered buttons before that.
    @ViewBuilder func glassButtonStyle(prominent: Bool = false) -> some View {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            if prominent { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
        } else {
            if prominent { buttonStyle(.borderedProminent) } else { buttonStyle(.bordered) }
        }
        #else
        if prominent { buttonStyle(.borderedProminent) } else { buttonStyle(.bordered) }
        #endif
    }
}

/// A small colored status dot with a VoiceOver label.
struct StatusDot: View {
    let tone: StatusTone
    let label: String

    var body: some View {
        Circle()
            .fill(tone.color)
            .frame(width: 7, height: 7)
            .accessibilityElement()
            .accessibilityLabel(label)
    }
}

/// A round, filled app glyph like the modules in Control Center.
struct AppGlyph: View {
    let app: AppID
    var dimmed = false

    var body: some View {
        Image(systemName: app == .whatsapp ? "phone.bubble.fill" : "message.fill")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(Circle().fill(color.gradient))
            .saturation(dimmed ? 0 : 1)
            .opacity(dimmed ? 0.55 : 1)
            .accessibilityHidden(true)
    }

    private var color: Color {
        app == .whatsapp
            ? Color(red: 0.15, green: 0.73, blue: 0.53)
            : Color(red: 0.2, green: 0.78, blue: 0.35)
    }
}

/// An app name badge ("iMessage", "WhatsApp").
struct AppBadge: View {
    let label: String

    var body: some View {
        Text(label)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(.quaternary))
            .foregroundStyle(.secondary)
    }
}

/// Section title above a panel card.
struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, PanelMetrics.inset + 6)
            .padding(.top, 12)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A full-width, menu-like action row with a hover highlight.
struct MenuRow<Trailing: View>: View {
    let title: String
    let systemImage: String
    var disabled = false
    let action: () -> Void
    @ViewBuilder var trailing: () -> Trailing
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .frame(width: 16)
                    .foregroundStyle(.secondary)
                Text(title)
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .contentShape(RoundedRectangle(cornerRadius: PanelMetrics.rowRadius, style: .continuous))
            .background(
                RoundedRectangle(cornerRadius: PanelMetrics.rowRadius, style: .continuous)
                    .fill(hovering && !disabled ? Color.primary.opacity(0.09) : .clear)
            )
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .onHover { hovering = $0 }
        .padding(.horizontal, PanelMetrics.inset - 4)
    }
}

extension MenuRow where Trailing == EmptyView {
    init(title: String, systemImage: String, disabled: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, systemImage: systemImage, disabled: disabled, action: action, trailing: { EmptyView() })
    }
}

/// Inline error text.
struct InlineError: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.red)
            .symbolRenderingMode(.multicolor)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("Error: \(message)")
    }
}

/// Reports whether the hosting window is on screen (used to detect the
/// MenuBarExtra panel opening and closing).
struct WindowVisibilityReader: NSViewRepresentable {
    let onChange: (Bool) -> Void

    func makeNSView(context: Context) -> ObserverView {
        let view = ObserverView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ nsView: ObserverView, context: Context) {
        nsView.onChange = onChange
    }

    final class ObserverView: NSView {
        var onChange: ((Bool) -> Void)?
        private var observers: [NSObjectProtocol] = []
        private var lastValue: Bool?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            observers.forEach(NotificationCenter.default.removeObserver)
            observers = []
            // Observers are removed here when the view leaves its window.
            guard let window else { report(false); return }
            let center = NotificationCenter.default
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didBecomeKeyNotification,
                         NSWindow.didResignKeyNotification, NSWindow.willCloseNotification] {
                observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] note in
                    let closing = note.name == NSWindow.willCloseNotification
                    MainActor.assumeIsolated {
                        guard let self, let window = self.window else { return }
                        let visible = !closing && window.isVisible && window.occlusionState.contains(.visible)
                        self.report(visible)
                    }
                })
            }
            report(window.isVisible)
        }

        private func report(_ visible: Bool) {
            guard visible != lastValue else { return }
            lastValue = visible
            onChange?(visible)
        }
    }
}
