import ProntoMenuBarKit
import SwiftUI

/// Tags, each shown as an @ icon and its name. Clicking a tag expands its apps
/// as checkmarks, like Listening Mode under AirPods in the Sound menu.
struct TagsSection: View {
    @Environment(MenuBarModel.self) private var model
    @State private var expandedTag: String?
    @State private var adding = false
    @State private var newTag = ""
    @State private var newTagApps: Set<AppID>?
    @FocusState private var addFieldFocused: Bool

    private var assignable: [AppID] { TagPlanner.assignableApps(for: model.channels) }
    private var labels: [AppID: String] { model.appLabels }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Tags")
            ForEach(model.tagEntries) { entry in
                tagRow(entry)
                if expandedTag == entry.tag {
                    editor(for: entry)
                }
            }
            if adding {
                addForm
            } else {
                MenuItem(action: startAdding, disabled: model.busyAction != nil) {
                    IconRow(icon: MenuIcon(systemName: "plus"), title: "Add Tag…")
                }
            }
            if let error = model.tagError {
                InlineError(message: error)
                    .padding(.horizontal, PanelMetrics.inset)
                    .padding(.vertical, 4)
            }
        }
    }

    private func label(_ app: AppID) -> String { labels[app] ?? app.defaultLabel }

    /// The tag without its @, since the icon already shows one.
    private func name(_ tag: String) -> String {
        tag.hasPrefix("@") ? String(tag.dropFirst()) : tag
    }

    // MARK: Rows

    private func tagRow(_ entry: TagEntry) -> some View {
        let expanded = expandedTag == entry.tag
        return MenuItem(action: {
            model.tagError = nil
            withAnimation(.snappy(duration: 0.2)) { expandedTag = expanded ? nil : entry.tag }
        }) {
            IconRow(icon: MenuIcon(systemName: "at", active: expanded),
                    title: name(entry.tag),
                    subtitle: Presentation.appList(entry.apps, labels: labels)) {
                if model.busyAction == .tag(entry.tag) {
                    ProgressView().controlSize(.small)
                }
                DisclosureChevron(expanded: expanded)
            }
        }
        .accessibilityLabel("\(entry.tag), used in \(Presentation.appList(entry.apps, labels: labels))")
        .accessibilityHint(expanded ? "Hide options" : "Choose apps or remove this tag")
    }

    /// Checkmarks apply right away. The last app can't be unchecked; use Remove Tag.
    private func editor(for entry: TagEntry) -> some View {
        let current = Set(entry.apps)
        return ExpandedGroup {
            ForEach(Array(Set(assignable).union(entry.apps)).sorted(), id: \.self) { app in
                let checked = current.contains(app)
                CheckItem(title: label(app), checked: checked,
                          disabled: model.busyAction != nil || (checked && current.count == 1)) {
                    var desired = current
                    if checked { desired.remove(app) } else { desired.insert(app) }
                    Task { await model.setApps(desired, for: entry) }
                }
            }
            MenuItem(action: {
                Task {
                    if await model.removeTag(entry) { expandedTag = nil }
                }
            }, disabled: model.busyAction != nil) {
                HStack(spacing: 6) {
                    Color.clear.frame(width: PanelMetrics.iconSize, height: 1)
                    Text("Remove Tag")
                    Spacer()
                }
                .padding(.vertical, 1)
            }
        }
    }

    // MARK: Add

    private func startAdding() {
        model.tagError = nil
        expandedTag = nil
        newTag = ""
        newTagApps = nil
        adding = true
        addFieldFocused = true
    }

    private func stopAdding() {
        adding = false
        newTag = ""
        newTagApps = nil
        model.tagError = nil
    }

    private var addForm: some View {
        let selection = newTagApps ?? TagPlanner.defaultApps(for: model.channels)
        return VStack(alignment: .leading, spacing: 0) {
            MenuItem {
                HStack(spacing: 8) {
                    MenuIcon(systemName: "at", active: true)
                    TextField("tag name", text: $newTag)
                        .textFieldStyle(.plain)
                        .focused($addFieldFocused)
                        .onSubmit { add(selection) }
                        .onExitCommand { stopAdding() }
                        .accessibilityLabel("New tag name")
                    if model.busyAction == .addTag {
                        ProgressView().controlSize(.small)
                    }
                }
            }
            if assignable.count > 1 {
                ExpandedGroup {
                    ForEach(assignable, id: \.self) { app in
                        let checked = selection.contains(app)
                        CheckItem(title: label(app), checked: checked) {
                            var apps = selection
                            if checked { apps.remove(app) } else { apps.insert(app) }
                            newTagApps = apps
                        }
                    }
                }
            }
            HStack {
                Text("Press Return to add, Esc to cancel.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, PanelMetrics.inset)
            .padding(.vertical, 3)
        }
        .onAppear { addFieldFocused = true }
        .onChange(of: newTag) { if model.tagError != nil { model.tagError = nil } }
        .onChange(of: addFieldFocused) { _, focused in
            if !focused && newTag.isEmpty { stopAdding() }
        }
    }

    private func add(_ apps: Set<AppID>) {
        let input = newTag
        guard !input.trimmingCharacters(in: .whitespaces).isEmpty else { stopAdding(); return }
        Task {
            if await model.addTag(input, apps: apps) { stopAdding() }
        }
    }
}
