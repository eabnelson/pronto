import Foundation
import Observation

/// Steps of the WhatsApp link window.
public enum LinkPhase: Equatable, Sendable {
    /// Disclosure and risk acknowledgement (only when WhatsApp isn't configured yet).
    case disclosure
    /// Options (phone number, tags) before starting.
    case ready
    /// Process started, waiting for the first code.
    case starting
    case qr(code: String)
    case pairingCode(code: String)
    /// The phone accepted the link; wacli is finishing its first sync.
    case syncing
    case linked
    case failed(message: String)

    public var isActive: Bool {
        switch self {
        case .starting, .qr, .pairingCode, .syncing: return true
        default: return false
        }
    }

    /// Pure transition for one stream event.
    public func applying(_ event: LinkEvent) -> LinkPhase {
        switch event {
        case .qr(let code): return .qr(code: code)
        case .pairingCode(let code): return .pairingCode(code: code)
        case .syncing: return .syncing
        case .linked: return .linked
        case .error(let reason, let message):
            if reason == LinkModel.consentRequiredReason { return .disclosure }
            return .failed(message: LinkModel.errorText(reason: reason, message: message))
        case .unknown: return self
        }
    }
}

/// The owner-facing WhatsApp disclosure. Shown verbatim before first link.
public enum WhatsAppDisclosure {
    public static let text = "WhatsApp support uses wacli, which links this Mac as a WhatsApp device through the unofficial WhatsApp Web protocol. It is not affiliated with WhatsApp or Meta. Automated use of a linked device may violate WhatsApp's terms and can lead to your account being restricted. Replies are sent from your own WhatsApp account, and anyone in a chat where you have sent a message can trigger a reply with your tag."
}

/// State for the WhatsApp link window (`whatsapp link --events`).
@MainActor
@Observable
public final class LinkModel {
    public nonisolated static let consentRequiredReason = "consent-required"

    public private(set) var phase: LinkPhase
    /// `true` when WhatsApp isn't configured yet, so the disclosure must be accepted here.
    public private(set) var needsDisclosure: Bool
    public var acceptedRisk = false
    public var usePhoneNumber = false
    public var phoneInput = ""
    /// Tags offered for a first link; all selected by default.
    public let availableTags: [String]
    public var selectedTags: Set<String>
    public private(set) var validationError: String?

    private let client: CLIClient
    private let onLinked: @MainActor () -> Void
    @ObservationIgnored private var task: Task<Void, Never>?

    public init(client: CLIClient, whatsAppConfigured: Bool, availableTags: [String], onLinked: @escaping @MainActor () -> Void = {}) {
        self.client = client
        self.needsDisclosure = !whatsAppConfigured
        self.phase = whatsAppConfigured ? .ready : .disclosure
        self.availableTags = availableTags
        self.selectedTags = Set(availableTags)
        self.onLinked = onLinked
    }

    /// Continue from the disclosure step; requires the explicit acknowledgement.
    public func acknowledgeDisclosure() {
        guard acceptedRisk else { return }
        phase = .ready
    }

    /// Builds the link options from the form, or sets `validationError`.
    public func makeOptions() -> WhatsAppLinkOptions? {
        validationError = nil
        var phone: String?
        if usePhoneNumber {
            guard let normalized = PhoneValidation.normalize(phoneInput) else {
                validationError = "Enter your WhatsApp phone number with country code, e.g. +1 555 123 4567."
                return nil
            }
            phone = normalized
        }
        var tags: [String] = []
        if needsDisclosure {
            guard acceptedRisk else {
                validationError = "Confirm that you understand the risk first."
                return nil
            }
            if !availableTags.isEmpty {
                guard !selectedTags.isEmpty else {
                    validationError = "Choose at least one tag for WhatsApp."
                    return nil
                }
                // The CLI defaults to every configured tag; only pass an explicit subset.
                if selectedTags != Set(availableTags) {
                    tags = availableTags.filter(selectedTags.contains)
                }
            }
        }
        // Already-configured WhatsApp was accepted when it was first linked.
        return WhatsAppLinkOptions(phone: phone, acceptRisk: true, tags: tags)
    }

    public func start() {
        guard !phase.isActive, let options = makeOptions() else { return }
        phase = .starting
        let stream = client.linkWhatsApp(options)
        task = Task { [weak self] in
            do {
                for try await event in stream {
                    guard let self else { return }
                    self.apply(event)
                    if event.isTerminal { break }
                }
                guard let self else { return }
                if self.phase.isActive {
                    self.phase = .failed(message: "Linking ended before WhatsApp was linked. Try again.")
                }
            } catch is CancellationError {
                // Cancelled by the user; `cancel()` already reset the phase.
            } catch {
                guard let self else { return }
                if self.phase.isActive {
                    self.phase = .failed(message: (error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
                }
            }
        }
    }

    func apply(_ event: LinkEvent) {
        let next = phase.applying(event)
        if next == .disclosure {
            needsDisclosure = true
            acceptedRisk = false
        }
        phase = next
        if next == .linked { onLinked() }
    }

    /// Terminates the link process.
    public func cancel() {
        task?.cancel()
        task = nil
        if phase.isActive { phase = .ready }
    }

    /// Back to the form after a failure.
    public func reset() {
        cancel()
        phase = needsDisclosure && !acceptedRisk ? .disclosure : .ready
    }

    /// Waits for the stream to end (tests).
    public func waitUntilFinished() async { await task?.value }

    nonisolated static func errorText(reason: String?, message: String?) -> String {
        if let message, !message.isEmpty { return message }
        switch reason {
        case "timeout"?: return "The code expired before it was scanned. Try again."
        case let reason?: return "Linking failed (\(reason))."
        case nil: return "Linking failed."
        }
    }
}
