import Foundation

/// Whose browser a conversation works in (S-87). Every way to the browser asks here, the agent's
/// calls (`BrowserAgent`) and the app's pages alike, so both always reach the same one.
///
/// - A conversation has its own browser, keyed by its session id.
/// - A subagent uses the browser of the conversation that started it: the user only sees the
///   workbench there.
/// - A Bot's own chat uses the Bot's browser, `bot:<id>`. ds-bot moves a long chat on to a fresh
///   Session (a new part, its `parts.js`), and the pages the Bot had open are still there in the
///   next part, as in ds-bot's own desktop browser, which it keys by the Bot (`browser-plugins.js`).
///   Every part counts: the current one, the earlier ones, and those opened while it was busy.
/// - A Bot's hidden Session in a group keeps its own browser for now: ds-bot's `state` does not say
///   whose it is. `Team.groupSessions` is where that goes once it does.
///
/// Kept free of the app's types, so the rules can be checked on their own
/// (`app/UnitTests/BrowserOwnershipTests.swift`).
enum BrowserOwnership {
    /// What the Bot team says about its Sessions.
    struct Team: Equatable {
        /// Every part of each Bot's own chat, to the Bot's id.
        var chats: [String: String] = [:]
        /// A Bot's hidden Sessions in groups, to the Bot's id. Empty until ds-bot says whose they are
        /// (its `state` lists them flat, under `rooms[].parts`).
        var groupSessions: [String: String] = [:]

        /// No Bots, or none that can run here: every conversation is its own.
        static let empty = Team()

        /// The Bot whose browser `session` uses, if any.
        func bot(of session: String) -> String? { chats[session] ?? groupSessions[session] }
    }

    static let botPrefix = "bot:"

    /// The key of a Bot's browser.
    static func key(bot id: String) -> String { botPrefix + id }

    /// The Bot a browser key stands for; nil for a conversation's own.
    static func bot(ofKey key: String) -> String? {
        key.hasPrefix(botPrefix) ? String(key.dropFirst(botPrefix.count)) : nil
    }

    /// The conversation a session works for: a subagent's is the one at the top of its line.
    static func conversation(of session: String, parent: (String) -> String?) -> String {
        var id = session
        var seen: Set<String> = [id]
        while let next = parent(id), !next.isEmpty, seen.insert(next).inserted { id = next }
        return id
    }

    /// The browser `session` works in. Nil while the team is not known yet (`team` nil): a Bot's chat
    /// taken for a conversation of its own would split its browser in two, so the caller waits.
    static func owner(of session: String, parent: (String) -> String?, team: Team?) -> String? {
        let conversation = conversation(of: session, parent: parent)
        guard let team else { return nil }
        if let bot = team.bot(of: conversation) { return key(bot: bot) }
        return conversation
    }
}
