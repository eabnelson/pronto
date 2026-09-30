import Foundation
import Testing
@testable import ProntoMenuBarKit

@Suite("WhatsApp link NDJSON")
struct LinkEventTests {
    @Test func parsesDocumentedEvents() throws {
        #expect(try LinkEvent.parse(line: #"{"event":"qr","code":"2@..."}"#) == .qr(code: "2@..."))
        #expect(try LinkEvent.parse(line: #"{"event":"pairing_code","code":"ABCD-EFGH"}"#) == .pairingCode(code: "ABCD-EFGH"))
        #expect(try LinkEvent.parse(line: #"{"event":"syncing"}"#) == .syncing)
        #expect(try LinkEvent.parse(line: #"{"event":"linked"}"#) == .linked)
        #expect(try LinkEvent.parse(line: #"{"event":"error","reason":"consent-required","message":"..."}"#)
                == .error(reason: "consent-required", message: "..."))
    }

    @Test func blankLinesAreSkipped() throws {
        #expect(try LinkEvent.parse(line: "") == nil)
        #expect(try LinkEvent.parse(line: "   \r") == nil)
    }

    @Test func unknownEventsAreTolerated() throws {
        #expect(try LinkEvent.parse(line: #"{"event":"progress","percent":40}"#) == .unknown(event: "progress"))
    }

    @Test func plainCLIErrorBecomesErrorEvent() throws {
        #expect(try LinkEvent.parse(line: #"{"error":"wacli is not installed"}"#) == .error(reason: nil, message: "wacli is not installed"))
    }

    @Test func malformedLinesThrow() throws {
        #expect(throws: CLIError.self) { try LinkEvent.parse(line: "not json") }
        #expect(throws: CLIError.self) { try LinkEvent.parse(line: #"{"event":"qr"}"#) }
        #expect(throws: CLIError.self) { try LinkEvent.parse(line: #"{"code":"x"}"#) }
    }

    @Test func terminalEvents() throws {
        #expect(LinkEvent.linked.isTerminal)
        #expect(LinkEvent.error(reason: nil, message: nil).isTerminal)
        #expect(!LinkEvent.syncing.isTerminal)
        #expect(!LinkEvent.qr(code: "x").isTerminal)
    }

    @Test func fixtureStreamsParse() throws {
        func parseAll(_ name: String) throws -> [LinkEvent] {
            var buffer = NDJSONLineBuffer()
            var lines = buffer.append(Fixture.data(name))
            if let rest = buffer.finish() { lines.append(rest) }
            return try lines.compactMap { try LinkEvent.parse(line: $0) }
        }
        #expect(try parseAll("link-qr.ndjson") == [.qr(code: "2@first-qr-code"), .qr(code: "2@second-qr-code"), .syncing, .linked])
        #expect(try parseAll("link-phone.ndjson") == [.pairingCode(code: "ABCD-EFGH"), .syncing, .linked])
        #expect(try parseAll("link-consent-required.ndjson").first == .error(reason: "consent-required", message: "Pass --accept-risk after showing the WhatsApp disclosure."))
    }
}

@Suite("NDJSON line buffer")
struct NDJSONLineBufferTests {
    @Test func splitsCompleteLines() throws {
        var buffer = NDJSONLineBuffer()
        let lines = buffer.append(Data("{\"a\":1}\n{\"b\":2}\n".utf8))
        #expect(lines.map { String(decoding: $0, as: UTF8.self) } == ["{\"a\":1}", "{\"b\":2}"])
        #expect(buffer.finish() == nil)
    }

    @Test func buffersPartialLinesAcrossChunks() throws {
        var buffer = NDJSONLineBuffer()
        #expect(buffer.append(Data("{\"event\":".utf8)).isEmpty)
        #expect(buffer.append(Data("\"qr\",\"code\":\"x\"".utf8)).isEmpty)
        let lines = buffer.append(Data("}\n{\"event\"".utf8))
        #expect(lines.count == 1)
        #expect(try LinkEvent.parse(line: lines[0]) == .qr(code: "x"))
        #expect(buffer.append(Data(":\"linked\"}".utf8)).isEmpty)
        let rest = buffer.finish()
        #expect(rest.map { try? LinkEvent.parse(line: $0) } == .linked)
    }

    @Test func byteAtATime() throws {
        let text = String(decoding: Fixture.data("link-qr.ndjson"), as: UTF8.self)
        var buffer = NDJSONLineBuffer()
        var events: [LinkEvent] = []
        for byte in Data(text.utf8) {
            for line in buffer.append(Data([byte])) {
                if let event = try LinkEvent.parse(line: line) { events.append(event) }
            }
        }
        #expect(events.count == 4)
        #expect(events.last == .linked)
    }

    @Test func handlesCRLFAndBlankLines() throws {
        var buffer = NDJSONLineBuffer()
        let lines = buffer.append(Data("{\"event\":\"linked\"}\r\n\r\n\n".utf8))
        #expect(lines.count == 3)
        #expect(String(decoding: lines[0], as: UTF8.self) == "{\"event\":\"linked\"}")
        #expect(lines[1].isEmpty && lines[2].isEmpty)
    }

    @Test func multibyteCharactersSplitAcrossChunks() throws {
        let line = Data(#"{"event":"error","message":"café ☕️"}"#.utf8) + Data([0x0A])
        var buffer = NDJSONLineBuffer()
        let mid = line.count - 5
        #expect(buffer.append(line.prefix(mid)).isEmpty)
        let lines = buffer.append(line.suffix(from: mid))
        #expect(try LinkEvent.parse(line: lines[0]) == .error(reason: nil, message: "café ☕️"))
    }

    @Test func dropsRunawayLines() throws {
        var buffer = NDJSONLineBuffer(maxLineLength: 8)
        #expect(buffer.append(Data("0123456789".utf8)).isEmpty)
        #expect(buffer.finish() == nil)
    }
}
