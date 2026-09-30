import CoreGraphics
import CoreImage
import Foundation

/// Renders WhatsApp link codes as crisp QR images.
public enum QRCodeRenderer {
    /// Returns a black-on-white QR code scaled by an integer factor with
    /// nearest-neighbor sampling so modules stay sharp. `targetSize` is in pixels.
    public static func image(for code: String, targetSize: Int = 480, correctionLevel: String = "M") -> CGImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(code.utf8), forKey: "inputMessage")
        filter.setValue(correctionLevel, forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }

        let modules = output.extent.width
        guard modules > 0 else { return nil }
        let scale = max(1, (CGFloat(targetSize) / modules).rounded(.down))
        let scaled = output
            .samplingNearest()
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))

        let context = CIContext(options: [.useSoftwareRenderer: false])
        return context.createCGImage(scaled, from: scaled.extent.integral)
    }
}
