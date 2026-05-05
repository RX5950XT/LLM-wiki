package com.llmwiki.ui.workspace

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.llmwiki.R
import com.llmwiki.BuildConfig
import com.llmwiki.data.AndroidHttpClient
import com.llmwiki.data.buildDriveReconnectUrl
import com.llmwiki.data.isDriveReconnectError
import com.llmwiki.data.requireAccessToken
import com.llmwiki.data.SupabaseClientProvider
import io.github.jan.supabase.auth.auth
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

data class WorkspaceCreateUiState(
    val name: String = "My Wiki",
    val submitting: Boolean = false,
    val error: String? = null,
    val driveReconnectUrl: String? = null,
    val createdWorkspaceId: String? = null,
)

private val workspaceJson = Json { ignoreUnknownKeys = true }

class WorkspaceCreateViewModel(application: Application) : AndroidViewModel(application) {

    private val supabase = SupabaseClientProvider.client
    private val _uiState = MutableStateFlow(WorkspaceCreateUiState())
    val uiState: StateFlow<WorkspaceCreateUiState> = _uiState

    fun updateName(value: String) {
        _uiState.update { it.copy(name = value) }
    }

    fun createWorkspace() {
        val current = _uiState.value
        if (current.submitting || current.name.isBlank()) return

        viewModelScope.launch {
            var accessToken = supabase.requireAccessToken(forceRefresh = true) ?: run {
                _uiState.update { it.copy(error = unauthorizedMessage()) }
                return@launch
            }

            _uiState.update { it.copy(submitting = true, error = null) }

            try {
                var response = AndroidHttpClient.instance.post(webApiUrl("/api/workspaces")) {
                    header("Authorization", "Bearer $accessToken")
                    contentType(ContentType.Application.Json)
                    setBody(buildJsonObject {
                        put("name", _uiState.value.name.trim())
                    }.toString())
                }
                if (response.status.value == 401) {
                    accessToken = supabase.requireAccessToken(forceRefresh = true) ?: accessToken
                    response = AndroidHttpClient.instance.post(webApiUrl("/api/workspaces")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(buildJsonObject {
                            put("name", _uiState.value.name.trim())
                        }.toString())
                    }
                }
                val text = response.bodyAsText()

                if (response.status.value !in 200..299) {
                    val message = parseApiError(text, "Failed to create workspace")

                    _uiState.update {
                        it.copy(
                            submitting = false,
                            error = message,
                            driveReconnectUrl = if (
                                response.status.value == 403 && isDriveReconnectError(message)
                            ) buildDriveReconnectUrl("workspace-create") else null,
                        )
                    }
                    return@launch
                }
                if (!isJsonObject(text)) {
                    _uiState.update {
                        it.copy(
                            submitting = false,
                            error = nonJsonApiMessage("Failed to create workspace"),
                        )
                    }
                    return@launch
                }

                val workspaceId = workspaceJson.decodeFromString<Map<String, String>>(text)["id"]
                if (workspaceId.isNullOrBlank()) {
                    _uiState.update {
                        it.copy(submitting = false, error = "Missing workspace id in response")
                    }
                    return@launch
                }

                _uiState.update {
                    it.copy(
                        submitting = false,
                        error = null,
                        driveReconnectUrl = null,
                        createdWorkspaceId = workspaceId,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        submitting = false,
                        error = e.toUserFacingMessage("Failed to create workspace"),
                    )
                }
            }
        }
    }

    fun onDriveReconnectCompleted() {
        _uiState.update { it.copy(error = null, driveReconnectUrl = null) }
    }

    fun dismissDriveReconnectPrompt() {
        _uiState.update { it.copy(driveReconnectUrl = null) }
    }

    fun consumeCreatedWorkspace() {
        _uiState.update { it.copy(createdWorkspaceId = null) }
    }

    private fun parseApiError(raw: String, fallback: String): String {
        if (raw.isBlank()) return fallback
        if (isHtmlResponse(raw)) return nonJsonApiMessage(fallback)
        return runCatching {
            val error = workspaceJson.decodeFromString<Map<String, String>>(raw)["error"]
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
        ) unauthorizedMessage() else detail
    }

    private fun webApiUrl(path: String) = BuildConfig.WEB_API_BASE_URL.trimEnd('/') + path
}
