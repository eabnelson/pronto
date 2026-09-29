import Foundation

/// Runs the installed `pronto` executable with argument arrays (never a shell)
/// after verifying its code signature. All blocking work happens on background
/// queues; nothing here touches the main thread.
public final class ProcessCLIClient: CLIClient, @unchecked Sendable {
    public let location: CLILocation
    private let environment: [String: String]
    private let verifiedSignature = Locked<FileFingerprint?>(nil)

    public init(location: CLILocation = .resolve(), environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.location = location
        var env = environment
        env.removeValue(forKey: CLILocation.overrideEnvironmentKey)
        self.environment = env
    }

    // MARK: CLIClient

    public func run(_ command: CLICommand) async throws -> CLIOutput {
        let url = location.url
        let arguments = command.arguments
        let environment = environment
        let timeout = command.timeout
        let process = ProcessHandle()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<CLIOutput, Error>) in
                DispatchQueue.global(qos: .userInitiated).async { [self] in
                    do {
                        try self.prepareExecutable()
                        let output = try process.runToCompletion(
                            url: url, arguments: arguments, environment: environment, timeout: timeout
                        )
                        continuation.resume(returning: output)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            process.cancel()
        }
    }

    public func linkWhatsApp(_ options: WhatsAppLinkOptions) -> AsyncThrowingStream<LinkEvent, Error> {
        let url = location.url
        let arguments = CLICommand.whatsappLink(options).arguments
        let environment = environment
        return AsyncThrowingStream { continuation in
            let process = ProcessHandle()
            continuation.onTermination = { _ in process.cancel() }
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                do {
                    try self.prepareExecutable()
                    try process.stream(url: url, arguments: arguments, environment: environment) { line in
                        do {
                            if let event = try LinkEvent.parse(line: line) { continuation.yield(event) }
                        } catch {
                            // Malformed lines are skipped; the stream contract is one object per line.
                        }
                    } completion: { exitCode, stderr, cancelled in
                        if cancelled {
                            continuation.finish(throwing: CancellationError())
                        } else if exitCode != 0 {
                            let message = String(decoding: stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                            continuation.finish(throwing: CLIError.failed(
                                message: message.isEmpty ? "Linking stopped (exit status \(exitCode))." : String(message.prefix(500)),
                                exitCode: exitCode
                            ))
                        } else {
                            continuation.finish()
                        }
                    }
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: Verification

    /// Ensures the executable exists and (unless overridden for development)
    /// satisfies Pronto's designated requirement. The result is cached per file
    /// fingerprint so polling does not re-hash the binary every few seconds.
    func prepareExecutable() throws {
        let path = location.url.path
        guard FileManager.default.isExecutableFile(atPath: path) else {
            throw CLIError.notInstalled(path: path)
        }
        guard location.requiresSignatureCheck else { return }
        let fingerprint = FileFingerprint(path: path)
        if let fingerprint, verifiedSignature.value == fingerprint { return }
        if let failure = CodeSignatureVerifier.verify(location.url) {
            verifiedSignature.value = nil
            throw CLIError.untrusted(path: path, detail: failure.detail)
        }
        verifiedSignature.value = fingerprint
    }
}

/// Identity of a file on disk, used to invalidate the signature cache when the
/// CLI is replaced (for example by `pronto update`).
struct FileFingerprint: Equatable, Sendable {
    var inode: UInt64
    var size: UInt64
    var modified: Date

    init?(path: String) {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let inode = (attributes[.systemFileNumber] as? NSNumber)?.uint64Value,
              let size = (attributes[.size] as? NSNumber)?.uint64Value,
              let modified = attributes[.modificationDate] as? Date else { return nil }
        self.inode = inode
        self.size = size
        self.modified = modified
    }
}

/// A tiny lock-protected box.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: Value
    init(_ value: Value) { _value = value }
    var value: Value {
        get { lock.withLock { _value } }
        set { lock.withLock { _value = newValue } }
    }
    func withValue<T>(_ body: (inout Value) -> T) -> T { lock.withLock { body(&_value) } }
}

/// Owns one child process and makes cancellation/timeout race-free.
final class ProcessHandle: @unchecked Sendable {
    private enum Phase { case idle, running(Process), finished, cancelled }
    private let lock = NSLock()
    private var phase: Phase = .idle
    private var didTimeOut = false
    private var wasCancelled = false

    func cancel() {
        lock.withLock {
            wasCancelled = true
            switch phase {
            case .idle: phase = .cancelled
            case .running(let process): if process.isRunning { process.terminate() }
            case .finished, .cancelled: break
            }
        }
    }

    private func timeOut() {
        lock.withLock {
            if case .running(let process) = phase, process.isRunning {
                didTimeOut = true
                process.terminate()
            }
        }
    }

    private func launch(url: URL, arguments: [String], environment: [String: String]) throws -> (Process, Pipe, Pipe) {
        let process = Process()
        process.executableURL = url
        process.arguments = arguments
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try lock.withLock {
            if case .cancelled = phase { throw CancellationError() }
            do {
                try process.run()
            } catch {
                throw CLIError.launchFailed(error.localizedDescription)
            }
            phase = .running(process)
        }
        return (process, stdout, stderr)
    }

    private func markFinished() {
        lock.withLock { phase = .finished }
    }

    /// Blocking: runs the process, collects stdout/stderr, and returns its output.
    func runToCompletion(url: URL, arguments: [String], environment: [String: String], timeout: TimeInterval?) throws -> CLIOutput {
        let (process, stdout, stderr) = try launch(url: url, arguments: arguments, environment: environment)
        var timer: DispatchWorkItem?
        if let timeout {
            let item = DispatchWorkItem { [weak self] in self?.timeOut() }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout, execute: item)
            timer = item
        }
        let errData = Locked(Data())
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errData.value = stderr.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        let outData = stdout.fileHandleForReading.readDataToEndOfFile()
        group.wait()
        process.waitUntilExit()
        timer?.cancel()
        markFinished()

        let (timedOut, cancelled) = lock.withLock { (didTimeOut, wasCancelled) }
        if cancelled { throw CancellationError() }
        if timedOut { throw CLIError.timedOut }
        return CLIOutput(exitCode: process.terminationStatus, stdout: outData, stderr: errData.value)
    }

    /// Blocking: runs the process, delivering each complete stdout line as it arrives.
    func stream(
        url: URL, arguments: [String], environment: [String: String],
        onLine: (Data) -> Void,
        completion: (_ exitCode: Int32, _ stderr: Data, _ cancelled: Bool) -> Void
    ) throws {
        let (process, stdout, stderr) = try launch(url: url, arguments: arguments, environment: environment)
        let errData = Locked(Data())
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            let data = stderr.fileHandleForReading.readDataToEndOfFile()
            errData.value = data.suffix(4096)
            group.leave()
        }
        var buffer = NDJSONLineBuffer()
        let handle = stdout.fileHandleForReading
        while true {
            let chunk = handle.availableData
            if chunk.isEmpty { break }
            for line in buffer.append(chunk) { onLine(line) }
        }
        if let rest = buffer.finish() { onLine(rest) }
        group.wait()
        process.waitUntilExit()
        markFinished()
        let cancelled = lock.withLock { wasCancelled }
        completion(process.terminationStatus, errData.value, cancelled)
    }
}
