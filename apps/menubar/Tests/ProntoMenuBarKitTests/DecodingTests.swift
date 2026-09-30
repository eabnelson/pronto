import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Contract decoding (docs/CLI_JSON.md)")
struct DecodingTests {
    @Test func decodesDocumentedStatus() throws {
        let status = try Fixture.decode(StatusResponse.self, "status.json")
        #expect(status.version == "0.5.0")
        #expect(status.listener == .running)
        #expect(status.daemon == .ready)
        #expect(status.database == "ready")
        #expect(status.channel(.imessage) == ChannelStatus(state: .ready, tags: ["@s4"]))
        #expect(status.channel(.whatsapp)?.state == .needsLink)
        #expect(status.channel(.whatsapp)?.tags == ["@s4", "@wa"])
        #expect(status.degradedCapabilities.isEmpty)
        #expect(status.active == 0 && status.ambiguous == 0 && status.parked == 0 && status.rateLimited == 0)
        #expect(status.lastSettledAt == 1_790_719_000_000)
    }

    @Test func decodesStatusWithReasonAndNullTimestamp() throws {
        let status = try Fixture.decode(StatusResponse.self, "status-failed.json")
        #expect(status.listener == .loaded)
        #expect(status.daemon == .failed)
        #expect(status.channel(.imessage)?.reason == "imsg exited")
        #expect(status.lastSettledAt == nil)
    }

    @Test func statusChannelWithoutTagsDecodes() throws {
        let status = try Fixture.decode(StatusResponse.self, "status-degraded.json")
        #expect(status.channel(.imessage)?.tags == [])
        #expect(status.degradedCapabilities == ["attachments"])
    }

    @Test func unknownStatesDecodeWithoutFailing() throws {
        let json = #"{"version":"9.0.0","listener":"hibernating","daemon":"sleepy","channels":{"signal":{"state":"warming"}}}"#
        let status = try CLIOutput(exitCode: 0, stdout: Data(json.utf8)).decode(StatusResponse.self)
        #expect(status.listener.rawValue == "hibernating")
        #expect(status.channels["signal"]?.state.rawValue == "warming")
        #expect(status.degradedCapabilities == [])
    }

    @Test func decodesDocumentedChannelsList() throws {
        let response = try Fixture.decode(ChannelsResponse.self, "channels-list.json")
        #expect(response.channels.count == 2)
        let imessage = try #require(response.channel(.imessage))
        #expect(imessage.label == "iMessage")
        #expect(imessage.configured && imessage.enabled)
        #expect(imessage.tool == ChannelTool(name: "imsg", path: "/opt/homebrew/bin/imsg", installed: true))
        let whatsapp = try #require(response.channel(.whatsapp))
        #expect(!whatsapp.configured && !whatsapp.enabled)
        #expect(whatsapp.tool?.path == nil)
        #expect(whatsapp.tool?.installed == false)
        #expect(response.enabledApps == [.imessage])
        #expect(response.configuredApps == [.imessage])
    }

    @Test func decodesDocumentedTags() throws {
        let response = try Fixture.decode(TagsResponse.self, "tags-list.json")
        #expect(response.tags == [TagEntry(tag: "@s4", apps: [.imessage, .whatsapp])])
    }

    @Test func tagsListIsAnObjectNotABareArray() {
        let bare = CLIOutput(exitCode: 0, stdout: Data(#"[{"tag":"@s4","apps":["imessage"]}]"#.utf8))
        #expect(throws: CLIError.self) { try bare.decode(TagsResponse.self) }
    }

    @Test func decodesListenerResponses() throws {
        #expect(try Fixture.decode(ListenerResponse.self, "listener-running.json").listener == .running)
        #expect(try Fixture.decode(ListenerResponse.self, "listener-stopped.json").listener == .stopped)
    }

    @Test func decodesDocumentedDoctor() throws {
        let doctor = try Fixture.decode(DoctorResponse.self, "doctor.json")
        #expect(doctor.healthy)
        #expect(doctor.checks == [DoctorCheck(id: "whatsapp-linked", status: .ok)])
        let mixed = try Fixture.decode(DoctorResponse.self, "doctor-mixed.json")
        #expect(!mixed.healthy)
        #expect(mixed.checks[1].remediation?.contains("Full Disk Access") == true)
    }

    @Test func decodesUpdates() throws {
        let check = try Fixture.decode(UpdateCheckResponse.self, "update-check-available.json")
        #expect(check == UpdateCheckResponse(status: .available, installedVersion: "0.5.0", version: "0.5.1"))
        #expect(check.isAvailable)
        #expect(try !Fixture.decode(UpdateCheckResponse.self, "update-check-current.json").isAvailable)
        #expect(try Fixture.decode(UpdateInstallResponse.self, "update-installed.json") == UpdateInstallResponse(status: .installed, version: "0.5.1"))
        #expect(try Fixture.decode(UpdateInstallResponse.self, "update-migration-required.json").status == .migrationRequired)
    }

    @Test func sampleJSONMatchesFixtures() throws {
        // The preview samples embed the documented examples; keep them in sync.
        let decoder = JSONDecoder()
        #expect(try decoder.decode(StatusResponse.self, from: Data(SampleJSON.status.utf8)) == Fixture.decode(StatusResponse.self, "status.json"))
        #expect(try decoder.decode(ChannelsResponse.self, from: Data(SampleJSON.channels.utf8)) == Fixture.decode(ChannelsResponse.self, "channels-list.json"))
        #expect(try decoder.decode(TagsResponse.self, from: Data(SampleJSON.tags.utf8)) == Fixture.decode(TagsResponse.self, "tags-list.json"))
    }
}

@Suite("CLI output rules")
struct CLIOutputTests {
    @Test func errorObjectBecomesFailedWithMessage() {
        let output = Fixture.output("error.json", exitCode: 1)
        #expect(throws: CLIError.failed(message: "Every enabled app must keep at least one tag.", exitCode: 1)) {
            try output.decode(TagsResponse.self)
        }
    }

    @Test func errorObjectWinsEvenWithZeroExit() {
        let output = CLIOutput(exitCode: 0, stdout: Data(#"{"error":"nope"}"#.utf8))
        #expect(throws: CLIError.failed(message: "nope", exitCode: 0)) { try output.decode(StatusResponse.self) }
    }

    @Test func statusIsAcceptedWithNonZeroExit() throws {
        // "The exit code is 0 only when the listener is running and the daemon is ready; the JSON is printed either way."
        let status = try Fixture.output("status-paused.json", exitCode: 1).decode(StatusResponse.self)
        #expect(status.listener == .stopped)
    }

    @Test func nonZeroExitWithoutJSONUsesStderr() {
        let output = CLIOutput(exitCode: 3, stdout: Data(), stderr: Data("boom\n".utf8))
        #expect(throws: CLIError.failed(message: "boom", exitCode: 3)) { try output.decode(StatusResponse.self) }
    }

    @Test func nonZeroExitWithoutAnyOutputHasGenericMessage() {
        let output = CLIOutput(exitCode: 2, stdout: Data())
        #expect(throws: CLIError.failed(message: "Pronto exited with status 2.", exitCode: 2)) { try output.decode(StatusResponse.self) }
    }

    @Test func garbageWithZeroExitIsDecodingError() {
        let output = CLIOutput(exitCode: 0, stdout: Data("hello".utf8))
        #expect(throws: CLIError.decoding("StatusResponse")) { try output.decode(StatusResponse.self) }
    }

    @Test func surroundingWhitespaceIsIgnored() throws {
        let output = CLIOutput(exitCode: 0, stdout: Data("\n  {\"listener\": \"running\"}\n\n".utf8))
        #expect(try output.decode(ListenerResponse.self).listener == .running)
    }
}
