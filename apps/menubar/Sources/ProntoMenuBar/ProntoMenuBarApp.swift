import AppKit
import ProntoMenuBarKit
import SwiftUI

enum WindowID {
    static let diagnostics = "diagnostics"
    static let linkWhatsApp = "link-whatsapp"
}

@main
struct ProntoMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var controller = AppController()

    var body: some Scene {
        MenuBarExtra {
            PanelView()
                .environment(controller)
                .environment(controller.model)
        } label: {
            MenuBarLabel(icon: controller.model.icon)
        }
        .menuBarExtraStyle(.window)

        Window("Pronto Diagnostics", id: WindowID.diagnostics) {
            DiagnosticsView(model: controller.diagnostics)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)

        Window("Link WhatsApp", id: WindowID.linkWhatsApp) {
            LinkWhatsAppWindow()
                .environment(controller)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // Menu bar only, even when run unbundled via `swift run`.
        NSApp.setActivationPolicy(.accessory)
        UserDefaults.standard.register(defaults: ["NSQuitAlwaysKeepsWindows": false])
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SwiftUI may restore or auto-open a Window scene at launch; the app starts in the menu bar only.
        for window in NSApp.windows where window.identifier?.rawValue.hasPrefix(WindowID.diagnostics) == true
            || window.identifier?.rawValue.hasPrefix(WindowID.linkWhatsApp) == true {
            window.close()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
