import Foundation

/// Every CLI invocation the menu bar app makes. `arguments` is the exact
/// argument vector passed to the executable (never a shell string).
public enum CLICommand: Hashable, Sendable {
    case status
    case channelsList
    case channelsEnable(AppID)
    case channelsDisable(AppID)
    case tagsList
    /// `tags add <tag> --app <app>... --json`. Empty `apps` means "every enabled app".
    case tagsAdd(tag: String, apps: [AppID])
    /// `tags remove <tag> [--app <app>]... --json`. Empty `apps` means "every app".
    case tagsRemove(tag: String, apps: [AppID])
    case start
    case stop
    case doctor
    case updateCheck
    case updateInstall
    case whatsappLink(WhatsAppLinkOptions)

    public var arguments: [String] {
        switch self {
        case .status:
            return ["status", "--json"]
        case .channelsList:
            return ["channels", "list", "--json"]
        case .channelsEnable(let app):
            return ["channels", "enable", app.rawValue, "--json"]
        case .channelsDisable(let app):
            return ["channels", "disable", app.rawValue, "--json"]
        case .tagsList:
            return ["tags", "list", "--json"]
        case .tagsAdd(let tag, let apps):
            return ["tags", "add", tag] + Self.appFlags(apps) + ["--json"]
        case .tagsRemove(let tag, let apps):
            return ["tags", "remove", tag] + Self.appFlags(apps) + ["--json"]
        case .start:
            return ["start", "--json"]
        case .stop:
            return ["stop", "--json"]
        case .doctor:
            return ["doctor", "--json"]
        case .updateCheck:
            return ["update", "--check", "--json"]
        case .updateInstall:
            return ["update", "--json"]
        case .whatsappLink(let options):
            return options.arguments
        }
    }

    /// Maximum wall-clock time before the process is terminated. `nil` means no limit
    /// (the link stream is cancelled by the user instead).
    public var timeout: TimeInterval? {
        switch self {
        case .doctor: return 240
        case .updateInstall: return 900
        case .updateCheck: return 90
        case .start, .stop: return 120
        case .whatsappLink: return nil
        default: return 30
        }
    }

    /// Commands that change state; the UI serializes these.
    public var isMutation: Bool {
        switch self {
        case .channelsEnable, .channelsDisable, .tagsAdd, .tagsRemove, .start, .stop, .updateInstall, .whatsappLink:
            return true
        default:
            return false
        }
    }

    private static func appFlags(_ apps: [AppID]) -> [String] {
        var seen = Set<AppID>()
        return apps.sorted().filter { seen.insert($0).inserted }.flatMap { ["--app", $0.rawValue] }
    }
}

/// Options for `pronto whatsapp link --events [--phone <number>] [--accept-risk] [--tag <tag>]...`.
public struct WhatsAppLinkOptions: Hashable, Sendable {
    public var phone: String?
    public var acceptRisk: Bool
    public var tags: [String]

    public init(phone: String? = nil, acceptRisk: Bool, tags: [String] = []) {
        self.phone = phone
        self.acceptRisk = acceptRisk
        self.tags = tags
    }

    public var arguments: [String] {
        var args = ["whatsapp", "link", "--events"]
        if let phone, !phone.isEmpty { args += ["--phone", phone] }
        if acceptRisk { args.append("--accept-risk") }
        for tag in tags { args += ["--tag", tag] }
        return args
    }
}
