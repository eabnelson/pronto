import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Slack workspace apps") @MainActor
struct SlackWorkspaceTests {
    let second = AppID("slack:" + String(repeating: "a", count: 32))
    let discovery = #"{"workspaceApps":true,"deferredTags":true,"workspaces":[{"handle":"one","id":"key-one","label":"One","connected":true},{"handle":"two","id":"key-two","label":"Two","connected":false}]}"#

    @Test func newWorkspacePickerExcludesAddedWorkspacesAndReconnectStaysBound() async {
        let fake = FakeCLIClient(responses: [.slackDiscover: discovery])
        let add = SlackModel(client: fake)
        await add.discover()
        #expect(add.workspaces.map(\.handle) == ["two"])
        #expect(add.selectedWorkspace.isEmpty)
        let reconnect = SlackModel(client: fake)
        reconnect.reconnectWorkspaceKey = "key-one"
        await reconnect.discover()
        #expect(reconnect.workspaces.map(\.handle) == ["one"])
    }

    @Test func addingWorkspaceFinishesWithoutConversationSelection() async {
        let command = CLICommand.slackLink(workspace: "two", tags: [])
        let fake = FakeCLIClient(responses: [.slackDiscover: discovery, command: #"{"event":"linked","workspace":"Two","member":"Owner","selectionRequired":false}"#])
        let model = SlackModel(client: fake)
        await model.discover()
        model.selectedWorkspace = "two"; model.acceptedRisk = true
        #expect(await model.link())
        #expect(fake.invocations == [.slackDiscover, command])
        #expect(model.message == "Two added. Use Tags in the menu bar to assign tags.")
        #expect(command.arguments == ["slack", "link", "--workspace", "two", "--events", "--accept-risk", "--defer-tags"])
        #expect(model.conversations.isEmpty)
    }

    @Test func olderCLIRequestsAnUpdateInsteadOfUsingTheOldSelectionFlow() async {
        let fake = FakeCLIClient(responses: [.slackDiscover: #"{"workspaces":[{"handle":"old","label":"One"}]}"#])
        let model = SlackModel(client: fake)
        await model.discover()
        model.selectedWorkspace = "old"; model.acceptedRisk = true
        #expect(!(await model.link()))
        #expect(fake.invocations == [.slackDiscover])
        #expect(model.error?.contains("Update Pronto") == true)
    }

    @Test func workspaceCLIWithoutDeferredTagsRequestsAnUpdate() async {
        let fake = FakeCLIClient(responses: [.slackDiscover: #"{"workspaceApps":true,"workspaces":[{"handle":"old","label":"One"}]}"#])
        let model = SlackModel(client: fake)
        await model.discover()
        model.selectedWorkspace = "old"; model.acceptedRisk = true
        #expect(!(await model.link()))
        #expect(fake.invocations == [.slackDiscover])
        #expect(model.error?.contains("Update Pronto") == true)
    }

    @Test func workspaceWithoutTagsWaitsForTheTagsSection() {
        let channels = ChannelsResponse(channels: [ChannelInfo(app: .slack, label: "One", configured: true, enabled: true)])
        let row = ChannelRowBuilder.rows(status: nil, channels: channels).first!
        #expect(row.statusText == "No tags")
        #expect(row.detail == "Add a tag below to start answering.")
    }

    @Test func workspaceRowsHaveIndependentIdentityAndTagsUseTheWorkspaceArgument() throws {
        let channels = ChannelsResponse(channels: [
            ChannelInfo(app: .slack, label: "One", configured: true, enabled: true, tags: ["@one"]),
            ChannelInfo(app: second, label: "Two", configured: true, enabled: false, tags: ["@two"]),
        ])
        let rows = ChannelRowBuilder.rows(status: nil, channels: channels)
        #expect(rows.map(\.app) == [.slack, second])
        #expect(rows[1].label == "Two" && rows[1].statusText == "Off")
        #expect(rows.allSatisfy { $0.app.isSlack })
        #expect(CLICommand.tagsAdd(tag: "@new", apps: [second]).arguments == ["tags", "add", "@new", "--app", second.rawValue, "--json"])
        #expect(CLICommand.slackRemoveWorkspace(second).arguments == ["slack", "unlink", "--app", second.rawValue, "--json"])
    }

    @Test func removingOneWorkspaceRefreshesItsAppAndTagAssignments() async {
        let fake = FakeCLIClient(responses: [
            .slackRemoveWorkspace(second): #"{"linked":false}"#,
            .channelsList: #"{"channels":[{"app":"slack","label":"One","configured":true,"enabled":true,"tags":["@one"]}]}"#,
            .tagsList: #"{"tags":[{"tag":"@one","apps":["slack"]}]}"#,
            .status: #"{"version":"0.5.1","listener":"running","daemon":"ready","channels":{"slack":{"state":"ready","tags":["@one"]}}}"#,
        ])
        let menu = MenuBarModel(client: fake, defaults: nil)
        #expect(await menu.removeSlackWorkspace(second))
        #expect(menu.channelRows.map(\.app) == [.slack])
        #expect(menu.tagEntries.map(\.apps) == [[.slack]])
        #expect(menu.busyAction == nil)
    }
}
