import Foundation
import Observation

/// A state-changing action in progress. Only one runs at a time; the UI
/// disables the matching controls while it does.
public enum BusyAction: Hashable, Sendable {
    case channel(AppID)
    case listener
    case tag(String)
    case addTag
}

public enum UpdatePhase: Equatable, Sendable {
    case idle
    case checking
    case installing(version: String?)
}

/// App state for the menu bar panel. All CLI calls go through `CLIClient`;
/// the SwiftUI layer only reads these properties and calls these methods.
@MainActor
@Observable
public final class MenuBarModel {
    // MARK: State from the CLI

    public private(set) var status: StatusResponse?
    public private(set) var channels: ChannelsResponse?
    public private(set) var tags: TagsResponse?
    /// The last failure to reach the CLI at all (cleared on the next success).
    public private(set) var clientError: CLIError?

    // MARK: UI state

    public private(set) var isPanelOpen = false
    public private(set) var busyAction: BusyAction?
    /// Inline error for app toggles, pause/resume, etc.
    public var actionError: String?
    /// Inline error for the tags section (e.g. "an app must keep at least one tag").
    public var tagError: String?

    // MARK: Updates

    public private(set) var updatePhase: UpdatePhase = .idle
    /// The last `update --check` result that reported an update. Persisted so a
    /// relaunch keeps showing it until the next check (at most every 6 hours).
    public private(set) var availableUpdate: UpdateCheckResponse? {
        didSet {
            if let availableUpdate, let data = try? JSONEncoder().encode(availableUpdate) {
                defaults?.set(data, forKey: Self.availableUpdateKey)
            } else {
                defaults?.removeObject(forKey: Self.availableUpdateKey)
            }
        }
    }
    public private(set) var lastUpdateCheck: Date?
    /// Result or error of the last manual check or install.
    public var updateMessage: String?

    // MARK: Dependencies

    public let client: CLIClient
    public let policy: PollPolicy
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private let defaults: UserDefaults?
    private static let lastUpdateCheckKey = "lastUpdateCheck"
    private static let availableUpdateKey = "availableUpdate"

    @ObservationIgnored private let statusFlight = SingleFlight<StatusResponse>()
    @ObservationIgnored private let channelsFlight = SingleFlight<ChannelsResponse>()
    @ObservationIgnored private let tagsFlight = SingleFlight<TagsResponse>()
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    public init(
        client: CLIClient,
        policy: PollPolicy = .standard,
        defaults: UserDefaults? = .standard,
        now: @escaping @Sendable () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.client = client
        self.policy = policy
        self.defaults = defaults
        self.now = now
        self.sleep = sleep
        if let stored = defaults?.object(forKey: Self.lastUpdateCheckKey) as? Date {
            lastUpdateCheck = stored
        }
        if let data = defaults?.data(forKey: Self.availableUpdateKey),
           let stored = try? JSONDecoder().decode(UpdateCheckResponse.self, from: data), stored.isAvailable {
            availableUpdate = stored
        }
    }

    // MARK: Derived

    public var health: OverallHealth {
        HealthEvaluator.evaluate(HealthInput(
            status: status, channels: channels,
            updateAvailable: pendingUpdate != nil,
            clientError: clientError
        ))
    }

    /// The available update, unless the installed CLI already has that version
    /// (e.g. it was updated from Terminal since the last check).
    public var pendingUpdate: UpdateCheckResponse? {
        guard let update = availableUpdate, update.isAvailable else { return nil }
        if let installed = status?.version, let offered = update.version, installed == offered { return nil }
        return update
    }

    public var icon: MenuBarIcon { MenuBarIcon(health: health) }
    public var channelRows: [ChannelRow] { ChannelRowBuilder.rows(status: status, channels: channels) }
    public var tagEntries: [TagEntry] { TagPlanner.sorted(tags) }
    public var isInstalled: Bool {
        if case .notInstalled = clientError { return false }
        return true
    }
    public var isPaused: Bool { status.map(HealthEvaluator.isPaused) ?? false }
    public var version: String? { status?.version ?? availableUpdate?.installedVersion }
    public var whatsApp: ChannelInfo? { channels?.channel(.whatsapp) }
    /// Labels from `channels list`, for tag badges.
    public var appLabels: [AppID: String] {
        Dictionary((channels?.channels ?? []).map { ($0.app, $0.label) }, uniquingKeysWith: { a, _ in a })
    }

    // MARK: Polling

    /// Starts background polling (idempotent).
    public func start() {
        guard pollTask == nil else { return }
        startLoop(skipFirstTick: false)
    }

    public func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Opening the panel refreshes everything right away and switches to fast polling.
    public func setPanelOpen(_ open: Bool) {
        guard open != isPanelOpen else { return }
        isPanelOpen = open
        if open {
            let wasRunning = pollTask != nil
            stop()
            Task { await self.refresh(full: true) }
            if wasRunning { startLoop(skipFirstTick: true) }
        } else {
            actionError = nil
        }
    }

    private func startLoop(skipFirstTick: Bool) {
        pollTask = Task { [weak self] in
            var tick = 0
            while !Task.isCancelled {
                guard let self else { return }
                if tick > 0 || !skipFirstTick { await self.pollOnce(full: tick == 0) }
                tick += 1
                let interval = self.policy.statusInterval(panelOpen: self.isPanelOpen, installed: self.isInstalled)
                do { try await self.sleep(interval) } catch { return }
            }
        }
    }

    /// One polling tick: refresh status (and apps/tags when `full`), then run an
    /// automatic update check if one is due.
    public func pollOnce(full: Bool) async {
        await refresh(full: full || channels == nil)
        if isInstalled, status != nil, policy.isUpdateCheckDue(lastCheck: lastUpdateCheck, now: now()) {
            await checkForUpdates(manual: false)
        }
    }

    /// Refreshes status; with `full`, also apps and tags. Concurrent calls share one process each.
    public func refresh(full: Bool) async {
        let client = client
        do {
            if full {
                async let s = statusFlight.run { try await client.status() }
                async let c = channelsFlight.run { try await client.channels() }
                async let t = tagsFlight.run { try await client.tags() }
                let (status, channels, tags) = try await (s, c, t)
                self.status = status
                self.channels = channels
                self.tags = tags
            } else {
                status = try await statusFlight.run { try await client.status() }
            }
            clientError = nil
        } catch is CancellationError {
            return
        } catch let error as CLIError {
            clientError = error
            if case .notInstalled = error {
                status = nil
                channels = nil
                tags = nil
            }
        } catch {
            clientError = .failed(message: error.localizedDescription, exitCode: -1)
        }
    }

    // MARK: Actions

    private func perform(_ action: BusyAction, _ body: () async throws -> Void) async -> Bool {
        guard busyAction == nil else { return false }
        busyAction = action
        defer { busyAction = nil }
        do {
            try await body()
            return true
        } catch is CancellationError {
            return false
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            switch action {
            case .tag, .addTag: tagError = message
            default: actionError = message
            }
            return false
        }
    }

    /// `channels enable|disable <app> --json`
    @discardableResult
    public func setChannel(_ app: AppID, enabled: Bool) async -> Bool {
        actionError = nil
        return await perform(.channel(app)) {
            self.channels = try await self.client.setChannel(app, enabled: enabled)
            await self.refresh(full: false)
        }
    }

    /// `stop --json` / `start --json`
    @discardableResult
    public func setPaused(_ paused: Bool) async -> Bool {
        actionError = nil
        return await perform(.listener) {
            _ = try await self.client.setListener(running: !paused)
            await self.refresh(full: false)
        }
    }

    /// Validates client-side, then `tags add <tag> --app ... --json`.
    @discardableResult
    public func addTag(_ input: String, apps: Set<AppID>) async -> Bool {
        tagError = nil
        switch TagPlanner.addCommand(input: input, apps: apps) {
        case .failure(let failure):
            tagError = failure.message
            return false
        case .success(let command):
            return await perform(.addTag) {
                self.tags = try await self.client.run(command).decode(TagsResponse.self)
                await self.refresh(full: true)
            }
        }
    }

    /// Applies checkbox changes for one tag (adds before removes).
    @discardableResult
    public func setApps(_ desired: Set<AppID>, for entry: TagEntry) async -> Bool {
        tagError = nil
        let commands = TagPlanner.editCommands(tag: entry.tag, current: Set(entry.apps), desired: desired)
        guard !commands.isEmpty else { return true }
        let ok = await perform(.tag(entry.tag)) {
            for command in commands {
                self.tags = try await self.client.run(command).decode(TagsResponse.self)
            }
        }
        await refresh(full: true)
        return ok
    }

    /// `tags remove <tag> --json` (removes it from every app).
    @discardableResult
    public func removeTag(_ entry: TagEntry) async -> Bool {
        await setApps([], for: entry)
    }

    /// `update --check --json`. Automatic checks are silent; manual checks report the result.
    public func checkForUpdates(manual: Bool) async {
        guard updatePhase == .idle else { return }
        updatePhase = .checking
        defer { updatePhase = .idle }
        if manual { updateMessage = nil }
        do {
            let result = try await client.checkForUpdate()
            availableUpdate = result.isAvailable ? result : nil
            recordUpdateCheck()
            if manual {
                updateMessage = result.isAvailable
                    ? "Pronto \(result.version ?? "") is available."
                    : "Pronto is up to date."
            }
        } catch is CancellationError {
        } catch {
            // Record failed automatic checks too so an offline Mac is not re-checked every poll.
            recordUpdateCheck()
            if manual { updateMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription }
        }
    }

    /// `update --json`
    public func installUpdate() async {
        guard updatePhase == .idle else { return }
        updatePhase = .installing(version: availableUpdate?.version)
        defer { updatePhase = .idle }
        updateMessage = nil
        do {
            let result = try await client.installUpdate()
            updateMessage = Presentation.updateResultText(result)
            if result.status == .installed || result.status == .current || result.status == .migrationInstalled {
                availableUpdate = nil
            }
        } catch is CancellationError {
        } catch {
            updateMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
        await refresh(full: true)
    }

    private func recordUpdateCheck() {
        let date = now()
        lastUpdateCheck = date
        defaults?.set(date, forKey: Self.lastUpdateCheckKey)
    }
}
