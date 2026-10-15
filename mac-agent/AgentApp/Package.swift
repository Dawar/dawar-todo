// swift-tools-version:5.9
import PackageDescription

// Native menu bar shell for the DawarTodo execution agent. All agent,
// enrollment and update logic lives in the bundled Node controller
// (portable/mac-agent/cli.mjs); this target only presents and invokes it.
let package = Package(
    name: "DawarTodoAgent",
    platforms: [.macOS(.v13)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.6.4"),
    ],
    targets: [
        .executableTarget(
            name: "DawarTodoAgent",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/DawarTodoAgent",
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
    ]
)
