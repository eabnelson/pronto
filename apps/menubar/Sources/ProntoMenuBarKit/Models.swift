import Foundation

// Codable models for the machine-readable CLI contract in docs/CLI_JSON.md.
//
// String-valued states are modelled as open "string enums" (RawRepresentable
// structs) so a newer CLI that adds a state never breaks decoding; unknown
// values are treated conservatively by the presentation logic.

/// An app Pronto answers in (`imessage`, `whatsapp`).
public struct AppID: RawRepresentable, Codable, Hashable, Sendable, Comparable, CustomStringConvertible {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }

    public static let imessage = AppID("imessage")
    public static let whatsapp = AppID("whatsapp")

    /// Human label used when the CLI did not provide one.
    public var defaultLabel: String {
        switch self {
        case .imessage: return "iMessage"
        case .whatsapp: return "WhatsApp"
        default: return rawValue.prefix(1).uppercased() + rawValue.dropFirst()
        }
    }

    /// Stable display order: iMessage, WhatsApp, then anything else alphabetically.
    private var sortKey: (Int, String) {
        switch self {
        case .imessage: return (0, rawValue)
        case .whatsapp: return (1, rawValue)
        default: return (2, rawValue)
        }
    }

    public static func < (lhs: AppID, rhs: AppID) -> Bool { lhs.sortKey < rhs.sortKey }
    public var description: String { rawValue }
}

/// `listener`: `running`, `loaded`, or `stopped`.
public struct ListenerState: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let running = ListenerState(rawValue: "running")
    public static let loaded = ListenerState(rawValue: "loaded")
    public static let stopped = ListenerState(rawValue: "stopped")
}

/// `daemon`: `starting`, `ready`, `degraded`, `failed`, `stopped`, or `unknown`.
public struct DaemonState: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let starting = DaemonState(rawValue: "starting")
    public static let ready = DaemonState(rawValue: "ready")
    public static let degraded = DaemonState(rawValue: "degraded")
    public static let failed = DaemonState(rawValue: "failed")
    public static let stopped = DaemonState(rawValue: "stopped")
    public static let unknown = DaemonState(rawValue: "unknown")
}

/// Channel `state`: `starting`, `ready`, `degraded`, `failed`, `needs_link`, `stopped`, or `unknown`.
public struct ChannelState: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let starting = ChannelState(rawValue: "starting")
    public static let ready = ChannelState(rawValue: "ready")
    public static let degraded = ChannelState(rawValue: "degraded")
    public static let failed = ChannelState(rawValue: "failed")
    public static let needsLink = ChannelState(rawValue: "needs_link")
    public static let stopped = ChannelState(rawValue: "stopped")
    public static let unknown = ChannelState(rawValue: "unknown")
}

// MARK: - status --json

public struct ChannelStatus: Codable, Hashable, Sendable {
    public var state: ChannelState
    public var tags: [String]
    public var reason: String?

    public init(state: ChannelState, tags: [String] = [], reason: String? = nil) {
        self.state = state
        self.tags = tags
        self.reason = reason
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        state = try c.decode(ChannelState.self, forKey: .state)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        reason = try c.decodeIfPresent(String.self, forKey: .reason)
    }
}

public struct StatusResponse: Codable, Hashable, Sendable {
    public var version: String
    public var listener: ListenerState
    public var daemon: DaemonState
    public var database: String?
    public var channels: [String: ChannelStatus]
    public var degradedCapabilities: [String]
    public var active: Int?
    public var ambiguous: Int?
    public var parked: Int?
    public var rateLimited: Int?
    /// Milliseconds since the Unix epoch.
    public var lastSettledAt: Double?

    public init(
        version: String,
        listener: ListenerState,
        daemon: DaemonState,
        database: String? = nil,
        channels: [String: ChannelStatus] = [:],
        degradedCapabilities: [String] = [],
        active: Int? = nil, ambiguous: Int? = nil, parked: Int? = nil, rateLimited: Int? = nil,
        lastSettledAt: Double? = nil
    ) {
        self.version = version
        self.listener = listener
        self.daemon = daemon
        self.database = database
        self.channels = channels
        self.degradedCapabilities = degradedCapabilities
        self.active = active
        self.ambiguous = ambiguous
        self.parked = parked
        self.rateLimited = rateLimited
        self.lastSettledAt = lastSettledAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(String.self, forKey: .version)
        listener = try c.decode(ListenerState.self, forKey: .listener)
        daemon = try c.decode(DaemonState.self, forKey: .daemon)
        database = try c.decodeIfPresent(String.self, forKey: .database)
        channels = try c.decodeIfPresent([String: ChannelStatus].self, forKey: .channels) ?? [:]
        degradedCapabilities = try c.decodeIfPresent([String].self, forKey: .degradedCapabilities) ?? []
        active = try c.decodeIfPresent(Int.self, forKey: .active)
        ambiguous = try c.decodeIfPresent(Int.self, forKey: .ambiguous)
        parked = try c.decodeIfPresent(Int.self, forKey: .parked)
        rateLimited = try c.decodeIfPresent(Int.self, forKey: .rateLimited)
        lastSettledAt = try c.decodeIfPresent(Double.self, forKey: .lastSettledAt)
    }

    public func channel(_ app: AppID) -> ChannelStatus? { channels[app.rawValue] }
}

// MARK: - channels list --json

public struct ChannelTool: Codable, Hashable, Sendable {
    public var name: String
    public var path: String?
    public var installed: Bool

    public init(name: String, path: String? = nil, installed: Bool) {
        self.name = name
        self.path = path
        self.installed = installed
    }
}

public struct ChannelInfo: Codable, Hashable, Sendable, Identifiable {
    public var app: AppID
    public var label: String
    public var configured: Bool
    public var enabled: Bool
    public var tags: [String]
    public var tool: ChannelTool?

    public var id: AppID { app }

    public init(app: AppID, label: String? = nil, configured: Bool, enabled: Bool, tags: [String] = [], tool: ChannelTool? = nil) {
        self.app = app
        self.label = label ?? app.defaultLabel
        self.configured = configured
        self.enabled = enabled
        self.tags = tags
        self.tool = tool
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        app = try c.decode(AppID.self, forKey: .app)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? app.defaultLabel
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        tool = try c.decodeIfPresent(ChannelTool.self, forKey: .tool)
    }
}

public struct ChannelsResponse: Codable, Hashable, Sendable {
    public var channels: [ChannelInfo]
    public init(channels: [ChannelInfo]) { self.channels = channels }

    public func channel(_ app: AppID) -> ChannelInfo? { channels.first { $0.app == app } }
    public var enabledApps: [AppID] { channels.filter(\.enabled).map(\.app).sorted() }
    public var configuredApps: [AppID] { channels.filter(\.configured).map(\.app).sorted() }
}

// MARK: - tags list/add/remove --json

public struct TagEntry: Codable, Hashable, Sendable, Identifiable {
    public var tag: String
    public var apps: [AppID]
    public var id: String { tag }

    public init(tag: String, apps: [AppID]) {
        self.tag = tag
        self.apps = apps
    }
}

public struct TagsResponse: Codable, Hashable, Sendable {
    public var tags: [TagEntry]
    public init(tags: [TagEntry]) { self.tags = tags }
}

// MARK: - start/stop --json

public struct ListenerResponse: Codable, Hashable, Sendable {
    public var listener: ListenerState
    public init(listener: ListenerState) { self.listener = listener }
}

// MARK: - doctor --json

public struct CheckStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let ok = CheckStatus(rawValue: "ok")
    public static let degraded = CheckStatus(rawValue: "degraded")
    public static let failed = CheckStatus(rawValue: "failed")
}

public struct DoctorCheck: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var status: CheckStatus
    public var remediation: String?

    public init(id: String, status: CheckStatus, remediation: String? = nil) {
        self.id = id
        self.status = status
        self.remediation = remediation
    }
}

public struct DoctorResponse: Codable, Hashable, Sendable {
    public var healthy: Bool
    public var checks: [DoctorCheck]
    public init(healthy: Bool, checks: [DoctorCheck]) {
        self.healthy = healthy
        self.checks = checks
    }
}

// MARK: - update --json

public struct UpdateCheckStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let current = UpdateCheckStatus(rawValue: "current")
    public static let available = UpdateCheckStatus(rawValue: "available")
}

public struct UpdateCheckResponse: Codable, Hashable, Sendable {
    public var status: UpdateCheckStatus
    public var installedVersion: String?
    public var version: String?

    public init(status: UpdateCheckStatus, installedVersion: String? = nil, version: String? = nil) {
        self.status = status
        self.installedVersion = installedVersion
        self.version = version
    }

    public var isAvailable: Bool { status == .available }
}

public struct UpdateInstallStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let installed = UpdateInstallStatus(rawValue: "installed")
    public static let current = UpdateInstallStatus(rawValue: "current")
    public static let migrationRequired = UpdateInstallStatus(rawValue: "migration_required")
    public static let migrationInstalled = UpdateInstallStatus(rawValue: "migration_installed")
}

public struct UpdateInstallResponse: Codable, Hashable, Sendable {
    public var status: UpdateInstallStatus
    public var version: String?

    public init(status: UpdateInstallStatus, version: String? = nil) {
        self.status = status
        self.version = version
    }
}

// MARK: - Errors

/// Failures print `{"error": "<message>"}`.
public struct CLIErrorResponse: Codable, Hashable, Sendable {
    public var error: String
}
