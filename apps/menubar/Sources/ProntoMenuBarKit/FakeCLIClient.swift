import Foundation

/// In-memory `CLIClient` for tests and SwiftUI previews. Responses are raw
/// JSON so they exercise the same decoding path as the real client.
public final class FakeCLIClient: CLIClient, @unchecked Sendable {
    public typealias Handler = @Sendable (CLICommand) async throws -> CLIOutput

    private let lock = NSLock()
    private var handler: Handler
    private var _invocations: [CLICommand] = []
    private var _linkEvents: [LinkEvent]
    private var _linkError: Error?
    private let linkEventDelay: Duration

    public init(
        linkEvents: [LinkEvent] = [],
        linkError: Error? = nil,
        linkEventDelay: Duration = .zero,
        handler: @escaping Handler
    ) {
        self.handler = handler
        _linkEvents = linkEvents
        _linkError = linkError
        self.linkEventDelay = linkEventDelay
    }

    /// Serves fixed JSON per command; unknown commands fail with a CLI error.
    public convenience init(responses: [CLICommand: String], linkEvents: [LinkEvent] = [], linkEventDelay: Duration = .zero) {
        self.init(linkEvents: linkEvents, linkEventDelay: linkEventDelay) { command in
            if let json = responses[command] { return CLIOutput(exitCode: 0, stdout: Data(json.utf8)) }
            return CLIOutput(exitCode: 1, stdout: Data(#"{"error":"unsupported in fake"}"#.utf8))
        }
    }

    /// Every command the app has run, in order (link sessions included).
    public var invocations: [CLICommand] { lock.withLock { _invocations } }

    public func setHandler(_ handler: @escaping Handler) { lock.withLock { self.handler = handler } }
    public func setLinkEvents(_ events: [LinkEvent], error: Error? = nil) {
        lock.withLock {
            _linkEvents = events
            _linkError = error
        }
    }

    public func run(_ command: CLICommand) async throws -> CLIOutput {
        let handler = lock.withLock { () -> Handler in
            _invocations.append(command)
            return self.handler
        }
        try Task.checkCancellation()
        return try await handler(command)
    }

    public func linkWhatsApp(_ options: WhatsAppLinkOptions) -> AsyncThrowingStream<LinkEvent, Error> {
        let (events, error) = lock.withLock { () -> ([LinkEvent], Error?) in
            _invocations.append(.whatsappLink(options))
            return (_linkEvents, _linkError)
        }
        let delay = linkEventDelay
        return AsyncThrowingStream { continuation in
            let task = Task {
                for event in events {
                    if delay > .zero { try? await Task.sleep(for: delay) }
                    if Task.isCancelled { continuation.finish(throwing: CancellationError()); return }
                    continuation.yield(event)
                }
                if let error { continuation.finish(throwing: error) } else { continuation.finish() }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

public extension FakeCLIClient {
    /// The example payloads from docs/CLI_JSON.md, for previews.
    static func documentedExamples() -> FakeCLIClient {
        FakeCLIClient(
            responses: [
                .status: SampleJSON.status,
                .channelsList: SampleJSON.channels,
                .tagsList: SampleJSON.tags,
                .updateCheck: SampleJSON.updateAvailable,
                .doctor: SampleJSON.doctor,
                .start: #"{"listener": "running"}"#,
                .stop: #"{"listener": "stopped"}"#,
            ],
            linkEvents: [.qr(code: "2@preview"), .syncing, .linked],
            linkEventDelay: .seconds(2)
        )
    }
}

/// Documented example payloads (docs/CLI_JSON.md) for previews.
public enum SampleJSON {
    public static let status = """
    {
      "version": "0.5.0",
      "listener": "running",
      "daemon": "ready",
      "database": "ready",
      "channels": {
        "imessage": { "state": "ready", "tags": ["@s4"] },
        "whatsapp": { "state": "needs_link", "tags": ["@s4", "@wa"] }
      },
      "degradedCapabilities": [],
      "active": 0, "ambiguous": 0, "parked": 0, "rateLimited": 0,
      "lastSettledAt": 1790719000000
    }
    """

    public static let channels = """
    {
      "channels": [
        { "app": "imessage", "label": "iMessage", "configured": true, "enabled": true,
          "tags": ["@s4"], "tool": { "name": "imsg", "path": "/opt/homebrew/bin/imsg", "installed": true } },
        { "app": "whatsapp", "label": "WhatsApp", "configured": false, "enabled": false,
          "tags": [], "tool": { "name": "wacli", "path": null, "installed": false } }
      ]
    }
    """

    public static let tags = #"{"tags": [{"tag": "@s4", "apps": ["imessage", "whatsapp"]}]}"#
    public static let updateAvailable = #"{ "status": "available", "installedVersion": "0.5.0", "version": "0.5.1" }"#
    public static let doctor = #"{"healthy": true, "checks": [{"id": "whatsapp-linked", "status": "ok"}]}"#
}
