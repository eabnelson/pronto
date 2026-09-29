import Foundation

/// When to poll `status --json` and `update --check --json`.
public struct PollPolicy: Equatable, Sendable {
    public var panelOpenInterval: Duration
    public var backgroundInterval: Duration
    /// Automatic update checks run at most this often (manual checks always run).
    public var updateCheckInterval: TimeInterval
    /// Slower polling when the CLI is missing, so an idle app stays quiet.
    public var notInstalledInterval: Duration

    public init(
        panelOpenInterval: Duration = .seconds(5),
        backgroundInterval: Duration = .seconds(60),
        updateCheckInterval: TimeInterval = 6 * 60 * 60,
        notInstalledInterval: Duration = .seconds(60)
    ) {
        self.panelOpenInterval = panelOpenInterval
        self.backgroundInterval = backgroundInterval
        self.updateCheckInterval = updateCheckInterval
        self.notInstalledInterval = notInstalledInterval
    }

    public static let standard = PollPolicy()

    public func statusInterval(panelOpen: Bool, installed: Bool) -> Duration {
        if !installed { return panelOpen ? panelOpenInterval : notInstalledInterval }
        return panelOpen ? panelOpenInterval : backgroundInterval
    }

    /// Whether an automatic update check is due.
    public func isUpdateCheckDue(lastCheck: Date?, now: Date) -> Bool {
        guard let lastCheck else { return true }
        // A clock that moved backwards should not suppress checks forever.
        if now < lastCheck { return true }
        return now.timeIntervalSince(lastCheck) >= updateCheckInterval
    }
}

/// Coalesces concurrent calls: while one call is in flight, later callers await
/// the same result instead of starting another process.
@MainActor
public final class SingleFlight<Value: Sendable> {
    private var inFlight: Task<Value, Error>?

    public init() {}

    public var isRunning: Bool { inFlight != nil }

    public func run(_ operation: @escaping @Sendable () async throws -> Value) async throws -> Value {
        if let inFlight { return try await inFlight.value }
        let task = Task { try await operation() }
        inFlight = task
        defer { inFlight = nil }
        return try await task.value
    }
}
