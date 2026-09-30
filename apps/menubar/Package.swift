// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ProntoMenuBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ProntoMenuBar", targets: ["ProntoMenuBar"]),
        .library(name: "ProntoMenuBarKit", targets: ["ProntoMenuBarKit"]),
    ],
    targets: [
        // Testable logic: CLI contract models, parsing, state, and policies.
        .target(
            name: "ProntoMenuBarKit",
            linkerSettings: [
                .linkedFramework("Security"),
                .linkedFramework("CoreImage"),
            ]
        ),
        // Thin SwiftUI layer.
        .executableTarget(
            name: "ProntoMenuBar",
            dependencies: ["ProntoMenuBarKit"],
            linkerSettings: [
                .linkedFramework("ServiceManagement"),
            ]
        ),
        .testTarget(
            name: "ProntoMenuBarKitTests",
            dependencies: ["ProntoMenuBarKit"]
        ),
    ]
)
