package com.llmwiki.ui.auth

import android.content.Context
import android.content.Intent
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.llmwiki.BuildConfig
import com.llmwiki.data.requireAccessToken
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
    data object Restoring : AuthState
    data object Loading : AuthState
    data class Success(val workspaceId: String?, val accountName: String) : AuthState
    data class Error(val message: String) : AuthState
}

class AuthViewModel : ViewModel() {

    private val _state = MutableStateFlow<AuthState>(AuthState.Idle)
    val state: StateFlow<AuthState> = _state
    private var restoreAttempted = false

    private fun buildGoogleSignInOptions(): GoogleSignInOptions {
        val googleClientId = BuildConfig.GOOGLE_CLIENT_ID.trim()
        return GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(googleClientId)
            .requestEmail()
            .build()
    }

    fun restoreSessionIfPossible() {
        if (restoreAttempted) return
        restoreAttempted = true

        viewModelScope.launch {
            _state.value = AuthState.Restoring
            try {
                val supabase = SupabaseClientProvider.client
                supabase.auth.awaitInitialization()
                val session = supabase.auth.currentSessionOrNull()
                if (session != null) {
                    supabase.requireAccessToken(forceRefresh = true)
                }
                val refreshedSession = supabase.auth.currentSessionOrNull()
                val user = refreshedSession?.user
                if (refreshedSession == null || user?.email.isNullOrBlank()) {
                    _state.value = AuthState.Idle
                    return@launch
                }

                val workspaces = supabase
                    .from("workspaces")
                    .select()
                    .decodeList<com.llmwiki.data.WorkspaceRow>()

                _state.value = AuthState.Success(
                    workspaceId = workspaces.firstOrNull()?.id,
                    accountName = user?.email.orEmpty(),
                )
            } catch (_: Exception) {
                _state.value = AuthState.Idle
            }
        }
    }

    fun createGoogleSignInIntent(context: Context): Intent? {
        val googleClientId = BuildConfig.GOOGLE_CLIENT_ID.trim()
        if (googleClientId.isBlank()) {
            _state.value = AuthState.Error("Missing Google Web Client ID. Rebuild the Android app with GOOGLE_CLIENT_ID or GOOGLE_OAUTH_CLIENT_ID configured.")
            return null
        }

        _state.value = AuthState.Loading
        return GoogleSignIn.getClient(context, buildGoogleSignInOptions()).signInIntent
    }

    fun clearGoogleSignInSession(context: Context, onCleared: () -> Unit) {
        GoogleSignIn.getClient(context, buildGoogleSignInOptions())
            .signOut()
            .addOnCompleteListener { onCleared() }
    }

    fun handleGoogleSignInResult(data: Intent?) {
        viewModelScope.launch {
            try {
                val account = GoogleSignIn.getSignedInAccountFromIntent(data)
                    .getResult(ApiException::class.java)
                val idToken = account.idToken
                if (idToken.isNullOrBlank()) {
                    _state.value = AuthState.Error("Google sign-in did not return an ID token. Verify GOOGLE_CLIENT_ID is the Web OAuth client ID.")
                    return@launch
                }

                val supabase = SupabaseClientProvider.client
                supabase.auth.signInWith(IDToken) {
                    this.idToken = idToken
                    provider = Google
                }

                val workspaces = supabase
                    .from("workspaces")
                    .select()
                    .decodeList<com.llmwiki.data.WorkspaceRow>()

                _state.value = AuthState.Success(
                    workspaceId = workspaces.firstOrNull()?.id,
                    accountName = account.email ?: account.account?.name.orEmpty(),
                )
            } catch (e: ApiException) {
                _state.value = AuthState.Error(
                    "Google sign-in failed (${e.statusCode}). Verify the Android OAuth client package com.llmwiki and this build's SHA-1 in Google Cloud Console."
                )
            } catch (e: Exception) {
                _state.value = AuthState.Error(e.message ?: "Unknown error")
            }
        }
    }
}
