package com.llmwiki.ui.auth

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import com.llmwiki.BuildConfig
import com.llmwiki.data.SupabaseClientProvider
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.auth.providers.Google
import io.github.jan.supabase.auth.providers.builtin.IDToken
import io.github.jan.supabase.postgrest.from
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

sealed interface AuthState {
    data object Idle : AuthState
    data object Loading : AuthState
    data class Success(val workspaceId: String?, val accountName: String) : AuthState
    data class Error(val message: String) : AuthState
}

class AuthViewModel : ViewModel() {

    private val _state = MutableStateFlow<AuthState>(AuthState.Idle)
    val state: StateFlow<AuthState> = _state

    fun signInWithGoogle(context: Context) {
        viewModelScope.launch {
            _state.value = AuthState.Loading
            try {
                val credentialManager = CredentialManager.create(context)

                val googleIdOption = GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(false)
                    .setServerClientId(BuildConfig.GOOGLE_CLIENT_ID)
                    .setAutoSelectEnabled(false)
                    .build()

                val request = GetCredentialRequest.Builder()
                    .addCredentialOption(googleIdOption)
                    .build()

                val result = credentialManager.getCredential(context, request)
                val credential = result.credential

                if (credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    val googleCredential = GoogleIdTokenCredential.createFrom(credential.data)

                    val supabase = SupabaseClientProvider.client
                    supabase.auth.signInWith(IDToken) {
                        idToken = googleCredential.idToken
                        provider = Google
                    }

                    // Fetch first workspace
                    val workspaces = supabase
                        .from("workspaces")
                        .select()
                        .decodeList<com.llmwiki.data.WorkspaceRow>()

                    // googleCredential.id is the email — used as GoogleAccountCredential account name
                    _state.value = AuthState.Success(
                        workspaceId = workspaces.firstOrNull()?.id,
                        accountName = googleCredential.id,
                    )
                } else {
                    _state.value = AuthState.Error("Unexpected credential type")
                }
            } catch (e: GetCredentialException) {
                _state.value = AuthState.Error(e.message ?: "Sign-in cancelled")
            } catch (e: Exception) {
                _state.value = AuthState.Error(e.message ?: "Unknown error")
            }
        }
    }
}
