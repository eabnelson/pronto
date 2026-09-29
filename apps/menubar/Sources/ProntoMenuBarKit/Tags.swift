import Foundation

/// Turns tag edits in the UI into `tags add/remove` commands.
public enum TagPlanner {
    public enum Failure: Error, Equatable, Sendable {
        case invalidTag(TagValidation.Failure)
        case noApps

        public var message: String {
            switch self {
            case .invalidTag(let failure): return failure.message
            case .noApps: return "Choose at least one app."
            }
        }
    }

    /// Apps checked by default in the "Add tag" form: every enabled app.
    public static func defaultApps(for channels: ChannelsResponse?) -> Set<AppID> {
        Set(channels?.enabledApps ?? [])
    }

    /// Apps a tag can be assigned to: every configured app.
    public static func assignableApps(for channels: ChannelsResponse?) -> [AppID] {
        channels?.configuredApps ?? []
    }

    /// Validates and normalizes a new tag and builds `tags add <tag> --app ... --json`.
    public static func addCommand(input: String, apps: Set<AppID>) -> Result<CLICommand, Failure> {
        switch TagValidation.normalize(input) {
        case .failure(let failure):
            return .failure(.invalidTag(failure))
        case .success(let tag):
            guard !apps.isEmpty else { return .failure(.noApps) }
            return .success(.tagsAdd(tag: tag, apps: apps.sorted()))
        }
    }

    /// Commands that change `tag` from `current` apps to `desired` apps.
    /// Adds run before removals so an app never passes through having no tag
    /// when a tag is being moved between apps. An empty `desired` removes the tag.
    public static func editCommands(tag: String, current: Set<AppID>, desired: Set<AppID>) -> [CLICommand] {
        if desired.isEmpty { return [.tagsRemove(tag: tag, apps: [])] }
        var commands: [CLICommand] = []
        let added = desired.subtracting(current)
        let removed = current.subtracting(desired)
        if !added.isEmpty { commands.append(.tagsAdd(tag: tag, apps: added.sorted())) }
        if !removed.isEmpty { commands.append(.tagsRemove(tag: tag, apps: removed.sorted())) }
        return commands
    }

    /// Tags sorted for display with their apps in stable order.
    public static func sorted(_ response: TagsResponse?) -> [TagEntry] {
        (response?.tags ?? [])
            .map { TagEntry(tag: $0.tag, apps: Array(Set($0.apps)).sorted()) }
            .sorted { $0.tag.localizedStandardCompare($1.tag) == .orderedAscending }
    }
}
