import Capacitor
import AuthenticationServices
import Security

/**
 * The member's Nostr key in their password manager: iCloud Keychain (the
 * Passwords app), saved as a password for the BIES domain with the npub as
 * the username. The app's side is src/services/savedKey.js; Android's is
 * SavedKeyPlugin.java.
 *
 * Both calls need the app and the domain to vouch for each other: the
 * webcredentials entry in App.entitlements, and the domain's
 * /.well-known/apple-app-site-association listing this app.
 */
@objc(SavedKeyPlugin)
public class SavedKeyPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "SavedKeyPlugin"
    public let jsName = "SavedKey"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    static let domain = "app.buildinelsalvador.com"

    // A get() in flight: the controller must outlive performRequests().
    private var pendingGet: CAPPluginCall?
    private var controller: ASAuthorizationController?
    // With no keys to show, iOS fails at once as "canceled", the same answer
    // as a member closing the sheet. Only the time taken tells them apart:
    // nobody opens and closes the sheet within a second.
    private var startedAt = Date()

    /// iOS asks the member to confirm, then saves. Resolves { saved }.
    @objc func save(_ call: CAPPluginCall) {
        guard let username = call.getString("username"), let password = call.getString("password") else {
            call.reject("username and password are required")
            return
        }
        SecAddSharedWebCredential(Self.domain as CFString, username as CFString, password as CFString) { error in
            if let error = error {
                let code = CFErrorGetCode(error)
                call.resolve([
                    "saved": false,
                    "cancelled": code == Int(errSecUserCanceled),
                    "error": "\(code)",
                ])
            } else {
                call.resolve(["saved": true])
            }
        }
    }

    /// iOS shows the saved keys for the domain and the member picks one.
    /// Resolves { found, username, password }, or { found: false } when there
    /// is none or the member closed the sheet.
    @objc func get(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let previous = self.pendingGet {
                previous.resolve(["found": false, "cancelled": true])
            }
            let request = ASAuthorizationPasswordProvider().createRequest()
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.pendingGet = call
            self.controller = controller
            self.startedAt = Date()
            controller.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController,
                                        didCompleteWithAuthorization authorization: ASAuthorization) {
        if let credential = authorization.credential as? ASPasswordCredential {
            pendingGet?.resolve(["found": true, "username": credential.user, "password": credential.password])
        } else {
            pendingGet?.resolve(["found": false])
        }
        pendingGet = nil
        self.controller = nil
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let code = (error as? ASAuthorizationError)?.code
        let elapsed = Date().timeIntervalSince(startedAt)
        pendingGet?.resolve([
            "found": false,
            "cancelled": code == .canceled && elapsed >= 1,
            "error": "\((error as NSError).code)",
        ])
        pendingGet = nil
        self.controller = nil
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return bridge?.webView?.window ?? ASPresentationAnchor()
    }
}
