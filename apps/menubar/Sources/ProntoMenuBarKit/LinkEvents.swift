import Foundation

/// One event from `pronto whatsapp link --events`.
public enum LinkEvent: Hashable, Sendable {
    case qr(code: String)
    case pairingCode(code: String)
    /// The phone accepted the link; wacli is finishing its first sync of recent
    /// messages (can take a few minutes). Always followed by `linked` on success.
    case syncing
    case linked
    case error(reason: String?, message: String?)
    /// An event type this version of the app does not know; ignored by the UI.
    case unknown(event: String)

    private struct Wire: Decodable {
        var event: String?
        var code: String?
        var reason: String?
        var message: String?
        /// A plain CLI failure (`{"error": "..."}`), e.g. for invalid arguments.
        var error: String?
    }

    /// Parses one NDJSON line. Returns `nil` for blank lines; throws for malformed JSON.
    public static func parse(line: Data) throws -> LinkEvent? {
        let trimmed = line.trimmingASCIIWhitespace()
        if trimmed.isEmpty { return nil }
        let wire: Wire
        do {
            wire = try JSONDecoder().decode(Wire.self, from: trimmed)
        } catch {
            throw CLIError.decoding("malformed link event")
        }
        guard let event = wire.event else {
            if let failure = wire.error { return .error(reason: nil, message: failure) }
            throw CLIError.decoding("link event without type")
        }
        switch event {
        case "qr":
            guard let code = wire.code, !code.isEmpty else { throw CLIError.decoding("qr event without code") }
            return .qr(code: code)
        case "pairing_code":
            guard let code = wire.code, !code.isEmpty else { throw CLIError.decoding("pairing_code event without code") }
            return .pairingCode(code: code)
        case "syncing":
            return .syncing
        case "linked":
            return .linked
        case "error":
            return .error(reason: wire.reason, message: wire.message)
        default:
            return .unknown(event: event)
        }
    }

    public static func parse(line: String) throws -> LinkEvent? {
        try parse(line: Data(line.utf8))
    }

    public var isTerminal: Bool {
        switch self {
        case .linked, .error: return true
        default: return false
        }
    }
}

/// Splits an incrementally-read byte stream into complete newline-terminated lines.
/// Partial lines are buffered until the rest arrives (pipes deliver arbitrary chunks).
public struct NDJSONLineBuffer: Sendable {
    private var pending = Data()
    /// Guards against a runaway producer that never emits a newline.
    public let maxLineLength: Int

    public init(maxLineLength: Int = 1 << 20) {
        self.maxLineLength = maxLineLength
    }

    /// Appends a chunk and returns every complete line (without the terminator).
    public mutating func append(_ chunk: Data) -> [Data] {
        pending.append(chunk)
        var lines: [Data] = []
        while let newline = pending.firstIndex(of: 0x0A) {
            var line = pending[pending.startIndex..<newline]
            if line.last == 0x0D { line = line.dropLast() }
            lines.append(Data(line))
            pending = Data(pending[pending.index(after: newline)...])
        }
        if pending.count > maxLineLength {
            pending.removeAll()
        }
        return lines
    }

    /// Returns the trailing unterminated line, if any, at end of stream.
    public mutating func finish() -> Data? {
        defer { pending.removeAll() }
        let rest = pending.trimmingASCIIWhitespace()
        return rest.isEmpty ? nil : rest
    }
}

extension Data {
    func trimmingASCIIWhitespace() -> Data {
        let isSpace: (UInt8) -> Bool = { $0 == 0x20 || $0 == 0x09 || $0 == 0x0A || $0 == 0x0D }
        guard let first = firstIndex(where: { !isSpace($0) }),
              let last = lastIndex(where: { !isSpace($0) }) else { return Data() }
        return Data(self[first...last])
    }
}
