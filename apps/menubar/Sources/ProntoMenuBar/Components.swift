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
        let size = NSImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
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

/// Metrics of the macOS 26 system menus (Wi-Fi, Sound, Bluetooth).
enum PanelMetrics {
    static let width: CGFloat = 300
    /// Text and separators start this far from the panel edge.
    static let inset: CGFloat = 14
    /// Hover highlights start this far from the panel edge.
    static let highlightInset: CGFloat = 5
    static let rowRadius: CGFloat = 8
    static let iconSize: CGFloat = 26
    static let cardRadius: CGFloat = 14
}

extension View {
    /// A grouped box, used by the standalone windows.
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

/// A full-width menu separator.
struct MenuSeparator: View {
    var body: some View {
        Divider()
            .padding(.horizontal, PanelMetrics.inset)
            .padding(.vertical, 5)
    }
}

/// A section title like "Known Network" in the Wi-Fi menu.
struct SectionHeader: View {
    let title: String
    var body: some View {
        Text(title)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, PanelMetrics.inset)
            .padding(.top, 2)
            .padding(.bottom, 3)
            .accessibilityAddTraits(.isHeader)
    }
}

/// A round symbol like the device icons in the Sound and Bluetooth menus:
/// accent-filled when active, a quiet gray otherwise.
struct MenuIcon: View {
    let systemName: String
    var active = false
    var tint: Color = .accentColor

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(active ? AnyShapeStyle(.white) : AnyShapeStyle(.primary.opacity(0.85)))
            .frame(width: PanelMetrics.iconSize, height: PanelMetrics.iconSize)
            .background(Circle().fill(active ? AnyShapeStyle(tint) : AnyShapeStyle(.primary.opacity(0.1))))
            .accessibilityHidden(true)
    }
}

/// A menu row that highlights on hover. Rows without an action don't highlight.
struct MenuItem<Content: View>: View {
    var action: (() -> Void)?
    var disabled = false
    var verticalPadding: CGFloat = 4
    @ViewBuilder var content: () -> Content
    @State private var hovering = false

    var body: some View {
        let row = content()
            .padding(.horizontal, PanelMetrics.inset - PanelMetrics.highlightInset)
            .padding(.vertical, verticalPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: PanelMetrics.rowRadius, style: .continuous)
                    .fill(hovering && action != nil && !disabled ? Color.primary.opacity(0.1) : .clear)
            )
            .padding(.horizontal, PanelMetrics.highlightInset)
        if let action {
            Button(action: action) { row }
                .buttonStyle(.plain)
                .disabled(disabled)
                .onHover { hovering = $0 }
        } else {
            row
        }
    }
}

/// A plain text command like "Wi-Fi Settings…".
struct MenuCommand<Trailing: View>: View {
    let title: String
    var disabled = false
    let action: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        MenuItem(action: action, disabled: disabled) {
            HStack(spacing: 6) {
                Text(title)
                Spacer(minLength: 8)
                trailing()
            }
            .padding(.vertical, 1)
            .opacity(disabled ? 0.4 : 1)
        }
    }
}

extension MenuCommand where Trailing == EmptyView {
    init(title: String, disabled: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, disabled: disabled, action: action, trailing: { EmptyView() })
    }
}

/// A row with a round icon, a title, and an optional subtitle.
struct IconRow<Trailing: View>: View {
    let icon: MenuIcon
    let title: String
    var subtitle: String?
    var subtitleColor: Color?
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 8) {
            icon
            VStack(alignment: .leading, spacing: 0) {
                Text(title).lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.system(size: 11))
                        .foregroundStyle(subtitleColor.map(AnyShapeStyle.init) ?? AnyShapeStyle(.secondary))
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            trailing()
        }
    }
}

extension IconRow where Trailing == EmptyView {
    init(icon: MenuIcon, title: String, subtitle: String? = nil, subtitleColor: Color? = nil) {
        self.init(icon: icon, title: title, subtitle: subtitle, subtitleColor: subtitleColor, trailing: { EmptyView() })
    }
}

/// A disclosure chevron like the one on AirPods in the Sound menu.
struct DisclosureChevron: View {
    let expanded: Bool
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(.secondary)
            .rotationEffect(.degrees(expanded ? 90 : 0))
            .accessibilityHidden(true)
    }
}

/// The shaded band an expanded row's options sit in (see "Listening Mode" in the Sound menu).
struct ExpandedGroup<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0, content: content)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.primary.opacity(0.06))
            .padding(.vertical, 3)
    }
}

/// A checkable option inside an expanded group: a leading checkmark column, then the title.
struct CheckItem: View {
    let title: String
    let checked: Bool
    var disabled = false
    let action: () -> Void

    var body: some View {
        MenuItem(action: action, disabled: disabled) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .opacity(checked ? 1 : 0)
                    .frame(width: PanelMetrics.iconSize)
                Text(title)
                Spacer()
            }
            .padding(.vertical, 1)
            .opacity(disabled ? 0.4 : 1)
        }
        .accessibilityAddTraits(checked ? .isSelected : [])
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

/// Shapes the MenuBarExtra window like the system menus. Place it as a
/// background of the panel content so its frame is the content's size.
///
/// SwiftUI's window has squarer corners than the system menus and can stay
/// taller than its content after the content shrinks, which leaves the
/// content floating in a square box. This rounds the window and keeps it
/// exactly the content's size, anchored at the top under the menu bar.
struct PanelChrome: NSViewRepresentable {
    static let cornerRadius: CGFloat = 15

    func makeNSView(context: Context) -> ChromeView { ChromeView() }
    func updateNSView(_ nsView: ChromeView, context: Context) {}

    final class ChromeView: NSView {
        private var resizeObserver: NSObjectProtocol?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            resizeObserver.map(NotificationCenter.default.removeObserver)
            resizeObserver = window.map {
                NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: $0, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.scheduleFit() }
                }
            }
            fit()
        }

        override func setFrameSize(_ newSize: NSSize) {
            super.setFrameSize(newSize)
            scheduleFit()
        }

        /// Fits after the current layout pass finishes.
        private func scheduleFit() {
            DispatchQueue.main.async { [weak self] in self?.fit() }
        }

        private func fit() {
            guard let window, let content = window.contentView else { return }
            let size = bounds.size
            if size.width > 0, size.height > 0,
               abs(content.frame.width - size.width) > 0.5 || abs(content.frame.height - size.height) > 0.5 {
                let frame = window.frameRect(forContentRect: NSRect(origin: .zero, size: size))
                let top = window.frame.maxY
                window.setFrame(NSRect(x: window.frame.minX, y: top - frame.height,
                                       width: frame.width, height: frame.height), display: true)
            }
            for view in [content.superview, content].compactMap({ $0 }) {
                view.wantsLayer = true
                guard let layer = view.layer, layer.cornerRadius != PanelChrome.cornerRadius else { continue }
                layer.cornerRadius = PanelChrome.cornerRadius
                layer.cornerCurve = .continuous
                layer.masksToBounds = true
            }
            window.invalidateShadow()
        }
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
