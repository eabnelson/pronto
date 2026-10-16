import Foundation
import Observation

public struct SlackWorkspace: Decodable, Identifiable, Sendable {
    public let handle: String
    public let label: String
    public var id: String { handle }
}
public struct SlackConversation: Decodable, Identifiable, Sendable {
    public let handle: String
    public let label: String
    public let type: String
    public let supported: Bool
    public let selected: Bool
    public let eligibility: String
    public var id: String { handle }
}
private struct SlackDiscovery: Decodable { let workspaces: [SlackWorkspace] }
private struct SlackConversations: Decodable { let conversations: [SlackConversation]; let truncated: Bool }
public struct SlackLinkProgress: Decodable, Sendable { public let event: String; public let message: String?; public let member: String?; public let workspace: String? }
private struct SlackSelectionResult: Decodable { let selected: Int }
private struct SlackUnlinkResult: Decodable { let linked: Bool }

@MainActor @Observable
public final class SlackModel {
    public private(set) var workspaces: [SlackWorkspace] = []
    public private(set) var conversations: [SlackConversation] = []
    public var selectedWorkspace = ""
    public var selected = Set<String>()
    public var acceptedRisk = false
    public var tags = "@pronto"
    public private(set) var busy = false
    public private(set) var message: String?
    public private(set) var error: String?
    public private(set) var truncated = false
    private let client: CLIClient
    private var revision = 0
    private var activeTask: Task<Void, Never>?
    public init(client: CLIClient) { self.client = client }
    public static let disclosure = "Slack uses your desktop sign-in through an unofficial protocol that Slack may change or restrict. Replies come from your account. Any human participant in a selected conversation where you have participated can use your tag to run your local agent with unrestricted access to this Mac. Tags are not authentication. Conversation text may be sent to your model provider. Select only conversations whose participants you trust. Connecting selects none and sends no messages."
    public var canSave: Bool { selected.count <= 5 && !busy }
    public func discover() async {
        await perform {
            let result = try await self.client.run(.slackDiscover).decode(SlackDiscovery.self)
            try Task.checkCancellation()
            self.workspaces = result.workspaces
            self.selectedWorkspace = ""
        }
    }
    public func loadConversations() async {
        await perform { try await self.readConversations() }
    }
    private func readConversations() async throws {
        let result = try await client.run(.slackConversations).decode(SlackConversations.self)
        try Task.checkCancellation()
        conversations = result.conversations
        selected = Set(result.conversations.filter(\.selected).map(\.handle))
        truncated = result.truncated
    }
    public func link() async {
        guard acceptedRisk, !selectedWorkspace.isEmpty else { return }
        let workspace = selectedWorkspace
        let tags = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        await perform {
            self.message = "Approve Pronto in macOS if requested. Connecting does not send a message."
            var linked = false
            for try await result in self.client.linkSlack(workspace: workspace, tags: tags) {
                try Task.checkCancellation()
                if result.event == "error" { throw CLIError.failed(message: result.message ?? "Slack linking failed.", exitCode: 1) }
                if result.event == "approval_required" { self.message = result.message }
                if result.event == "linked" {
                    linked = true
                    self.message = "Connected as \(result.member ?? "your account") in \(result.workspace ?? "your workspace"). Select up to five trusted conversations."
                }
            }
            guard linked else { throw CLIError.decoding("Slack link ended before completion") }
            self.selectedWorkspace = ""
            try await self.readConversations()
        }
    }
    public func save() async {
        guard canSave else { return }
        let handles = selected.sorted()
        await perform {
            _ = try await self.client.run(.slackSelect(handles)).decode(SlackSelectionResult.self)
            try Task.checkCancellation()
            self.message = handles.isEmpty ? "No conversations selected. Slack will accept no requests." : "Conversation selection saved. Only new requests are eligible."
            try await self.readConversations()
        }
    }
    public func unlink() async {
        await perform {
            _ = try await self.client.run(.slackUnlink).decode(SlackUnlinkResult.self)
            try Task.checkCancellation()
            self.conversations = []; self.selected = []; self.message = "Slack disconnected. Your Slack desktop sign-in is unchanged."
        }
    }
    public func cancel() {
        revision += 1; activeTask?.cancel(); activeTask = nil; busy = false
        message = "Cancelled. Refresh to check whether an operation already completed."
    }
    private func perform(_ action: @escaping @MainActor () async throws -> Void) async {
        guard !busy else { return }
        revision += 1; let current = revision; busy = true; error = nil
        let task = Task { @MainActor in
            do { try await action() } catch is CancellationError { } catch {
                if current == self.revision {
                    let reason = error.localizedDescription
                    if reason.contains("slack-handle-expired") { self.error = "These choices expired. Refresh workspaces or conversations and choose again." }
                    else if reason.contains("slack-needs-link") { self.error = "Reconnect Slack and approve Pronto in macOS if requested." }
                    else if reason.contains("slack-profile-unavailable") { self.error = "Sign in to the direct-download Slack desktop app, then refresh workspaces." }
                    else { self.error = reason }
                }
            }
        }
        activeTask = task
        await task.value
        if current == revision { busy = false; activeTask = nil }
    }
}
