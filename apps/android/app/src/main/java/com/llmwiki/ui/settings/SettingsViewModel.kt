package com.llmwiki.ui.settings

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.llmwiki.R
import com.llmwiki.BuildConfig
import com.llmwiki.data.AndroidHttpClient
import com.llmwiki.data.AppLanguage
import com.llmwiki.data.AppPreferencesRepository
import com.llmwiki.data.LlmProfile
import com.llmwiki.data.LlmProfileRepository
import com.llmwiki.data.ProfileAuthRequiredException
import com.llmwiki.data.requireAccessToken
import com.llmwiki.data.SupabaseClientProvider
import com.llmwiki.data.ThemeMode
import io.github.jan.supabase.auth.auth
import io.ktor.client.request.delete
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class SettingsUiState(
    val profiles: List<LlmProfile> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val createLoading: Boolean = false,
    val accountEmail: String = "",
    val accountId: String = "",
    val themeMode: ThemeMode = ThemeMode.SYSTEM,
    val language: AppLanguage = AppLanguage.SYSTEM,
)

private val settingsJson = Json { ignoreUnknownKeys = true }

class SettingsViewModel(application: Application) : AndroidViewModel(application) {

    private val supabase = SupabaseClientProvider.client
    private val preferencesRepository = AppPreferencesRepository(application)
    private val profileRepository = LlmProfileRepository(supabase)
    private val settingsState = MutableStateFlow(
        SettingsUiState(
            accountEmail = supabase.auth.currentSessionOrNull()?.user?.email.orEmpty(),
            accountId = supabase.auth.currentSessionOrNull()?.user?.id.orEmpty(),
        )
    )

    val uiState: StateFlow<SettingsUiState> = combine(
        settingsState,
        preferencesRepository.themeMode,
        preferencesRepository.language,
    ) { base, themeMode, language ->
        base.copy(themeMode = themeMode, language = language)
    }.stateIn(viewModelScope, kotlinx.coroutines.flow.SharingStarted.WhileSubscribed(5_000), settingsState.value)

    init {
        loadProfiles()
    }

    fun loadProfiles() {
        viewModelScope.launch {
            settingsState.update { it.copy(loading = true, error = null) }
            try {
                val profiles = profileRepository.listProfiles()
                settingsState.update {
                    it.copy(
                        profiles = profiles,
                        loading = false,
                        error = null,
                    )
                }
            } catch (_: ProfileAuthRequiredException) {
                settingsState.update { it.copy(loading = false, error = unauthorizedMessage()) }
            } catch (e: Exception) {
                settingsState.update {
                    it.copy(
                        loading = false,
                        error = e.toUserFacingMessage("Failed to load profiles"),
                    )
                }
            }
        }
    }

    fun setThemeMode(value: ThemeMode) {
        viewModelScope.launch {
            preferencesRepository.setThemeMode(value)
        }
    }

    fun setLanguage(value: AppLanguage) {
        viewModelScope.launch {
            preferencesRepository.setLanguage(value)
        }
    }

    fun createProfile(
        name: String,
        baseUrl: String,
        apiKey: String,
        model: String,
        isDefault: Boolean,
        onDone: (Boolean) -> Unit,
    ) {
        viewModelScope.launch {
            var accessToken = supabase.requireAccessToken(forceRefresh = true)
                ?: run {
                    settingsState.update { it.copy(error = unauthorizedMessage()) }
                    onDone(false)
                    return@launch
                }
            settingsState.update { it.copy(createLoading = true, error = null) }
            try {
                val bodyJson = buildJsonObject {
                    put("name", name)
                    put("base_url", baseUrl)
                    put("api_key", apiKey)
                    put("model", model)
                    put("is_default", isDefault)
                }.toString()
                var response = AndroidHttpClient.instance.post(webApiUrl("/api/settings/profiles")) {
                    header("Authorization", "Bearer $accessToken")
                    contentType(ContentType.Application.Json)
                    setBody(bodyJson)
                }
                if (response.status.value == 401) {
                    accessToken = supabase.requireAccessToken(forceRefresh = true) ?: accessToken
                    response = AndroidHttpClient.instance.post(webApiUrl("/api/settings/profiles")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                }
                val text = response.bodyAsText()
                val ok = response.status.value in 200..299 && isJsonObject(text)
                settingsState.update {
                    it.copy(
                        createLoading = false,
                        error = if (ok) null else parseApiError(text, "Failed to save profile"),
                    )
                }
                if (ok) loadProfiles()
                onDone(ok)
            } catch (e: Exception) {
                settingsState.update {
                    it.copy(
                        createLoading = false,
                        error = e.toUserFacingMessage("Failed to save profile"),
                    )
                }
                onDone(false)
            }
        }
    }

    fun deleteProfile(id: String) {
        viewModelScope.launch {
            try {
                var accessToken = supabase.requireAccessToken(forceRefresh = true) ?: return@launch
                var response = AndroidHttpClient.instance.delete(webApiUrl("/api/settings/profiles?id=$id")) {
                    header("Authorization", "Bearer $accessToken")
                }
                if (response.status.value == 401) {
                    accessToken = supabase.requireAccessToken(forceRefresh = true) ?: accessToken
                    response = AndroidHttpClient.instance.delete(webApiUrl("/api/settings/profiles?id=$id")) {
                        header("Authorization", "Bearer $accessToken")
                    }
                }
                val text = response.bodyAsText()
                if (response.status.value in 200..299 && isJsonObject(text)) {
                    loadProfiles()
                } else {
                    settingsState.update {
                        it.copy(error = parseApiError(text, "Failed to delete profile"))
                    }
                }
            } catch (e: Exception) {
                settingsState.update { it.copy(error = e.toUserFacingMessage("Failed to delete profile")) }
            }
        }
    }

    private fun parseApiError(raw: String, fallback: String): String {
        if (raw.isBlank()) return fallback
        if (isHtmlResponse(raw)) return nonJsonApiMessage(fallback)
        return runCatching {
            val error = settingsJson.decodeFromString<Map<String, String>>(raw)["error"]
                ?.takeIf { it.isNotBlank() }
                ?: fallback
            if (error == "Unauthorized") unauthorizedMessage() else error
        }.getOrElse {
            if (raw.trim().equals("Unauthorized", ignoreCase = true)) unauthorizedMessage() else raw
        }
    }

    private fun isJsonObject(raw: String): Boolean =
        raw.trimStart().startsWith("{")

    private fun isHtmlResponse(raw: String): Boolean {
        val trimmed = raw.trimStart()
        return trimmed.startsWith("<!DOCTYPE", ignoreCase = true) ||
            trimmed.startsWith("<html", ignoreCase = true)
    }

    private fun nonJsonApiMessage(fallback: String): String =
        "$fallback: ${getApplication<Application>().getString(R.string.error_api_not_json)}"

    private fun unauthorizedMessage(): String =
        getApplication<Application>().getString(R.string.error_unauthorized)

    private fun Throwable.toUserFacingMessage(fallback: String): String {
        val detail = message ?: return fallback
        return if (
            detail.contains("Unauthorized", ignoreCase = true) ||
            detail.contains("JWT", ignoreCase = true) ||
            detail.contains("auth", ignoreCase = true)
        ) {
            unauthorizedMessage()
        } else if (
            detail.contains("timeout", ignoreCase = true) ||
            detail.contains("timed out", ignoreCase = true) ||
            detail.contains("Unable to resolve host", ignoreCase = true) ||
            detail.contains("Software caused connection abort", ignoreCase = true)
        ) {
            getApplication<Application>().getString(R.string.error_network_timeout)
        } else {
            detail
        }
    }

    private fun webApiUrl(path: String) = BuildConfig.WEB_API_BASE_URL.trimEnd('/') + path
}
