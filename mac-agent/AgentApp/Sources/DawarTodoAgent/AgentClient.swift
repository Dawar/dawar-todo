import Foundation

/// Runs the bundled controller with the bundled Node runtime. Every command
/// prints one JSON object {ok, result | error}. Nothing secret is passed as an
/// argument: pairing passes only the path of the owner's pairing file.
final class AgentClient {
    struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private let resources: URL
    private let queue = DispatchQueue(label: "ca.dawar.todo.agentapp.controller")

    init(resources: URL) { self.resources = resources }

    private var node: URL { resources.appendingPathComponent("node/bin/node") }
    private var cli: URL { resources.appendingPathComponent("agent/portable/mac-agent/cli.mjs") }

    func run<T: Decodable>(_ command: String, _ extra: [String] = [], as type: T.Type, completion: @escaping (Result<T, Error>) -> Void) {
        queue.async {
            let result = Result { try self.runSync(command, extra, as: type) }
            DispatchQueue.main.async { completion(result) }
        }
    }

    func runSync<T: Decodable>(_ command: String, _ extra: [String] = [], as type: T.Type) throws -> T {
        let data = try invoke(command, extra)
        struct Envelope: Decodable { let ok: Bool; let error: String? }
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.ok else { throw Failure(message: envelope.error ?? "The agent controller failed.") }
        struct Payload<R: Decodable>: Decodable { let result: R }
        return try JSONDecoder().decode(Payload<T>.self, from: data).result
    }

    /// Raw JSON result, used for diagnostics export.
    func invoke(_ command: String, _ extra: [String] = []) throws -> Data {
        let process = Process()
        process.executableURL = node
        process.arguments = [cli.path, command, "--resources", resources.path, "--time-zone", TimeZone.current.identifier] + extra
        process.currentDirectoryURL = resources
        process.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory()]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard !data.isEmpty else {
            throw Failure(message: "The agent controller exited (\(process.terminationReason == .uncaughtSignal ? "signal" : "status") \(process.terminationStatus)) without a result.")
        }
        return data
    }
}

/// Accepts any result where only success matters.
struct AnyJSON: Decodable { init(from decoder: Decoder) throws {} }
