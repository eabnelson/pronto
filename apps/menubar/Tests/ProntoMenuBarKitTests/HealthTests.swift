import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Health aggregation")
struct HealthTests {
    func status(_ file: String) throws -> StatusResponse { try Fixture.decode(StatusResponse.self, file) }
    func channels(_ file: String) throws -> ChannelsResponse { try Fixture.decode(ChannelsResponse.self, file) }

    @Test func healthyIsNormal() throws {
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status-healthy.json"), channels: try channels("channels-both.json")))
        #expect(health == .normal)
        #expect(MenuBarIcon(health: health).symbolName == "ellipsis.bubble.fill")
        #expect(MenuBarIcon(health: health).tint == .none)
        #expect(!MenuBarIcon(health: health).dimmed)
    }

    @Test func updateAvailableIsAttention() throws {
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status-healthy.json"), channels: try channels("channels-both.json"), updateAvailable: true))
        #expect(health == .attention(["An update is available"]))
        #expect(MenuBarIcon(health: health).tint == .warning)
        #expect(MenuBarIcon(health: health).symbolName == "exclamationmark.bubble")
    }

    @Test func enabledAppNeedingLinkIsError() throws {
        // Documented example: WhatsApp needs_link; channels-both marks WhatsApp enabled.
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status.json"), channels: try channels("channels-both.json")))
        #expect(health == .error(["WhatsApp needs linking"]))
        #expect(MenuBarIcon(health: health).tint == .error)
    }

    @Test func disabledAppDoesNotCount() throws {
        // Documented example pair: WhatsApp needs_link but is not enabled.
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status.json"), channels: try channels("channels-list.json")))
        #expect(health == .normal)
    }

    @Test func withoutChannelsEveryStatusAppCounts() throws {
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status.json")))
        #expect(health == .error(["WhatsApp needs linking"]))
    }

    @Test func pausedWhenStoppedByUser() throws {
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status-paused.json"), channels: try channels("channels-list.json"), updateAvailable: true))
        #expect(health == .paused)
        let icon = MenuBarIcon(health: health)
        #expect(icon.dimmed)
        #expect(icon.accessibilityLabel == "Pronto: paused")
    }

    @Test func stoppedAfterFailureIsError() {
        let s = StatusResponse(version: "0.5.0", listener: .stopped, daemon: .failed)
        #expect(HealthEvaluator.evaluate(HealthInput(status: s)) == .error(["Pronto stopped after an error"]))
        #expect(!HealthEvaluator.isPaused(s))
    }

    @Test func failedDaemonIsError() throws {
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status-failed.json"), channels: try channels("channels-list.json")))
        guard case .error(let reasons) = health else { Issue.record("expected error, got \(health)"); return }
        #expect(reasons.contains("Pronto isn't running"))
        #expect(reasons.contains("iMessage is unavailable"))
    }

    @Test func degradedIsAttention() throws {
        let health = HealthEvaluator.evaluate(HealthInput(status: try status("status-degraded.json"), channels: try channels("channels-list.json")))
        #expect(health == .attention(["Pronto is degraded", "Some features are limited", "iMessage is degraded"]))
        #expect(health.summary == "Pronto is degraded (+2 more)")
    }

    @Test func startingIsAttention() {
        let s = StatusResponse(version: "1", listener: .running, daemon: .starting,
                               channels: ["imessage": ChannelStatus(state: .starting)])
        #expect(HealthEvaluator.evaluate(HealthInput(status: s)) == .attention(["Pronto is starting", "iMessage is starting"]))
    }

    @Test func loadedButNotRunningWhileStartingIsAttention() {
        let s = StatusResponse(version: "1", listener: .loaded, daemon: .starting)
        #expect(HealthEvaluator.evaluate(HealthInput(status: s)) == .attention(["Pronto is starting"]))
    }

    @Test func runningButDaemonStoppedIsError() {
        let s = StatusResponse(version: "1", listener: .running, daemon: .stopped)
        #expect(HealthEvaluator.evaluate(HealthInput(status: s)) == .error(["Pronto isn't running"]))
    }

    @Test func enabledAppMissingFromStatusIsAttention() throws {
        let s = StatusResponse(version: "1", listener: .running, daemon: .ready, channels: ["imessage": ChannelStatus(state: .ready)])
        let health = HealthEvaluator.evaluate(HealthInput(status: s, channels: try channels("channels-both.json")))
        #expect(health == .attention(["WhatsApp status unknown"]))
    }

    @Test func unknownStatesAreAttention() {
        let s = StatusResponse(version: "1", listener: .running, daemon: DaemonState(rawValue: "mystery"),
                               channels: ["imessage": ChannelStatus(state: ChannelState(rawValue: "weird"))])
        #expect(HealthEvaluator.evaluate(HealthInput(status: s)) == .attention(["Pronto's state is unknown", "iMessage isn't ready"]))
    }

    @Test func clientErrors() throws {
        #expect(HealthEvaluator.evaluate(HealthInput(status: nil, clientError: .notInstalled(path: "/x"))) == .notInstalled)
        #expect(MenuBarIcon(health: .notInstalled).symbolName == "questionmark.bubble")
        let untrusted = HealthEvaluator.evaluate(HealthInput(status: nil, clientError: .untrusted(path: "/x", detail: "not signed by Pronto")))
        guard case .unavailable(let message) = untrusted else { Issue.record("expected unavailable"); return }
        #expect(message.contains("couldn't be verified"))
        // A transient timeout keeps the last known status.
        let kept = HealthEvaluator.evaluate(HealthInput(status: try status("status-healthy.json"), channels: try channels("channels-both.json"), clientError: .timedOut))
        #expect(kept == .normal)
        #expect(HealthEvaluator.evaluate(HealthInput(status: nil, clientError: .timedOut)) == .unavailable("Pronto took too long to respond."))
    }

    @Test func loadingIsDimmed() {
        #expect(HealthEvaluator.evaluate(HealthInput(status: nil)) == .loading)
        #expect(MenuBarIcon(health: .loading).dimmed)
        #expect(OverallHealth.loading.summary == "Checking…")
    }

    @Test func summaries() {
        #expect(OverallHealth.normal.summary == "Ready")
        #expect(OverallHealth.paused.summary == "Paused")
        #expect(OverallHealth.error(["WhatsApp needs linking"]).summary == "WhatsApp needs linking")
        #expect(MenuBarIcon(health: .error(["WhatsApp needs linking"])).accessibilityLabel == "Pronto: WhatsApp needs linking")
    }
}

@Suite("App rows")
struct ChannelRowTests {
    func rows(_ statusFile: String?, _ channelsFile: String?) throws -> [ChannelRow] {
        let status = try statusFile.map { try Fixture.decode(StatusResponse.self, $0) }
        let channels = try channelsFile.map { try Fixture.decode(ChannelsResponse.self, $0) }
        return ChannelRowBuilder.rows(status: status, channels: channels)
    }

    @Test func documentedExamples() throws {
        let rows = try rows("status.json", "channels-list.json")
        #expect(rows.map(\.app) == [.imessage, .whatsapp])
        let imessage = rows[0]
        #expect(imessage.statusText == "Ready")
        #expect(imessage.tone == .ok)
        #expect(imessage.showsToggle)
        #expect(!imessage.toggleAllowed)  // the only enabled app
        #expect(imessage.toggleHelp == "At least one app must stay on.")
        let whatsapp = rows[1]
        #expect(whatsapp.statusText == "Unavailable")
        #expect(whatsapp.detail == "Install wacli to use WhatsApp.")
        #expect(!whatsapp.showsToggle)
        #expect(!whatsapp.showsLinkButton)  // wacli isn't installed
        #expect(whatsapp.accessibilityLabel == "WhatsApp: Unavailable. Install wacli to use WhatsApp.")
    }

    @Test func linkButtonWhenWacliInstalledButNotConfigured() throws {
        let whatsapp = try rows("status.json", "channels-wacli-installed.json")[1]
        #expect(whatsapp.statusText == "Not set up")
        #expect(whatsapp.showsLinkButton)
        #expect(!whatsapp.showsToggle)
    }

    @Test func linkButtonWhenNeedsLink() throws {
        let rows = try rows("status.json", "channels-both.json")
        #expect(rows[1].statusText == "Needs linking")
        #expect(rows[1].tone == .error)
        #expect(rows[1].showsLinkButton)
        #expect(rows[0].toggleAllowed && rows[1].toggleAllowed)
        #expect(!rows[0].showsLinkButton)
    }

    @Test func pausedRows() throws {
        let rows = try rows("status-paused.json", "channels-both.json")
        #expect(rows.allSatisfy { $0.statusText == "Paused" && $0.tone == .inactive })
    }

    @Test func disabledRowsAreOff() throws {
        var channels = try Fixture.decode(ChannelsResponse.self, "channels-both.json")
        channels.channels[1].enabled = false
        let rows = ChannelRowBuilder.rows(status: try Fixture.decode(StatusResponse.self, "status-healthy.json"), channels: channels)
        #expect(rows[1].statusText == "Off")
        #expect(rows[1].showsToggle)
        #expect(rows[1].toggleAllowed)
        #expect(!rows[0].toggleAllowed)
    }

    @Test func degradedWithReason() throws {
        let row = try rows("status-degraded.json", "channels-list.json")[0]
        #expect(row.statusText == "Degraded")
        #expect(row.detail == "Full Disk Access is missing")
        #expect(row.tone == .warning)
    }

    @Test func beforeStatusArrives() throws {
        let rows = try rows(nil, "channels-list.json")
        #expect(rows[0].statusText == "Checking…")
        #expect(rows[0].tone == .pending)
    }

    @Test func statusOnly() throws {
        let rows = try rows("status.json", nil)
        #expect(rows.count == 2)
        #expect(!rows[0].showsToggle)
        #expect(rows[1].showsLinkButton)
    }

    @Test(arguments: [
        (ChannelState.ready, "Ready", StatusTone.ok),
        (.starting, "Starting…", .pending),
        (.needsLink, "Needs linking", .error),
        (.degraded, "Degraded", .warning),
        (.failed, "Unavailable", .error),
        (.stopped, "Stopped", .warning),
        (.unknown, "Unknown", .warning),
    ])
    func stateText(state: ChannelState, text: String, tone: StatusTone) {
        #expect(ChannelRowBuilder.describe(state) == (text, tone))
    }
}
