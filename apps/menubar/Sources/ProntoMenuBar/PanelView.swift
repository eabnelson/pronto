import ProntoMenuBarKit
import SwiftUI

/// The MenuBarExtra window content, laid out like the system Wi-Fi and Sound menus.
struct PanelView: View {
    @Environment(AppController.self) private var controller
    @Environment(MenuBarModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            if model.isInstalled, !isUnverified {
                UpdateSection()
                MenuSeparator()
                appsSection
                MenuSeparator()
                TagsSection()
                if let error = model.actionError {
                    InlineError(message: error)
                        .padding(.horizontal, PanelMetrics.inset)
                        .padding(.top, 6)
                }
            } else {
                MenuSeparator()
                NotInstalledView(unverifiedMessage: isUnverified ? model.health.summary : nil)
            }

            MenuSeparator()
            actions
        }
        .padding(.vertical, 5)
        .frame(width: PanelMetrics.width)
        .fixedSize(horizontal: false, vertical: true)
        .background(WindowVisibilityReader { visible in model.setPanelOpen(visible) })
        .background(PanelChrome())
    }

    private var isUnverified: Bool {
        if case .untrusted? = model.clientError { return true }
        return false
    }

    // MARK: Header

    /// "Pronto" and an on/off switch, like "Wi-Fi" at the top of its menu.
    private var header: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Pronto").font(.system(size: 13, weight: .semibold))
                if showsSummary {
                    Text(model.health.summary)
                        .font(.system(size: 11))
                        .foregroundStyle(summaryColor)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if model.busyAction == .listener {
                ProgressView().controlSize(.small)
            }
            if model.status != nil {
                Toggle(isOn: Binding(
                    get: { !model.isPaused },
                    set: { on in Task { await model.setPaused(!on) } }
                )) {
                    Text("Answer messages")
                }
                .labelsHidden()
                .toggleStyle(.switch)
                .disabled(model.busyAction != nil)
                .help(model.isPaused
                      ? "Resume answering messages"
                      : "Pause answering messages. Quitting this menu doesn't stop Pronto.")
            }
        }
        .padding(.horizontal, PanelMetrics.inset)
        .padding(.top, 5)
        .padding(.bottom, 4)
    }

    private var showsSummary: Bool {
        switch model.health {
        case .normal: return false
        default: return model.isInstalled
        }
    }

    private var summaryColor: Color {
        switch model.icon.tint {
        case .error: return .red
        case .warning: return .orange
        case .none: return .secondary
        }
    }

    // MARK: Apps

    private var appsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Apps")
            ForEach(model.channelRows) { row in
                ChannelRowView(row: row) {
                    controller.prepareLink()
                    openWindow(id: WindowID.linkWhatsApp)
                    controller.bringToFront()
                }
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuCommand(title: "Check for Updates…", disabled: !model.isInstalled || model.updatePhase != .idle, action: {
                Task { await model.checkForUpdates(manual: true) }
            }, trailing: {
                if let version = model.version {
                    Text(version).foregroundStyle(.tertiary).accessibilityLabel("version \(version)")
                }
            })
            MenuCommand(title: "Run Diagnostics…", disabled: !model.isInstalled) {
                openWindow(id: WindowID.diagnostics)
                controller.bringToFront()
                controller.diagnostics.run()
            }
            MenuCommand(title: "Open Logs") {
                controller.openLogs()
            }
            MenuCommand(title: "Launch at Login", action: {
                controller.setLaunchAtLogin(!controller.launchAtLogin)
            }, trailing: {
                if controller.launchAtLogin {
                    Image(systemName: "checkmark").font(.system(size: 12, weight: .semibold))
                }
            })
            .accessibilityValue(controller.launchAtLogin ? "On" : "Off")
            .onAppear { controller.refreshLaunchAtLogin() }
            MenuSeparator()
            MenuCommand(title: "Quit Pronto Menu Bar") {
                controller.quit()
            }
            .help("Pronto keeps answering messages after the menu bar app quits.")
        }
    }
}

/// One app, like a device in the Bluetooth menu: the icon fills in when the
/// app is on, and clicking the row turns it on or off (or links WhatsApp).
struct ChannelRowView: View {
    let row: ChannelRow
    let onLink: () -> Void
    @Environment(MenuBarModel.self) private var model
    @State private var showingSetup = false

    /// Apps that aren't set up and can't be linked from here show a prompt for the owner's agent.
    private var offersSetupPrompt: Bool { !row.configured && !row.showsLinkButton }

    var body: some View {
        VStack(spacing: 0) {
            item
            if offersSetupPrompt && showingSetup {
                ExpandedGroup {
                    CopyablePrompt(prompt: SetupPrompt.add(row.app, labels: model.appLabels,
                                                           keeping: model.channels?.enabledApps ?? []))
                }
            }
        }
    }

    private var item: some View {
        MenuItem(action: action, disabled: model.busyAction != nil) {
            IconRow(
                icon: MenuIcon(systemName: row.app == .whatsapp ? "phone.fill" : "message.fill",
                               active: row.enabled && row.configured),
                title: row.label,
                subtitle: row.detail.map { "\(row.statusText) · \($0)" } ?? row.statusText,
                subtitleColor: subtitleColor
            ) {
                if model.busyAction == .channel(row.app) {
                    ProgressView().controlSize(.small)
                } else if row.showsLinkButton {
                    Text("Link…").foregroundStyle(.secondary)
                } else if offersSetupPrompt {
                    DisclosureChevron(expanded: showingSetup)
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.accessibilityLabel)
        .accessibilityHint(hint ?? "")
        .help(hint ?? "")
    }

    private var action: (() -> Void)? {
        if row.showsLinkButton { return onLink }
        if offersSetupPrompt {
            return { withAnimation(.snappy(duration: 0.2)) { showingSetup.toggle() } }
        }
        guard row.showsToggle, row.toggleAllowed else { return nil }
        let enabled = !row.enabled
        return { Task { await model.setChannel(row.app, enabled: enabled) } }
    }

    private var hint: String? {
        if row.showsLinkButton { return "Link \(row.label)" }
        if offersSetupPrompt { return "Get a prompt that has your agent set up \(row.label)" }
        guard row.showsToggle else { return nil }
        if !row.toggleAllowed { return row.toggleHelp }
        return row.enabled ? "Stop answering in \(row.label)" : "Answer in \(row.label)"
    }

    private var subtitleColor: Color? {
        guard row.enabled else { return nil }
        switch row.tone {
        case .error: return .red
        case .warning: return .orange
        default: return nil
        }
    }
}

/// Shown when the CLI is missing or fails verification.
struct NotInstalledView: View {
    let unverifiedMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            IconRow(icon: MenuIcon(systemName: unverifiedMessage == nil ? "shippingbox" : "lock"),
                    title: unverifiedMessage == nil ? "Pronto isn't installed" : "Pronto couldn't be verified",
                    subtitle: unverifiedMessage.map { "\($0) Reinstall Pronto to fix this." })
                .padding(.horizontal, PanelMetrics.inset)
                .padding(.bottom, 4)
            CopyablePrompt(prompt: SetupPrompt.install)
        }
    }
}

/// Update availability, install confirmation, progress, and result.
struct UpdateSection: View {
    @Environment(MenuBarModel.self) private var model
    @State private var confirming = false

    var body: some View {
        if hasContent {
            VStack(alignment: .leading, spacing: 0) {
                MenuSeparator()
                switch model.updatePhase {
                case .installing(let version):
                    MenuItem {
                        IconRow(icon: MenuIcon(systemName: "arrow.down", active: true),
                                title: version.map { "Installing Pronto \($0)…" } ?? "Installing update…") {
                            ProgressView().controlSize(.small)
                        }
                    }
                case .checking:
                    MenuItem {
                        IconRow(icon: MenuIcon(systemName: "arrow.down"), title: "Checking for updates…") {
                            ProgressView().controlSize(.small)
                        }
                    }
                case .idle:
                    if let update = model.pendingUpdate {
                        MenuItem(action: { confirming.toggle() }, disabled: model.busyAction != nil) {
                            IconRow(icon: MenuIcon(systemName: "arrow.down", active: true),
                                    title: "Update Available",
                                    subtitle: "Pronto \(update.version ?? "")") {
                                DisclosureChevron(expanded: confirming)
                            }
                        }
                        if confirming {
                            ExpandedGroup {
                                Text("Pronto finishes the current reply, updates, and restarts.")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.horizontal, PanelMetrics.inset)
                                    .padding(.bottom, 3)
                                MenuCommand(title: "Install and Restart") {
                                    confirming = false
                                    Task { await model.installUpdate() }
                                }
                            }
                        }
                    }
                }
                if let message = model.updateMessage, model.updatePhase == .idle {
                    Text(message)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, PanelMetrics.inset)
                        .padding(.vertical, 3)
                }
            }
        }
    }

    private var hasContent: Bool {
        model.updatePhase != .idle || model.pendingUpdate != nil || model.updateMessage != nil
    }
}

#Preview("Panel") {
    let controller = AppController(client: FakeCLIClient.documentedExamples())
    return PanelView()
        .environment(controller)
        .environment(controller.model)
}
