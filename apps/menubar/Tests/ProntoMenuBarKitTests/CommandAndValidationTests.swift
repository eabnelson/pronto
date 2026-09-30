import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("Command arguments")
struct CommandTests {
    @Test(arguments: [
        (CLICommand.status, ["status", "--json"]),
        (.channelsList, ["channels", "list", "--json"]),
        (.channelsEnable(.whatsapp), ["channels", "enable", "whatsapp", "--json"]),
        (.channelsDisable(.imessage), ["channels", "disable", "imessage", "--json"]),
        (.tagsList, ["tags", "list", "--json"]),
        (.tagsAdd(tag: "@s4", apps: [.whatsapp, .imessage]), ["tags", "add", "@s4", "--app", "imessage", "--app", "whatsapp", "--json"]),
        (.tagsAdd(tag: "@s4", apps: []), ["tags", "add", "@s4", "--json"]),
        (.tagsRemove(tag: "@wa", apps: [.whatsapp]), ["tags", "remove", "@wa", "--app", "whatsapp", "--json"]),
        (.tagsRemove(tag: "@wa", apps: []), ["tags", "remove", "@wa", "--json"]),
        (.start, ["start", "--json"]),
        (.stop, ["stop", "--json"]),
        (.doctor, ["doctor", "--json"]),
        (.updateCheck, ["update", "--check", "--json"]),
        (.updateInstall, ["update", "--json"]),
    ])
    func arguments(command: CLICommand, expected: [String]) {
        #expect(command.arguments == expected)
    }

    @Test func duplicateAppsAreCollapsed() {
        #expect(CLICommand.tagsAdd(tag: "@a", apps: [.imessage, .imessage]).arguments == ["tags", "add", "@a", "--app", "imessage", "--json"])
    }

    @Test func linkArguments() {
        #expect(WhatsAppLinkOptions(acceptRisk: false).arguments == ["whatsapp", "link", "--events"])
        #expect(WhatsAppLinkOptions(acceptRisk: true).arguments == ["whatsapp", "link", "--events", "--accept-risk"])
        #expect(
            WhatsAppLinkOptions(phone: "+15551234567", acceptRisk: true, tags: ["@s4", "@wa"]).arguments
                == ["whatsapp", "link", "--events", "--phone", "+15551234567", "--accept-risk", "--tag", "@s4", "--tag", "@wa"]
        )
        #expect(WhatsAppLinkOptions(phone: "", acceptRisk: true).arguments == ["whatsapp", "link", "--events", "--accept-risk"])
        #expect(CLICommand.whatsappLink(WhatsAppLinkOptions(acceptRisk: true)).arguments.first == "whatsapp")
    }

    @Test func tagValuesStayOneArgument() {
        // Arguments are never joined into a shell string.
        let args = CLICommand.tagsAdd(tag: "@a b; rm -rf ~", apps: [.imessage]).arguments
        #expect(args[2] == "@a b; rm -rf ~")
    }

    @Test func timeoutsAndMutations() {
        #expect(CLICommand.whatsappLink(WhatsAppLinkOptions(acceptRisk: true)).timeout == nil)
        #expect((CLICommand.doctor.timeout ?? 0) >= 120)
        #expect(CLICommand.status.timeout == 30)
        #expect(CLICommand.tagsAdd(tag: "@a", apps: []).isMutation)
        #expect(!CLICommand.status.isMutation)
        #expect(!CLICommand.updateCheck.isMutation)
    }
}

@Suite("Tag validation")
struct TagValidationTests {
    @Test(arguments: [
        ("@s4", "@s4"),
        ("s4", "@s4"),
        ("@Pronto", "@pronto"),
        ("  @Work_Bot-2 \n", "@work_bot-2"),
        ("_", "@_"),
        (String(repeating: "a", count: 32), "@" + String(repeating: "a", count: 32)),
        ("@" + String(repeating: "Z", count: 32), "@" + String(repeating: "z", count: 32)),
    ])
    func valid(input: String, normalized: String) {
        #expect(TagValidation.normalize(input) == .success(normalized))
        #expect(TagValidation.isValid(input))
    }

    @Test(arguments: [
        ("", TagValidation.Failure.empty),
        ("@", .empty),
        ("   ", .empty),
        (String(repeating: "a", count: 33), .tooLong),
        ("@with space", .invalidCharacters),
        ("@@double", .invalidCharacters),
        ("@émoji", .invalidCharacters),
        ("@a.b", .invalidCharacters),
        ("@ｓ4", .invalidCharacters),
        ("a@b", .invalidCharacters),
    ])
    func invalid(input: String, failure: TagValidation.Failure) {
        #expect(TagValidation.normalize(input) == .failure(failure))
        #expect(!TagValidation.isValid(input))
    }

    @Test func matchesCLIRegex() throws {
        let regex = try Regex("^@?[A-Za-z0-9_-]{1,32}$")
        let samples = ["@a", "a", "@-", "@a-b_c", "@" + String(repeating: "x", count: 32), "@" + String(repeating: "x", count: 33),
                       "", "@", "@ a", "@a!", "ab@", "@Ä", "@a\n"]
        for sample in samples {
            #expect(TagValidation.isValid(sample) == (sample.wholeMatch(of: regex) != nil || sample == "@a\n"), "\(sample)")
        }
    }

    @Test func failureMessagesAreHuman() {
        #expect(TagValidation.Failure.empty.message.contains("tag name"))
        #expect(TagValidation.Failure.tooLong.message.contains("32"))
    }
}

@Suite("Phone validation")
struct PhoneValidationTests {
    @Test func normalizes() {
        #expect(PhoneValidation.normalize("+1 (555) 123-4567") == "+15551234567")
        #expect(PhoneValidation.normalize("44 20 7946 0958") == "442079460958")
        #expect(PhoneValidation.normalize("+49.30.1234567") == "+49301234567")
    }

    @Test func rejects() {
        #expect(PhoneValidation.normalize("") == nil)
        #expect(PhoneValidation.normalize("12345") == nil)
        #expect(PhoneValidation.normalize("+1234567890123456") == nil)
        #expect(PhoneValidation.normalize("555-CALL-NOW") == nil)
        #expect(PhoneValidation.normalize("++15551234567") == nil)
        #expect(PhoneValidation.normalize("--phone") == nil)
    }
}
