package com.llmwiki.ui.wiki

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.llmwiki.data.DriveClient
import com.llmwiki.data.PageRepository
import com.llmwiki.data.SupabaseClientProvider
import com.llmwiki.data.WorkspaceRow
import com.llmwiki.data.room.AppDatabase
import com.llmwiki.data.room.PageEntity
import io.github.jan.supabase.auth.auth
import com.llmwiki.sync.SyncWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

data class WikiUiState(
    val workspace: WorkspaceRow? = null,
    val activePage: PageEntity? = null,
    val pageContent: String? = null,
    val contentLoading: Boolean = false,
    val syncError: String? = null,
)

class WikiViewModel(application: Application) : AndroidViewModel(application) {

    private val db = AppDatabase.getInstance(application)
    private val supabase = SupabaseClientProvider.client

    // DriveClient is created lazily after auth gives us the account name
    private var driveClient: DriveClient? = null

    private val repository = PageRepository(db, null) // drive set after auth

    private val workspaceId = MutableStateFlow<String?>(null)

    /** Observed page list (Room-backed, updates immediately) */
    val pages: StateFlow<List<PageEntity>> = workspaceId
        .flatMapLatest { id ->
            if (id == null) flowOf(emptyList())
            else db.pageDao().observePages(id)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _uiState = MutableStateFlow(WikiUiState())
    val uiState: StateFlow<WikiUiState> = _uiState

    fun init(workspaceIdParam: String?, accountName: String) {
        // Build drive client with the authenticated Google account
        driveClient = DriveClient(getApplication(), accountName)

        viewModelScope.launch {
            // Load workspace info
            val workspaces = repository.getWorkspaces()
            val targetId = workspaceIdParam ?: workspaces.firstOrNull()?.id
            val workspace = workspaces.firstOrNull { it.id == targetId }

            _uiState.value = _uiState.value.copy(workspace = workspace)
            workspaceId.value = targetId

            if (targetId != null) {
                syncPages(targetId)
                // Enqueue periodic background sync (hourly, requires network)
                SyncWorker.schedule(getApplication(), accountName, targetId)
            }
        }
    }

    fun syncPages(wsId: String = workspaceId.value ?: return) {
        viewModelScope.launch {
            try {
                val repo = PageRepository(db, driveClient)
                repo.syncPages(wsId)
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(syncError = e.message)
            }
        }
    }

    fun selectPage(page: PageEntity) {
        _uiState.value = _uiState.value.copy(
            activePage = page,
            pageContent = page.content,
            contentLoading = page.content == null,
        )
        if (page.content == null) {
            loadContent(page)
        }
    }

    private fun loadContent(page: PageEntity) {
        viewModelScope.launch {
            try {
                val wsId = workspaceId.value ?: return@launch
                val repo = PageRepository(db, driveClient)
                val content = repo.loadPageContent(wsId, page.slug)
                _uiState.value = _uiState.value.copy(
                    pageContent = content,
                    contentLoading = false,
                )
            } catch (e: Exception) {
                _uiState.value = _uiState.value.copy(
                    contentLoading = false,
                    syncError = e.message,
                )
            }
        }
    }

    /** Send a URL to the web ingest API for processing */
    fun ingestUrl(url: String, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            try {
                // Delegate to web API (same backend used by the web app)
                val session = supabase.auth.currentSessionOrNull()
                val accessToken = session?.accessToken ?: return@launch

                val client = io.ktor.client.HttpClient(io.ktor.client.engine.android.Android)
                val response = client.post(
                    urlString = com.llmwiki.BuildConfig.SUPABASE_URL.replace("supabase.co", "vercel.app") +
                        "/api/ingest"
                ) {
                    header("Authorization", "Bearer $accessToken")
                    contentType(io.ktor.http.ContentType.Application.Json)
                    setBody(
                        kotlinx.serialization.json.Json.encodeToString(
                            kotlinx.serialization.json.buildJsonObject {
                                put("kind", kotlinx.serialization.json.JsonPrimitive("url"))
                                put("url", kotlinx.serialization.json.JsonPrimitive(url))
                                put("workspace_id", kotlinx.serialization.json.JsonPrimitive(wsId))
                            }
                        )
                    )
                }
                client.close()
                onDone(response.status.isSuccess())
            } catch (e: Exception) {
                onDone(false)
            }
        }
    }
}
