import AppKit
import UniformTypeIdentifiers

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    static let hub = URL(string: "https://work.dawar.ca")!

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let menu = NSMenu()
    private let updater = Updater()
    private var client: AgentClient!
    private var status: AgentStatus?
    private var lastError: String?
    private var installError: String?
    private var pollTimer: Timer?
    private var updateTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let resources = Bundle.main.resourceURL else { return }
        client = AgentClient(resources: resources)
        menu.delegate = self
        statusItem.menu = menu
        render()
        updater.start()
        // Install is idempotent: it verifies the bundle, copies runtime and
        // release outside the app, and stages (never switches) a new release.
        client.run("install", as: AnyJSON.self) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { self.installError = error.localizedDescription }
            self.refresh { status in
                if status?.wanted == true, status?.phase == Phase.stopped.rawValue || status?.phase == Phase.crashed.rawValue { self.command("start") }
            }
            self.checkForUpdates(interactive: false)
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.tick() }
        updateTimer = Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.checkForUpdates(interactive: false) }
    }

    // Quitting the menu bar app leaves the launchd agent and its work running.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }

    private func tick() {
        refresh { [weak self] status in
            guard let self, let status else { return }
            if status.release.health == "pending" { self.command("check-health", quiet: true) }
            if status.release.staged != nil { self.command("apply-staged", quiet: true) }
        }
    }

    private func refresh(_ then: ((AgentStatus?) -> Void)? = nil) {
        client.run("status", as: AgentStatus.self) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let status): self.status = status; self.lastError = nil
            case .failure(let error): self.lastError = error.localizedDescription
            }
            self.render()
            then?(self.status)
        }
    }

    private func command(_ name: String, _ extra: [String] = [], quiet: Bool = false, done: (() -> Void)? = nil) {
        client.run(name, extra, as: AnyJSON.self) { [weak self] result in
            if case .failure(let error) = result, !quiet { self?.alert("DawarTodo Agent", error.localizedDescription) }
            self?.refresh()
            done?()
        }
    }

    private var phase: Phase { Phase(rawValue: status?.phase ?? "") ?? .notInstalled }

    private func render() {
        let image = NSImage(systemSymbolName: phase.symbol, accessibilityDescription: "DawarTodo Agent: \(phase.title)")
        image?.isTemplate = true
        statusItem.button?.image = image
        statusItem.button?.toolTip = "DawarTodo Agent — \(phase.title)"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(disabled("DawarTodo Agent — \(phase.title)"))
        if let bots = status?.agent?.bots {
            menu.addItem(disabled(bots.working > 0 ? "\(bots.working) of \(bots.total) bots working" : "\(bots.total) bots idle"))
            for bot in bots.active { menu.addItem(disabled("    \(bot.name) — \(bot.status)")) }
            if bots.settling > 0 { menu.addItem(disabled("    \(bots.settling) tool call(s) settling")) }
        }
        if let installError { menu.addItem(disabled("⚠︎ Install failed: \(installError)")) }
        if let lastError { menu.addItem(disabled("⚠︎ \(lastError)")) }
        menu.addItem(.separator())

        switch phase {
        case .needsPairing:
            menu.addItem(item("Pair This Mac…", #selector(pair)))
        case .needsActivation:
            menu.addItem(item("Enable Execution on This Mac…", #selector(enableExecution)))
        case .stopped, .crashed:
            menu.addItem(item("Start Agent", #selector(start)))
        case .disconnected, .unresponsive, .starting:
            menu.addItem(item("Reconnect", #selector(reconnect)))
            menu.addItem(item("Stop Agent…", #selector(stop)))
        case .connected, .working:
            menu.addItem(item("Stop Agent…", #selector(stop)))
        case .notInstalled:
            break
        }
        menu.addItem(item("Open DawarTodo", #selector(openHub)))
        menu.addItem(.separator())

        let version = status?.app.map { "Version \($0.appVersion) (\($0.build))" } ?? "Version unknown"
        menu.addItem(disabled(version))
        if let staged = status?.update.staged, staged.build > (status?.app?.build ?? 0) {
            menu.addItem(item("Install Update \(staged.appVersion)…", #selector(installUpdate)))
        } else if let check = status?.update.lastCheck, !check.compatible {
            menu.addItem(disabled("Update required: \(check.reason ?? "incompatible with DawarTodo")"))
        }
        if let staged = status?.release.staged { menu.addItem(disabled("Agent \(staged.prefix(8)) switches when work settles")) }
        if status?.release.health == "rolled-back" { menu.addItem(disabled("Last update rolled back to the previous release")) }
        menu.addItem(item("Check for Updates", #selector(checkNow)))
        menu.addItem(.separator())

        menu.addItem(item("Show Logs", #selector(showLogs)))
        menu.addItem(item("Save Diagnostics…", #selector(saveDiagnostics)))
        let login = item("Start at Login", #selector(toggleLogin))
        login.state = LoginItem.enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(.separator())
        menu.addItem(item("Quit (agent keeps running)", #selector(quit)))
    }

    private func item(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    @objc private func pair() {
        client.run("fingerprint", as: FingerprintResult.self) { [weak self] result in
            guard let self else { return }
            let key: FingerprintResult
            switch result {
            case .success(let value): key = value
            case .failure(let error): return self.alert("Pair this Mac", error.localizedDescription)
            }
            let alert = NSAlert()
            alert.messageText = "Pair this Mac with DawarTodo"
            alert.informativeText = "Open work.dawar.ca → Settings → Execution machines, confirm this fingerprint and download the five-minute pairing file:\n\n\(key.fingerprint)"
            alert.addButton(withTitle: "Choose Pairing File…")
            alert.addButton(withTitle: "Open Settings")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                let panel = NSOpenPanel()
                panel.allowedContentTypes = [.json]
                panel.message = "Choose the pairing file downloaded from DawarTodo Settings."
                if panel.runModal() == .OK, let url = panel.url { self.command("pair", ["--pairing-file", url.path]) }
            case .alertSecondButtonReturn:
                NSWorkspace.shared.open(AppDelegate.hub)
            default: break
            }
        }
    }

    @objc private func enableExecution() {
        let alert = NSAlert()
        alert.messageText = "Enable execution on this Mac?"
        alert.informativeText = "Bots you place on this Mac in DawarTodo will run here with full access to their workspaces, using your existing model, reasoning and Fast settings. Placement and each bot's approval still happen in DawarTodo."
        alert.addButton(withTitle: "Enable")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { command("enable-execution") { [weak self] in self?.command("start") } }
    }

    @objc private func start() { command("start") }
    @objc private func reconnect() { command("reconnect") }

    @objc private func stop() {
        client.run("stop", as: StopResult.self) { [weak self] result in
            guard let self else { return }
            if case .failure(let error) = result { self.alert("Stop Agent", error.localizedDescription) }
            guard case .success(let stop) = result, !stop.stopped, stop.reason == "busy" else { return self.refresh() }
            let alert = NSAlert()
            alert.messageText = "Bots are still working"
            alert.informativeText = "\(stop.working ?? 0) bot(s) are mid-turn and \(stop.settling ?? 0) tool call(s) are settling. Stopping now interrupts them; queued messages are kept. Use each bot's Stop in DawarTodo to end a turn cleanly."
            alert.addButton(withTitle: "Keep Running")
            alert.addButton(withTitle: "Stop Anyway")
            alert.alertStyle = .warning
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertSecondButtonReturn { self.command("stop", ["--force"]) }
        }
    }

    @objc private func openHub() { NSWorkspace.shared.open(AppDelegate.hub) }
    @objc private func checkNow() { checkForUpdates(interactive: true) }

    private func checkForUpdates(interactive: Bool) {
        guard status?.phase != Phase.needsPairing.rawValue else { return }
        client.run("stage-update", as: StageResult.self) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let staged):
                if staged.staged, let appcast = staged.appcast, interactive { self.updater.install(appcastPath: appcast) }
                else if interactive { self.alert("DawarTodo Agent", staged.staged ? "Update \(staged.appVersion ?? "") is ready to install." : "Up to date (\(staged.reason ?? "no newer approved release")).") }
            case .failure(let error):
                if interactive { self.alert("Update check failed", error.localizedDescription) }
            }
            self.refresh()
        }
    }

    @objc private func installUpdate() {
        if let appcast = status?.update.staged?.appcast { updater.install(appcastPath: appcast) }
    }

    @objc private func showLogs() {
        guard let logs = status?.logs else { return }
        let url = URL(fileURLWithPath: logs.stderr)
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: "/System/Applications/Utilities/Console.app"), configuration: .init())
        } else {
            NSWorkspace.shared.open(URL(fileURLWithPath: logs.directory))
        }
    }

    @objc private func saveDiagnostics() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "DawarTodo Agent diagnostics.json"
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        DispatchQueue.global().async { [client] in
            do { try client!.invoke("diagnostics").write(to: url, options: .atomic) }
            catch { DispatchQueue.main.async { self.alert("Diagnostics", error.localizedDescription) } }
        }
    }

    @objc private func toggleLogin() {
        do { try LoginItem.set(!LoginItem.enabled) } catch { alert("Start at Login", error.localizedDescription) }
    }

    @objc private func quit() { NSApp.terminate(nil) }

    private func alert(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
