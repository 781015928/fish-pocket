import Foundation

/// One Siri invocation keeps its session and request ID if it continues in the foreground.
@MainActor
final class BotShortcutQuestion {
    private let botID: String
    private let text: String
    private let requestID = UUID().uuidString.lowercased()
    private var target: (app: AppModel, session: SessionModel)?
    private var sent = false

    init(botID: String, text: String) {
        self.botID = botID
        self.text = text
    }

    private func resolve() async throws -> (app: AppModel, session: SessionModel) {
        if let target { return target }
        let engine = NodeEngine.shared
        engine.start()
        for await phase in engine.$phase.values {
            try Task.checkCancellation()
            switch phase {
            case .starting: continue
            case .running(let url, let generation):
                let app = await EngineConnection.shared.connect(to: url, generation: generation)
                try Task.checkCancellation()
                let state = try await app.botTeam.call("state")
                guard let bot = state["bots"].array.first(where: { $0["id"].string == botID }),
                      let sessionID = bot["sessionId"].string, !sessionID.isEmpty else {
                    throw EngineError(code: "bot/not-found", message: String(localized: "这个 Bot 已不在团队里"), detail: .null)
                }
                let target = (app: app, session: SessionModel(sessionId: sessionID, app: app))
                self.target = target
                return target
            case .exited, .unsupported:
                throw EngineError(code: nil, message: String(localized: "无法启动本机引擎，请打开 Fish Pocket 查看。"), detail: .null)
            }
        }
        throw CancellationError()
    }

    func send() async throws {
        guard !sent else { return }
        let (_, session) = try await resolve()
        try Task.checkCancellation()
        try await session.prompt(content: [["type": "text", "text": .string(text)]], steer: false, requestId: requestID)
        sent = true
    }

    func answer() async throws -> String? {
        let (app, session) = try await resolve()
        let frames = app.mux.open("session/observeEvent", ["request": ["address": [
            "kind": "session", "sessionId": .string(session.sessionId),
        ]]])
        var currentTurn: Int?
        var questionTurn: Int?
        var answer: String?
        for try await frame in frames {
            try Task.checkCancellation()
            if frame["type"].string == "ready" {
                try await send()
                continue
            }
            let event = frame["event"], data = event["data"]
            switch event["type"].string {
            case "turn/start":
                currentTurn = data["turn"].int
            case "user/message" where data["source"]["rpcId"].string == requestID:
                questionTurn = currentTurn
            case "assistant/message" where questionTurn != nil && data["turn"].int == questionTurn:
                guard data["interrupted"].bool != true else { continue }
                let content = data["message"]["content"].array
                let spoken = content.filter { $0["type"].string == "text" }.compactMap { $0["text"].string }
                    .joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                let callsTool = content.contains { $0["type"].string == "tool-call" }
                answer = spoken.isEmpty || callsTool ? nil : spoken
            case "turn/end" where questionTurn != nil && data["turn"].int == questionTurn:
                if let failure = TurnFailure(reason: data["reason"]) {
                    throw EngineError(code: failure.code, message: failure.message, detail: .null)
                }
                return data["reason"]["kind"].string == "completed" ? answer : nil
            default: break
            }
        }
        return nil
    }
}
