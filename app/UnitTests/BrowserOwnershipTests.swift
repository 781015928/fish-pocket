import Foundation

// Whose browser a session works in (`app/DshIOS/Browser/BrowserOwnership.swift`).
// Run with `scripts/test-swift-units.sh`.

private let parents = [
    "sub": "plain",
    "sub-of-sub": "sub",
    "bot-sub": "bot-now",
    "loop-a": "loop-b",
    "loop-b": "loop-a",
]
private func parent(_ id: String) -> String? { parents[id] }

private let team = BrowserOwnership.Team(chats: [
    "bot-now": "b1",
    "bot-old": "b1",
    "bot-busy": "b1",
    "bot-busy-old": "b1",
    "other-bot": "b2",
])

private func owner(_ session: String, _ team: BrowserOwnership.Team? = team) -> String? {
    BrowserOwnership.owner(of: session, parent: parent, team: team)
}

@main
enum BrowserOwnershipTests {
    static func main() {
        var failures = 0
        func expect(_ value: String?, _ wanted: String?, _ what: String) {
            if value == wanted { print("ok   \(what)") } else { failures += 1; print("FAIL \(what): \(value ?? "nil") ≠ \(wanted ?? "nil")") }
        }

        // A Bot's own chat: every part goes to the one browser.
        expect(owner("bot-now"), "bot:b1", "current part")
        expect(owner("bot-old"), "bot:b1", "earlier part")
        expect(owner("bot-busy"), "bot:b1", "part opened while busy")
        expect(owner("bot-busy-old"), "bot:b1", "earlier part of a part opened while busy")
        expect(owner("other-bot"), "bot:b2", "another Bot has its own")

        // Subagents: the browser of the conversation at the top of their line.
        expect(owner("sub"), "plain", "subagent of a conversation")
        expect(owner("sub-of-sub"), "plain", "subagent of a subagent")
        expect(owner("bot-sub"), "bot:b1", "subagent of a Bot's chat")
        expect(owner("loop-a"), "loop-b", "a parent loop ends")

        // Conversations of their own.
        expect(owner("plain"), "plain", "plain conversation")
        expect(owner("unknown"), "unknown", "session the app has not listed")
        expect(owner("plain", .empty), "plain", "no Bots here")
        expect(owner("bot-now", .empty), "bot-now", "no team: a session is its own")

        // The team not read yet: nobody is given a browser that might split a Bot's.
        expect(owner("bot-now", nil), nil, "Bot's chat, team not loaded")
        expect(owner("plain", nil), nil, "plain conversation, team not loaded")
        expect(owner("bot-sub", nil), nil, "subagent, team not loaded")

        // A Bot's hidden group Session, once ds-bot says whose it is.
        var withGroups = team
        withGroups.groupSessions = ["group-hidden": "b1"]
        expect(owner("group-hidden"), "group-hidden", "hidden group Session: its own today")
        expect(owner("group-hidden", withGroups), "bot:b1", "hidden group Session, once known")

        // Keys.
        expect(BrowserOwnership.key(bot: "b1"), "bot:b1", "key of a Bot")
        expect(BrowserOwnership.bot(ofKey: "bot:b1"), "b1", "Bot of a key")
        expect(BrowserOwnership.bot(ofKey: "plain"), nil, "no Bot in a session key")
        expect(BrowserOwnership.conversation(of: "bot-sub", parent: parent), "bot-now", "conversation of a subagent")

        if failures > 0 {
            print("\(failures) failed")
            exit(1)
        }
        print("all passed")
    }
}
