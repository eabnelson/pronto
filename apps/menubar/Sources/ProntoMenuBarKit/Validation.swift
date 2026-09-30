import Foundation

/// Client-side tag validation using the same rule as the CLI:
/// `^@?[A-Za-z0-9_-]{1,32}$`, normalized to a leading `@` and lowercase.
public enum TagValidation {
    public enum Failure: Error, Equatable, Sendable {
        case empty
        case tooLong
        case invalidCharacters

        public var message: String {
            switch self {
            case .empty: return "Enter a tag name, like pronto."
            case .tooLong: return "Tags can be at most 32 characters."
            case .invalidCharacters: return "Use only letters, numbers, - and _."
            }
        }
    }

    public static let maxLength = 32

    /// Returns the normalized tag (e.g. `@s4`) or a failure describing why it is invalid.
    public static func normalize(_ input: String) -> Result<String, Failure> {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = trimmed.hasPrefix("@") ? String(trimmed.dropFirst()) : trimmed
        if body.isEmpty { return .failure(.empty) }
        guard body.unicodeScalars.allSatisfy(isAllowed) else { return .failure(.invalidCharacters) }
        if body.count > maxLength { return .failure(.tooLong) }
        return .success("@" + body.lowercased())
    }

    public static func isValid(_ input: String) -> Bool {
        if case .success = normalize(input) { return true }
        return false
    }

    private static func isAllowed(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case "A"..."Z", "a"..."z", "0"..."9", "_", "-": return true
        default: return false
        }
    }
}

/// Normalizes the optional phone number for `whatsapp link --phone`.
/// Accepts digits with an optional leading `+`, ignoring spaces, dashes, dots and parentheses.
public enum PhoneValidation {
    public static func normalize(_ input: String) -> String? {
        let stripped = input.filter { !" -.()\u{00A0}".contains($0) }
        let body = stripped.hasPrefix("+") ? String(stripped.dropFirst()) : stripped
        guard (6...15).contains(body.count), body.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return stripped.hasPrefix("+") ? "+" + body : body
    }
}
