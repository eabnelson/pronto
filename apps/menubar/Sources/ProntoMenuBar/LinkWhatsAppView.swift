import ProntoMenuBarKit
import SwiftUI

/// Hosts the current link session; creates one if the window was opened directly.
struct LinkWhatsAppWindow: View {
    @Environment(AppController.self) private var controller

    var body: some View {
        Group {
            if let link = controller.linkModel {
                LinkWhatsAppView(model: link)
            } else {
                ProgressView().frame(width: 420, height: 200)
            }
        }
        .onAppear { if controller.linkModel == nil { controller.prepareLink() } }
        .onDisappear { controller.endLink() }  // closing the window terminates the process
    }
}

struct LinkWhatsAppView: View {
    @Bindable var model: LinkModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "qrcode")
                    .font(.title2)
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text("Link WhatsApp").font(.title3.weight(.semibold))
            }
            content
        }
        .padding(20)
        .frame(width: 420)
        .animation(.default, value: model.phase)
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .disclosure: disclosure
        case .ready: form
        case .starting:
            waiting("Starting…")
        case .qr(let code):
            qr(code)
        case .pairingCode(let code):
            pairing(code)
        case .syncing:
            waiting("Linked — finishing the first sync of recent messages…",
                    detail: "This can take a few minutes. You can keep using WhatsApp on your phone.")
        case .linked:
            linked
        case .failed(let message):
            VStack(alignment: .leading, spacing: 12) {
                InlineError(message: message)
                buttons {
                    Button("Close") { close() }
                    Button("Try Again") { model.reset() }.keyboardShortcut(.defaultAction)
                }
            }
        }
    }

    // MARK: Steps

    private var disclosure: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(WhatsAppDisclosure.text)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            Toggle("I understand the risk", isOn: $model.acceptedRisk)
                .toggleStyle(.checkbox)
            buttons {
                Button("Cancel") { close() }.keyboardShortcut(.cancelAction)
                Button("Continue") { model.acknowledgeDisclosure() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.acceptedRisk)
            }
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pronto links this Mac as a WhatsApp device. Keep WhatsApp open on your phone and go to Settings › Linked Devices › Link a Device.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Toggle("Use phone number instead", isOn: $model.usePhoneNumber)
                .toggleStyle(.checkbox)
            if model.usePhoneNumber {
                TextField("Phone number with country code", text: $model.phoneInput)
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.telephoneNumber)
                    .onSubmit { model.start() }
            }

            if model.needsDisclosure && !model.availableTags.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Answer these tags in WhatsApp").font(.callout.weight(.medium))
                    HStack(spacing: 12) {
                        ForEach(model.availableTags, id: \.self) { tag in
                            Toggle(tag, isOn: Binding(
                                get: { model.selectedTags.contains(tag) },
                                set: { on in
                                    if on { model.selectedTags.insert(tag) } else { model.selectedTags.remove(tag) }
                                }
                            ))
                            .toggleStyle(.checkbox)
                        }
                    }
                }
            }

            if let error = model.validationError {
                InlineError(message: error)
            }

            buttons {
                Button("Cancel") { close() }.keyboardShortcut(.cancelAction)
                Button(model.usePhoneNumber ? "Get Pairing Code" : "Show QR Code") { model.start() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }

    private func qr(_ code: String) -> some View {
        VStack(spacing: 12) {
            QRCodeView(code: code)
                .frame(width: 240, height: 240)
                .frame(maxWidth: .infinity)
            Text("Scan with WhatsApp on your phone: Settings › Linked Devices › Link a Device. The code refreshes automatically.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            buttons {
                Button("Cancel") { model.cancel() }.keyboardShortcut(.cancelAction)
            }
        }
    }

    private func pairing(_ code: String) -> some View {
        VStack(spacing: 12) {
            Text(code)
                .font(.system(size: 34, weight: .semibold, design: .monospaced))
                .textSelection(.enabled)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary.opacity(0.6)))
                .accessibilityLabel("Pairing code \(code.map(String.init).joined(separator: " "))")
            Text("On your phone, open WhatsApp › Settings › Linked Devices › Link a Device › Link with phone number instead, and enter this code.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            buttons {
                Button("Cancel") { model.cancel() }.keyboardShortcut(.cancelAction)
            }
        }
    }

    private func waiting(_ title: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text(title)
            }
            if let detail {
                Text(detail).font(.callout).foregroundStyle(.secondary)
            }
            buttons {
                Button("Cancel") { model.cancel() }.keyboardShortcut(.cancelAction)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var linked: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("WhatsApp is linked. Pronto now answers your tags there.", systemImage: "checkmark.circle.fill")
                .symbolRenderingMode(.multicolor)
            buttons {
                Button("Done") { close() }.keyboardShortcut(.defaultAction)
            }
        }
        .task {
            try? await Task.sleep(for: .seconds(2.5))
            close()
        }
    }

    private func buttons<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack {
            Spacer()
            content()
        }
    }

    private func close() {
        model.cancel()
        dismiss()
    }
}

/// A crisp QR code for the current link code.
struct QRCodeView: View {
    let code: String

    var body: some View {
        Group {
            if let image = QRCodeRenderer.image(for: code, targetSize: 720) {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(1, contentMode: .fit)
                    .padding(10)
                    .background(Color.white, in: RoundedRectangle(cornerRadius: 8))
            } else {
                Image(systemName: "qrcode").font(.largeTitle).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("WhatsApp link QR code")
    }
}
