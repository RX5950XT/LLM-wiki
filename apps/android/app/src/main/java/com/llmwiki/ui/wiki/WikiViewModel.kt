package com.llmwiki.ui.wiki

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.llmwiki.BuildConfig
import com.llmwiki.R
import com.llmwiki.data.AndroidHttpClient
import com.llmwiki.data.AppPreferencesRepository
import com.llmwiki.data.DriveClient
import com.llmwiki.data.IngestJobRow
import com.llmwiki.data.LlmProfileRepository
import com.llmwiki.data.LlmProfile
import com.llmwiki.data.PageLinkRow
import com.llmwiki.data.PageRepository
import com.llmwiki.data.SourceListItem
import com.llmwiki.data.SourceRow
import com.llmwiki.data.PageLoadResult
import com.llmwiki.data.PageErrorCodes
import com.llmwiki.data.ProfileAuthRequiredException
import com.llmwiki.data.requireAccessToken
import com.llmwiki.data.SearchResult
import com.llmwiki.data.SupabaseClientProvider
import com.llmwiki.data.WorkspaceRow
import com.llmwiki.data.buildDriveReconnectUrl
import com.llmwiki.data.isDriveReconnectError
import com.llmwiki.data.isSupabaseAuthProblem
import com.llmwiki.data.room.AppDatabase
import com.llmwiki.data.room.PageEntity
import com.llmwiki.sync.SyncWorker
import io.github.jan.supabase.auth.auth
import io.github.jan.supabase.postgrest.from
import io.github.jan.supabase.postgrest.query.Columns
import io.github.jan.supabase.postgrest.query.Order
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.HttpHeaders
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * A deep reorganisation is cut off by the server's 300s invocation limit, so a
 * pass reports `more_work` and the client chains the next one. Keep in step with
 * the Web client's MAX_MAINTENANCE_PASSES.
 */
private const val MAX_MAINTENANCE_PASSES = 6

data class ChatMessage(
    val role: String,
    val content: String,
    val citedSlugs: List<String> = emptyList(),
    val isStreaming: Boolean = false,
    val proposals: List<ActionProposal> = emptyList(),
)

/** Destructive action the AI proposed; executes only after the user confirms. */
data class ActionProposal(
    val action: String,
    val params: Map<String, String>,
    val label: String,
    val status: String = "pending", // pending | running | done | error | dismissed
    val error: String? = null,
)

data class WikiUiState(
    val workspace: WorkspaceRow? = null,
    val workspaces: List<WorkspaceRow> = emptyList(),
    val workspacesLoaded: Boolean = false,
    val activePage: PageEntity? = null,
    val pageContent: String? = null,
    val contentLoading: Boolean = false,
    val syncError: String? = null,
    val chatMessages: List<ChatMessage> = emptyList(),
    val chatLoading: Boolean = false,
    val synthesisSavedSlug: String? = null,
    val signedOut: Boolean = false,
    val showSearch: Boolean = false,
    val searchQuery: String = "",
    val searchResults: List<SearchResult> = emptyList(),
    val searchLoading: Boolean = false,
    val profiles: List<LlmProfile> = emptyList(),
    val selectedProfileId: String? = null,
    val driveReconnectUrl: String? = null,
    val lastErrorRequestId: String? = null,
    val workspaceActionLoading: Boolean = false,
    val ingestLoading: Boolean = false,
    val ingestProgress: Int = 0,
    val pageSaveLoading: Boolean = false,
    val syncLoading: Boolean = false,
    val backlinks: List<String> = emptyList(),
    val chatDraft: String = "",
    val sources: List<SourceListItem>? = null,
    val sourcesLoading: Boolean = false,
    /** Workspaces @-tagged as extra context for the next chat question */
    val taggedWorkspaceIds: List<String> = emptyList(),
    /** "已導入到 X" notice after an auto-routed ingest */
    val ingestRoutedName: String? = null,
    /** The background maintenance job (health check + dedupe) is running */
    val organizeRunning: Boolean = false,
    /** Pages / workspaces changed so far by the running maintenance job */
    val maintenanceChanges: Int = 0,
    /** Source id currently being re-ingested (null = none) */
    val reingestingSourceId: String? = null,
)

private val apiJson = Json { ignoreUnknownKeys = true }

@OptIn(ExperimentalCoroutinesApi::class)
class WikiViewModel(application: Application) : AndroidViewModel(application) {

    private val db = AppDatabase.getInstance(application)
    private val supabase = SupabaseClientProvider.client

    private var driveClient: DriveClient? = null
    private var accountName: String = ""
    private val repository = PageRepository(db, null)
    private val profileRepository = LlmProfileRepository(supabase)
    private val appPreferences = AppPreferencesRepository(application)

    private val workspaceId = MutableStateFlow<String?>(null)
    private val accountNameFlow = MutableStateFlow("")
    private var searchJob: Job? = null

    val pages: StateFlow<List<PageEntity>> = combine(workspaceId, accountNameFlow) { id, account -> id to account }
        .flatMapLatest { (id, account) ->
            if (id == null || account.isBlank()) flowOf(emptyList())
            else db.pageDao().observePages(id, account)
        }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _uiState = MutableStateFlow(WikiUiState())
    val uiState: StateFlow<WikiUiState> = _uiState

    fun init(workspaceIdParam: String?, accountName: String, initialPageSlug: String? = null) {
        this.accountName = accountName
        accountNameFlow.value = accountName
        driveClient = DriveClient(getApplication(), accountName)

        refreshWorkspaces(
            preferredWorkspaceId = workspaceIdParam,
            preferredPageSlug = initialPageSlug,
            syncSelected = true,
        )
        loadProfiles()
    }

    private var lastForegroundSyncAt = 0L

    fun refreshAfterForeground() {
        val now = System.currentTimeMillis()
        if (now - lastForegroundSyncAt < 15 * 60 * 1000L) return
        lastForegroundSyncAt = now
        loadProfiles()
        refreshWorkspaces(syncSelected = true)
    }

    fun switchWorkspace(ws: WorkspaceRow) {
        _uiState.update {
            it.copy(
                workspace = ws,
                activePage = null,
                pageContent = null,
                chatMessages = emptyList(),
                showSearch = false,
                searchQuery = "",
                searchResults = emptyList(),
                driveReconnectUrl = null,
                backlinks = emptyList(),
                sources = null,
            )
        }
        workspaceId.value = ws.id
        persistLastWorkspace(ws)
        viewModelScope.launch {
            syncPagesInternal(ws.id)
            selectDefaultPageIfNeeded(ws.id)
            SyncWorker.schedule(getApplication(), accountName, ws.id)
        }
    }

    fun renameWorkspace(workspace: WorkspaceRow, newName: String) {
        val trimmed = newName.trim()
        if (trimmed.isBlank() || trimmed == workspace.name) return

        viewModelScope.launch {
            _uiState.update { it.copy(workspaceActionLoading = true, syncError = null) }
            try {
                val bodyJson = buildJsonObject { put("name", trimmed) }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.patch(webApiUrl("/api/workspaces/${workspace.id}")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: run {
                    _uiState.update { it.copy(workspaceActionLoading = false, syncError = unauthorizedMessage()) }
                    return@launch
                }
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    _uiState.update {
                        it.copy(
                            workspaceActionLoading = false,
                            syncError = parseApiError(text, str(R.string.error_op_rename_workspace)),
                        )
                    }
                    return@launch
                }
                if (!isJsonObject(text)) {
                    _uiState.update {
                        it.copy(
                            workspaceActionLoading = false,
                            syncError = nonJsonApiMessage(str(R.string.error_op_rename_workspace)),
                        )
                    }
                    return@launch
                }

                val updated = apiJson.decodeFromString<Map<String, WorkspaceRow>>(text)["workspace"]
                    ?: workspace.copy(name = trimmed)
                _uiState.update { state ->
                    state.copy(
                        workspace = if (state.workspace?.id == updated.id) updated else state.workspace,
                        workspaces = state.workspaces.map { if (it.id == updated.id) updated else it },
                        workspaceActionLoading = false,
                        syncError = null,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        workspaceActionLoading = false,
                        syncError = e.toUserFacingMessage(str(R.string.error_op_rename_workspace)),
                    )
                }
            }
        }
    }

    fun deleteWorkspace(workspace: WorkspaceRow) {
        viewModelScope.launch {
            _uiState.update { it.copy(workspaceActionLoading = true, syncError = null) }
            try {
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.delete(webApiUrl("/api/workspaces/${workspace.id}")) {
                        header("Authorization", "Bearer $accessToken")
                    }
                } ?: run {
                    _uiState.update { it.copy(workspaceActionLoading = false, syncError = unauthorizedMessage()) }
                    return@launch
                }
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    _uiState.update {
                        it.copy(
                            workspaceActionLoading = false,
                            syncError = parseApiError(text, str(R.string.error_op_delete_workspace)),
                        )
                    }
                    return@launch
                }
                val deleteSucceeded = if (isJsonObject(text)) {
                    apiJson.parseToJsonElement(text).jsonObject["ok"]?.jsonPrimitive?.booleanOrNull == true
                } else {
                    false
                }
                if (!deleteSucceeded) {
                    _uiState.update {
                        it.copy(
                            workspaceActionLoading = false,
                            syncError = nonJsonApiMessage(str(R.string.error_op_delete_workspace)),
                        )
                    }
                    return@launch
                }

                SyncWorker.cancel(getApplication(), accountName, workspace.id)
                db.pageDao().deleteByWorkspace(workspace.id, accountName)
                val remaining = _uiState.value.workspaces.filterNot { it.id == workspace.id }
                val next = remaining.firstOrNull()
                _uiState.update {
                    it.copy(
                        workspaces = remaining,
                        workspace = next,
                        activePage = null,
                        pageContent = null,
                        chatMessages = emptyList(),
                        workspaceActionLoading = false,
                        syncError = null,
                    )
                }
                workspaceId.value = next?.id
                persistLastWorkspace(next)
                next?.let {
                    syncPagesInternal(it.id)
                    selectDefaultPageIfNeeded(it.id)
                    SyncWorker.schedule(getApplication(), accountName, it.id)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        workspaceActionLoading = false,
                        syncError = e.toUserFacingMessage(str(R.string.error_op_delete_workspace)),
                    )
                }
            }
        }
    }

    fun moveWorkspaceUp(workspace: WorkspaceRow) {
        reorderWorkspace(workspace, -1)
    }

    fun moveWorkspaceDown(workspace: WorkspaceRow) {
        reorderWorkspace(workspace, 1)
    }

    fun syncPages(wsId: String? = workspaceId.value) {
        val id = wsId ?: return
        viewModelScope.launch {
            if (accountName.isBlank()) return@launch
            syncPagesInternal(id)
        }
    }

    fun selectPage(page: PageEntity) {
        _uiState.update {
            it.copy(
                activePage = page,
                pageContent = page.content,
                contentLoading = page.content == null,
                showSearch = false,
                searchQuery = "",
                searchResults = emptyList(),
                backlinks = emptyList(),
            )
        }
        if (page.content == null) loadContent(page)
        loadBacklinks(page.slug)
    }

    /** Pages whose [[wikilinks]] point at the given slug (mirrors the Web backlinks panel). */
    private fun loadBacklinks(slug: String) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            val backlinks = runCatching {
                supabase.requireAccessToken(forceRefresh = false)
                supabase.from("page_links")
                    .select(columns = Columns.raw("from_slug")) {
                        filter {
                            eq("workspace_id", wsId)
                            eq("to_slug", slug)
                        }
                    }
                    .decodeList<PageLinkRow>()
                    .map { it.fromSlug }
                    .distinct()
                    .sorted()
            }.getOrDefault(emptyList())
            _uiState.update { state ->
                if (state.activePage?.slug == slug) state.copy(backlinks = backlinks) else state
            }
        }
    }

    fun selectPageBySlug(slug: String) {
        val page = resolvePageSlug(slug)
            ?: return
        selectPage(page)
    }

    fun selectSearchResult(slug: String) {
        val existing = pages.value.find { it.slug == slug }
        if (existing != null) {
            selectPage(existing)
            return
        }

        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            syncPagesInternal(wsId)
            val page = db.pageDao().getPage(wsId, accountName, slug)
            if (page != null) {
                selectPage(page)
            } else {
                _uiState.update { it.copy(syncError = str(R.string.error_page_not_found)) }
            }
        }
    }

    private fun loadContent(page: PageEntity) {
        viewModelScope.launch {
            try {
                val wsId = workspaceId.value ?: return@launch
                val repo = PageRepository(db, driveClient)
                when (val result = repo.loadPageContent(wsId, accountName, page.slug)) {
                    is PageLoadResult.Success -> {
                        _uiState.update {
                            it.copy(
                                pageContent = result.content,
                                contentLoading = false,
                                syncError = null,
                                driveReconnectUrl = null,
                                lastErrorRequestId = null,
                            )
                        }
                    }
                    is PageLoadResult.Failure -> {
                        if (result.reconnectRequired) {
                            val message = mapPageLoadError(result)
                            _uiState.update {
                                it.copy(
                                    pageContent = null,
                                    contentLoading = false,
                                    lastErrorRequestId = result.requestId,
                                )
                            }
                            requestDriveReconnect("page-load", message)
                        } else {
                            _uiState.update {
                                it.copy(
                                    pageContent = null,
                                    contentLoading = false,
                                    syncError = mapPageLoadError(result),
                                    lastErrorRequestId = result.requestId,
                                )
                            }
                        }
                    }
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(contentLoading = false, syncError = e.toUserFacingMessage(str(R.string.error_op_load_page))) }
            }
        }
    }

    fun toggleLock(slug: String, currentLocked: Boolean) {
        val newLocked = !currentLocked
        // Optimistic update — immediate visual feedback before network round-trip
        _uiState.update { state ->
            if (state.activePage?.slug == slug) {
                state.copy(activePage = state.activePage.copy(lockedByHuman = newLocked))
            } else state
        }
        viewModelScope.launch {
            val wsId = workspaceId.value ?: run {
                // No workspace; revert the optimistic update
                _uiState.update { state ->
                    if (state.activePage?.slug == slug) {
                        state.copy(activePage = state.activePage.copy(lockedByHuman = currentLocked))
                    } else state
                }
                return@launch
            }
            db.pageDao().updateLock(wsId, accountName, slug, newLocked)
            try {
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.patch(webApiUrl("/api/pages/$wsId/${slug.encodePathSegments()}")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody("""{"locked_by_human":$newLocked}""")
                    }
                }
                if (response == null || response.status.value !in 200..299) {
                    // Rollback Room and UI
                    db.pageDao().updateLock(wsId, accountName, slug, currentLocked)
                    _uiState.update { state ->
                        val rolled = if (state.activePage?.slug == slug) {
                            state.copy(activePage = state.activePage.copy(lockedByHuman = currentLocked))
                        } else state
                        if (response != null) {
                            rolled.copy(syncError = parseApiError(response.bodyAsText(), str(R.string.error_op_lock)))
                        } else {
                            rolled
                        }
                    }
                }
            } catch (e: Exception) {
                // Rollback Room and UI
                db.pageDao().updateLock(wsId, accountName, slug, currentLocked)
                _uiState.update { state ->
                    val rolled = if (state.activePage?.slug == slug) {
                        state.copy(activePage = state.activePage.copy(lockedByHuman = currentLocked))
                    } else state
                    rolled.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_lock)))
                }
            }
        }
    }

    fun toggleSearch() {
        _uiState.update { it.copy(showSearch = !it.showSearch, searchQuery = "", searchResults = emptyList()) }
    }

    fun updateSearchQuery(query: String) {
        _uiState.update { it.copy(searchQuery = query) }
        searchJob?.cancel()
        if (query.length >= 2) {
            searchJob = viewModelScope.launch {
                delay(200)
                doSearch(query)
            }
        } else {
            _uiState.update { it.copy(searchResults = emptyList(), searchLoading = false) }
        }
    }

    private suspend fun doSearch(query: String) {
        val wsId = workspaceId.value ?: return
        _uiState.update { it.copy(searchLoading = true) }
        try {
            val response = sendAuthorizedRequest { accessToken ->
                AndroidHttpClient.instance.get(webApiUrl("/api/search?workspace_id=$wsId&q=${query.encodeUrl()}")) {
                    header("Authorization", "Bearer $accessToken")
                }
            } ?: return
            val text = response.bodyAsText()

            if (response.status.value !in 200..299) {
                _uiState.update {
                    it.copy(
                        searchResults = emptyList(),
                        searchLoading = false,
                        syncError = parseApiError(text, str(R.string.error_op_search)),
                    )
                }
                return
            }

            val wrapper = apiJson.decodeFromString<Map<String, List<SearchResult>>>(text)
            _uiState.update {
                it.copy(
                    searchResults = wrapper["pages"] ?: emptyList(),
                    searchLoading = false,
                    syncError = null,
                )
            }
        } catch (e: Exception) {
            _uiState.update { it.copy(searchLoading = false, syncError = e.toUserFacingMessage(str(R.string.error_op_search))) }
        }
    }

    fun clearSearch() {
        searchJob?.cancel()
        _uiState.update {
            it.copy(showSearch = false, searchQuery = "", searchResults = emptyList(), searchLoading = false)
        }
    }

    fun loadProfiles() {
        viewModelScope.launch {
            try {
                val profiles = profileRepository.listProfiles()
                val selectedId = _uiState.value.selectedProfileId
                    ?.takeIf { selected -> profiles.any { it.id == selected } }
                val defaultId = profiles.firstOrNull { it.isDefault }?.id

                _uiState.update {
                    it.copy(
                        profiles = profiles,
                        selectedProfileId = selectedId ?: defaultId ?: profiles.firstOrNull()?.id,
                    )
                }
            } catch (_: ProfileAuthRequiredException) {
                _uiState.update { it.copy(profiles = emptyList(), selectedProfileId = null) }
            } catch (_: Exception) {
                // Ignore profile refresh failures to avoid blocking the main wiki flow.
            }
        }
    }

    fun setSelectedProfile(profileId: String?) {
        _uiState.update { it.copy(selectedProfileId = profileId) }
    }

    fun onDriveReconnectCompleted() {
        _uiState.update { it.copy(driveReconnectUrl = null, syncError = null) }
        refreshAfterForeground()
    }

    fun dismissDriveReconnectPrompt() {
        _uiState.update { it.copy(driveReconnectUrl = null) }
    }

    /** Chat input draft lives here so closing the sheet or rotating never discards it. */
    fun updateChatDraft(value: String) {
        _uiState.update { it.copy(chatDraft = value) }
    }

    fun tagWorkspace(wsId: String) {
        _uiState.update { state ->
            if (state.taggedWorkspaceIds.contains(wsId) || state.taggedWorkspaceIds.size >= 5) state
            else state.copy(taggedWorkspaceIds = state.taggedWorkspaceIds + wsId)
        }
    }

    fun untagWorkspace(wsId: String) {
        _uiState.update { it.copy(taggedWorkspaceIds = it.taggedWorkspaceIds - wsId) }
    }

    fun sendQuery(userText: String) {
        if (userText.isBlank()) return
        val wsId = workspaceId.value ?: return

        val userMsg = ChatMessage(role = "user", content = userText)
        val history = _uiState.value.chatMessages
        val newHistory = history + userMsg
        val placeholder = ChatMessage(role = "assistant", content = "", isStreaming = true)
        val taggedIds = _uiState.value.taggedWorkspaceIds
        val currentSlug = _uiState.value.activePage?.slug
        _uiState.update {
            it.copy(
                chatMessages = newHistory + placeholder,
                chatLoading = true,
                synthesisSavedSlug = null,
                chatDraft = "",
            )
        }

        viewModelScope.launch {
            try {
                val bodyJson = buildJsonObject {
                    put("messages", buildJsonArray {
                        newHistory.forEach { message ->
                            add(buildJsonObject {
                                put("role", message.role)
                                put("content", message.content)
                            })
                        }
                    })
                    put("workspace_id", wsId)
                    _uiState.value.selectedProfileId?.let { put("profile_id", it) }
                    currentSlug?.let { put("current_slug", it) }
                    if (taggedIds.isNotEmpty()) {
                        put("context_workspace_ids", buildJsonArray { taggedIds.forEach { add(JsonPrimitive(it)) } })
                    }
                }.toString()

                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/query")) {
                        header("Authorization", "Bearer $accessToken")
                        header("x-llm-wiki-locale", currentUiLocale())
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: run {
                    _uiState.update { state ->
                        state.copy(
                            chatMessages = state.chatMessages.dropLast(1),
                            chatLoading = false,
                            syncError = unauthorizedMessage(),
                        )
                    }
                    return@launch
                }

                if (response.status.value !in 200..299) {
                    val message = parseApiError(response.bodyAsText(), str(R.string.error_op_query))
                    if (response.status.value == 403 && isDriveReconnectError(message)) {
                        requestDriveReconnect("query", message)
                    } else {
                        _uiState.update { it.copy(syncError = message) }
                    }
                    _uiState.update { state ->
                        state.copy(
                            chatMessages = state.chatMessages.dropLast(1),
                            chatLoading = false,
                        )
                    }
                    return@launch
                }

                val channel = response.bodyAsChannel()
                val raw = StringBuilder()
                val citationDelimiter = "\u0000CITATIONS\u0000"

                while (!channel.isClosedForRead) {
                    val chunk = channel.readUTF8Line() ?: break
                    raw.append(chunk).append("\n")
                    // Hide any trailing NUL-delimited metadata block while streaming
                    val nulIdx = raw.indexOf(citationDelimiter[0])
                    val displayText = if (nulIdx >= 0) raw.substring(0, nulIdx) else raw.toString()
                    _uiState.update { state ->
                        val messages = state.chatMessages.dropLast(1) +
                            placeholder.copy(content = displayText.trimEnd())
                        state.copy(chatMessages = messages)
                    }
                }

                val parsed = parseStreamMeta(raw.toString())
                _uiState.update { state ->
                    val final = ChatMessage(
                        role = "assistant",
                        content = parsed.text.trimEnd(),
                        citedSlugs = parsed.citedSlugs,
                        proposals = parsed.proposals,
                    )
                    state.copy(
                        chatMessages = state.chatMessages.dropLast(1) + final,
                        chatLoading = false,
                        syncError = null,
                        taggedWorkspaceIds = emptyList(),
                    )
                }
                // The AI may have created/renamed a workspace this turn — refresh the
                // switcher list (syncSelected=false keeps it cheap unless it changed)
                refreshWorkspaces(syncSelected = false)
            } catch (e: Exception) {
                _uiState.update { state ->
                    state.copy(
                        chatMessages = state.chatMessages.dropLast(1),
                        chatLoading = false,
                        syncError = e.toUserFacingMessage(str(R.string.error_op_query)),
                    )
                }
            }
        }
    }

    /** Runs a user-confirmed destructive action via the same server path the AI tools use. */
    fun executeProposal(messageIndex: Int, proposalIndex: Int) {
        val message = _uiState.value.chatMessages.getOrNull(messageIndex) ?: return
        val proposal = message.proposals.getOrNull(proposalIndex) ?: return
        if (proposal.status != "pending") return
        updateProposalStatus(messageIndex, proposalIndex, "running", null)
        viewModelScope.launch {
            try {
                val bodyJson = buildJsonObject {
                    put("action", proposal.action)
                    proposal.params.forEach { (k, v) -> put(k, v) }
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/agent/execute")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: run {
                    updateProposalStatus(messageIndex, proposalIndex, "error", unauthorizedMessage())
                    return@launch
                }
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    updateProposalStatus(
                        messageIndex,
                        proposalIndex,
                        "error",
                        parseApiError(text, str(R.string.error_op_agent_action)),
                    )
                    return@launch
                }
                updateProposalStatus(messageIndex, proposalIndex, "done", null)
                if (proposal.action == "delete_workspace") {
                    proposal.params["workspace_id"]?.let { deletedId ->
                        SyncWorker.cancel(getApplication(), accountName, deletedId)
                        db.pageDao().deleteByWorkspace(deletedId, accountName)
                    }
                    refreshWorkspaces(preferredWorkspaceId = null, syncSelected = true)
                } else {
                    workspaceId.value?.let { syncPagesInternal(it) }
                }
            } catch (e: Exception) {
                updateProposalStatus(
                    messageIndex,
                    proposalIndex,
                    "error",
                    e.toUserFacingMessage(str(R.string.error_op_agent_action)),
                )
            }
        }
    }

    fun dismissProposal(messageIndex: Int, proposalIndex: Int) {
        updateProposalStatus(messageIndex, proposalIndex, "dismissed", null)
    }

    private fun updateProposalStatus(messageIndex: Int, proposalIndex: Int, status: String, error: String?) {
        _uiState.update { state ->
            state.copy(
                chatMessages = state.chatMessages.mapIndexed { i, msg ->
                    if (i != messageIndex) msg
                    else msg.copy(
                        proposals = msg.proposals.mapIndexed { j, p ->
                            if (j != proposalIndex) p else p.copy(status = status, error = error)
                        },
                    )
                },
            )
        }
    }

    /**
     * The single maintenance job: health check + dedupe/re-classification across all
     * workspaces (POST /api/organize). It rewrites the wiki directly — no report page —
     * and keeps running server-side even if the app leaves the foreground.
     */
    fun runMaintenance(onDone: (Boolean) -> Unit = {}) {
        val wsId = workspaceId.value ?: return
        if (_uiState.value.organizeRunning) return
        val failMsg = str(R.string.error_op_organize)
        viewModelScope.launch {
            _uiState.update { it.copy(organizeRunning = true, maintenanceChanges = 0, syncError = null) }
            var carried = 0
            try {
                // A deep reorganisation does not fit in one server invocation (300s):
                // the pass reports more_work when it was cut off mid-plan, and we chain
                // the next one so a single button press converges. Mirrors the Web client.
                for (pass in 1..MAX_MAINTENANCE_PASSES) {
                    val bodyJson = buildJsonObject { put("workspace_id", wsId) }.toString()
                    val response = sendAuthorizedRequest { accessToken ->
                        AndroidHttpClient.instance.post(webApiUrl("/api/organize")) {
                            header("Authorization", "Bearer $accessToken")
                            header("x-llm-wiki-locale", currentUiLocale())
                            contentType(ContentType.Application.Json)
                            setBody(bodyJson)
                        }
                    } ?: run {
                        _uiState.update { it.copy(organizeRunning = false, syncError = unauthorizedMessage()) }
                        onDone(false)
                        return@launch
                    }
                    val text = response.bodyAsText()
                    val bodyJsonObj = if (isJsonObject(text)) apiJson.parseToJsonElement(text).jsonObject else null
                    val jobId = bodyJsonObj?.get("jobId")?.jsonPrimitive?.contentOrNull
                    if (response.status.value !in 200..299 || jobId == null) {
                        _uiState.update {
                            it.copy(organizeRunning = false, syncError = parseApiError(text, failMsg))
                        }
                        onDone(false)
                        return@launch
                    }

                    val deadline = System.currentTimeMillis() + 6 * 60 * 1000L
                    var settled = false
                    var moreWork = false
                    while (System.currentTimeMillis() < deadline) {
                        delay(3_000)
                        val poll = sendAuthorizedRequest { accessToken ->
                            AndroidHttpClient.instance.get(webApiUrl("/api/organize?job_id=$jobId")) {
                                header("Authorization", "Bearer $accessToken")
                            }
                        } ?: continue
                        val pollText = poll.bodyAsText()
                        if (poll.status.value !in 200..299 || !isJsonObject(pollText)) continue
                        val obj = apiJson.parseToJsonElement(pollText).jsonObject
                        val changes = (obj["progress"] as? JsonArray)?.size ?: 0
                        when (obj["status"]?.jsonPrimitive?.contentOrNull) {
                            "done" -> {
                                carried += changes
                                moreWork = obj["more_work"]?.jsonPrimitive?.booleanOrNull ?: false
                                syncPagesInternal(wsId, forceSync = true)
                                // Maintenance may rename / create / delete / reorder workspaces
                                refreshWorkspaces(syncSelected = false)
                                _uiState.update { it.copy(maintenanceChanges = carried) }
                                settled = true
                            }
                            "failed" -> {
                                val err = obj["error"]?.jsonPrimitive?.contentOrNull
                                    ?.takeIf { it.isNotBlank() } ?: failMsg
                                _uiState.update {
                                    it.copy(organizeRunning = false, maintenanceChanges = 0, syncError = err)
                                }
                                onDone(false)
                                return@launch
                            }
                            // still running — surface how many pages/workspaces changed so far
                            else -> _uiState.update { it.copy(maintenanceChanges = carried + changes) }
                        }
                        if (settled) break
                    }
                    if (!settled) {
                        _uiState.update {
                            it.copy(organizeRunning = false, syncError = str(R.string.error_network_timeout))
                        }
                        onDone(false)
                        return@launch
                    }
                    if (!moreWork) break
                }

                _uiState.update {
                    it.copy(organizeRunning = false, maintenanceChanges = 0, syncError = null)
                }
                onDone(true)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(organizeRunning = false, syncError = e.toUserFacingMessage(failMsg))
                }
                onDone(false)
            }
        }
    }

    fun clearIngestNotice() {
        _uiState.update { it.copy(ingestRoutedName = null) }
    }

    fun saveSynthesis(question: String, answer: String, citedSlugs: List<String>) {
        val wsId = workspaceId.value ?: return
        viewModelScope.launch {
            try {
                val bodyJson = buildJsonObject {
                    put("question", question)
                    put("answer", answer)
                    put("cited_slugs", buildJsonArray { citedSlugs.forEach { add(JsonPrimitive(it)) } })
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/workspaces/$wsId/synthesis")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: return@launch
                val text = response.bodyAsText()

                if (response.status.value !in 200..299) {
                    val message = parseApiError(text, str(R.string.error_op_synthesis))
                    if (response.status.value == 403 && isDriveReconnectError(message)) {
                        requestDriveReconnect("synthesis", message)
                    } else {
                        _uiState.update { it.copy(syncError = message) }
                    }
                    return@launch
                }

                val slug = apiJson.decodeFromString<Map<String, String>>(text)["slug"]
                if (slug != null) {
                    _uiState.update { it.copy(synthesisSavedSlug = slug, syncError = null) }
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_synthesis))) }
            }
        }
    }

    fun clearSynthesisSlug() {
        _uiState.update { it.copy(synthesisSavedSlug = null) }
    }

    fun savePageContent(slug: String, content: String, onDone: (Boolean) -> Unit = {}) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            _uiState.update { it.copy(pageSaveLoading = true) }
            try {
                val bodyJson = buildJsonObject {
                    put("content", content)
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.patch(webApiUrl("/api/pages/$wsId/${slug.encodePathSegments()}")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: run {
                    _uiState.update {
                        it.copy(pageSaveLoading = false, syncError = unauthorizedMessage())
                    }
                    onDone(false)
                    return@launch
                }
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    _uiState.update {
                        it.copy(
                            pageSaveLoading = false,
                            syncError = parseApiError(text, str(R.string.error_op_save_page)),
                        )
                    }
                    onDone(false)
                    return@launch
                }

                syncPagesInternal(wsId)
                db.pageDao().updateContent(wsId, accountName, slug, content)
                val updatedPage = db.pageDao().getPage(wsId, accountName, slug)
                _uiState.update {
                    it.copy(
                        activePage = updatedPage ?: it.activePage,
                        pageContent = content,
                        pageSaveLoading = false,
                        syncError = null,
                    )
                }
                onDone(true)
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        pageSaveLoading = false,
                        syncError = e.toUserFacingMessage(str(R.string.error_op_save_page)),
                    )
                }
                onDone(false)
            }
        }
    }

    /** Read-only sources list (immutable after ingest) joined with the latest job state. */
    fun loadSources() {
        val wsId = workspaceId.value ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(sourcesLoading = true) }
            try {
                supabase.requireAccessToken(forceRefresh = false)
                val sources = supabase.from("sources")
                    .select(columns = Columns.raw("id,kind,title,url,created_at,ingested_at")) {
                        filter { eq("workspace_id", wsId) }
                        order("created_at", order = Order.DESCENDING)
                        limit(200)
                    }
                    .decodeList<SourceRow>()
                val jobs = supabase.from("ingest_jobs")
                    .select(columns = Columns.raw("source_id,status,error,touched_pages,started_at")) {
                        filter { eq("workspace_id", wsId) }
                        order("started_at", order = Order.DESCENDING)
                    }
                    .decodeList<IngestJobRow>()
                val latestJob = jobs.groupBy { it.sourceId }.mapValues { it.value.first() }
                val items = sources.map { source ->
                    val job = latestJob[source.id]
                    SourceListItem(
                        source = source,
                        jobStatus = job?.status,
                        jobError = job?.error,
                        touchedCount = job?.touchedPages?.size ?: 0,
                    )
                }
                _uiState.update { it.copy(sources = items, sourcesLoading = false) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        sourcesLoading = false,
                        sources = emptyList(),
                        syncError = e.toUserFacingMessage(str(R.string.error_op_load_sources)),
                    )
                }
            }
        }
    }

    /** Re-run the ingest pipeline for an already-imported source (e.g. a failed one). */
    fun reingestSource(sourceId: String) {
        if (_uiState.value.reingestingSourceId != null) return
        viewModelScope.launch {
            _uiState.update { it.copy(reingestingSourceId = sourceId, syncError = null) }
            try {
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/sources/$sourceId/reingest")) {
                        header("Authorization", "Bearer $accessToken")
                        header("x-llm-wiki-locale", currentUiLocale())
                    }
                } ?: run {
                    _uiState.update { it.copy(reingestingSourceId = null, syncError = unauthorizedMessage()) }
                    return@launch
                }
                val text = response.bodyAsText()
                val obj = if (isJsonObject(text)) apiJson.parseToJsonElement(text).jsonObject else null
                val jobId = obj?.get("jobId")?.jsonPrimitive?.contentOrNull
                if (response.status.value !in 200..299 || jobId == null) {
                    _uiState.update {
                        it.copy(
                            reingestingSourceId = null,
                            syncError = parseApiError(text, str(R.string.sources_reingest_failed)),
                        )
                    }
                    return@launch
                }
                val deadline = System.currentTimeMillis() + 6 * 60 * 1000L
                while (System.currentTimeMillis() < deadline) {
                    delay(3_000)
                    val poll = sendAuthorizedRequest { accessToken ->
                        AndroidHttpClient.instance.get(webApiUrl("/api/ingest?job_id=$jobId")) {
                            header("Authorization", "Bearer $accessToken")
                        }
                    } ?: continue
                    val pollText = poll.bodyAsText()
                    if (poll.status.value !in 200..299 || !isJsonObject(pollText)) continue
                    val status = apiJson.parseToJsonElement(pollText).jsonObject["status"]
                        ?.jsonPrimitive?.contentOrNull
                    if (status == "done" || status == "failed") break
                }
                _uiState.update { it.copy(reingestingSourceId = null) }
                loadSources()
                workspaceId.value?.let { syncPagesInternal(it, forceSync = true) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        reingestingSourceId = null,
                        syncError = e.toUserFacingMessage(str(R.string.sources_reingest_failed)),
                    )
                }
            }
        }
    }

    fun signOut() {
        viewModelScope.launch {
            val workspaceIds = _uiState.value.workspaces.map { it.id }
            try {
                supabase.auth.signOut()
                GoogleSignIn.getClient(
                    getApplication(),
                    GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
                        .requestIdToken(BuildConfig.GOOGLE_CLIENT_ID.trim())
                        .requestEmail()
                        .build(),
                ).signOut()
            } finally {
                workspaceIds.forEach { SyncWorker.cancel(getApplication(), accountName, it) }
                db.pageDao().deleteByAccount(accountName)
                _uiState.update { it.copy(signedOut = true) }
            }
        }
    }

    fun ingestUrl(url: String, autoRoute: Boolean = false, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            _uiState.update { it.copy(ingestLoading = true, ingestProgress = 0, ingestRoutedName = null) }
            try {
                val requestBody = buildJsonObject {
                    put("kind", "url")
                    put("url", url)
                    if (autoRoute) {
                        put("auto_route", true)
                        put("fallback_workspace_id", wsId)
                    } else {
                        put("workspace_id", wsId)
                    }
                    _uiState.value.selectedProfileId?.let { put("profile_id", it) }
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/ingest")) {
                        header("Authorization", "Bearer $accessToken")
                        header("x-llm-wiki-locale", currentUiLocale())
                        contentType(ContentType.Application.Json)
                        setBody(requestBody)
                    }
                } ?: return@launch
                val text = response.bodyAsText()
                handleIngestResult(wsId, response.status.value, text, onDone)
            } catch (e: Exception) {
                _uiState.update { it.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_ingest))) }
                onDone(false)
            } finally {
                _uiState.update { it.copy(ingestLoading = false, ingestProgress = 0) }
            }
        }
    }

    fun ingestText(title: String, content: String, autoRoute: Boolean = false, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            _uiState.update { it.copy(ingestLoading = true, ingestProgress = 0, ingestRoutedName = null) }
            try {
                val requestBody = buildJsonObject {
                    put("kind", "text")
                    put("title", title)
                    put("content", content)
                    if (autoRoute) {
                        put("auto_route", true)
                        put("fallback_workspace_id", wsId)
                    } else {
                        put("workspace_id", wsId)
                    }
                    _uiState.value.selectedProfileId?.let { put("profile_id", it) }
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/ingest")) {
                        header("Authorization", "Bearer $accessToken")
                        header("x-llm-wiki-locale", currentUiLocale())
                        contentType(ContentType.Application.Json)
                        setBody(requestBody)
                    }
                } ?: return@launch
                val text = response.bodyAsText()
                handleIngestResult(wsId, response.status.value, text, onDone)
            } catch (e: Exception) {
                _uiState.update { it.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_ingest))) }
                onDone(false)
            } finally {
                _uiState.update { it.copy(ingestLoading = false, ingestProgress = 0) }
            }
        }
    }

    private suspend fun handleIngestResult(
        wsId: String,
        statusCode: Int,
        raw: String,
        onDone: (Boolean) -> Unit,
    ) {
        if (statusCode !in 200..299) {
            val message = parseApiError(raw, str(R.string.error_op_ingest))
            if (statusCode == 403 && isDriveReconnectError(message)) {
                requestDriveReconnect("ingest", message)
            } else {
                _uiState.update { it.copy(syncError = message) }
            }
            onDone(false)
            return
        }

        // Async ingest protocol: server responds { jobId, status: "running" } right away
        // and runs the LLM pipeline in the background. Poll until the job is terminal —
        // the request no longer blocks for minutes, so backgrounding the app is safe.
        val bodyJson = if (isJsonObject(raw)) {
            runCatching { apiJson.parseToJsonElement(raw).jsonObject }.getOrNull()
        } else null
        val jobId = bodyJson?.get("jobId")?.jsonPrimitive?.contentOrNull
        val initialStatus = bodyJson?.get("status")?.jsonPrimitive?.contentOrNull
        // Auto-routed ingest: surface which workspace the AI picked
        bodyJson?.get("routed_workspace_name")?.jsonPrimitive?.contentOrNull?.let { routedName ->
            _uiState.update { it.copy(ingestRoutedName = routedName) }
        }

        if (jobId != null && initialStatus != "done") {
            val error = pollIngestJob(jobId)
            if (error != null) {
                _uiState.update { it.copy(syncError = error) }
                onDone(false)
                return
            }
        }

        _uiState.update { it.copy(syncError = null) }
        // Force full sync and content reload so the UI reflects ingest results immediately
        syncPagesInternal(wsId, forceSync = true)
        selectDefaultPageIfNeeded(wsId)
        onDone(true)
    }

    /** Polls the ingest job until done/failed. Returns null on success, error message otherwise. */
    private suspend fun pollIngestJob(jobId: String): String? {
        val deadline = System.currentTimeMillis() + 6 * 60 * 1000L // server budget 300s + buffer
        var consecutiveFailures = 0
        while (System.currentTimeMillis() < deadline) {
            delay(3_000)
            try {
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.get(webApiUrl("/api/ingest?job_id=$jobId")) {
                        header("Authorization", "Bearer $accessToken")
                    }
                } ?: return unauthorizedMessage()
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    if (++consecutiveFailures >= 5) return parseApiError(text, str(R.string.error_op_ingest))
                    continue
                }
                consecutiveFailures = 0
                if (!isJsonObject(text)) continue
                val obj = apiJson.parseToJsonElement(text).jsonObject
                when (obj["status"]?.jsonPrimitive?.contentOrNull) {
                    "done" -> return null
                    "failed" -> return obj["error"]?.jsonPrimitive?.contentOrNull
                        ?.takeIf { it.isNotBlank() } ?: str(R.string.error_op_ingest)
                    else -> {
                        // Still running — surface live cascade progress
                        val touched = (obj["touched_pages"] as? kotlinx.serialization.json.JsonArray)?.size ?: 0
                        if (touched > 0) _uiState.update { it.copy(ingestProgress = touched) }
                    }
                }
            } catch (e: Exception) {
                if (++consecutiveFailures >= 5) return e.toUserFacingMessage(str(R.string.error_op_ingest))
            }
        }
        return getApplication<Application>().getString(R.string.error_network_timeout)
    }

    private fun refreshWorkspaces(
        preferredWorkspaceId: String? = workspaceId.value,
        preferredPageSlug: String? = null,
        syncSelected: Boolean,
    ) {
        viewModelScope.launch {
            try {
                val workspaces = repository.getWorkspaces()
                val previousId = workspaceId.value
                val targetId = preferredWorkspaceId
                    ?.takeIf { selected -> workspaces.any { it.id == selected } }
                    ?: previousId?.takeIf { selected -> workspaces.any { it.id == selected } }
                    ?: workspaces.firstOrNull()?.id
                val workspace = workspaces.firstOrNull { it.id == targetId }

                _uiState.update {
                    val switchedWorkspace = targetId != previousId
                    it.copy(
                        workspace = workspace,
                        workspaces = workspaces,
                        workspacesLoaded = true,
                        activePage = if (switchedWorkspace) null else it.activePage,
                        pageContent = if (switchedWorkspace) null else it.pageContent,
                        chatMessages = if (switchedWorkspace) emptyList() else it.chatMessages,
                        syncError = null,
                    )
                }
                workspaceId.value = targetId
                persistLastWorkspace(workspace)

                if (targetId != null) {
                    if (syncSelected || targetId != previousId) {
                        syncPagesInternal(targetId)
                        if (!preferredPageSlug.isNullOrBlank()) {
                            selectPageBySlugFromDb(targetId, preferredPageSlug)
                        } else {
                            selectDefaultPageIfNeeded(targetId)
                        }
                    }
                    SyncWorker.schedule(getApplication(), accountName, targetId)
                }
            } catch (e: Exception) {
                // Offline cold start: fall back to the persisted workspace so the
                // Room page cache is browsable instead of an empty screen
                val cached = restoreLastWorkspace()
                if (cached != null && workspaceId.value == null) {
                    _uiState.update {
                        it.copy(
                            workspace = cached,
                            workspaces = listOf(cached),
                            workspacesLoaded = true,
                            syncError = e.toUserFacingMessage(str(R.string.error_op_load_workspaces)),
                        )
                    }
                    workspaceId.value = cached.id
                    selectDefaultPageIfNeeded(cached.id)
                } else {
                    _uiState.update { it.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_load_workspaces))) }
                }
            }
        }
    }

    private fun persistLastWorkspace(workspace: WorkspaceRow?) {
        val ws = workspace ?: return
        if (accountName.isBlank()) return
        viewModelScope.launch {
            runCatching {
                appPreferences.setLastWorkspace(
                    accountName,
                    apiJson.encodeToString(WorkspaceRow.serializer(), ws),
                )
            }
        }
    }

    private suspend fun restoreLastWorkspace(): WorkspaceRow? {
        if (accountName.isBlank()) return null
        return runCatching {
            appPreferences.getLastWorkspaceJson(accountName)?.let {
                apiJson.decodeFromString(WorkspaceRow.serializer(), it)
            }
        }.getOrNull()
    }

    fun clearSyncError() {
        _uiState.update { it.copy(syncError = null) }
    }

    private suspend fun syncPagesInternal(wsId: String, forceSync: Boolean = false) {
        _uiState.update { it.copy(syncLoading = true) }
        try {
            val repo = PageRepository(db, driveClient)
            repo.syncPages(wsId, accountName, currentUiLocale(), forceSync)
            val activeSlug = _uiState.value.activePage?.slug
            if (activeSlug != null) {
                val updatedPage = db.pageDao().getPage(wsId, accountName, activeSlug)
                if (updatedPage != null) {
                    if (forceSync) {
                        // Always reload active page content after ingest to reflect changes
                        _uiState.update { state ->
                            state.copy(activePage = updatedPage, contentLoading = true, syncError = null)
                        }
                        db.pageDao().clearContent(wsId, accountName, activeSlug)
                        loadContent(updatedPage)
                    } else {
                        _uiState.update { state ->
                            state.copy(
                                activePage = updatedPage,
                                pageContent = if (state.activePage?.version == updatedPage.version) state.pageContent else updatedPage.content,
                                contentLoading = state.activePage?.version != updatedPage.version && updatedPage.content == null,
                                syncError = null,
                            )
                        }
                        if (updatedPage.content == null) {
                            loadContent(updatedPage)
                        }
                    }
                }
            } else {
                _uiState.update { it.copy(syncError = null) }
            }
        } catch (e: Exception) {
            _uiState.update { it.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_sync))) }
        } finally {
            _uiState.update { it.copy(syncLoading = false) }
        }
    }

    private fun str(resId: Int): String = getApplication<Application>().getString(resId)

    private suspend fun selectDefaultPageIfNeeded(wsId: String) {
        val active = _uiState.value.activePage
        if (active?.workspaceId == wsId) return

        val page = db.pageDao().getPage(wsId, accountName, "index.md")
            ?: db.pageDao().getPage(wsId, accountName, "log.md")
            ?: return
        selectPage(page)
    }

    private suspend fun selectPageBySlugFromDb(wsId: String, slug: String) {
        val resolvedSlug = resolvePageSlug(slug)?.slug
        val normalized = normalizeWikiSlug(slug)
        val page = listOfNotNull(resolvedSlug, normalized, slug)
            .distinct()
            .firstNotNullOfOrNull { candidate ->
                db.pageDao().getPage(wsId, accountName, candidate)
            }
        if (page != null) {
            selectPage(page)
        } else {
            selectDefaultPageIfNeeded(wsId)
        }
    }

    private fun requestDriveReconnect(source: String, message: String) {
        _uiState.update {
            it.copy(
                syncError = message,
                driveReconnectUrl = buildDriveReconnectUrl(source),
                lastErrorRequestId = null,
            )
        }
    }

    private fun mapPageLoadError(result: PageLoadResult.Failure): String {
        val app = getApplication<Application>()
        val base = when (result.code) {
            PageErrorCodes.AUTH_REQUIRED -> app.getString(R.string.error_unauthorized)
            PageErrorCodes.PAGE_NOT_FOUND,
            PageErrorCodes.PAGE_NOT_FOUND_LOCAL -> app.getString(R.string.error_page_not_found)
            PageErrorCodes.DRIVE_RECONNECT_REQUIRED -> app.getString(R.string.error_drive_reconnect_required)
            PageErrorCodes.DRIVE_PERMISSION_DENIED -> app.getString(R.string.error_drive_permission_denied)
            PageErrorCodes.DRIVE_FILE_NOT_FOUND -> app.getString(R.string.error_drive_file_not_found)
            PageErrorCodes.DRIVE_FILE_TRASHED -> app.getString(R.string.error_drive_file_trashed)
            PageErrorCodes.DRIVE_RATE_LIMITED -> app.getString(R.string.error_drive_rate_limited)
            PageErrorCodes.UNSUPPORTED_MIME_TYPE -> app.getString(R.string.error_drive_unsupported_mime)
            PageErrorCodes.EMPTY_DRIVE_RESPONSE -> app.getString(R.string.error_drive_empty_response)
            PageErrorCodes.API_INVALID_RESPONSE -> app.getString(R.string.error_api_invalid_response)
            PageErrorCodes.INTERNAL_ERROR -> app.getString(R.string.error_internal_server)
            else -> result.userMessage.ifBlank { app.getString(R.string.error_internal_server) }
        }
        return if (result.requestId.isNullOrBlank()) base else "$base (req: ${result.requestId})"
    }

    private fun parseApiError(raw: String, fallback: String): String {
        if (raw.isBlank()) return fallback
        if (isHtmlResponse(raw)) return nonJsonApiMessage(fallback)
        return runCatching {
            val error = apiJson.decodeFromString<Map<String, String>>(raw)["error"]
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

    private fun normalizeWikiSlug(slug: String): String {
        val decoded = runCatching { java.net.URLDecoder.decode(slug, "UTF-8") }.getOrDefault(slug)
        val trimmed = decoded.trim().removePrefix("/").substringBefore("#")
        if (trimmed.isBlank()) return trimmed
        if (trimmed.endsWith(".md")) return trimmed
        return "$trimmed.md"
    }

    private fun resolvePageSlug(rawSlug: String): PageEntity? {
        val normalized = normalizeWikiSlug(rawSlug)
        return pages.value.find { it.slug == normalized }
            ?: pages.value.find { it.slug == rawSlug }
            ?: pages.value.find { page -> matchesWikiAlias(page, rawSlug) }
    }

    private fun matchesWikiAlias(page: PageEntity, rawSlug: String): Boolean {
        val target = canonicalWikiAlias(rawSlug)
        if (target.isBlank()) return false
        val pageSlug = page.slug.removeSuffix(".md")
        val slugBasename = pageSlug.substringAfterLast('/')
        val title = page.title.orEmpty()
        return canonicalWikiAlias(pageSlug) == target ||
            canonicalWikiAlias(slugBasename) == target ||
            canonicalWikiAlias(title) == target
    }

    private fun canonicalWikiAlias(value: String): String =
        value
            .trim()
            .removePrefix("/")
            .substringBefore("#")
            .removeSuffix(".md")
            .substringAfterLast('/')
            .lowercase()
            .replace("&", "and")
            .replace(Regex("[\\s_\\-()]+"), "")

    private fun unauthorizedMessage(): String =
        getApplication<Application>().getString(R.string.error_unauthorized)

    private fun Throwable.toUserFacingMessage(fallback: String): String {
        val detail = message ?: return fallback
        return if (isSupabaseAuthProblem()) {
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

    private fun webApiUrl(path: String) =
        com.llmwiki.BuildConfig.WEB_API_BASE_URL.trimEnd('/') + path

    private fun String.encodeUrl() =
        java.net.URLEncoder.encode(this, "UTF-8").replace("+", "%20")

    private fun String.encodePathSegments(): String =
        split('/').joinToString("/") { it.encodeUrl() }

    private fun currentUiLocale(): String {
        val primary = getApplication<Application>().resources.configuration.locales[0]
            ?.toLanguageTag()
            .orEmpty()
        return if (primary.startsWith("en", ignoreCase = true)) "en" else "zh-TW"
    }

    private suspend fun sendAuthorizedRequest(
        request: suspend (String) -> HttpResponse,
    ): HttpResponse? {
        var accessToken = supabase.requireAccessToken(forceRefresh = false)
            ?: supabase.requireAccessToken(forceRefresh = true)
            ?: return null
        var response = request(accessToken)
        if (response.status.value == 401) {
            accessToken = supabase.requireAccessToken(forceRefresh = true) ?: return response
            response = request(accessToken)
        }
        return response
    }

    private fun reorderWorkspace(workspace: WorkspaceRow, delta: Int) {
        val current = _uiState.value.workspaces
        val fromIndex = current.indexOfFirst { it.id == workspace.id }
        val toIndex = fromIndex + delta
        if (fromIndex < 0 || toIndex !in current.indices) return

        val reordered = current.toMutableList().apply {
            add(toIndex, removeAt(fromIndex))
        }

        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    workspaces = reordered,
                    workspace = reordered.firstOrNull { item -> item.id == _uiState.value.workspace?.id },
                    workspaceActionLoading = true,
                    syncError = null,
                )
            }

            try {
                val bodyJson = buildJsonObject {
                    put("workspace_ids", buildJsonArray {
                        reordered.forEach { add(JsonPrimitive(it.id)) }
                    })
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.patch(webApiUrl("/api/workspaces/reorder")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: run {
                    _uiState.update {
                        it.copy(
                            workspaces = current,
                            workspaceActionLoading = false,
                            syncError = unauthorizedMessage(),
                        )
                    }
                    return@launch
                }
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    _uiState.update {
                        it.copy(
                            workspaces = current,
                            workspaceActionLoading = false,
                            syncError = parseApiError(text, str(R.string.error_op_reorder_workspace)),
                        )
                    }
                    return@launch
                }

                _uiState.update { it.copy(workspaceActionLoading = false, syncError = null) }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        workspaces = current,
                        workspaceActionLoading = false,
                        syncError = e.toUserFacingMessage(str(R.string.error_op_reorder_workspace)),
                    )
                }
            }
        }
    }
}

private data class StreamMeta(
    val text: String,
    val citedSlugs: List<String>,
    val proposals: List<ActionProposal>,
)

@kotlinx.serialization.Serializable
private data class ProposalWire(
    val action: String,
    val params: Map<String, String> = emptyMap(),
    val label: String = "",
)

/**
 * Parses trailing NUL-delimited metadata blocks appended to the query stream
 * (NUL + CITATIONS + NUL + json, then NUL + ACTIONS + NUL + json).
 * Unknown block names are ignored for forward compatibility.
 */
private fun parseStreamMeta(raw: String): StreamMeta {
    val nul = 0.toChar()
    val blockRegex = Regex("$nul([A-Z_]+)$nul")
    val matches = blockRegex.findAll(raw).toList()
    if (matches.isEmpty()) return StreamMeta(raw, emptyList(), emptyList())

    val text = raw.substring(0, matches.first().range.first)
    var cited: List<String> = emptyList()
    var proposals: List<ActionProposal> = emptyList()
    matches.forEachIndexed { i, match ->
        val start = match.range.last + 1
        val end = if (i + 1 < matches.size) matches[i + 1].range.first else raw.length
        val jsonPart = raw.substring(start, end).trim()
        runCatching {
            when (match.groupValues[1]) {
                "CITATIONS" -> cited = Json.decodeFromString<List<String>>(jsonPart)
                "ACTIONS" -> proposals = Json { ignoreUnknownKeys = true }
                    .decodeFromString<List<ProposalWire>>(jsonPart)
                    .map { ActionProposal(action = it.action, params = it.params, label = it.label) }
            }
        }
    }
    return StreamMeta(text, cited, proposals)
}
