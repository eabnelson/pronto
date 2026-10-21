import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Slack desktop controls") @MainActor
struct SlackTests {
    @Test func exactCommandArguments() {
        #expect(CLICommand.slackSelect([]).arguments == ["slack", "conversations", "select", "--clear", "--json"])
        #expect(CLICommand.slackSelect(["opaque"]).arguments == ["slack", "conversations", "select", "--conversation", "opaque", "--json"])
        #expect(CLICommand.slackLink(workspace: "opaque", tags: ["@pronto"]).arguments == ["slack", "link", "--workspace", "opaque", "--events", "--accept-risk", "--tag", "@pronto"])
    }
    @Test func discoveryNeverChoosesWorkspace() async {
        let client = FakeCLIClient(responses: [.slackDiscover: #"{"workspaces":[{"handle":"opaque","label":"Synthetic workspace"}]}"#])
        let model = SlackModel(client: client)
        await model.discover()
        #expect(model.workspaces.count == 1)
        #expect(model.selectedWorkspace.isEmpty)
        await model.link()
        #expect(client.invocations == [.slackDiscover])
    }
    @Test func selectionMustBeExplicitAndClearIsSupported() async {
        let rows = #"{"conversations":[{"handle":"opaque","label":"Synthetic self DM","type":"self","supported":true,"selected":false,"eligibility":"unknown"}],"truncated":false}"#
        let client = FakeCLIClient(responses: [.slackConversations: rows, .slackSelect([]): #"{"selected":0}"#])
        let model = SlackModel(client: client)
        await model.loadConversations()
        #expect(model.selected.isEmpty)
        await model.save()
        #expect(client.invocations.contains(.slackSelect([])))
        #expect(model.message?.contains("accept no requests") == true)
    }
    @Test func failedLinkRetainsActionableReason() async {
        let client = FakeCLIClient(responses: [.slackLink(workspace: "opaque", tags: []): #"{"event":"error","reason":"slack-needs-link","message":"Approve the helper and reconnect."}"#])
        let model = SlackModel(client: client)
        model.acceptedRisk = true; model.selectedWorkspace = "opaque"
        await model.link()
        #expect(model.error?.contains("Approve the helper") == true)
        #expect(model.conversations.isEmpty)
    }
}

@Suite("Slack cancellation") @MainActor
struct SlackCancellationTests {
    @Test func cancellationIgnoresLateDiscovery() async {
        let client = FakeCLIClient { _ in
            try? await Task.sleep(for: .milliseconds(50))
            return CLIOutput(exitCode: 0, stdout: Data(#"{"workspaces":[{"handle":"late","label":"Late synthetic result"}]}"#.utf8))
        }
        let model = SlackModel(client: client)
        let load = Task { await model.discover() }
        await Task.yield()
        model.cancel()
        await load.value
        #expect(model.workspaces.isEmpty)
        #expect(!model.busy)
    }
}
