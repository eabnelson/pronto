import Foundation

/// Errors surfaced to the UI.
public enum CLIError: Error, Equatable, Sendable, LocalizedError {
    /// No executable at the expected path.
    case notInstalled(path: String)
    /// The executable failed code signature verification.
    case untrusted(path: String, detail: String)
    /// The process could not be launched.
    case launchFailed(String)
    /// The CLI reported `{"error": "..."}` or exited non-zero without usable output.
    case failed(message: String, exitCode: Int32)
    /// The output did not match the documented contract.
    case decoding(String)
    case timedOut

    public var errorDescription: String? {
        switch self {
        case .notInstalled: return "Pronto isn't installed."
        case .untrusted(_, let detail): return "The installed Pronto couldn't be verified (\(detail))."
        case .launchFailed(let message): return "Couldn't run Pronto: \(message)"
        case .failed(let message, _): return message
        case .decoding(let message): return "Unexpected response from Pronto: \(message)"
        case .timedOut: return "Pronto took too long to respond."
        }
    }
}

/// Raw result of one CLI invocation.
public struct CLIOutput: Sendable, Equatable {
    public var exitCode: Int32
    public var stdout: Data
    public var stderr: Data

    public init(exitCode: Int32, stdout: Data, stderr: Data = Data()) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }

    /// Decodes the documented JSON object, applying the contract's error rules:
    /// - `{"error": "..."}` always becomes `CLIError.failed`.
    /// - A non-zero exit with a well-formed result object is accepted (e.g. `status`
    ///   prints its JSON even when unhealthy).
    /// - A non-zero exit without a decodable result becomes `CLIError.failed`.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let body = stdout.trimmingASCIIWhitespace()
        let decoder = JSONDecoder()
        if let failure = try? decoder.decode(CLIErrorResponse.self, from: body) {
            throw CLIError.failed(message: failure.error, exitCode: exitCode)
        }
        do {
            return try decoder.decode(T.self, from: body)
        } catch {
            if exitCode != 0 {
                let message = String(decoding: stderr, as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                throw CLIError.failed(
                    message: message.isEmpty ? "Pronto exited with status \(exitCode)." : String(message.prefix(500)),
                    exitCode: exitCode
                )
            }
            throw CLIError.decoding(String(describing: T.self))
        }
    }
}

/// The only way the app talks to Pronto. The real implementation runs the
/// installed executable; `FakeCLIClient` serves fixtures for tests and previews.
public protocol CLIClient: Sendable {
    /// Runs a one-shot `--json` command and returns its raw output.
    func run(_ command: CLICommand) async throws -> CLIOutput
    /// Runs `whatsapp link --events`, yielding events as NDJSON lines arrive.
    /// Cancelling the consuming task terminates the process.
    func linkWhatsApp(_ options: WhatsAppLinkOptions) -> AsyncThrowingStream<LinkEvent, Error>
}

public extension CLIClient {
    func status() async throws -> StatusResponse { try await run(.status).decode(StatusResponse.self) }
    func channels() async throws -> ChannelsResponse { try await run(.channelsList).decode(ChannelsResponse.self) }
    func setChannel(_ app: AppID, enabled: Bool) async throws -> ChannelsResponse {
        try await run(enabled ? .channelsEnable(app) : .channelsDisable(app)).decode(ChannelsResponse.self)
    }
    func tags() async throws -> TagsResponse { try await run(.tagsList).decode(TagsResponse.self) }
    func addTag(_ tag: String, apps: [AppID]) async throws -> TagsResponse {
        try await run(.tagsAdd(tag: tag, apps: apps)).decode(TagsResponse.self)
    }
    func removeTag(_ tag: String, apps: [AppID]) async throws -> TagsResponse {
        try await run(.tagsRemove(tag: tag, apps: apps)).decode(TagsResponse.self)
    }
    func setListener(running: Bool) async throws -> ListenerResponse {
        try await run(running ? .start : .stop).decode(ListenerResponse.self)
    }
    func doctor() async throws -> DoctorResponse { try await run(.doctor).decode(DoctorResponse.self) }
    func checkForUpdate() async throws -> UpdateCheckResponse { try await run(.updateCheck).decode(UpdateCheckResponse.self) }
    func installUpdate() async throws -> UpdateInstallResponse { try await run(.updateInstall).decode(UpdateInstallResponse.self) }
}
