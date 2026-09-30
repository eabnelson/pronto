import ProntoMenuBarKit
import SwiftUI

/// Lists `doctor --json` checks with status icons and remediation text.
struct DiagnosticsView: View {
    let model: DiagnosticsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "stethoscope")
                    .font(.title2)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Diagnostics").font(.title3.weight(.semibold))
                    Text(subtitle).font(.callout).foregroundStyle(.secondary)
                }
            }

            content
                .frame(maxWidth: .infinity, minHeight: 220, alignment: .topLeading)

            HStack {
                Spacer()
                Button("Run Again") { model.run() }
                    .glassButtonStyle()
                    .disabled(model.isRunning)
                Button("Done") {
                    model.cancel()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .glassButtonStyle(prominent: true)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { if model.phase == .idle { model.run() } }
    }

    private var subtitle: String {
        switch model.phase {
        case .idle: return "Checks Pronto's setup and runtime."
        case .running: return "Running checks. This can take about a minute."
        case .finished(let response):
            return response.healthy ? "Everything looks good." : "Some checks need attention."
        case .failed: return "Diagnostics couldn't finish."
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .idle:
            EmptyView()
        case .running(let startedAt):
            VStack(spacing: 10) {
                ProgressView()
                TimelineView(.periodic(from: startedAt, by: 1)) { context in
                    let elapsed = max(0, Int(context.date.timeIntervalSince(startedAt)))
                    Text("\(elapsed)s elapsed")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Running diagnostics")
        case .finished:
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.checks.enumerated()), id: \.element.id) { index, check in
                        if index > 0 { Divider().padding(.leading, 40) }
                        CheckRow(check: check)
                    }
                }
                .padding(.horizontal, 12)
                .panelCard()
            }
            .frame(maxHeight: 360)
        case .failed(let message):
            InlineError(message: message)
        }
    }
}

private struct CheckRow: View {
    let check: DoctorCheck

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Presentation.checkTone(check.status).color)
                .frame(width: 18)
                .accessibilityLabel(Presentation.checkStatusText(check.status))
            VStack(alignment: .leading, spacing: 3) {
                Text(Presentation.checkTitle(check.id))
                if let remediation = check.remediation, !remediation.isEmpty {
                    Text(remediation)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            Text(Presentation.checkStatusText(check.status))
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch check.status {
        case .ok: return "checkmark.circle.fill"
        case .degraded: return "exclamationmark.triangle.fill"
        case .failed: return "xmark.octagon.fill"
        default: return "questionmark.circle.fill"
        }
    }
}
