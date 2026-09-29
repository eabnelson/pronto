import ProntoMenuBarKit
import SwiftUI

/// The MenuBarExtra window content.
struct PanelView: View {
    @Environment(AppController.self) private var controller
    @Environment(MenuBarModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().padding(.horizontal, 10)

            if model.isInstalled, !isUnverified {
                appsSection
                TagsSection()
                if let error = model.actionError {
                    InlineError(message: error)
                        .padding(.horizontal, 14)
                        .padding(.top, 8)
                }
                UpdateSection()
            } else {
                NotInstalledView(unverifiedMessage: isUnverified ? model.health.summary : nil)
            }

            Divider().padding(.horizontal, 10).padding(.top, 10)
            actions
        }
        .padding(.bottom, 6)
        .frame(width: 340)
        .background(WindowVisibilityReader { visible in model.setPanelOpen(visible) })
    }

    private var isUnverified: Bool {
        if case .untrusted? = model.clientError { return true }
        return false
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            MenuBarLabel(icon: model.icon)
                .font(.title2)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Pronto").font(.headline)
                    if let version = model.version {
                        Text(version)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .accessibilityLabel("version \(version)")
                    }
                }
                Text(model.health.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Pronto \(model.version ?? ""), \(model.health.summary)")
            Spacer()
            if model.status != nil {
                pauseButton
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var pauseButton: some View {
        let paused = model.isPaused
        return Button {
            Task { await model.setPaused(!paused) }
        } label: {
            if model.busyAction == .listener {
                ProgressView().controlSize(.small)
            } else {
                Label(paused ? "Resume" : "Pause", systemImage: paused ? "play.fill" : "pause.fill")
            }
        }
        .controlSize(.small)
        .disabled(model.busyAction != nil)
        .help(paused ? "Resume answering messages" : "Pause answering messages. Quitting this menu doesn't stop Pronto.")
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
            MenuRow(title: "Check for Updates", systemImage: "arrow.down.circle",
                    disabled: !model.isInstalled || model.updatePhase != .idle) {
                Task { await model.checkForUpdates(manual: true) }
            }
            MenuRow(title: "Run Diagnostics…", systemImage: "stethoscope", disabled: !model.isInstalled) {
                openWindow(id: WindowID.diagnostics)
                controller.bringToFront()
                controller.diagnostics.run()
            }
            MenuRow(title: "Open Logs", systemImage: "doc.text.magnifyingglass") {
                controller.openLogs()
            }
            MenuRow(title: "Launch at Login", systemImage: "power", action: {
                controller.setLaunchAtLogin(!controller.launchAtLogin)
            }, trailing: {
                if controller.launchAtLogin {
                    Image(systemName: "checkmark").foregroundStyle(.secondary)
                }
            })
            .accessibilityValue(controller.launchAtLogin ? "On" : "Off")
            .onAppear { controller.refreshLaunchAtLogin() }
            MenuRow(title: "Quit Pronto Menu Bar", systemImage: "xmark.circle") {
                controller.quit()
            }
            .help("Pronto keeps answering messages after the menu bar app quits.")
        }
        .padding(.top, 6)
    }
}

/// One app row: status dot, name, human status, toggle, and link button.
struct ChannelRowView: View {
    let row: ChannelRow
    let onLink: () -> Void
    @Environment(MenuBarModel.self) private var model

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            StatusDot(tone: row.tone, label: row.statusText)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.label)
                Text(row.detail.map { "\(row.statusText) · \($0)" } ?? row.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel)
            Spacer(minLength: 8)
            if row.showsLinkButton {
                Button("Link WhatsApp…", action: onLink)
                    .controlSize(.small)
            }
            if row.showsToggle {
                if model.busyAction == .channel(row.app) {
                    ProgressView().controlSize(.small)
                }
                Toggle(isOn: Binding(
                    get: { row.enabled },
                    set: { enabled in Task { await model.setChannel(row.app, enabled: enabled) } }
                )) {
                    Text(row.enabled ? "Turn off \(row.label)" : "Turn on \(row.label)")
                }
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)
                .disabled(!row.toggleAllowed || model.busyAction != nil)
                .help(row.toggleHelp ?? (row.enabled ? "Stop answering in \(row.label)" : "Answer in \(row.label)"))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }
}

/// Shown when the CLI is missing or fails verification.
struct NotInstalledView: View {
    let unverifiedMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(unverifiedMessage == nil ? "Pronto isn't installed" : "Pronto couldn't be verified",
                  systemImage: unverifiedMessage == nil ? "shippingbox" : "lock.trianglebadge.exclamationmark")
                .font(.headline)
            Text(unverifiedMessage.map { "\($0) Reinstall Pronto using the setup guide." }
                 ?? "Install Pronto with the setup guide. This menu updates automatically once it's installed.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Link("Open Setup Guide", destination: AppController.setupGuideURL)
        }
        .padding(14)
    }
}

/// Update availability, install confirmation, progress, and result.
struct UpdateSection: View {
    @Environment(MenuBarModel.self) private var model
    @State private var confirming = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch model.updatePhase {
            case .installing(let version):
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(version.map { "Installing Pronto \($0)…" } ?? "Installing update…")
                        .font(.callout)
                }
            case .checking:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Checking for updates…").font(.callout).foregroundStyle(.secondary)
                }
            case .idle:
                if let update = model.pendingUpdate {
                    if confirming {
                        Text("Install Pronto \(update.version ?? "")? Pronto finishes the current reply, updates, and restarts.")
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Spacer()
                            Button("Cancel") { confirming = false }
                            Button("Install") {
                                confirming = false
                                Task { await model.installUpdate() }
                            }
                            .keyboardShortcut(.defaultAction)
                        }
                        .controlSize(.small)
                    } else {
                        HStack {
                            Label("Pronto \(update.version ?? "") is available", systemImage: "arrow.down.circle.fill")
                                .font(.callout)
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(.tint)
                            Spacer()
                            Button("Install Update…") { confirming = true }
                                .controlSize(.small)
                                .disabled(model.busyAction != nil)
                        }
                    }
                }
            }
            if let message = model.updateMessage, model.updatePhase == .idle {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 14)
        .padding(.top, hasContent ? 10 : 0)
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
