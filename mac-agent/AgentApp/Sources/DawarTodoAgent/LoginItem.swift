import ServiceManagement

/// Start at login registers the app itself (macOS 13+). The app then starts
/// the launchd agent only if the owner had it running before.
enum LoginItem {
    static var enabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}
