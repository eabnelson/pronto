import Foundation
import Observation

/// State for the diagnostics window (`doctor --json`, which can take about a minute).
@MainActor
@Observable
public final class DiagnosticsModel {
    public enum Phase: Equatable, Sendable {
        case idle
        case running(startedAt: Date)
        case finished(DoctorResponse)
        case failed(String)
    }

    public private(set) var phase: Phase = .idle
    private let client: CLIClient
    private let now: @Sendable () -> Date
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(client: CLIClient, now: @escaping @Sendable () -> Date = { Date() }) {
        self.client = client
        self.now = now
    }

    public var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    /// Checks sorted with problems first.
    public var checks: [DoctorCheck] {
        if case .finished(let response) = phase { return Presentation.sortedChecks(response.checks) }
        return []
    }

    /// Starts a run unless one is already in progress.
    public func run() {
        guard !isRunning else { return }
        phase = .running(startedAt: now())
        let client = client
        task = Task { [weak self] in
            do {
                let response = try await client.doctor()
                self?.phase = .finished(response)
            } catch is CancellationError {
                self?.phase = .idle
            } catch {
                self?.phase = .failed((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
            }
        }
    }

    /// Waits for the current run (tests).
    public func waitUntilFinished() async { await task?.value }

    public func cancel() {
        task?.cancel()
        task = nil
        if isRunning { phase = .idle }
    }
}
