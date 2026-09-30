import Foundation

/// Color family for a status dot.
public enum StatusTone: Equatable, Sendable {
    case ok, pending, warning, error, inactive
}

/// Presentation model for one app row in the panel.
public struct ChannelRow: Identifiable, Equatable, Sendable {
    public var app: AppID
    public var label: String
    public var statusText: String
    public var detail: String?
    public var tone: StatusTone
    public var configured: Bool
    public var enabled: Bool
    /// Whether an enable/disable toggle is shown (only for configured apps).
    public var showsToggle: Bool
    /// `false` when turning the toggle off would leave no enabled app.
    public var toggleAllowed: Bool
    public var toggleHelp: String?
    public var showsLinkButton: Bool

    public var id: AppID { app }

    /// Text for VoiceOver, e.g. "WhatsApp: Needs linking".
    public var accessibilityLabel: String {
        [label + ": " + statusText, detail].compactMap { $0 }.joined(separator: ". ")
    }
}

public enum ChannelRowBuilder {
    public static func rows(status: StatusResponse?, channels: ChannelsResponse?) -> [ChannelRow] {
        var apps = Set(channels?.channels.map(\.app) ?? [])
        for key in status.map({ Array($0.channels.keys) }) ?? [] { apps.insert(AppID(rawValue: key)) }
        let enabledCount = channels?.channels.filter(\.enabled).count
            ?? status?.channels.count ?? 0
        let paused = status.map(HealthEvaluator.isPaused) ?? false

        return apps.sorted().map { app in
            let info = channels?.channel(app)
            let live = status?.channel(app)
            let configured = info?.configured ?? (live != nil)
            let enabled = info?.enabled ?? (live != nil)
            let label = info?.label ?? app.defaultLabel
            let toolInstalled = info?.tool?.installed ?? false

            var row = ChannelRow(
                app: app, label: label, statusText: "", detail: nil, tone: .inactive,
                configured: configured, enabled: enabled,
                showsToggle: info != nil && configured,
                toggleAllowed: true, toggleHelp: nil, showsLinkButton: false
            )

            if !configured {
                if let tool = info?.tool, !tool.installed {
                    row.statusText = "Unavailable"
                    row.detail = "Install \(tool.name) to use \(label)."
                } else {
                    row.statusText = "Not set up"
                }
                row.tone = .inactive
                row.showsLinkButton = app == .whatsapp && toolInstalled
            } else if !enabled {
                row.statusText = "Off"
                row.tone = .inactive
                row.showsLinkButton = app == .whatsapp && live?.state == .needsLink
            } else if paused {
                row.statusText = "Paused"
                row.tone = .inactive
            } else if let live {
                (row.statusText, row.tone) = describe(live.state)
                row.detail = live.reason
                row.showsLinkButton = app == .whatsapp && live.state == .needsLink
            } else if status == nil {
                row.statusText = "Checking…"
                row.tone = .pending
            } else {
                row.statusText = "Unknown"
                row.tone = .warning
            }

            if row.showsToggle && enabled && enabledCount <= 1 {
                row.toggleAllowed = false
                row.toggleHelp = "At least one app must stay on."
            }
            return row
        }
    }

    public static func describe(_ state: ChannelState) -> (String, StatusTone) {
        switch state {
        case .ready: return ("Ready", .ok)
        case .starting: return ("Starting…", .pending)
        case .needsLink: return ("Needs linking", .error)
        case .degraded: return ("Degraded", .warning)
        case .failed: return ("Unavailable", .error)
        case .stopped: return ("Stopped", .warning)
        default: return ("Unknown", .warning)
        }
    }
}
