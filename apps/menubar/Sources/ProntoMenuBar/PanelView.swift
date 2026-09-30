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

            if model.isInstalled, !isUnverified {
                UpdateSection()
                appsSection
                TagsSection()
                if let error = model.actionError {
                    InlineError(message: error)
                        .padding(.horizontal, PanelMetrics.inset + 6)
                        .padding(.top, 8)
                }
            } else {
                NotInstalledView(unverifiedMessage: isUnverified ? model.health.summary : nil)
                    .panelCard()
                    .padding(.horizontal, PanelMetrics.inset)
            }

            Divider().padding(.horizontal, PanelMetrics.inset + 6).padding(.top, 12).padding(.bottom, 4)
            actions
        }
        .padding(.top, 4)
        .padding(.bottom, 8)
        .frame(width: PanelMetrics.width)
        .background(WindowVisibilityReader { visible in model.setPanelOpen(visible) })
    }

    private var isUnverified: Bool {
        if case .untrusted? = model.clientError { return true }
        return false
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: model.icon.symbolName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 34, height: 34)
                .background(Circle().fill(headerTint.gradient))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Pronto").font(.title3.weight(.semibold))
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
        .padding(.horizontal, PanelMetrics.inset + 6)
        .padding(.vertical, 10)
    }

    private var headerTint: Color {
        switch model.icon.tint {
        case .error: return .red
        case .warning: return .orange
        case .none: return model.icon.dimmed ? .gray : .accentColor
        }
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
                    .labelStyle(.iconOnly)
                    .frame(width: 16, height: 16)
            }
        }
        .glassButtonStyle()
        .buttonBorderShape(.circle)
        .controlSize(.large)
        .disabled(model.busyAction != nil)
        .help(paused ? "Resume answering messages" : "Pause answering messages. Quitting this menu doesn't stop Pronto.")
    }

    // MARK: Apps

    private var appsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Apps")
            VStack(spacing: 0) {
                ForEach(Array(model.channelRows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().padding(.leading, 52) }
                    ChannelRowView(row: row) {
                        controller.prepareLink()
                        openWindow(id: WindowID.linkWhatsApp)
                        controller.bringToFront()
                    }
                }
            }
            .padding(.vertical, 4)
            .panelCard()
            .padding(.horizontal, PanelMetrics.inset)
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
    }
}

/// One app row: status dot, name, human status, toggle, and link button.
struct ChannelRowView: View {
    let row: ChannelRow
    let onLink: () -> Void
    @Environment(MenuBarModel.self) private var model

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            AppGlyph(app: row.app, dimmed: !row.enabled)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.label).font(.body.weight(.medium))
                HStack(spacing: 5) {
                    StatusDot(tone: row.tone, label: row.statusText)
                    Text(row.detail.map { "\(row.statusText) · \($0)" } ?? row.statusText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(row.accessibilityLabel)
            Spacer(minLength: 8)
            if row.showsLinkButton {
                Button("Link…", action: onLink)
                    .glassButtonStyle(prominent: true)
                    .controlSize(.small)
                    .help("Link WhatsApp")
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
                .controlSize(.small)
                .disabled(!row.toggleAllowed || model.busyAction != nil)
                .help(row.toggleHelp ?? (row.enabled ? "Stop answering in \(row.label)" : "Answer in \(row.label)"))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
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
                                .glassButtonStyle()
                            Button("Install") {
                                confirming = false
                                Task { await model.installUpdate() }
                            }
                            .keyboardShortcut(.defaultAction)
                            .glassButtonStyle(prominent: true)
                        }
                        .controlSize(.small)
                    } else {
                        HStack {
                            Label("Pronto \(update.version ?? "") is available", systemImage: "arrow.down.circle.fill")
                                .font(.callout)
                                .symbolRenderingMode(.hierarchical)
                                .foregroundStyle(.tint)
                            Spacer()
                            Button("Install…") { confirming = true }
                                .glassButtonStyle(prominent: true)
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
        .padding(hasContent ? 12 : 0)
        .background {
            if hasContent {
                RoundedRectangle(cornerRadius: PanelMetrics.cardRadius, style: .continuous)
                    .fill(.tint.opacity(0.12))
            }
        }
        .padding(.horizontal, PanelMetrics.inset)
        .padding(.top, hasContent ? 4 : 0)
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
