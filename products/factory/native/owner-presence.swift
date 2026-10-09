// Owner presence for titan-factory.
// With one argument, the reason, it shows the system dialog (Touch ID, or the login password) and
// prints a proof id; it exits non-zero on cancel, on error and when there is no GUI session.
// keygen, pubkey and sign manage a Secure Enclave P-256 key; every signature needs that same dialog.
// The private key never leaves the enclave: the key file holds CryptoKit's dataRepresentation, an
// opaque blob that only this Mac's enclave can use. Tags name key files, so a throwaway probe key
// never touches the owner key.
import CryptoKit
import Foundation
import LocalAuthentication
import Security

enum Exit: Int32 {
    case denied = 1, unavailable = 2, missingKey = 3, keyExists = 4, failed = 5, usage = 64
}

let usage = """
    usage: owner-presence <reason>
           owner-presence keygen [--tag <tag>] [--replace]
           owner-presence pubkey [--tag <tag>] [--id]
           owner-presence sign [--tag <tag>] [--] <reason>    (statement bytes on stdin)
    """

func fail(_ code: Exit, _ message: String) -> Never {
    FileHandle.standardError.write(Data("owner-presence: \(message)\n".utf8))
    exit(code.rawValue)
}

struct Invocation {
    var tag = "owner-key"
    var flags = Set<String>()
    var positional: [String] = []
}

func isValidTag(_ tag: String) -> Bool {
    let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
    return (1...32).contains(tag.count) && tag.first != "-" && tag.allSatisfy { allowed.contains($0) }
}

func parse(_ args: ArraySlice<String>, flags: Set<String>) -> Invocation {
    var invocation = Invocation()
    var rest = args
    while let arg = rest.popFirst() {
        if arg == "--" {
            invocation.positional.append(contentsOf: rest)
            break
        } else if arg == "--tag" {
            guard let tag = rest.popFirst(), isValidTag(tag) else { fail(.usage, "--tag takes 1-32 of [a-z0-9-], not starting with -") }
            invocation.tag = tag
        } else if flags.contains(arg) {
            invocation.flags.insert(arg)
        } else if arg.hasPrefix("--") {
            fail(.usage, "unknown option \(arg)\n\(usage)")
        } else {
            invocation.positional.append(arg)
        }
    }
    return invocation
}

func keyURL(tag: String) -> URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("titan-factory", isDirectory: true).appendingPathComponent("\(tag).se")
}

@available(macOS 11, *)
func keyId(_ publicKey: P256.Signing.PublicKey) -> String {
    String(SHA256.hash(data: publicKey.derRepresentation).map { String(format: "%02x", $0) }.joined().prefix(16))
}

func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

func requireDialog(_ context: LAContext) {
    var policyError: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
        fail(.unavailable, "owner presence unavailable: \(policyError?.localizedDescription ?? "unknown")")
    }
}

// O_EXCL refuses an existing file or symlink, so only --replace, which unlinks first, overwrites a key.
func writeKey(_ blob: Data, to url: URL, replace: Bool) {
    let dir = url.deletingLastPathComponent()
    do {
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    } catch {
        fail(.failed, "cannot create \(dir.path): \(error.localizedDescription)")
    }
    if replace { unlink(url.path) }
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else {
        if errno == EEXIST { fail(.keyExists, "\(url.path) exists; pass --replace to overwrite it") }
        fail(.failed, "cannot create \(url.path): \(String(cString: strerror(errno)))")
    }
    defer { close(fd) }
    let written = blob.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
    guard written == blob.count else { fail(.failed, "short write to \(url.path)") }
}

@available(macOS 11, *)
func loadKey(tag: String, context: LAContext? = nil) -> SecureEnclave.P256.Signing.PrivateKey {
    let url = keyURL(tag: tag)
    guard let blob = try? Data(contentsOf: url) else { fail(.missingKey, "no key at \(url.path); run owner-presence keygen") }
    do {
        return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
    } catch {
        fail(.missingKey, "\(url.path) is not a Secure Enclave key of this Mac: \(error.localizedDescription)")
    }
}

@available(macOS 11, *)
func keygen(_ invocation: Invocation) {
    guard invocation.positional.isEmpty else { fail(.usage, usage) }
    let url = keyURL(tag: invocation.tag)
    let replace = invocation.flags.contains("--replace")
    if !replace && FileManager.default.fileExists(atPath: url.path) { fail(.keyExists, "\(url.path) exists; pass --replace to overwrite it") }
    guard SecureEnclave.isAvailable else { fail(.unavailable, "this Mac has no Secure Enclave") }
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &accessError) else {
        fail(.failed, "access control: \(accessError.map { ($0.takeRetainedValue() as Error).localizedDescription } ?? "unknown")")
    }
    do {
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        writeKey(key.dataRepresentation, to: url, replace: replace)
        print(keyId(key.publicKey))
    } catch {
        fail(.failed, "keygen: \(error.localizedDescription)")
    }
}

@available(macOS 11, *)
func pubkey(_ invocation: Invocation) {
    guard invocation.positional.isEmpty else { fail(.usage, usage) }
    let publicKey = loadKey(tag: invocation.tag).publicKey
    print(invocation.flags.contains("--id") ? keyId(publicKey) : publicKey.pemRepresentation)
}

// CryptoKit hashes with SHA-256 before the enclave signs, so the output is ECDSA P-256 SHA-256 over the exact stdin bytes.
@available(macOS 11, *)
func sign(_ invocation: Invocation) {
    guard invocation.positional.count == 1 else { fail(.usage, usage) }
    let statement = FileHandle.standardInput.readDataToEndOfFile()
    guard !statement.isEmpty else { fail(.usage, "no statement bytes on stdin") }
    let context = LAContext()
    context.localizedReason = invocation.positional[0]
    requireDialog(context)
    let key = loadKey(tag: invocation.tag, context: context)
    do {
        let signature = try key.signature(for: statement)
        print(base64url(signature.derRepresentation))
    } catch {
        fail(.denied, "not signed: \(error.localizedDescription)")
    }
}

func confirmPresence(reason: String) {
    let context = LAContext()
    requireDialog(context)
    let done = DispatchSemaphore(value: 0)
    var granted = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in
        granted = ok
        done.signal()
    }
    done.wait()
    guard granted else { exit(Exit.denied.rawValue) }
    print(UUID().uuidString.lowercased())
}

// CryptoKit's DER and PEM encodings need macOS 11; swiftc's default deployment target is older.
let args = CommandLine.arguments.dropFirst()
if #available(macOS 11, *) {
    switch args.first {
    case "keygen"?: keygen(parse(args.dropFirst(), flags: ["--replace"]))
    case "pubkey"?: pubkey(parse(args.dropFirst(), flags: ["--id"]))
    case "sign"?: sign(parse(args.dropFirst(), flags: []))
    case let reason? where args.count == 1: confirmPresence(reason: reason)
    default: fail(.usage, usage)
    }
} else {
    fail(.unavailable, "owner-presence needs macOS 11 or later")
}
