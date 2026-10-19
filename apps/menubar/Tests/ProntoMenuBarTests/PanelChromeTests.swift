import AppKit
import Testing
@testable import ProntoMenuBar

@Suite("Panel window chrome", .serialized)
@MainActor
struct PanelChromeTests {
    @Test func roundedContentHasNoOpaqueWindowBehindItsCorners() async throws {
        _ = NSApplication.shared
        let size = NSSize(width: 300, height: 240)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // A contrasting window backing exposes the same artifact as the desktop.
        window.backgroundColor = .systemBlue
        window.isOpaque = true
        let content = NSView(frame: NSRect(origin: .zero, size: size))
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.systemBlue.cgColor
        window.contentView = content
        let chrome = PanelChrome.ChromeView(frame: content.bounds)
        content.addSubview(chrome)
        defer { window.close() }

        // Exercise the real attachment and resizing callbacks, including shrinkage.
        for height: CGFloat in [240, 400, 180] {
            chrome.setFrameSize(NSSize(width: size.width, height: height))
            // Drain the fit already queued after the AppKit layout pass.
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                DispatchQueue.main.async { continuation.resume() }
            }
            #expect(window.contentView?.frame.height == height)
            #expect(!window.isOpaque)
            #expect(window.backgroundColor.alphaComponent == 0)
            let frame = try #require(content.superview)
            let bitmap = try #require(frame.bitmapImageRepForCachingDisplay(in: frame.bounds))
            frame.cacheDisplay(in: frame.bounds, to: bitmap)
            #expect(try #require(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)).alphaComponent == 1)
            for x in [0, bitmap.pixelsWide - 1] {
                for y in [0, bitmap.pixelsHigh - 1] {
                    #expect(try #require(bitmap.colorAt(x: x, y: y)).alphaComponent == 0)
                }
            }
        }
    }
}
