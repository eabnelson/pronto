import Foundation
import Observation

public struct SlackWorkspace: Decodable, Identifiable, Sendable {
    public let handle: String
    public let label: String
    public let workspaceKey: String?
    public let connected: Bool?
    private enum CodingKeys: String, CodingKey { case handle, label, connected; case workspaceKey = "id" }
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
private struct SlackDiscovery: Decodable { let workspaces: [SlackWorkspace]; let workspaceApps: Bool?; let deferredTags: Bool? }
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
    public var reconnectWorkspaceKey: String?
    public var tags = ""
    public private(set) var busy = false
    public private(set) var message: String?
    public private(set) var error: String?
    public private(set) var truncated = false
    public private(set) var supportsWorkspaceApps: Bool?
    public private(set) var supportsDeferredTags: Bool?
    private let client: CLIClient
    private var revision = 0
    private var activeTask: Task<Bool, Never>?
    public init(client: CLIClient) { self.client = client }
    public static let disclosure = "Pronto uses Slack on this Mac and replies as you. Anyone in a supported conversation where you've participated can use this workspace's tags to run your local agent with access to this Mac. Conversation text may be sent to your model provider. Add only workspaces whose participants you trust. Slack support uses an unofficial protocol that Slack may change. Connecting sends no messages."
    public var canSave: Bool { selected.count <= 5 && !busy }
    public func discover() async {
        await perform {
            let result = try await self.client.run(.slackDiscover).decode(SlackDiscovery.self)
            try Task.checkCancellation()
            self.supportsWorkspaceApps = result.workspaceApps == true
            self.supportsDeferredTags = result.deferredTags == true
            self.workspaces = result.workspaces.filter {
                if let key = self.reconnectWorkspaceKey { return $0.workspaceKey == key }
                return $0.connected != true
            }
            self.selectedWorkspace = ""
            if self.supportsWorkspaceApps == false || self.supportsDeferredTags == false { self.error = "Update Pronto to add Slack workspaces from the menu bar." }
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
    @discardableResult public func link() async -> Bool {
        guard acceptedRisk, !selectedWorkspace.isEmpty else { return false }
        guard supportsWorkspaceApps != false, supportsDeferredTags != false else { error = "Update Pronto to add Slack workspaces from the menu bar."; return false }
        let workspace = selectedWorkspace
        let tags = tags.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        return await perform {
            self.message = "Approve Pronto in macOS if requested. Connecting does not send a message."
            var linked = false
            for try await result in self.client.linkSlack(workspace: workspace, tags: tags) {
                try Task.checkCancellation()
                if result.event == "error" { throw CLIError.failed(message: result.message ?? "Slack linking failed.", exitCode: 1) }
                if result.event == "approval_required" { self.message = result.message }
                if result.event == "linked" {
                    linked = true
                    self.message = "\(result.workspace ?? "Slack workspace") added. Use Tags in the menu bar to assign tags."
                }
            }
            guard linked else { throw CLIError.decoding("Slack link ended before completion") }
            self.selectedWorkspace = ""
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
    @discardableResult private func perform(_ action: @escaping @MainActor () async throws -> Void) async -> Bool {
        guard !busy else { return false }
        revision += 1; let current = revision; busy = true; error = nil
        let task = Task { @MainActor in
            do { try await action(); try Task.checkCancellation(); return true } catch is CancellationError { } catch {
                if current == self.revision {
                    let reason = error.localizedDescription
                    if reason.contains("slack-handle-expired") { self.error = "These choices expired. Refresh workspaces or conversations and choose again." }
                    else if reason.contains("slack-needs-link") { self.error = "Reconnect Slack and approve Pronto in macOS if requested." }
                    else if reason.contains("slack-profile-unavailable") { self.error = "Sign in to the direct-download Slack desktop app, then refresh workspaces." }
                    else { self.error = reason }
                }
            }
            return false
        }
        activeTask = task
        let success = await withTaskCancellationHandler { await task.value } onCancel: { task.cancel() }
        if current == revision { busy = false; activeTask = nil }
        return current == revision && success
    }
}
