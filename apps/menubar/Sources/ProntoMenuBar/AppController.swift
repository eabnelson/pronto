import AppKit
import Observation
import ProntoMenuBarKit
import ServiceManagement
import SwiftUI

/// Wires the library models to the app and owns macOS integrations
/// (login item, Finder, windows). Holds no CLI logic of its own.
@MainActor
@Observable
final class AppController {
    static let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/pronto/daemon.log")

    let model: MenuBarModel
    let diagnostics: DiagnosticsModel
    /// The active link session; created when the link window opens.
    var linkModel: LinkModel?
    private(set) var launchAtLogin: Bool = false

    init(client: CLIClient? = nil) {
        let client = client ?? ProcessCLIClient()
        model = MenuBarModel(client: client)
        diagnostics = DiagnosticsModel(client: client)
        refreshLaunchAtLogin()
        if let path = ProcessInfo.processInfo.environment[Self.snapshotEnvironmentKey], !path.isEmpty {
            Task { await self.writeSnapshots(to: URL(fileURLWithPath: path)) }
        } else {
            model.start()
        }
    }

    // MARK: Development snapshots

    /// Development aid for checking layout without clicking through the UI:
    /// `PRONTO_MENUBAR_SNAPSHOT=/tmp/pronto` renders the panel, diagnostics, and
    /// link windows (light and dark) to `/tmp/pronto-*.png` and quits. Rendering
    /// happens offscreen, so it needs no Screen Recording permission.
    static let snapshotEnvironmentKey = "PRONTO_MENUBAR_SNAPSHOT"

    private func writeSnapshots(to url: URL) async {
        let base = url.path
        await model.pollOnce(full: true)
        snapshot(PanelView().environment(self).environment(model), to: "\(base)-panel")

        diagnostics.run()
        await diagnostics.waitUntilFinished()
        snapshot(DiagnosticsView(model: diagnostics), to: "\(base)-diagnostics")

        prepareLink()
        if let link = linkModel {
            snapshot(LinkWhatsAppView(model: link), to: "\(base)-link-\(link.phase == .disclosure ? "disclosure" : "form")")
            link.acceptedRisk = true
            link.acknowledgeDisclosure()
            link.start()
            for _ in 0..<200 {
                if case .qr = link.phase { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            snapshot(LinkWhatsAppView(model: link), to: "\(base)-link-qr")
            endLink()
        }
        NSApp.terminate(nil)
    }

    private func snapshot<V: View>(_ view: V, to base: String) {
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let host = NSHostingView(rootView: view.fixedSize().background(Color(nsColor: .windowBackgroundColor)))
            host.appearance = NSAppearance(named: appearance)
            host.frame = CGRect(origin: .zero, size: host.fittingSize)
            let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = host.appearance
            window.backgroundColor = .windowBackgroundColor
            window.contentView = host
            host.layoutSubtreeIfNeeded()
            guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
            host.cacheDisplay(in: host.bounds, to: rep)
            if let png = rep.representation(using: .png, properties: [:]) {
                try? png.write(to: URL(fileURLWithPath: "\(base)-\(name).png"))
            }
        }
    }

    // MARK: WhatsApp linking

    /// Prepares a fresh link session with the current configuration.
    func prepareLink() {
        linkModel?.cancel()
        let whatsApp = model.whatsApp
        let tags = model.tagEntries.map(\.tag)
        linkModel = LinkModel(
            client: model.client,
            whatsAppConfigured: whatsApp?.configured ?? false,
            availableTags: tags,
            onLinked: { [weak self] in
                Task { await self?.model.refresh(full: true) }
            }
        )
    }

    func endLink() {
        linkModel?.cancel()
        linkModel = nil
    }

    // MARK: Login item

    func refreshLaunchAtLogin() {
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
                if SMAppService.mainApp.status == .requiresApproval {
                    SMAppService.openSystemSettingsLoginItems()
                }
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            model.actionError = "Couldn't change Launch at Login: \(error.localizedDescription)"
        }
        refreshLaunchAtLogin()
    }

    // MARK: Finder

    func openLogs() {
        let fm = FileManager.default
        if fm.fileExists(atPath: Self.logURL.path) {
            NSWorkspace.shared.activateFileViewerSelecting([Self.logURL])
        } else if fm.fileExists(atPath: Self.logURL.deletingLastPathComponent().path) {
            NSWorkspace.shared.open(Self.logURL.deletingLastPathComponent())
        } else {
            model.actionError = "No logs yet. Pronto writes them to ~/Library/Logs/pronto."
        }
    }

    func bringToFront() {
        NSApp.activate()
    }

    func quit() {
        // Quitting the menu bar app never stops the listener.
        NSApp.terminate(nil)
    }
}
