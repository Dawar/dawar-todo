import Foundation

/// Mirrors MacAgentController.status() in portable/mac-agent/controller.mjs.
struct AgentStatus: Decodable {
    struct Active: Decodable { let id: String; let name: String; let status: String }
    struct Bots: Decodable { let total: Int; let working: Int; let settling: Int; let active: [Active] }
    struct Agent: Decodable { let connected: Bool?; let ready: Bool?; let bots: Bots?; let source: String? }
    struct Release: Decodable { let current: String?; let previous: String?; let staged: String?; let health: String? }
    struct App: Decodable { let appVersion: String; let build: Int }
    struct Available: Decodable { let build: Int; let appVersion: String }
    struct LastCheck: Decodable { let at: Double; let compatible: Bool; let reason: String?; let available: Available? }
    struct StagedUpdate: Decodable { let build: Int; let appVersion: String; let appcast: String }
    struct Update: Decodable { let lastCheck: LastCheck?; let staged: StagedUpdate? }
    struct Logs: Decodable { let directory: String; let stdout: String; let stderr: String }

    let phase: String
    let agent: Agent?
    let release: Release
    let app: App?
    let update: Update
    let wanted: Bool
    let logs: Logs

    var isBusy: Bool { (agent?.bots?.working ?? 0) > 0 || (agent?.bots?.settling ?? 0) > 0 }
}

struct StopResult: Decodable { let stopped: Bool; let reason: String?; let working: Int?; let settling: Int? }
struct FingerprintResult: Decodable { let fingerprint: String }
struct StageResult: Decodable { let staged: Bool; let reason: String?; let appcast: String?; let appVersion: String? }

enum Phase: String {
    case notInstalled = "not-installed", needsPairing = "needs-pairing", needsActivation = "needs-activation"
    case stopped, crashed, starting, unresponsive, disconnected, connected, working

    var title: String {
        switch self {
        case .notInstalled: return "Installing…"
        case .needsPairing: return "Not paired"
        case .needsActivation: return "Paired — execution not enabled"
        case .stopped: return "Stopped"
        case .crashed: return "Stopped unexpectedly"
        case .starting: return "Starting…"
        case .unresponsive: return "Not responding"
        case .disconnected: return "Reconnecting to DawarTodo…"
        case .connected: return "Connected"
        case .working: return "Working"
        }
    }

    var symbol: String {
        switch self {
        case .connected: return "checkmark.circle"
        case .working: return "bolt.circle.fill"
        case .stopped: return "pause.circle"
        case .starting, .notInstalled: return "circle.dotted"
        case .needsPairing, .needsActivation: return "person.badge.key"
        case .crashed, .unresponsive, .disconnected: return "exclamationmark.triangle"
        }
    }
}
