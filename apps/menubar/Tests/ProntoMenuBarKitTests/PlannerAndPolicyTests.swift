import CoreGraphics
import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Tag planning")
struct TagPlannerTests {
    @Test func defaultAppsAreEnabledApps() throws {
        #expect(TagPlanner.defaultApps(for: try Fixture.decode(ChannelsResponse.self, "channels-list.json")) == [.imessage])
        #expect(TagPlanner.defaultApps(for: try Fixture.decode(ChannelsResponse.self, "channels-both.json")) == [.imessage, .whatsapp])
        #expect(TagPlanner.defaultApps(for: nil).isEmpty)
    }

    @Test func assignableAppsAreConfiguredApps() throws {
        #expect(TagPlanner.assignableApps(for: try Fixture.decode(ChannelsResponse.self, "channels-wacli-installed.json")) == [.imessage])
        #expect(TagPlanner.assignableApps(for: try Fixture.decode(ChannelsResponse.self, "channels-both.json")) == [.imessage, .whatsapp])
    }

    @Test func addCommandNormalizes() {
        #expect(TagPlanner.addCommand(input: " Pronto ", apps: [.whatsapp, .imessage]) == .success(.tagsAdd(tag: "@pronto", apps: [.imessage, .whatsapp])))
    }

    @Test func addCommandRejects() {
        #expect(TagPlanner.addCommand(input: "bad tag", apps: [.imessage]) == .failure(.invalidTag(.invalidCharacters)))
        #expect(TagPlanner.addCommand(input: "@ok", apps: []) == .failure(.noApps))
        #expect(TagPlanner.Failure.noApps.message == "Choose at least one app.")
    }

    @Test func editAddsBeforeRemoving() {
        let commands = TagPlanner.editCommands(tag: "@wa", current: [.whatsapp], desired: [.imessage])
        #expect(commands == [.tagsAdd(tag: "@wa", apps: [.imessage]), .tagsRemove(tag: "@wa", apps: [.whatsapp])])
    }

    @Test func editNoChange() {
        #expect(TagPlanner.editCommands(tag: "@s4", current: [.imessage, .whatsapp], desired: [.whatsapp, .imessage]).isEmpty)
    }

    @Test func editOnlyAdds() {
        #expect(TagPlanner.editCommands(tag: "@wa", current: [.whatsapp], desired: [.whatsapp, .imessage]) == [.tagsAdd(tag: "@wa", apps: [.imessage])])
    }

    @Test func editToNothingRemovesEverywhere() {
        #expect(TagPlanner.editCommands(tag: "@wa", current: [.whatsapp], desired: []) == [.tagsRemove(tag: "@wa", apps: [])])
        #expect(CLICommand.tagsRemove(tag: "@wa", apps: []).arguments == ["tags", "remove", "@wa", "--json"])
    }

    @Test func sortedTags() {
        let response = TagsResponse(tags: [
            TagEntry(tag: "@wa", apps: [.whatsapp]),
            TagEntry(tag: "@Alpha", apps: [.whatsapp, .imessage, .imessage]),
        ])
        #expect(TagPlanner.sorted(response) == [
            TagEntry(tag: "@Alpha", apps: [.imessage, .whatsapp]),
            TagEntry(tag: "@wa", apps: [.whatsapp]),
        ])
    }
}

@Suite("Polling policy")
struct PollPolicyTests {
    @Test func intervals() {
        let policy = PollPolicy.standard
        #expect(policy.statusInterval(panelOpen: true, installed: true) == .seconds(5))
        #expect(policy.statusInterval(panelOpen: false, installed: true) == .seconds(60))
        #expect(policy.statusInterval(panelOpen: false, installed: false) == .seconds(60))
        #expect(policy.statusInterval(panelOpen: true, installed: false) == .seconds(5))
    }

    @Test func updateChecksAtMostEverySixHours() {
        let policy = PollPolicy.standard
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        #expect(policy.isUpdateCheckDue(lastCheck: nil, now: t0))
        #expect(!policy.isUpdateCheckDue(lastCheck: t0, now: t0))
        #expect(!policy.isUpdateCheckDue(lastCheck: t0, now: t0.addingTimeInterval(6 * 3600 - 1)))
        #expect(policy.isUpdateCheckDue(lastCheck: t0, now: t0.addingTimeInterval(6 * 3600)))
        #expect(policy.isUpdateCheckDue(lastCheck: t0, now: t0.addingTimeInterval(-60)))  // clock went backwards
    }
}

@Suite("Single-flight")
@MainActor
struct SingleFlightTests {
    actor Counter {
        var value = 0
        func increment() -> Int { value += 1; return value }
    }

    @Test func concurrentCallsShareOneOperation() async throws {
        let flight = SingleFlight<Int>()
        let counter = Counter()
        let gate = AsyncStream<Void>.makeStream()
        let a = Task {
            try await flight.run {
                for await _ in gate.stream { break }
                return await counter.increment()
            }
        }
        for _ in 0..<1000 where !flight.isRunning { await Task.yield() }
        #expect(flight.isRunning)
        let b = Task { try await flight.run { await counter.increment() } }
        for _ in 0..<20 { await Task.yield() }
        gate.continuation.yield()
        let (ra, rb) = try await (a.value, b.value)
        #expect(ra == 1 && rb == 1)
        #expect(await counter.value == 1)
        #expect(!flight.isRunning)
        // A later call starts a new operation.
        #expect(try await flight.run { await counter.increment() } == 2)
    }

    @Test func errorsPropagateToAllCallers() async {
        let flight = SingleFlight<Int>()
        await #expect(throws: CLIError.timedOut) { try await flight.run { throw CLIError.timedOut } }
        #expect(!flight.isRunning)
    }
}

@Suite("Presentation")
struct PresentationTests {
    @Test(arguments: [
        ("whatsapp-linked", "WhatsApp linked"),
        ("imessage-full-disk-access", "iMessage full disk access"),
        ("listener_running", "Listener running"),
        ("cli-signature", "CLI signature"),
        ("wacli-installed", "wacli installed"),
        ("database", "Database"),
        ("", ""),
    ])
    func checkTitles(id: String, title: String) {
        #expect(Presentation.checkTitle(id) == title)
    }

    @Test func checkOrderingPutsProblemsFirst() throws {
        let checks = try Fixture.decode(DoctorResponse.self, "doctor-mixed.json").checks
        #expect(Presentation.sortedChecks(checks).map(\.id) == ["imessage-full-disk-access", "whatsapp-linked", "listener-running"])
    }

    @Test func checkText() {
        #expect(Presentation.checkStatusText(.ok) == "OK")
        #expect(Presentation.checkTone(.failed) == .error)
        #expect(Presentation.checkTone(.degraded) == .warning)
    }

    @Test func updateResults() {
        #expect(Presentation.updateResultText(UpdateInstallResponse(status: .installed, version: "0.5.1")) == "Updated to Pronto 0.5.1.")
        #expect(Presentation.updateResultText(UpdateInstallResponse(status: .current)) == "Pronto is up to date.")
        #expect(Presentation.updateResultText(UpdateInstallResponse(status: .migrationRequired, version: "1.0.0")).contains("pronto update"))
        #expect(Presentation.updateResultText(UpdateInstallResponse(status: .migrationInstalled, version: "1.0.0")).contains("1.0.0"))
    }

    @Test func disclosureIsVerbatim() {
        #expect(WhatsAppDisclosure.text.hasPrefix("WhatsApp support uses wacli, which links this Mac as a WhatsApp device"))
        #expect(WhatsAppDisclosure.text.hasSuffix("can trigger a reply with your tag."))
        #expect(WhatsAppDisclosure.text.contains("It is not affiliated with WhatsApp or Meta."))
    }
}

@Suite("QR rendering")
struct QRCodeTests {
    @Test func rendersCrispSquareImage() throws {
        let image = try #require(QRCodeRenderer.image(for: "2@fake-qr-code,ZmFrZQ==", targetSize: 400))
        #expect(image.width == image.height)
        #expect(image.width <= 400)
        #expect(image.width >= 200)
    }

    @Test func scaleIsAnIntegerMultipleOfModules() throws {
        let small = try #require(QRCodeRenderer.image(for: "2@x", targetSize: 1))
        let big = try #require(QRCodeRenderer.image(for: "2@x", targetSize: 300))
        #expect(big.width % small.width == 0)
    }
}

@Suite("Setup prompt")
struct SetupPromptTests {
    @Test func installMatchesWebsite() {
        #expect(SetupPrompt.install == "Help me set up Pronto on this Mac. Follow https://studiofour.io/imessage-setup.md and stay with me until, in each messaging app I choose, one tagged message gets exactly one agent reply.")
    }

    @Test func addKeepsEnabledApps() {
        #expect(SetupPrompt.add(.imessage, keeping: [.whatsapp]) == "Help me add iMessage to Pronto on this Mac. Pronto is already installed and answering in WhatsApp. Follow https://studiofour.io/imessage-setup.md, re-run setup and choose iMessage as well as WhatsApp so they all stay on, and stay with me until one tagged message in iMessage gets exactly one agent reply.")
    }

    @Test func addWithNothingEnabled() {
        let prompt = SetupPrompt.add(.whatsapp, keeping: [])
        #expect(prompt.contains("Pronto is already installed. Follow"))
        #expect(prompt.contains("choose WhatsApp,"))
    }
}
