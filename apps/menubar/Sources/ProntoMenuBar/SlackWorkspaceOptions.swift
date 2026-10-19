import ProntoMenuBarKit
import SwiftUI

struct SlackWorkspaceOptions: View {
    let row: ChannelRow
    @Environment(MenuBarModel.self) private var model
    @State private var newTag = ""

    private var tags: [TagEntry] { model.tagEntries.filter { $0.apps.contains(row.app) } }

    var body: some View {
        ExpandedGroup {
            CheckItem(title: "Answer messages", checked: row.enabled,
                      disabled: model.busyAction != nil || !row.toggleAllowed) {
                Task { await model.setChannel(row.app, enabled: !row.enabled) }
            }
            SectionHeader(title: "Workspace Tags")
            ForEach(tags) { entry in
                CheckItem(title: entry.tag, checked: true,
                          disabled: model.busyAction != nil || tags.count <= 1) {
                    Task { await model.setApps(Set(entry.apps).subtracting([row.app]), for: entry) }
                }
            }
            MenuItem {
                HStack(spacing: 6) {
                    TextField("Add a tag…", text: $newTag)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("New tag for \(row.label)")
                        .onSubmit { addTag() }
                    Button("Add", action: addTag)
                        .disabled(newTag.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                .controlSize(.small)
            }
            .disabled(model.busyAction != nil)
            MenuCommand(title: "Remove Workspace", disabled: model.busyAction != nil || model.channels?.enabledApps.count == 1 && row.enabled) {
                Task { await model.removeSlackWorkspace(row.app) }
            }
        }
    }

    private func addTag() {
        let input = newTag
        Task { if await model.addTag(input, apps: [row.app]) { newTag = "" } }
    }
}
