// Shows the system owner-presence dialog (Touch ID, or the login password) with the reason
// given as the first argument. Prints a proof id on success; exits non-zero on cancel, on
// error and when there is no GUI session.
import Foundation
import LocalAuthentication

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write(Data("usage: owner-presence <reason>\n".utf8))
    exit(64)
}

let context = LAContext()
var policyError: NSError?
guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
    FileHandle.standardError.write(Data("owner presence unavailable: \(policyError?.localizedDescription ?? "unknown")\n".utf8))
    exit(2)
}

let done = DispatchSemaphore(value: 0)
var granted = false
context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: CommandLine.arguments[1]) { ok, _ in
    granted = ok
    done.signal()
}
done.wait()

if granted {
    print(UUID().uuidString.lowercased())
    exit(0)
}
exit(1)
