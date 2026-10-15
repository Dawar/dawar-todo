import Foundation
import Sparkle

/// Sparkle installs app updates. The controller has already fetched the
/// owner-signed release record with a node-signed request, verified it and
/// the archive hash, and written a local appcast; Sparkle verifies the
/// archive again with SUPublicEDKey before replacing the app. Automatic
/// Sparkle checks stay off so no unauthenticated feed is ever contacted.
final class Updater: NSObject, SPUUpdaterDelegate {
    private var appcast: String?
    private lazy var controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)

    func start() {
        controller.updater.automaticallyChecksForUpdates = false
        controller.updater.automaticallyDownloadsUpdates = false
    }

    /// Replacing the app does not touch the launchd agent or its work; the
    /// new app stages its agent release and switches it once work settles.
    func install(appcastPath: String) {
        appcast = URL(fileURLWithPath: appcastPath).absoluteString
        controller.checkForUpdates(nil)
    }

    func feedURLString(for updater: SPUUpdater) -> String? { appcast }
}
