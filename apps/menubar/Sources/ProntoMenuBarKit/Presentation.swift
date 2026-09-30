import Foundation

/// Text for diagnostics and updates.
public enum Presentation {
    /// Human title for a doctor check id, e.g. `whatsapp-linked` → "WhatsApp linked".
    public static func checkTitle(_ id: String) -> String {
        let words = id.split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "." }).map(String.init)
        guard !words.isEmpty else { return id }
        // Words with fixed capitalization (brands, tool names, acronyms).
        let fixed: [String: String] = [
            "imessage": "iMessage", "whatsapp": "WhatsApp", "imsg": "imsg", "wacli": "wacli",
            "cli": "CLI", "launchd": "launchd", "macos": "macOS", "tcc": "TCC", "fda": "Full Disk Access",
        ]
        return words.enumerated().map { index, word -> String in
            if let special = fixed[word.lowercased()] { return special }
            let lower = word.lowercased()
            return index == 0 ? lower.prefix(1).uppercased() + lower.dropFirst() : lower
        }.joined(separator: " ")
    }

    public static func checkStatusText(_ status: CheckStatus) -> String {
        switch status {
        case .ok: return "OK"
        case .degraded: return "Degraded"
        case .failed: return "Failed"
        default: return status.rawValue.capitalized
        }
    }

    public static func checkTone(_ status: CheckStatus) -> StatusTone {
        switch status {
        case .ok: return .ok
        case .degraded: return .warning
        case .failed: return .error
        default: return .warning
        }
    }

    /// Doctor checks ordered failed → degraded → ok, stable within a group.
    public static func sortedChecks(_ checks: [DoctorCheck]) -> [DoctorCheck] {
        func rank(_ s: CheckStatus) -> Int {
            switch s {
            case .failed: return 0
            case .degraded: return 1
            case .ok: return 3
            default: return 2
            }
        }
        return checks.enumerated()
            .sorted { (rank($0.element.status), $0.offset) < (rank($1.element.status), $1.offset) }
            .map(\.element)
    }

    public static func updateResultText(_ response: UpdateInstallResponse) -> String {
        switch response.status {
        case .installed:
            return response.version.map { "Updated to Pronto \($0)." } ?? "Update installed."
        case .current:
            return "Pronto is up to date."
        case .migrationRequired:
            return "This update needs a one-time migration. Run `pronto update` in Terminal to continue."
        case .migrationInstalled:
            return response.version.map { "Migrated and updated to Pronto \($0)." } ?? "Migration installed."
        default:
            return "Update finished (\(response.status.rawValue))."
        }
    }

    public static func appList(_ apps: [AppID], labels: [AppID: String] = [:]) -> String {
        apps.sorted().map { labels[$0] ?? $0.defaultLabel }.formatted(.list(type: .and))
    }
}
