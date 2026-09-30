import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Menu bar model")
@MainActor
struct MenuBarModelTests {
    func makeModel(_ cli: FixtureCLI, now: Date = Date(timeIntervalSince1970: 2_000_000_000)) -> MenuBarModel {
        MenuBarModel(client: cli.fake, defaults: nil, now: { now }, sleep: { _ in throw CancellationError() })
    }

    @Test func fullRefreshLoadsEverything() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        await model.refresh(full: true)
        #expect(model.status?.version == "0.5.0")
        #expect(model.version == "0.5.0")
        #expect(model.channels?.channels.count == 2)
        #expect(model.tagEntries.map(\.tag) == ["@s4"])
        #expect(model.health == .normal)
        #expect(model.clientError == nil)
        #expect(Set(cli.fake.invocations) == [.status, .channelsList, .tagsList])
    }

    @Test func statusOnlyRefresh() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        await model.refresh(full: false)
        #expect(cli.fake.invocations == [.status])
    }

    @Test func nonZeroStatusExitStillUpdates() async {
        let cli = FixtureCLI.standard()
        cli.set(.status, "status-paused.json", exitCode: 1)
        let model = makeModel(cli)
        await model.refresh(full: true)
        #expect(model.isPaused)
        #expect(model.health == .paused)
    }

    @Test func notInstalledClearsState() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        await model.refresh(full: true)
        cli.fake.setHandler { _ in throw CLIError.notInstalled(path: "/nope") }
        await model.refresh(full: false)
        #expect(!model.isInstalled)
        #expect(model.status == nil && model.channels == nil && model.tags == nil)
        #expect(model.health == .notInstalled)
    }

    @Test func concurrentRefreshesAreDebounced() async {
        let counter = Locked(0)
        let fake = FakeCLIClient { command in
            counter.withValue { $0 += 1 }
            try await Task.sleep(for: .milliseconds(50))
            return Fixture.output("status.json")
        }
        let model = MenuBarModel(client: fake, defaults: nil)
        async let a: Void = model.refresh(full: false)
        async let b: Void = model.refresh(full: false)
        async let c: Void = model.refresh(full: false)
        _ = await (a, b, c)
        #expect(counter.value == 1)
    }

    @Test func pollOnceChecksForUpdatesWhenDue() async {
        let cli = FixtureCLI.standard()
        cli.set(.updateCheck, "update-check-available.json")
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let model = makeModel(cli, now: now)
        await model.pollOnce(full: true)
        #expect(cli.fake.invocations.filter { $0 == .updateCheck }.count == 1)
        #expect(model.availableUpdate?.version == "0.5.1")
        #expect(model.lastUpdateCheck == now)
        #expect(model.health == .attention(["An update is available"]))
        #expect(model.icon.tint == .warning)
        #expect(model.updateMessage == nil)  // automatic checks are silent
        // Not due again within six hours.
        await model.pollOnce(full: false)
        #expect(cli.fake.invocations.filter { $0 == .updateCheck }.count == 1)
    }

    @Test func pollSkipsUpdateCheckWhenNotInstalled() async {
        let fake = FakeCLIClient { _ in throw CLIError.notInstalled(path: "/x") }
        let model = MenuBarModel(client: fake, defaults: nil)
        await model.pollOnce(full: true)
        #expect(!fake.invocations.contains(.updateCheck))
    }

    @Test func lastUpdateCheckPersists() async throws {
        let suite = "pronto-menubar-tests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cli = FixtureCLI.standard()
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let first = MenuBarModel(client: cli.fake, defaults: defaults, now: { now })
        await first.checkForUpdates(manual: true)
        let second = MenuBarModel(client: cli.fake, defaults: defaults, now: { now })
        #expect(second.lastUpdateCheck == now)
        #expect(second.availableUpdate == nil)

        cli.set(.updateCheck, "update-check-available.json")
        await second.checkForUpdates(manual: false)
        let third = MenuBarModel(client: cli.fake, defaults: defaults, now: { now })
        #expect(third.availableUpdate?.version == "0.5.1")
        #expect(third.pendingUpdate?.version == "0.5.1")
    }

    @Test func staleUpdateIsHiddenOnceInstalled() async {
        let installed = Locked("0.5.0")
        let fake = FakeCLIClient { command in
            switch command {
            case .status:
                return CLIOutput(exitCode: 0, stdout: Data(SampleJSON.status.replacingOccurrences(of: "0.5.0", with: installed.value).utf8))
            default:
                return Fixture.output("update-check-available.json")
            }
        }
        let model = MenuBarModel(client: fake, defaults: nil)
        await model.checkForUpdates(manual: false)
        await model.refresh(full: false)
        #expect(model.pendingUpdate?.version == "0.5.1")
        // Updated from Terminal: status now reports the offered version.
        installed.value = "0.5.1"
        await model.refresh(full: false)
        #expect(model.availableUpdate != nil)
        #expect(model.pendingUpdate == nil)
    }

    @Test func manualCheckReportsResult() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        await model.checkForUpdates(manual: true)
        #expect(model.updateMessage == "Pronto is up to date.")
        cli.set(.updateCheck, "update-check-available.json")
        await model.checkForUpdates(manual: true)
        #expect(model.updateMessage == "Pronto 0.5.1 is available.")
        #expect(model.updatePhase == .idle)
    }

    @Test func installUpdate() async {
        let cli = FixtureCLI.standard()
        cli.set(.updateCheck, "update-check-available.json")
        let model = makeModel(cli)
        await model.checkForUpdates(manual: false)
        #expect(model.availableUpdate != nil)
        await model.installUpdate()
        #expect(model.updateMessage == "Updated to Pronto 0.5.1.")
        #expect(model.availableUpdate == nil)
        #expect(cli.fake.invocations.contains(.updateInstall))
    }

    @Test func installUpdateFailureIsShown() async {
        let cli = FixtureCLI.standard()
        cli.set(.updateInstall, "error.json", exitCode: 1)
        let model = makeModel(cli)
        await model.installUpdate()
        #expect(model.updateMessage == "Every enabled app must keep at least one tag.")
    }

    @Test func toggleChannel() async {
        let cli = FixtureCLI.standard()
        cli.set(.channelsEnable(.whatsapp), "channels-both.json")
        let model = makeModel(cli)
        await model.refresh(full: true)
        #expect(await model.setChannel(.whatsapp, enabled: true))
        #expect(model.channels?.channel(.whatsapp)?.enabled == true)
        #expect(cli.fake.invocations.contains(.channelsEnable(.whatsapp)))
        #expect(model.busyAction == nil)
    }

    @Test func toggleChannelErrorIsInline() async {
        let cli = FixtureCLI.standard()
        cli.set(.channelsDisable(.imessage), "error.json", exitCode: 1)
        let model = makeModel(cli)
        #expect(!(await model.setChannel(.imessage, enabled: false)))
        #expect(model.actionError == "Every enabled app must keep at least one tag.")
    }

    @Test func pauseAndResume() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        cli.set(.status, "status-paused.json", exitCode: 1)
        #expect(await model.setPaused(true))
        #expect(model.isPaused)
        cli.set(.status, "status.json")
        #expect(await model.setPaused(false))
        #expect(!model.isPaused)
        #expect(cli.fake.invocations.filter { $0 == .stop || $0 == .start } == [.stop, .start])
    }

    @Test func addTagValidatesBeforeRunning() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        #expect(!(await model.addTag("not valid!", apps: [.imessage])))
        #expect(model.tagError == "Use only letters, numbers, - and _.")
        #expect(!(await model.addTag("@ok", apps: [])))
        #expect(model.tagError == "Choose at least one app.")
        #expect(cli.fake.invocations.isEmpty)
    }

    @Test func addTagRunsNormalizedCommand() async {
        let cli = FixtureCLI.standard()
        cli.set(.tagsAdd(tag: "@wa", apps: [.whatsapp]), "tags-list-both.json")
        let model = makeModel(cli)
        #expect(await model.addTag("WA", apps: [.whatsapp]))
        #expect(model.tagError == nil)
        #expect(cli.fake.invocations.first == .tagsAdd(tag: "@wa", apps: [.whatsapp]))
    }

    @Test func removeTagErrorFromCLIShownInline() async {
        let cli = FixtureCLI.standard()
        cli.set(.tagsRemove(tag: "@s4", apps: []), "error.json", exitCode: 1)
        let model = makeModel(cli)
        await model.refresh(full: true)
        let entry = model.tagEntries[0]
        #expect(!(await model.removeTag(entry)))
        #expect(model.tagError == "Every enabled app must keep at least one tag.")
    }

    @Test func editTagAppsRunsAddThenRemove() async {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        let entry = TagEntry(tag: "@wa", apps: [.whatsapp])
        #expect(await model.setApps([.imessage], for: entry))
        let mutations = cli.fake.invocations.filter(\.isMutation)
        #expect(mutations == [.tagsAdd(tag: "@wa", apps: [.imessage]), .tagsRemove(tag: "@wa", apps: [.whatsapp])])
    }

    @Test func editStopsAtFirstFailure() async {
        let cli = FixtureCLI.standard()
        cli.set(.tagsAdd(tag: "@wa", apps: [.imessage]), "error.json", exitCode: 1)
        let model = makeModel(cli)
        #expect(!(await model.setApps([.imessage], for: TagEntry(tag: "@wa", apps: [.whatsapp]))))
        #expect(!cli.fake.invocations.contains(.tagsRemove(tag: "@wa", apps: [.whatsapp])))
    }

    @Test func mutationsAreSerialized() async {
        let fake = FakeCLIClient { command in
            if command == .stop { try await Task.sleep(for: .milliseconds(100)) }
            return Fixture.output(command == .stop ? "listener-stopped.json" : "status.json")
        }
        let model = MenuBarModel(client: fake, defaults: nil)
        async let first = model.setPaused(true)
        await Task.yield()
        #expect(model.busyAction == .listener)
        let second = await model.setChannel(.imessage, enabled: false)
        #expect(!second)
        #expect(await first)
        #expect(!fake.invocations.contains(.channelsDisable(.imessage)))
    }

    @Test func panelOpenTriggersFullRefresh() async throws {
        let cli = FixtureCLI.standard()
        let model = makeModel(cli)
        model.setPanelOpen(true)
        #expect(model.isPanelOpen)
        for _ in 0..<50 where model.tags == nil { try await Task.sleep(for: .milliseconds(10)) }
        #expect(model.tags != nil)
        model.setPanelOpen(false)
        #expect(!model.isPanelOpen)
    }

    @Test func pollingLoopUsesPolicyIntervals() async throws {
        let cli = FixtureCLI.standard()
        let intervals = Locked<[Duration]>([])
        let model = MenuBarModel(client: cli.fake, defaults: nil, sleep: { duration in
            intervals.withValue { $0.append(duration) }
            if intervals.value.count >= 2 { throw CancellationError() }
        })
        model.start()
        for _ in 0..<100 where intervals.value.count < 2 { try await Task.sleep(for: .milliseconds(10)) }
        #expect(intervals.value == [.seconds(60), .seconds(60)])
        model.stop()
    }
}

@Suite("Diagnostics model")
@MainActor
struct DiagnosticsModelTests {
    @Test func runsDoctor() async {
        let cli = FixtureCLI.standard()
        cli.set(.doctor, "doctor-mixed.json", exitCode: 1)
        let model = DiagnosticsModel(client: cli.fake)
        model.run()
        #expect(model.isRunning)
        await model.waitUntilFinished()
        guard case .finished(let response) = model.phase else { Issue.record("expected finished"); return }
        #expect(!response.healthy)
        #expect(model.checks.first?.status == .failed)
    }

    @Test func reportsFailure() async {
        let fake = FakeCLIClient { _ in throw CLIError.timedOut }
        let model = DiagnosticsModel(client: fake)
        model.run()
        await model.waitUntilFinished()
        #expect(model.phase == .failed("Pronto took too long to respond."))
    }

    @Test func cancel() async {
        let fake = FakeCLIClient { _ in
            try await Task.sleep(for: .seconds(10))
            return Fixture.output("doctor.json")
        }
        let model = DiagnosticsModel(client: fake)
        model.run()
        model.cancel()
        #expect(model.phase == .idle)
    }
}

@Suite("Link model")
@MainActor
struct LinkModelTests {
    @Test func firstLinkRequiresDisclosure() {
        let model = LinkModel(client: FakeCLIClient { _ in throw CancellationError() }, whatsAppConfigured: false, availableTags: ["@s4"])
        #expect(model.phase == .disclosure)
        model.acknowledgeDisclosure()
        #expect(model.phase == .disclosure)  // checkbox not ticked
        model.acceptedRisk = true
        model.acknowledgeDisclosure()
        #expect(model.phase == .ready)
    }

    @Test func relinkSkipsDisclosure() {
        let model = LinkModel(client: FakeCLIClient { _ in throw CancellationError() }, whatsAppConfigured: true, availableTags: [])
        #expect(model.phase == .ready)
        #expect(model.makeOptions() == WhatsAppLinkOptions(acceptRisk: true))
    }

    @Test func optionsFromForm() {
        let model = LinkModel(client: FakeCLIClient { _ in throw CancellationError() }, whatsAppConfigured: false, availableTags: ["@s4", "@wa"])
        #expect(model.makeOptions() == nil)
        #expect(model.validationError != nil)
        model.acceptedRisk = true
        #expect(model.makeOptions() == WhatsAppLinkOptions(acceptRisk: true, tags: []))  // all tags = CLI default
        model.selectedTags = ["@wa"]
        #expect(model.makeOptions() == WhatsAppLinkOptions(acceptRisk: true, tags: ["@wa"]))
        model.selectedTags = []
        #expect(model.makeOptions() == nil)
        model.selectedTags = ["@s4", "@wa"]
        model.usePhoneNumber = true
        model.phoneInput = "nope"
        #expect(model.makeOptions() == nil)
        model.phoneInput = "+1 555 123 4567"
        #expect(model.makeOptions() == WhatsAppLinkOptions(phone: "+15551234567", acceptRisk: true))
    }

    @Test func streamsQRThenSyncingThenLinked() async {
        let fake = FakeCLIClient { _ in throw CancellationError() }
        fake.setLinkEvents([.qr(code: "2@a"), .qr(code: "2@b"), .syncing, .linked])
        var linkedCalls = 0
        let model = LinkModel(client: fake, whatsAppConfigured: true, availableTags: []) { linkedCalls += 1 }
        model.start()
        #expect(model.phase == .starting)
        await model.waitUntilFinished()
        #expect(model.phase == .linked)
        #expect(linkedCalls == 1)
        #expect(fake.invocations == [.whatsappLink(WhatsAppLinkOptions(acceptRisk: true))])
    }

    @Test func phaseTransitions() {
        #expect(LinkPhase.starting.applying(.qr(code: "a")) == .qr(code: "a"))
        #expect(LinkPhase.qr(code: "a").applying(.qr(code: "b")) == .qr(code: "b"))
        #expect(LinkPhase.starting.applying(.pairingCode(code: "ABCD-EFGH")) == .pairingCode(code: "ABCD-EFGH"))
        #expect(LinkPhase.qr(code: "a").applying(.syncing) == .syncing)
        #expect(LinkPhase.syncing.applying(.linked) == .linked)
        #expect(LinkPhase.qr(code: "a").applying(.unknown(event: "x")) == .qr(code: "a"))
        #expect(LinkPhase.starting.applying(.error(reason: "consent-required", message: "m")) == .disclosure)
        #expect(LinkPhase.starting.applying(.error(reason: "timeout", message: nil)) == .failed(message: "The code expired before it was scanned. Try again."))
        #expect(LinkPhase.starting.applying(.error(reason: "x", message: "Boom")) == .failed(message: "Boom"))
        #expect(LinkPhase.syncing.isActive && !LinkPhase.linked.isActive && !LinkPhase.ready.isActive)
    }

    @Test func consentRequiredReturnsToDisclosure() async {
        let fake = FakeCLIClient { _ in throw CancellationError() }
        fake.setLinkEvents([.error(reason: "consent-required", message: "…")])
        let model = LinkModel(client: fake, whatsAppConfigured: true, availableTags: [])
        model.start()
        await model.waitUntilFinished()
        #expect(model.phase == .disclosure)
        #expect(model.needsDisclosure)
        #expect(!model.acceptedRisk)
    }

    @Test func streamEndingEarlyFails() async {
        let fake = FakeCLIClient { _ in throw CancellationError() }
        fake.setLinkEvents([.qr(code: "2@a")])
        let model = LinkModel(client: fake, whatsAppConfigured: true, availableTags: [])
        model.start()
        await model.waitUntilFinished()
        #expect(model.phase == .failed(message: "Linking ended before WhatsApp was linked. Try again."))
        model.reset()
        #expect(model.phase == .ready)
    }

    @Test func processFailureIsShown() async {
        let fake = FakeCLIClient { _ in throw CancellationError() }
        fake.setLinkEvents([.qr(code: "2@a")], error: CLIError.failed(message: "wacli crashed", exitCode: 1))
        let model = LinkModel(client: fake, whatsAppConfigured: true, availableTags: [])
        model.start()
        await model.waitUntilFinished()
        #expect(model.phase == .failed(message: "wacli crashed"))
    }

    @Test func cancelReturnsToForm() async {
        let fake = FakeCLIClient(linkEvents: [.qr(code: "2@a"), .linked], linkEventDelay: .seconds(5)) { _ in throw CancellationError() }
        let model = LinkModel(client: fake, whatsAppConfigured: true, availableTags: [])
        model.start()
        model.cancel()
        #expect(model.phase == .ready)
    }
}
