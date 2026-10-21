import ProntoMenuBarKit
import SwiftUI

/// Add one desktop workspace; its tags are edited alongside the other apps.
struct SlackSettingsView: View {
    @Environment(MenuBarModel.self) private var menu
    @Environment(AppController.self) private var controller
    @Environment(\.dismiss) private var dismiss
    @State private var settings: SlackModel?
    private let usesProvidedSettings: Bool

    init(settings: SlackModel? = nil) {
        _settings = State(initialValue: settings)
        usesProvidedSettings = settings != nil
    }

    var body: some View {
        Group {
            if let settings { contents(settings) }
            else { ProgressView("Finding Slack workspaces…").padding(24) }
        }
        .frame(width: 360)
        .onDisappear { settings?.cancel() }
        .task(id: controller.slackWorkspaceToReconnect) {
            guard !usesProvidedSettings else { return }
            let model = SlackModel(client: menu.client)
            if let app = controller.slackWorkspaceToReconnect, let info = menu.channels?.channel(app) {
                model.reconnectWorkspaceKey = info.workspaceKey
            }
            settings = model
            await model.discover()
        }
    }

    private func contents(_ model: SlackModel) -> some View {
        @Bindable var model = model
        let reconnecting = controller.slackWorkspaceToReconnect != nil
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 8) {
                MenuIcon(systemName: "message.fill", active: true,
                         applicationBundleIdentifier: "com.tinyspeck.slackmacgap")
                Text(reconnecting ? "Reconnect Slack Workspace" : "Add Slack Workspace")
                    .font(.headline)
            }
            Text("Pronto replies as you. People in conversations where you’ve participated can use this workspace’s tags to run your local agent.")
                .fixedSize(horizontal: false, vertical: true)
            if model.busy {
                HStack { ProgressView().controlSize(.small); Text(model.message ?? "Finding workspaces…").font(.callout) }
            } else if model.workspaces.isEmpty {
                Text("Sign in to a new workspace in the Slack desktop app, then refresh.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !model.workspaces.isEmpty {
                Picker("Workspace", selection: $model.selectedWorkspace) {
                    Text("Choose a workspace").tag("")
                    ForEach(model.workspaces) { Text($0.label).tag($0.handle) }
                }
                Text(reconnecting ? "Your tags will stay unchanged." : "After adding the workspace, use Add Tag in the menu bar to choose which tags it answers.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            DisclosureGroup("How it works") {
                Text(SlackModel.disclosure).font(.caption)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = model.error { InlineError(message: error) }
            HStack {
                Button("Refresh") { Task { await model.discover() } }.disabled(model.busy)
                Spacer()
                Button("Cancel") { model.cancel(); dismiss() }.keyboardShortcut(.cancelAction)
                Button(reconnecting ? "Reconnect" : "Add Workspace") {
                    Task {
                        model.acceptedRisk = true
                        if await model.link() { await menu.refresh(full: true); dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy || model.supportsWorkspaceApps == false || model.supportsDeferredTags == false || model.selectedWorkspace.isEmpty)
            }
        }
        .padding(20)
    }
}
