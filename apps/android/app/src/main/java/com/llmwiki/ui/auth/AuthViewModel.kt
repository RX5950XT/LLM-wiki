package com.llmwiki.ui.auth

import android.app.Application
import android.content.Context
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.llmwiki.BuildConfig
import com.llmwiki.R
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
    data object Loading : AuthState
    data class Success(val workspaceId: String?, val accountName: String) : AuthState
    data class Error(val message: String) : AuthState
}

class AuthViewModel(application: Application) : AndroidViewModel(application) {

    private val _state = MutableStateFlow<AuthState>(AuthState.Idle)
    val state: StateFlow<AuthState> = _state

    private fun buildGoogleSignInOptions(): GoogleSignInOptions {
        val googleClientId = BuildConfig.GOOGLE_CLIENT_ID.trim()
        return GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(googleClientId)
            .requestEmail()
            .build()
    }

    fun createGoogleSignInIntent(context: Context): Intent? {
        val googleClientId = BuildConfig.GOOGLE_CLIENT_ID.trim()
        if (googleClientId.isBlank()) {
            _state.value = AuthState.Error(
                getApplication<Application>().getString(R.string.auth_missing_google_client_id)
            )
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
                    _state.value = AuthState.Error(
                        getApplication<Application>().getString(R.string.auth_missing_id_token)
                    )
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
                    getApplication<Application>().getString(R.string.auth_google_sign_in_failed, e.statusCode)
                )
            } catch (e: Exception) {
                _state.value = AuthState.Error(e.message ?: "Unknown error")
            }
        }
    }
}
