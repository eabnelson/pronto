import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Tag agents")
@MainActor
struct TagAgentTests {
    nonisolated static let configured = #"{"tags":[{"tag":"@work","apps":["imessage","slack"],"agents":{"primary":"claude","backup":"codex","inherited":false}}],"availableAgents":[{"id":"codex","label":"Codex","available":true},{"id":"claude","label":"Claude Code","available":true}]}"#
    nonisolated static let inherited = #"{"tags":[{"tag":"@work","apps":["imessage","slack"],"agents":{"primary":"codex","backup":null,"inherited":true}}],"availableAgents":[{"id":"codex","label":"Codex","available":true}]}"#

    @Test func decodesBothOldAndNewContractsWithoutLosingAgentsDuringSorting() throws {
        let old = try Fixture.decode(TagsResponse.self, "tags-list.json")
        #expect(old.tags[0].agents == nil)
        #expect(old.availableAgents == nil)
        let response = try CLIOutput(exitCode: 0, stdout: Data(Self.configured.utf8)).decode(TagsResponse.self)
        #expect(response.availableAgents?.map(\.id) == [.codex, .claude])
        #expect(TagPlanner.sorted(response)[0].agents == TagAgents(primary: .claude, backup: .codex, inherited: false))
        let inherited = try CLIOutput(exitCode: 0, stdout: Data(Self.inherited.utf8)).decode(TagsResponse.self)
        #expect(inherited.tags[0].agents?.backup == nil)
    }

    @Test func savesPairAndResetsWithOneMutationEach() async {
        let save = CLICommand.tagsAgents(tag: "@work", primary: .claude, backup: .codex)
        let reset = CLICommand.tagsAgentsReset(tag: "@work")
        let fake = FakeCLIClient(responses: [save: Self.configured, reset: Self.inherited])
        let model = MenuBarModel(client: fake, defaults: nil)
        #expect(await model.setAgents(for: "@work", primary: .claude, backup: .codex))
        #expect(model.tagEntries[0].agents?.primary == .claude)
        #expect(await model.setAgents(for: "@work", primary: nil))
        #expect(model.tagEntries[0].agents?.inherited == true)
        #expect(fake.invocations == [save, reset])
        #expect(save.arguments == ["tags", "agents", "@work", "--primary", "claude", "--backup", "codex", "--json"])
        #expect(reset.arguments == ["tags", "agents", "@work", "--reset", "--json"])
        #expect(CLICommand.tagsAgents(tag: "@work", primary: .codex, backup: nil).arguments.contains("none"))
        #expect(save.isMutation && reset.isMutation)
    }

    @Test func rejectsDuplicateAgentsAndKeepsTheLastSavedPairOnFailure() async {
        let save = CLICommand.tagsAgents(tag: "@work", primary: .claude, backup: nil)
        let fake = FakeCLIClient(responses: [.tagsList: Self.inherited, .status: SampleJSON.status,
                                            .channelsList: SampleJSON.channels,
                                            save: #"{"error":"Claude Code is not installed."}"#])
        let model = MenuBarModel(client: fake, defaults: nil)
        #expect(!(await model.setAgents(for: "@work", primary: .codex, backup: .codex)))
        #expect(fake.invocations.isEmpty)
        await model.refresh(full: true)
        #expect(!(await model.setAgents(for: "@work", primary: .claude)))
        #expect(model.tagError == "Claude Code is not installed.")
        #expect(model.tagEntries[0].agents?.primary == .codex)
        #expect(model.busyAction == nil)
    }

    @Test func anOlderRefreshCannotOverwriteASavedAgentPair() async {
        let entered = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        let fake = FakeCLIClient { command in
            if command == .tagsList {
                entered.continuation.yield()
                for await _ in release.stream { break }
                return CLIOutput(exitCode: 0, stdout: Data(Self.inherited.utf8))
            }
            if case .tagsAgents = command { return CLIOutput(exitCode: 0, stdout: Data(Self.configured.utf8)) }
            return CLIOutput(exitCode: 0, stdout: Data((command == .status ? SampleJSON.status : SampleJSON.channels).utf8))
        }
        let model = MenuBarModel(client: fake, defaults: nil)
        let refresh = Task { await model.refresh(full: true) }
        for await _ in entered.stream { break }
        #expect(await model.setAgents(for: "@work", primary: .claude, backup: .codex))
        release.continuation.yield()
        await refresh.value
        #expect(model.tagEntries[0].agents?.primary == .claude)
        entered.continuation.finish(); release.continuation.finish()
    }
}
