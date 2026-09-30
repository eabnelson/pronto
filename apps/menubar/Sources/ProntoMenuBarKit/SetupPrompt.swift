import Foundation

/// Prompts people paste into Codex or Claude Code to have their agent set Pronto
/// up by following the hosted setup guide.
public enum SetupPrompt {
    public static let guideURL = URL(string: "https://studiofour.io/imessage-setup.md")!

    /// Installs Pronto from scratch. Matches the "Help me get set up" prompt on the website.
    public static var install: String {
        "Help me set up Pronto on this Mac. Follow \(guideURL.absoluteString) and stay with me until, "
            + "in each messaging app I choose, one tagged message gets exactly one agent reply."
    }

    /// Adds `app` to an existing install without turning off the apps already in use.
    public static func add(_ app: AppID, labels: [AppID: String] = [:], keeping: [AppID]) -> String {
        let label = labels[app] ?? app.defaultLabel
        let kept = keeping.filter { $0 != app }
        let names = Presentation.appList(kept, labels: labels)
        let current = kept.isEmpty ? "Pronto is already installed." : "Pronto is already installed and answering in \(names)."
        let choice = kept.isEmpty ? "choose \(label)" : "choose \(label) as well as \(names) so they all stay on"
        return "Help me add \(label) to Pronto on this Mac. \(current) Follow \(guideURL.absoluteString), "
            + "re-run setup and \(choice), and stay with me until one tagged message in \(label) gets exactly one agent reply."
    }
}
