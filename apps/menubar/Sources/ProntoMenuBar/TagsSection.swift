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
            VStack(spacing: 0) {
                ForEach(model.tagEntries) { entry in
                    if editingTag == entry.tag {
                        editor(for: entry)
                    } else {
                        tagRow(entry)
                    }
                    Divider().padding(.leading, 40)
                }
                addForm
            }
            .padding(.vertical, 4)
            .panelCard()
            .padding(.horizontal, PanelMetrics.inset)
            if let error = model.tagError {
                InlineError(message: error)
                    .padding(.horizontal, PanelMetrics.inset + 6)
                    .padding(.top, 6)
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
            HStack(spacing: 8) {
                Image(systemName: "tag.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tint)
                    .frame(width: 20)
                Text(entry.tag).font(.body.weight(.medium))
                Spacer(minLength: 8)
                if model.busyAction == .tag(entry.tag) {
                    ProgressView().controlSize(.mini)
                }
                ForEach(entry.apps, id: \.self) { AppBadge(label: label($0)) }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
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
                Button("Remove", role: .destructive) {
                    Task {
                        if await model.removeTag(entry) { editingTag = nil }
                    }
                }
                .glassButtonStyle()
                Spacer()
                Button("Cancel") {
                    editingTag = nil
                    model.tagError = nil
                }
                .glassButtonStyle()
                Button("Save") {
                    Task {
                        if await model.setApps(editApps, for: entry) { editingTag = nil }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .glassButtonStyle(prominent: true)
                .disabled(editApps == Set(entry.apps) || editApps.isEmpty)
            }
            .controlSize(.small)
            .disabled(model.busyAction != nil)
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: PanelMetrics.rowRadius + 2, style: .continuous)
                .fill(.background.opacity(0.6))
        )
        .padding(4)
    }

    // MARK: Add

    private var addForm: some View {
        let selection = Binding<Set<AppID>>(
            get: { newTagApps ?? TagPlanner.defaultApps(for: model.channels) },
            set: { newTagApps = $0 }
        )
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 20)
                TextField("Add a tag, like @pronto", text: $newTag)
                    .textFieldStyle(.plain)
                    .focused($addFieldFocused)
                    .onSubmit { add(selection.wrappedValue) }
                    .accessibilityLabel("New tag")
                Button {
                    add(selection.wrappedValue)
                } label: {
                    if model.busyAction == .addTag {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.up")
                    }
                }
                .glassButtonStyle(prominent: true)
                .buttonBorderShape(.circle)
                .controlSize(.small)
                .disabled(newTag.trimmingCharacters(in: .whitespaces).isEmpty || model.busyAction != nil)
                .accessibilityLabel("Add tag")
            }
            if assignable.count > 1 && (addFieldFocused || !newTag.isEmpty) {
                appCheckboxes(selection: selection, apps: assignable)
                    .padding(.leading, 28)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
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
