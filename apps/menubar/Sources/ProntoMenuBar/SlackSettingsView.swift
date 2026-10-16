import ProntoMenuBarKit
import SwiftUI

struct SlackSettingsView: View {
    @Environment(MenuBarModel.self) private var menu
    @State private var settings: SlackModel?
    var body: some View {
        Group {
            if let settings { contents(settings) } else { ProgressView().padding(40) }
        }
        .frame(width: 480)
        .onDisappear { settings?.cancel() }
        .task {
            let model = SlackModel(client: menu.client); settings = model
            let tags = menu.channels?.channel(.slack)?.tags ?? menu.tagEntries.map(\.tag)
            if !tags.isEmpty { model.tags = tags.joined(separator: ", ") }
            if menu.channels?.channel(.slack)?.configured == true { await model.loadConversations() }
            await model.discover()
        }
    }
    private func contents(_ model: SlackModel) -> some View {
        @Bindable var model = model
        return ScrollView { VStack(alignment: .leading, spacing: 12) {
            Text("Slack desktop").font(.title2.bold())
            Text(SlackModel.disclosure).font(.callout).fixedSize(horizontal: false, vertical: true)
            Toggle("I accept this trust and account risk", isOn: $model.acceptedRisk)
            Picker("Workspace", selection: $model.selectedWorkspace) {
                Text("Choose a workspace").tag("")
                ForEach(model.workspaces) { Text($0.label).tag($0.handle) }
            }
            TextField("Tags, separated by commas", text: $model.tags)
            if let info = menu.channels?.channel(.slack), info.configured {
                Button(info.enabled ? "Turn Slack off" : "Turn Slack on") {
                    Task { await menu.setChannel(.slack, enabled: !info.enabled) }
                }
                .disabled(model.busy || info.enabled && (menu.channels?.enabledApps.count ?? 0) <= 1)
            }
            Text("Text replies only. Each thread has separate memory and a working folder. Turning Slack off preserves selection for catch-up; clearing selection or disconnecting revokes it.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Connect") { Task { await model.link(); await menu.refresh(full: true) } }
                    .disabled(!model.acceptedRisk || model.selectedWorkspace.isEmpty || model.busy)
                Button("Refresh workspaces") { Task { await model.discover() } }.disabled(model.busy)
                Button("Disconnect") { Task { await model.unlink(); await menu.refresh(full: true) } }.disabled(model.busy)
            }
            Text("Slack Connect, externally shared, archived and read-only conversations are unsupported. If participation is unknown, send an ordinary message yourself to establish it.").font(.caption).foregroundStyle(.secondary)
            if !model.conversations.isEmpty {
                Divider()
                Text("Trusted conversations (\(model.selected.count)/5)").font(.headline)
                ScrollView {
                    VStack(alignment: .leading) {
                        ForEach(model.conversations) { row in
                            Toggle(isOn: Binding(get: { model.selected.contains(row.handle) }, set: { on in
                                if on { model.selected.insert(row.handle) } else { model.selected.remove(row.handle) }
                            })) { Text("\(row.label) · \(row.type) · \(row.supported ? row.eligibility : "unsupported")") }
                            .disabled(!row.supported || model.busy || (!model.selected.contains(row.handle) && model.selected.count >= 5))
                        }
                    }
                }.frame(maxHeight: 220)
                if model.truncated { Text("The list reached its metadata limit. Refresh to continue setup with the CLI.").font(.caption) }
                HStack {
                    Button("Save selection") { Task { await model.save(); await menu.refresh(full: true) } }.disabled(!model.canSave)
                    Button("Refresh conversations") { Task { await model.loadConversations() } }.disabled(model.busy)
                    Button("Clear all") { model.selected = [] }.disabled(model.busy)
                }
            }
            if let message = model.message { Text(message).font(.callout).textSelection(.enabled) }
            if let error = model.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            if model.busy { HStack { ProgressView().controlSize(.small); Button("Cancel") { model.cancel() } } }
        }
        .padding(20) }.frame(height: 680)
    }
}
