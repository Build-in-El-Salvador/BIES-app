package com.bies.app;

import android.os.CancellationSignal;

import androidx.core.content.ContextCompat;
import androidx.credentials.CreateCredentialResponse;
import androidx.credentials.CreatePasswordRequest;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.GetPasswordOption;
import androidx.credentials.PasswordCredential;
import androidx.credentials.exceptions.CreateCredentialCancellationException;
import androidx.credentials.exceptions.CreateCredentialException;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The member's Nostr key in their password manager (Google Password Manager,
 * or another provider such as 1Password on Android 14+), through Credential
 * Manager, with the npub as the username. The app's side is
 * src/services/savedKey.js; iOS's is SavedKeyPlugin.swift.
 */
@CapacitorPlugin(name = "SavedKey")
public class SavedKeyPlugin extends Plugin {

    /** Android asks the member to confirm, then saves. Resolves { saved }. */
    @PluginMethod
    public void save(PluginCall call) {
        String username = call.getString("username");
        String password = call.getString("password");
        if (username == null || password == null) {
            call.reject("username and password are required");
            return;
        }
        CredentialManager.create(getContext()).createCredentialAsync(
            getActivity(),
            new CreatePasswordRequest(username, password),
            new CancellationSignal(),
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<CreateCredentialResponse, CreateCredentialException>() {
                @Override
                public void onResult(CreateCredentialResponse response) {
                    JSObject result = new JSObject();
                    result.put("saved", true);
                    call.resolve(result);
                }

                @Override
                public void onError(CreateCredentialException e) {
                    JSObject result = new JSObject();
                    result.put("saved", false);
                    result.put("cancelled", e instanceof CreateCredentialCancellationException);
                    result.put("error", e.getType());
                    call.resolve(result);
                }
            }
        );
    }

    /**
     * Android shows the saved keys and the member picks one. Resolves
     * { found, username, password }, or { found: false } when there is none
     * or the member closed the sheet.
     */
    @PluginMethod
    public void get(PluginCall call) {
        GetCredentialRequest request = new GetCredentialRequest.Builder()
            .addCredentialOption(new GetPasswordOption())
            .build();
        CredentialManager.create(getContext()).getCredentialAsync(
            getActivity(),
            request,
            new CancellationSignal(),
            ContextCompat.getMainExecutor(getContext()),
            new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                @Override
                public void onResult(GetCredentialResponse response) {
                    JSObject result = new JSObject();
                    Credential credential = response.getCredential();
                    if (credential instanceof PasswordCredential) {
                        PasswordCredential password = (PasswordCredential) credential;
                        result.put("found", true);
                        result.put("username", password.getId());
                        result.put("password", password.getPassword());
                    } else {
                        result.put("found", false);
                    }
                    call.resolve(result);
                }

                @Override
                public void onError(GetCredentialException e) {
                    JSObject result = new JSObject();
                    result.put("found", false);
                    result.put("cancelled", e instanceof GetCredentialCancellationException);
                    result.put("error", e.getType());
                    call.resolve(result);
                }
            }
        );
    }
}
