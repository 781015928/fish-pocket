import AppIntents
import Foundation
import UIKit

/// A Bot as Shortcuts and Siri see it. The list is the one the share extension offers
/// (`ShareTargets`, written by `ShareTargetsWriter`): the Bot page's order, hidden Bots left out,
/// each with its avatar as the app draws it. Reading it needs no engine.
struct BotEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: LocalizedStringResource(stringLiteral: "Bot"))
    static var defaultQuery = BotQuery()

    let id: String
    let name: String
    let role: String

    init(_ bot: ShareTargets.Bot) {
        id = bot.id
        name = bot.name
        role = bot.role
    }

    var displayRepresentation: DisplayRepresentation {
        // The Bot's own name and role, not phrases to translate.
        DisplayRepresentation(
            title: LocalizedStringResource(stringLiteral: name),
            subtitle: role.isEmpty ? nil : LocalizedStringResource(stringLiteral: role),
            // The picture itself: Shortcuts and Siri run in processes that cannot read the App Group's files.
            image: ShareTargets.avatarURL(of: id).flatMap { try? Data(contentsOf: $0) }.map { .init(data: $0) }
        )
    }
}

struct BotQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [BotEntity] {
        let bots = ShareTargets.read().bots
        return identifiers.compactMap { id in bots.first { $0.id == id }.map(BotEntity.init) }
    }

    func entities(matching string: String) async throws -> [BotEntity] {
        ShareTargets.read().bots.filter { $0.name.localizedCaseInsensitiveContains(string) }.map(BotEntity.init)
    }

    func suggestedEntities() async throws -> [BotEntity] {
        ShareTargets.read().bots.map(BotEntity.init)
    }
}

/// Opens one Bot's chat.
struct OpenBotIntent: AppIntent {
    static var title: LocalizedStringResource = "打开 Bot"
    static var description = IntentDescription("打开和一个 Bot 的聊天。")
    static var openAppWhenRun = true

    @Parameter(title: LocalizedStringResource(stringLiteral: "Bot"))
    var bot: BotEntity

    static var parameterSummary: some ParameterSummary {
        Summary("打开\(\.$bot)")
    }

    init() {}

    init(bot: BotEntity) {
        self.bot = bot
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        DshIntentBridge.open?(.bot(bot.id))
        return .result()
    }
}

/// Asks the selected Bot in its current chat and gives its answer back to Siri.
struct AskBotIntent: ForegroundContinuableIntent {
    static var title: LocalizedStringResource = "问 Bot"
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes { [.background, .foreground(.dynamic)] }

    @Parameter(title: LocalizedStringResource(stringLiteral: "Bot"))
    var bot: BotEntity
    @Parameter(title: "问题", requestValueDialog: "你想问什么？")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("问\(\.$bot)：\(\.$question)")
    }

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw $question.needsValueError("你想问什么？") }
        let request = BotShortcutQuestion(botID: bot.id, text: text)
        do {
            let answer = try await withThrowingTaskGroup(of: String?.self) { group in
                group.addTask { try await request.answer() }
                // Leave time for Siri to offer a handoff before the background runtime expires.
                group.addTask { try await Task.sleep(for: .seconds(20)); return nil }
                defer { group.cancelAll() }
                return try await group.next() ?? nil
            }
            try Task.checkCancellation()
            if let answer { return .result(value: answer, dialog: "\(answer)") }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Configuration, approval and request errors can be handled in the Bot's chat.
            try Task.checkCancellation()
        }

        let dialog: IntentDialog = "在 Fish Pocket 里继续这次问答？"
        if #available(iOS 26.0, *) {
            try await continueInForeground(dialog)
        } else {
            try await requestToContinueInForeground(dialog)
        }
        // A cold background invocation may have no window when the transition begins.
        // Deliver the link to the actual scene, just as a widget tap does.
        if !(await UIApplication.shared.open(DshLink.bot(bot.id).url)) {
            DshIntentBridge.open?(.bot(bot.id))
        }
        try await request.send()
        return .result(value: "", dialog: "请在聊天里查看回答。")
    }
}

/// Opens the page with the balance: Fish Pocket's credits, or the DeepSeek account's wallets.
struct ShowBalanceIntent: AppIntent {
    static var title: LocalizedStringResource = "查看余额"
    static var description = IntentDescription("打开 Fish Pocket 的余额页面。")
    static var openAppWhenRun = true

    init() {}

    @MainActor
    func perform() async throws -> some IntentResult {
        DshIntentBridge.open?(.balance)
        return .result()
    }
}
