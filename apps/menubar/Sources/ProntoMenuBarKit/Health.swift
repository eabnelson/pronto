import Foundation

/// Overall state shown by the menu bar icon.
public enum OverallHealth: Equatable, Sendable {
    /// No response yet.
    case loading
    /// The CLI is not installed at the expected path.
    case notInstalled
    /// The CLI exists but could not be verified or run.
    case unavailable(String)
    /// The listener was stopped by the user (`pronto stop`).
    case paused
    /// Listener stopped/failed, or an enabled app failed or needs linking.
    case error([String])
    /// Degraded, still starting, or an update is available.
    case attention([String])
    /// Listener running and every enabled app ready.
    case normal
}

public struct HealthInput: Sendable {
    public var status: StatusResponse?
    public var channels: ChannelsResponse?
    public var updateAvailable: Bool
    public var clientError: CLIError?

    public init(status: StatusResponse?, channels: ChannelsResponse? = nil, updateAvailable: Bool = false, clientError: CLIError? = nil) {
        self.status = status
        self.channels = channels
        self.updateAvailable = updateAvailable
        self.clientError = clientError
    }
}

public enum HealthEvaluator {
    /// Apps whose health counts toward the overall state: the enabled apps from
    /// `channels list` when known, otherwise every app in `status`.
    public static func enabledApps(status: StatusResponse, channels: ChannelsResponse?) -> [AppID] {
        if let channels { return channels.enabledApps }
        return status.channels.keys.map(AppID.init(rawValue:)).sorted()
    }

    /// `true` when the listener is stopped on purpose rather than because it failed.
    public static func isPaused(_ status: StatusResponse) -> Bool {
        status.listener == .stopped && status.daemon != .failed
    }

    public static func evaluate(_ input: HealthInput) -> OverallHealth {
        if let error = input.clientError {
            switch error {
            case .notInstalled: return .notInstalled
            case .untrusted, .launchFailed: return .unavailable(error.errorDescription ?? "Unavailable")
            default:
                // Transient failures (timeouts, odd output) keep showing the last known status.
                if input.status == nil { return .unavailable(error.errorDescription ?? "Unavailable") }
            }
        }
        guard let status = input.status else { return .loading }

        if status.listener == .stopped {
            return status.daemon == .failed ? .error(["Pronto stopped after an error"]) : .paused
        }

        var errors: [String] = []
        var warnings: [String] = []

        if status.listener != .running {
            if status.daemon == .starting {
                warnings.append("Pronto is starting")
            } else {
                errors.append("Pronto isn't running")
            }
        } else {
            switch status.daemon {
            case .ready: break
            case .failed, .stopped: errors.append("Pronto isn't running")
            case .starting: warnings.append("Pronto is starting")
            case .degraded: warnings.append("Pronto is degraded")
            default: warnings.append("Pronto's state is unknown")
            }
        }

        if !status.degradedCapabilities.isEmpty {
            warnings.append("Some features are limited")
        }

        for app in enabledApps(status: status, channels: input.channels) {
            let label = input.channels?.channel(app)?.label ?? app.defaultLabel
            guard let channel = status.channel(app) else {
                warnings.append("\(label) status unknown")
                continue
            }
            switch channel.state {
            case .ready: break
            case .needsLink: errors.append("\(label) needs linking")
            case .failed: errors.append("\(label) is unavailable")
            case .starting: warnings.append("\(label) is starting")
            case .degraded: warnings.append("\(label) is degraded")
            default: warnings.append("\(label) isn't ready")
            }
        }

        if !errors.isEmpty { return .error(errors) }
        if input.updateAvailable { warnings.append("An update is available") }
        if !warnings.isEmpty { return .attention(warnings) }
        return .normal
    }
}

/// How the menu bar icon should look for a given health.
public struct MenuBarIcon: Equatable, Sendable {
    public enum Tint: Equatable, Sendable { case none, warning, error }

    public var symbolName: String
    public var tint: Tint
    public var dimmed: Bool
    public var accessibilityLabel: String

    public init(symbolName: String, tint: Tint, dimmed: Bool, accessibilityLabel: String) {
        self.symbolName = symbolName
        self.tint = tint
        self.dimmed = dimmed
        self.accessibilityLabel = accessibilityLabel
    }

    public init(health: OverallHealth) {
        switch health {
        case .loading:
            self.init(symbolName: "ellipsis.bubble", tint: .none, dimmed: true, accessibilityLabel: "Pronto: checking status")
        case .notInstalled:
            self.init(symbolName: "questionmark.bubble", tint: .none, dimmed: true, accessibilityLabel: "Pronto isn't installed")
        case .unavailable:
            self.init(symbolName: "exclamationmark.bubble.fill", tint: .error, dimmed: false, accessibilityLabel: "Pronto: unavailable")
        case .paused:
            self.init(symbolName: "ellipsis.bubble", tint: .none, dimmed: true, accessibilityLabel: "Pronto: paused")
        case .error(let reasons):
            self.init(symbolName: "exclamationmark.bubble.fill", tint: .error, dimmed: false,
                      accessibilityLabel: "Pronto: " + (reasons.first ?? "needs attention"))
        case .attention(let reasons):
            self.init(symbolName: "exclamationmark.bubble", tint: .warning, dimmed: false,
                      accessibilityLabel: "Pronto: " + (reasons.first ?? "needs attention"))
        case .normal:
            self.init(symbolName: "ellipsis.bubble.fill", tint: .none, dimmed: false, accessibilityLabel: "Pronto: ready")
        }
    }
}

public extension OverallHealth {
    /// One-line summary for the panel header.
    var summary: String {
        switch self {
        case .loading: return "Checking…"
        case .notInstalled: return "Pronto isn't installed"
        case .unavailable(let message): return message
        case .paused: return "Paused"
        case .error(let reasons), .attention(let reasons):
            guard let first = reasons.first else { return "Needs attention" }
            return reasons.count > 1 ? "\(first) (+\(reasons.count - 1) more)" : first
        case .normal: return "Ready"
        }
    }
}
