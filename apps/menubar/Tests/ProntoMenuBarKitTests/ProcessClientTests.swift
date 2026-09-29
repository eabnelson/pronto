import Foundation
import Testing
@testable import ProntoMenuBarKit

/// Runs the real `ProcessCLIClient` against Tests/Fixtures/fake-pronto.
@Suite("Process client (fake-pronto)", .serialized)
struct ProcessClientTests {
    func makeClient(scenario: String = "docs") -> (ProcessCLIClient, URL) {
        let state = FileManager.default.temporaryDirectory.appendingPathComponent("fake-pronto-\(UUID().uuidString)")
        var env = ProcessInfo.processInfo.environment
        env["FAKE_PRONTO_SCENARIO"] = scenario
        env["FAKE_PRONTO_STATE_DIR"] = state.path
        env["FAKE_PRONTO_DELAY"] = "0"
        env[CLILocation.overrideEnvironmentKey] = "/should/be/removed"
        let client = ProcessCLIClient(location: CLILocation(url: Fixture.fakeCLI, requiresSignatureCheck: false), environment: env)
        return (client, state)
    }

    @Test func statusWithNonZeroExit() async throws {
        let (client, _) = makeClient()
        let output = try await client.run(.status)
        #expect(output.exitCode == 1)
        #expect(try output.decode(StatusResponse.self) == Fixture.decode(StatusResponse.self, "status.json"))
    }

    @Test func typedHelpers() async throws {
        let (client, _) = makeClient(scenario: "healthy")
        #expect(try await client.status().channel(.whatsapp)?.state == .ready)
        #expect(try await client.channels().enabledApps == [.imessage, .whatsapp])
        #expect(try await client.tags().tags.count == 2)
        #expect(try await client.addTag("@new", apps: [.imessage]).tags.count == 2)
        #expect(try await client.checkForUpdate().isAvailable)
        #expect(try await client.doctor().healthy == false)
    }

    @Test func pauseState() async throws {
        let (client, _) = makeClient()
        #expect(try await client.setListener(running: false).listener == .stopped)
        #expect(try await client.status().listener == .stopped)
        #expect(try await client.setListener(running: true).listener == .running)
    }

    @Test func cliErrorsSurface() async throws {
        let (client, _) = makeClient()
        await #expect(throws: CLIError.failed(message: "Every enabled app must keep at least one tag.", exitCode: 1)) {
            try await client.removeTag("@s4", apps: [])
        }
    }

    @Test func linkStream() async throws {
        let (client, _) = makeClient()
        var events: [LinkEvent] = []
        for try await event in client.linkWhatsApp(WhatsAppLinkOptions(acceptRisk: true)) { events.append(event) }
        #expect(events.count == 5)
        #expect(events.prefix(3).allSatisfy { if case .qr = $0 { return true } else { return false } })
        #expect(events.suffix(2) == [.syncing, .linked])
    }

    @Test func linkStreamWithPhone() async throws {
        let (client, _) = makeClient()
        var events: [LinkEvent] = []
        for try await event in client.linkWhatsApp(WhatsAppLinkOptions(phone: "+15551234567", acceptRisk: true)) { events.append(event) }
        #expect(events == [.pairingCode(code: "ABCD-EFGH"), .syncing, .linked])
    }

    @Test func linkStreamWithoutConsent() async throws {
        let (client, _) = makeClient()
        var events: [LinkEvent] = []
        do {
            for try await event in client.linkWhatsApp(WhatsAppLinkOptions(acceptRisk: false)) { events.append(event) }
        } catch let error as CLIError {
            if case .failed = error {} else { Issue.record("unexpected \(error)") }
        }
        #expect(events.first == .error(reason: "consent-required", message: "Pass --accept-risk after showing the WhatsApp disclosure."))
    }

    @Test func cancellingLinkTerminatesProcess() async throws {
        var env = ProcessInfo.processInfo.environment
        env["FAKE_PRONTO_DELAY"] = "30"
        env["FAKE_PRONTO_STATE_DIR"] = FileManager.default.temporaryDirectory.appendingPathComponent("fake-pronto-\(UUID().uuidString)").path
        let client = ProcessCLIClient(location: CLILocation(url: Fixture.fakeCLI, requiresSignatureCheck: false), environment: env)
        let start = Date()
        let task = Task {
            for try await _ in client.linkWhatsApp(WhatsAppLinkOptions(acceptRisk: true)) {}
        }
        try await Task.sleep(for: .milliseconds(300))
        task.cancel()
        _ = await task.result
        #expect(Date().timeIntervalSince(start) < 10)
    }

    @Test func missingExecutableIsNotInstalled() async {
        let client = ProcessCLIClient(location: CLILocation(url: URL(fileURLWithPath: "/nonexistent/pronto"), requiresSignatureCheck: true))
        await #expect(throws: CLIError.notInstalled(path: "/nonexistent/pronto")) { try await client.run(.status) }
        var events = 0
        await #expect(throws: CLIError.notInstalled(path: "/nonexistent/pronto")) {
            for try await _ in client.linkWhatsApp(WhatsAppLinkOptions(acceptRisk: true)) { events += 1 }
        }
    }

    @Test func unsignedExecutableIsRejectedWhenCheckRequired() async {
        let client = ProcessCLIClient(location: CLILocation(url: Fixture.fakeCLI, requiresSignatureCheck: true))
        do {
            _ = try await client.run(.status)
            Issue.record("expected untrusted")
        } catch let error as CLIError {
            guard case .untrusted = error else { Issue.record("unexpected \(error)"); return }
        } catch {
            Issue.record("unexpected \(error)")
        }
    }
}

@Suite("CLI location and signature")
struct CLILocationTests {
    @Test func defaultsToInstalledPath() {
        let home = URL(fileURLWithPath: "/Users/someone")
        let location = CLILocation.resolve(environment: [:], home: home)
        #expect(location.url.path == "/Users/someone/Library/Application Support/pronto/bin/pronto")
        #expect(location.requiresSignatureCheck)
    }

    @Test func environmentOverrideSkipsSignatureCheck() {
        let location = CLILocation.resolve(environment: ["PRONTO_MENUBAR_CLI": "/tmp/fake-pronto"], home: URL(fileURLWithPath: "/Users/x"))
        #expect(location.url.path == "/tmp/fake-pronto")
        #expect(!location.requiresSignatureCheck)
        #expect(CLILocation.resolve(environment: ["PRONTO_MENUBAR_CLI": "  "]).requiresSignatureCheck)
    }

    @Test func overrideExpandsTilde() {
        let location = CLILocation.resolve(environment: ["PRONTO_MENUBAR_CLI": "~/bin/pronto"])
        #expect(!location.url.path.contains("~"))
    }

    @Test func appleBinaryFailsProntoRequirement() {
        #expect(CodeSignatureVerifier.verify(URL(fileURLWithPath: "/bin/ls")) == .notSatisfied(errSecCSReqFailed))
        #expect(CodeSignatureVerifier.Failure.notSatisfied(errSecCSReqFailed).detail == "not signed by Pronto")
    }

    @Test func appleBinaryPassesAppleRequirement() {
        #expect(CodeSignatureVerifier.verify(URL(fileURLWithPath: "/bin/ls"), requirement: "anchor apple") == nil)
    }

    @Test func requirementStringIsValid() {
        // An invalid requirement would be reported as .invalidRequirement.
        if case .invalidRequirement? = CodeSignatureVerifier.verify(URL(fileURLWithPath: "/bin/ls")) {
            Issue.record("designated requirement failed to parse")
        }
        #expect(CodeSignatureVerifier.designatedRequirement ==
            #"identifier "dev.pronto.cli" and anchor apple generic and certificate leaf[subject.OU] = "9YCNUWK84C""#)
    }

    @Test(.enabled(if: FileManager.default.fileExists(atPath: CLILocation.installedURL().path),
                   "Only on Macs with Pronto installed"))
    func installedCLISatisfiesRequirement() {
        #expect(CodeSignatureVerifier.verify(CLILocation.installedURL()) == nil)
    }

    @Test func unsignedScriptIsUnreadableOrUnsatisfied() {
        #expect(CodeSignatureVerifier.verify(Fixture.fakeCLI) != nil)
    }
}
