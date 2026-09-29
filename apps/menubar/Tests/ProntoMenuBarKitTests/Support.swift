import Foundation
@testable import ProntoMenuBarKit

/// Fixture files shared with Tests/Fixtures/fake-pronto.
enum Fixture {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures", isDirectory: true)

    static let fakeCLI = directory.appendingPathComponent("fake-pronto")

    static func data(_ name: String) -> Data {
        let url = directory.appendingPathComponent("json").appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { fatalError("Missing fixture \(name)") }
        return data
    }

    static func string(_ name: String) -> String { String(decoding: data(name), as: UTF8.self) }

    static func output(_ name: String, exitCode: Int32 = 0) -> CLIOutput {
        CLIOutput(exitCode: exitCode, stdout: data(name))
    }

    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try output(name).decode(type)
    }
}

/// A fake client whose responses come from fixture files and can change mid-test.
final class FixtureCLI: @unchecked Sendable {
    private let lock = NSLock()
    private var files: [CLICommand: (String, Int32)]
    let fake: FakeCLIClient

    init(_ files: [CLICommand: String] = [:]) {
        self.files = files.mapValues { ($0, 0) }
        let table = WeakRef<FixtureCLI>()
        fake = FakeCLIClient { command in
            guard let owner = table.value else { throw CancellationError() }
            return owner.response(for: command)
        }
        table.value = self
    }

    func set(_ command: CLICommand, _ file: String, exitCode: Int32 = 0) {
        lock.withLock { files[command] = (file, exitCode) }
    }

    private func response(for command: CLICommand) -> CLIOutput {
        let entry: (String, Int32)? = lock.withLock {
            if let exact = files[command] { return exact }
            // Fall back to a response for the same command family.
            switch command {
            case .tagsAdd, .tagsRemove: return files[.tagsList]
            case .channelsEnable, .channelsDisable: return files[.channelsList]
            default: return nil
            }
        }
        guard let (file, exitCode) = entry else {
            return CLIOutput(exitCode: 1, stdout: Data(#"{"error": "no fixture"}"#.utf8))
        }
        return Fixture.output(file, exitCode: exitCode)
    }

    static func standard() -> FixtureCLI {
        FixtureCLI([
            .status: "status.json",
            .channelsList: "channels-list.json",
            .tagsList: "tags-list.json",
            .updateCheck: "update-check-current.json",
            .start: "listener-running.json",
            .stop: "listener-stopped.json",
            .doctor: "doctor-mixed.json",
            .updateInstall: "update-installed.json",
        ])
    }
}

final class WeakRef<T: AnyObject>: @unchecked Sendable {
    weak var value: T?
}

extension CLIError {
    var isNotInstalled: Bool {
        if case .notInstalled = self { return true }
        return false
    }
}
