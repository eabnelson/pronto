import ProntoMenuBarKit
import SwiftUI

/// All app setup starts here; tag creation stays in the Tags section.
struct AddAppSection: View {
    let onAddSlack: () -> Void
    @Environment(MenuBarModel.self) private var model
    @State private var expanded: Bool
    @State private var setupApp: AppID?

    init(expanded: Bool = false, setupApp: AppID? = nil, onAddSlack: @escaping () -> Void) {
        self.onAddSlack = onAddSlack
        _expanded = State(initialValue: expanded)
        _setupApp = State(initialValue: setupApp)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuItem(action: {
                withAnimation(.snappy(duration: 0.2)) { expanded.toggle(); setupApp = nil }
            }, disabled: model.busyAction != nil) {
                IconRow(icon: MenuIcon(systemName: "plus"), title: "Add App…") {
                    DisclosureChevron(expanded: expanded)
                }
            }
            if expanded {
                ExpandedGroup {
                    MenuItem(action: onAddSlack, disabled: model.busyAction != nil) {
                        IconRow(icon: MenuIcon(systemName: "message.fill", applicationBundleIdentifier: "com.tinyspeck.slackmacgap"),
                                title: "Slack Workspace…", subtitle: "Connect a workspace from Slack on this Mac")
                    }
                    ForEach([AppID.imessage, .whatsapp], id: \.self) { app in
                        let added = model.channels?.channel(app)?.configured == true
                        MenuItem(action: {
                            withAnimation(.snappy(duration: 0.2)) { setupApp = setupApp == app ? nil : app }
                        }, disabled: added || model.busyAction != nil) {
                            IconRow(icon: MenuIcon(systemName: app == .whatsapp ? "phone.fill" : "message.fill"),
                                    title: app.defaultLabel,
                                    subtitle: added ? "Already added" : "Ask your agent to set up")
                        }
                        if setupApp == app {
                            CopyablePrompt(prompt: SetupPrompt.add(app, labels: model.appLabels,
                                                                  keeping: model.channels?.enabledApps ?? []))
                        }
                    }
                }
            }
        }
    }
}
