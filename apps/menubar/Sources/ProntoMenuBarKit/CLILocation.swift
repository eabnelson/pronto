import Foundation
import Security

/// Where the CLI lives and whether its signature must be checked.
public struct CLILocation: Equatable, Sendable {
    public var url: URL
    /// `true` for the installed CLI; `false` for a developer override.
    public var requiresSignatureCheck: Bool

    public init(url: URL, requiresSignatureCheck: Bool) {
        self.url = url
        self.requiresSignatureCheck = requiresSignatureCheck
    }

    /// Environment variable that points the app at another executable
    /// (development and tests). Skips signature verification.
    public static let overrideEnvironmentKey = "PRONTO_MENUBAR_CLI"

    /// `~/Library/Application Support/pronto/bin/pronto`
    public static func installedURL(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        home.appendingPathComponent("Library/Application Support/pronto/bin/pronto", isDirectory: false)
    }

    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        home: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> CLILocation {
        if let override = environment[overrideEnvironmentKey]?.trimmingCharacters(in: .whitespaces), !override.isEmpty {
            let expanded = (override as NSString).expandingTildeInPath
            return CLILocation(url: URL(fileURLWithPath: expanded), requiresSignatureCheck: false)
        }
        return CLILocation(url: installedURL(home: home), requiresSignatureCheck: true)
    }
}

/// Verifies the installed CLI against Pronto's designated requirement before it is executed.
public enum CodeSignatureVerifier {
    /// The installed CLI must be signed by Pronto's Developer ID team with this identifier.
    public static let designatedRequirement =
        #"identifier "dev.pronto.cli" and anchor apple generic and certificate leaf[subject.OU] = "9YCNUWK84C""#

    public enum Failure: Error, Equatable, Sendable {
        case invalidRequirement(OSStatus)
        case unreadable(OSStatus)
        case notSatisfied(OSStatus)

        public var detail: String {
            switch self {
            case .invalidRequirement(let s): return "invalid requirement (\(s))"
            case .unreadable(let s): return "no readable code signature (\(s))"
            case .notSatisfied(let s):
                return s == errSecCSReqFailed ? "not signed by Pronto" : "signature check failed (\(s))"
            }
        }
    }

    /// Returns `nil` when `url` satisfies `requirement`, otherwise why it does not.
    public static func verify(_ url: URL, requirement: String = designatedRequirement) -> Failure? {
        var code: SecStaticCode?
        let createStatus = SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &code)
        guard createStatus == errSecSuccess, let code else { return .unreadable(createStatus) }

        var secRequirement: SecRequirement?
        let reqStatus = SecRequirementCreateWithString(requirement as CFString, SecCSFlags(), &secRequirement)
        guard reqStatus == errSecSuccess, let secRequirement else { return .invalidRequirement(reqStatus) }

        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSStrictValidate | kSecCSCheckNestedCode)
        let status = SecStaticCodeCheckValidity(code, flags, secRequirement)
        return status == errSecSuccess ? nil : .notSatisfied(status)
    }
}
