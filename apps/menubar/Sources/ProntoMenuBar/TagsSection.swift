import ProntoMenuBarKit
import SwiftUI

/// Tags with app badges, an inline editor, and an "Add tag" form.
struct TagsSection: View {
    @Environment(MenuBarModel.self) private var model
    @State private var editingTag: String?
    @State private var editApps: Set<AppID> = []
    @State private var newTag = ""
    @State private var newTagApps: Set<AppID>?
    @FocusState private var addFieldFocused: Bool

    private var assignable: [AppID] { TagPlanner.assignableApps(for: model.channels) }
    private var labels: [AppID: String] { model.appLabels }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Tags")
            ForEach(model.tagEntries) { entry in
                if editingTag == entry.tag {
                    editor(for: entry)
                } else {
                    tagRow(entry)
                }
            }
            addForm
            if let error = model.tagError {
                InlineError(message: error)
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
            }
        }
    }

    private func label(_ app: AppID) -> String { labels[app] ?? app.defaultLabel }

    // MARK: Rows

    private func tagRow(_ entry: TagEntry) -> some View {
        Button {
            model.tagError = nil
            editApps = Set(entry.apps)
            editingTag = entry.tag
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "tag").foregroundStyle(.secondary).imageScale(.small)
                Text(entry.tag)
                Spacer(minLength: 8)
                if model.busyAction == .tag(entry.tag) {
                    ProgressView().controlSize(.mini)
                }
                ForEach(entry.apps, id: \.self) { AppBadge(label: label($0)) }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(entry.tag), used in \(Presentation.appList(entry.apps, labels: labels))")
        .accessibilityHint("Edit which apps use this tag")
    }

    private func editor(for entry: TagEntry) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "tag.fill").foregroundStyle(.tint).imageScale(.small)
                Text(entry.tag).fontWeight(.medium)
                Spacer()
            }
            appCheckboxes(selection: $editApps, apps: Array(Set(assignable).union(entry.apps)).sorted())
            HStack {
                Button("Remove Tag", role: .destructive) {
                    Task {
                        if await model.removeTag(entry) { editingTag = nil }
                    }
                }
                Spacer()
                Button("Cancel") {
                    editingTag = nil
                    model.tagError = nil
                }
                Button("Save") {
                    Task {
                        if await model.setApps(editApps, for: entry) { editingTag = nil }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(editApps == Set(entry.apps) || editApps.isEmpty)
            }
            .controlSize(.small)
            .disabled(model.busyAction != nil)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.6)))
        .padding(.horizontal, 8)
        .padding(.vertical, 2)
    }

    // MARK: Add

    private var addForm: some View {
        let selection = Binding<Set<AppID>>(
            get: { newTagApps ?? TagPlanner.defaultApps(for: model.channels) },
            set: { newTagApps = $0 }
        )
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField("Add tag, e.g. @pronto", text: $newTag)
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                    .focused($addFieldFocused)
                    .onSubmit { add(selection.wrappedValue) }
                    .accessibilityLabel("New tag")
                Button {
                    add(selection.wrappedValue)
                } label: {
                    if model.busyAction == .addTag {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "plus")
                    }
                }
                .controlSize(.small)
                .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty || model.busyAction != nil)
                .accessibilityLabel("Add tag")
            }
            if assignable.count > 1 && (addFieldFocused || !newTag.isEmpty) {
                appCheckboxes(selection: selection, apps: assignable)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
        .onChange(of: newTag) { if model.tagError != nil { model.tagError = nil } }
    }

    private func add(_ apps: Set<AppID>) {
        let input = newTag
        Task {
            if await model.addTag(input, apps: apps) {
                newTag = ""
                newTagApps = nil
            }
        }
    }

    private func appCheckboxes(selection: Binding<Set<AppID>>, apps: [AppID]) -> some View {
        HStack(spacing: 12) {
            ForEach(apps, id: \.self) { app in
                Toggle(label(app), isOn: Binding(
                    get: { selection.wrappedValue.contains(app) },
                    set: { on in
                        if on { selection.wrappedValue.insert(app) } else { selection.wrappedValue.remove(app) }
                    }
                ))
                .toggleStyle(.checkbox)
                .controlSize(.small)
            }
        }
    }
}
