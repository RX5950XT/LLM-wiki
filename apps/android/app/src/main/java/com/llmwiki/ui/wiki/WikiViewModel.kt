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
import com.llmwiki.data.GraphInsights
import com.llmwiki.data.RawSourceCitation
import com.llmwiki.data.PageLinkRow
import com.llmwiki.data.WikiTargetRow
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
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.forms.ChannelProvider
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.HttpHeaders
import io.ktor.http.Headers
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
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
import io.ktor.utils.io.jvm.javaio.toByteReadChannel
import android.net.Uri
import java.io.FilterInputStream
import java.io.InputStream

/**
 * A deep reorganisation is cut off by the server's 300s invocation limit, so a
 * pass reports `more_work` and the client chains the next one. Keep in step with
 * the Web client's MAX_MAINTENANCE_PASSES.
 */
private const val MAX_MAINTENANCE_PASSES = 6

const val QUERY_MODE_STANDARD = "standard"
const val QUERY_MODE_FAITHFUL = "faithful"
private const val MAX_IMPORT_BYTES = 2L * 1024L * 1024L

data class ChatMessage(
    val role: String,
    val content: String,
    val citedSlugs: List<String> = emptyList(),
    val isStreaming: Boolean = false,
    val proposals: List<ActionProposal> = emptyList(),
    val rawCitations: List<RawSourceCitation> = emptyList(),
    val queryMode: String = QUERY_MODE_STANDARD,
)

/** Destructive action the AI proposed; executes only after the user confirms. */
data class ActionProposal(
    val action: String,
    val params: Map<String, String>,
    val label: String,
    val status: String = "pending", // pending | running | done | error | dismissed
    val error: String? = null,
)

data class IngestJobActionFailure(
    val jobId: String,
    val action: String,
    val message: String,
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
    /** Imports running server-side right now (survives closing the app). */
    val activeIngestCount: Int = 0,
    val activeIngestPages: Int = 0,
    /** Finished / failed jobs in the same batch window as the running ones (Web parity). */
    val activeIngestDone: Int = 0,
    val activeIngestFailed: Int = 0,
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
    /** The routed workspace was created by the router (nothing existing fit) */
    val ingestRoutedCreated: Boolean = false,
    /** The background maintenance job (health check + dedupe) is running */
    val organizeRunning: Boolean = false,
    /** Pages / workspaces changed so far by the running maintenance job */
    val maintenanceChanges: Int = 0,
    /** Source id currently being re-ingested (null = none) */
    val reingestingSourceId: String? = null,
    val selectedQueryMode: String = QUERY_MODE_STANDARD,
    val ingestJobs: List<IngestJobRow> = emptyList(),
    val ingestJobsLoading: Boolean = false,
    val ingestJobActionLoadingId: String? = null,
    val ingestJobActionFailure: IngestJobActionFailure? = null,
    val graphInsights: GraphInsights? = null,
    val graphInsightsLoading: Boolean = false,
    val graphInsightsError: String? = null,
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
        watchRunningIngests()
    }

    /**
     * Imports keep running server-side after the app is closed, so the banner is
     * derived from the jobs table rather than from anything this process remembers:
     * kill the app mid-import, come back, and the progress is still on screen.
     * (Web reads the same rows — see workspace-shell.tsx.)
     */
    private var ingestWatchJob: Job? = null

    private fun watchRunningIngests() {
        if (ingestWatchJob?.isActive == true) return
        ingestWatchJob = viewModelScope.launch {
            var hadActive = false
            var watchedWorkspaceId: String? = null
            while (isActive) {
                val wsId = workspaceId.value
                if (wsId != watchedWorkspaceId) {
                    watchedWorkspaceId = wsId
                    hadActive = false
                }
                val jobs = wsId?.let { runCatching { fetchIngestJobs(it) }.getOrNull() }
                if (jobs != null) {
                    val active = jobs.count { it.status == "pending" || it.status == "running" }
                    applyIngestJobs(wsId, jobs)
                    // The last import just landed — pull in what it wrote.
                    if (hadActive && active == 0 && workspaceId.value == wsId) {
                        wsId.let { syncPagesInternal(it, forceSync = true) }
                        refreshWorkspaces(syncSelected = false)
                    }
                    hadActive = active > 0
                }
                delay(if (hadActive) 5_000L else 20_000L)
            }
        }
    }

    private var lastForegroundSyncAt = 0L

    fun refreshAfterForeground() {
        // Queue state is cheap and must be restored even when the broader page
        // sync is throttled after a quick background/foreground transition.
        loadIngestJobs()
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
                ingestJobs = emptyList(),
                graphInsights = null,
                graphInsightsError = null,
            )
        }
        workspaceId.value = ws.id
        persistLastWorkspace(ws)
        loadIngestJobs()
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
        if (page != null) {
            selectPage(page)
            return
        }
        // Not in this workspace — maintenance re-shelves pages across workspaces and
        // leaves every link behind pointing at nothing. The page still exists, so
        // follow it there instead of silently doing nothing (the old behaviour).
        followLinkToOtherWorkspace(slug)
    }

    private fun followLinkToOtherWorkspace(rawSlug: String) {
        viewModelScope.launch {
            val currentId = workspaceId.value
            val target = runCatching {
                supabase.requireAccessToken(forceRefresh = false)
                val others = repository.getWorkspaces().filter { it.id != currentId }
                if (others.isEmpty()) return@runCatching null
                supabase.from("pages")
                    .select(columns = Columns.raw("workspace_id, slug, title")) {
                        filter {
                            isIn("workspace_id", others.map { it.id })
                            eq("zone", "wiki")
                        }
                    }
                    .decodeList<WikiTargetRow>()
                    .let { rows -> pickWikiTarget(rows, rawSlug) }
            }.getOrNull()

            if (target == null) {
                _uiState.update { it.copy(syncError = str(R.string.error_page_not_found)) }
                return@launch
            }
            refreshWorkspaces(
                preferredWorkspaceId = target.workspaceId,
                preferredPageSlug = target.slug,
                syncSelected = true,
            )
        }
    }

    /** Unique alias match on slug, else on title — mirrors the server's link resolver. */
    private fun pickWikiTarget(rows: List<WikiTargetRow>, rawSlug: String): WikiTargetRow? {
        val target = canonicalWikiAlias(rawSlug)
        if (target.isBlank()) return null
        val bySlug = rows.filter { canonicalWikiAlias(it.slug) == target }
        if (bySlug.size == 1) return bySlug.first()
        if (bySlug.size > 1) return null
        val byTitle = rows.filter { !it.title.isNullOrBlank() && canonicalWikiAlias(it.title) == target }
        return byTitle.singleOrNull()
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

    fun setSelectedQueryMode(mode: String) {
        val normalized = mode.takeIf { it == QUERY_MODE_FAITHFUL } ?: QUERY_MODE_STANDARD
        _uiState.update { it.copy(selectedQueryMode = normalized) }
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
        val queryMode = _uiState.value.selectedQueryMode
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
                    put("query_mode", queryMode)
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
                while (!channel.isClosedForRead) {
                    val chunk = channel.readUTF8Line() ?: break
                    raw.append(chunk).append("\n")
                    // Hide any trailing NUL-delimited metadata block while streaming
                    val nulIdx = raw.indexOf('\u0000')
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
                        rawCitations = parsed.rawCitations,
                        proposals = parsed.proposals,
                        queryMode = queryMode,
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
        _uiState.update { it.copy(ingestRoutedName = null, ingestRoutedCreated = false) }
    }

    fun loadIngestJobs() {
        val wsId = workspaceId.value ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(ingestJobsLoading = true) }
            try {
                applyIngestJobs(wsId, fetchIngestJobs(wsId))
            } catch (e: Exception) {
                if (workspaceId.value == wsId) {
                    _uiState.update {
                        it.copy(syncError = e.toUserFacingMessage(str(R.string.error_op_load_ingest_jobs)))
                    }
                }
            } finally {
                if (workspaceId.value == wsId) {
                    _uiState.update { it.copy(ingestJobsLoading = false) }
                }
            }
        }
    }

    fun updateIngestJob(jobId: String, action: String) {
        if (action !in setOf("pause", "resume", "retry")) return
        viewModelScope.launch {
            _uiState.update {
                it.copy(
                    ingestJobActionLoadingId = jobId,
                    ingestJobActionFailure = null,
                )
            }
            try {
                val body = buildJsonObject {
                    put("job_id", jobId)
                    put("action", action)
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.patch(webApiUrl("/api/ingest")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody(body)
                    }
                } ?: throw IllegalStateException(unauthorizedMessage())
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    throw IllegalStateException(parseApiError(text, str(R.string.error_op_update_ingest_job)))
                }
                _uiState.update {
                    it.copy(
                        ingestJobActionLoadingId = null,
                        ingestJobActionFailure = null,
                        syncError = null,
                    )
                }
                loadIngestJobs()
            } catch (e: Exception) {
                val message = e.toUserFacingMessage(str(R.string.error_op_update_ingest_job))
                _uiState.update {
                    it.copy(
                        ingestJobActionLoadingId = null,
                        ingestJobActionFailure = IngestJobActionFailure(jobId, action, message),
                        syncError = message,
                    )
                }
            }
        }
    }

    fun clearIngestJobActionError() {
        _uiState.update { state ->
            val failure = state.ingestJobActionFailure
            state.copy(
                ingestJobActionFailure = null,
                syncError = if (failure != null && state.syncError == failure.message) {
                    null
                } else {
                    state.syncError
                },
            )
        }
    }

    private suspend fun fetchIngestJobs(wsId: String): List<IngestJobRow> {
        val response = sendAuthorizedRequest { accessToken ->
            AndroidHttpClient.instance.get(webApiUrl("/api/ingest?workspace_id=$wsId")) {
                header("Authorization", "Bearer $accessToken")
            }
        } ?: throw IllegalStateException(unauthorizedMessage())
        val text = response.bodyAsText()
        if (response.status.value !in 200..299) {
            throw IllegalStateException(parseApiError(text, str(R.string.error_op_load_ingest_jobs)))
        }
        return decodeIngestJobs(text)
    }

    private fun applyIngestJobs(requestedWorkspaceId: String, jobs: List<IngestJobRow>) {
        if (workspaceId.value != requestedWorkspaceId) return
        val active = jobs.filter { it.status == "pending" || it.status == "running" }
        _uiState.update {
            it.copy(
                ingestJobs = jobs,
                activeIngestCount = active.size,
                activeIngestPages = active.sumOf { job -> job.touchedPages.size },
                activeIngestDone = jobs.count { it.status == "done" },
                activeIngestFailed = jobs.count { it.status == "failed" },
            )
        }
    }

    private fun decodeIngestJobs(raw: String): List<IngestJobRow> {
        val root = apiJson.parseToJsonElement(raw)
        val candidates = when (root) {
            is JsonArray -> root
            else -> {
                val jsonObject = root.jsonObject
                val data = jsonObject["data"]
                when {
                    jsonObject["jobs"] is JsonArray -> jsonObject["jobs"] as JsonArray
                    data is JsonArray -> data
                    data?.jsonObject?.get("jobs") is JsonArray -> data.jsonObject["jobs"] as JsonArray
                    else -> JsonArray(emptyList())
                }
            }
        }
        return candidates.mapNotNull { element ->
            runCatching {
                val jsonObject = element.jsonObject.toMutableMap()
                val source = jsonObject["source"]?.jsonObject
                if (jsonObject["source_title"] == null) source?.get("title")?.let { jsonObject["source_title"] = it }
                if (jsonObject["source_mime_type"] == null) {
                    source?.get("mime_type")?.let { jsonObject["source_mime_type"] = it }
                }
                apiJson.decodeFromJsonElement(
                    IngestJobRow.serializer(),
                    buildJsonObject { jsonObject.forEach { (key, value) -> put(key, value) } },
                )
            }.getOrNull()
        }.filter { it.id != null || it.sourceId.isNotBlank() }
    }

    fun loadGraphInsights() {
        val wsId = workspaceId.value ?: return
        viewModelScope.launch {
            _uiState.update { it.copy(graphInsightsLoading = true, graphInsightsError = null) }
            try {
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.get(webApiUrl("/api/graph/insights?workspace_id=$wsId")) {
                        header("Authorization", "Bearer $accessToken")
                    }
                } ?: throw IllegalStateException(unauthorizedMessage())
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    throw IllegalStateException(parseApiError(text, str(R.string.error_op_graph_insights)))
                }
                val root = apiJson.parseToJsonElement(text).jsonObject
                val data = root["data"] ?: root
                val insights = apiJson.decodeFromJsonElement(GraphInsights.serializer(), data)
                if (workspaceId.value == wsId) {
                    _uiState.update { it.copy(graphInsights = insights, graphInsightsError = null) }
                }
            } catch (e: Exception) {
                if (workspaceId.value == wsId) {
                    _uiState.update {
                        it.copy(graphInsightsError = e.toUserFacingMessage(str(R.string.error_op_graph_insights)))
                    }
                }
            } finally {
                if (workspaceId.value == wsId) {
                    _uiState.update { it.copy(graphInsightsLoading = false) }
                }
            }
        }
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
                    .select(columns = Columns.raw("source_id,status,error,touched_pages,started_at,updated_at")) {
                        filter { eq("workspace_id", wsId) }
                        order("updated_at", order = Order.DESCENDING)
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
                _uiState.update { it.copy(reingestingSourceId = null) }
                loadSources()
                loadIngestJobs()
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
            _uiState.update {
                it.copy(
                    ingestLoading = true,
                    ingestProgress = 0,
                    ingestRoutedName = null,
                    ingestRoutedCreated = false,
                )
            }
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
            if (content.toByteArray(Charsets.UTF_8).size.toLong() > MAX_IMPORT_BYTES) {
                _uiState.update { it.copy(syncError = str(R.string.error_import_file_too_large)) }
                onDone(false)
                return@launch
            }
            _uiState.update {
                it.copy(
                    ingestLoading = true,
                    ingestProgress = 0,
                    ingestRoutedName = null,
                    ingestRoutedCreated = false,
                )
            }
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

    fun ingestFile(
        uri: Uri,
        title: String,
        mimeType: String,
        autoRoute: Boolean = true,
        onDone: (Boolean) -> Unit,
    ) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            _uiState.update {
                it.copy(
                    ingestLoading = true,
                    ingestProgress = 0,
                    ingestRoutedName = null,
                    ingestRoutedCreated = false,
                )
            }
            try {
                val byteSize = countImportBytes(uri)
                val safeTitle = title
                    .ifBlank { str(R.string.wiki_imported_file) }
                    .toSafeUploadName()
                    .withImportExtension(mimeType)
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/ingest")) {
                        header("Authorization", "Bearer $accessToken")
                        header("x-llm-wiki-locale", currentUiLocale())
                        setBody(MultiPartFormDataContent(formData {
                            append("kind", "file")
                            append("title", safeTitle)
                            if (autoRoute) {
                                append("auto_route", "true")
                                append("fallback_workspace_id", wsId)
                            } else {
                                append("workspace_id", wsId)
                            }
                            _uiState.value.selectedProfileId?.let { append("profile_id", it) }
                            val contentType = safeTitle.toImportMimeType(mimeType)
                            append(
                                "file",
                                ChannelProvider(byteSize) {
                                    val stream = getApplication<Application>().contentResolver.openInputStream(uri)
                                        ?: throw IllegalArgumentException("Unable to open selected file")
                                    CountingImportInputStream(stream).toByteReadChannel()
                                },
                                Headers.build {
                                    append(
                                        HttpHeaders.ContentDisposition,
                                        "form-data; name=\"file\"; filename=\"" + safeTitle + "\"",
                                    )
                                    append(HttpHeaders.ContentType, contentType)
                                },
                            )
                        }))
                    }
                } ?: run {
                    _uiState.update { it.copy(syncError = unauthorizedMessage()) }
                    onDone(false)
                    return@launch
                }
                handleIngestResult(wsId, response.status.value, response.bodyAsText(), onDone)
            } catch (e: ImportTooLargeException) {
                _uiState.update { it.copy(syncError = str(R.string.error_import_file_too_large)) }
                onDone(false)
            } catch (e: Exception) {
                val message = if (e.hasImportTooLargeCause()) {
                    str(R.string.error_import_file_too_large)
                } else {
                    e.toUserFacingMessage(str(R.string.error_import_file_unreadable))
                }
                _uiState.update { it.copy(syncError = message) }
                onDone(false)
            } finally {
                _uiState.update { it.copy(ingestLoading = false, ingestProgress = 0) }
            }
        }
    }

    private suspend fun countImportBytes(uri: Uri): Long = withContext(Dispatchers.IO) {
        val stream = getApplication<Application>().contentResolver.openInputStream(uri)
            ?: throw IllegalArgumentException("Unable to open selected file")
        stream.use { input ->
            val buffer = ByteArray(32 * 1024)
            var total = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > MAX_IMPORT_BYTES) throw ImportTooLargeException()
            }
            total
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

        // Async ingest protocol: the server owns the queue. Keep the client request
        // short and let the durable job list/poller report progress after this returns.
        val bodyJson = if (isJsonObject(raw)) {
            runCatching { apiJson.parseToJsonElement(raw).jsonObject }.getOrNull()
        } else null
        val initialStatus = bodyJson?.get("status")?.jsonPrimitive?.contentOrNull
        val routedWorkspaceId = bodyJson?.get("routed_workspace_id")?.jsonPrimitive?.contentOrNull
        val jobId = bodyJson?.get("jobId")?.jsonPrimitive?.contentOrNull
        if (bodyJson == null || jobId.isNullOrBlank() || initialStatus.isNullOrBlank()) {
            _uiState.update { it.copy(syncError = nonJsonApiMessage(str(R.string.error_op_ingest))) }
            onDone(false)
            return
        }
        // Auto-routed ingest: surface which workspace the AI picked
        val routedCreated = bodyJson?.get("routed_workspace_created")?.jsonPrimitive?.booleanOrNull ?: false
        bodyJson?.get("routed_workspace_name")?.jsonPrimitive?.contentOrNull?.let { routedName ->
            _uiState.update { it.copy(ingestRoutedName = routedName, ingestRoutedCreated = routedCreated) }
        }

        _uiState.update { it.copy(syncError = null) }
        val targetWorkspaceId = routedWorkspaceId ?: wsId
        if (targetWorkspaceId != wsId || routedCreated) {
            // The old client ignored routed_workspace_id and kept showing the fallback
            // workspace. Follow the server's decision, including a newly created one.
            refreshWorkspaces(preferredWorkspaceId = targetWorkspaceId, syncSelected = true)
        } else if (initialStatus == "done") {
            // A duplicate source can be returned as already done/unchanged.
            syncPagesInternal(targetWorkspaceId, forceSync = true)
            selectDefaultPageIfNeeded(targetWorkspaceId)
        }
        loadIngestJobs()
        onDone(true)
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
                if (targetId != null) loadIngestJobs()

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

private class ImportTooLargeException : Exception()

private class CountingImportInputStream(input: InputStream) : FilterInputStream(input) {
    private var bytesRead = 0L

    override fun read(): Int {
        val value = super.read()
        if (value >= 0) count(1)
        return value
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        val readCount = super.read(buffer, offset, length)
        if (readCount > 0) count(readCount)
        return readCount
    }

    private fun count(amount: Int) {
        bytesRead += amount
        if (bytesRead > MAX_IMPORT_BYTES) throw ImportTooLargeException()
    }
}

private fun Throwable.hasImportTooLargeCause(): Boolean =
    generateSequence(this) { it.cause }.any { it is ImportTooLargeException }

private fun String.toSafeUploadName(): String =
    trim()
        .replace(Regex("[\\\"\\r\\n\\\\/]"), "_")
        .take(120)
        .ifBlank { "imported-file" }

private fun String.toImportMimeType(declaredMime: String): String {
    val extensionMime = when (substringAfterLast('.', missingDelimiterValue = "").lowercase()) {
        "txt", "md", "markdown" -> "text/plain"
        "pdf" -> "application/pdf"
        "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        "pptx" -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        "epub" -> "application/epub+zip"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        else -> null
    }
    if (extensionMime != null) return extensionMime
    return declaredMime.substringBefore(';').trim().lowercase().ifBlank { "application/octet-stream" }
}

private fun String.withImportExtension(declaredMime: String): String {
    val extension = substringAfterLast('.', missingDelimiterValue = "").lowercase()
    val known = setOf("txt", "md", "markdown", "pdf", "docx", "pptx", "epub", "png", "jpg", "jpeg", "webp", "gif")
    if (extension in known) return this
    val fallback = when (declaredMime.substringBefore(';').trim().lowercase()) {
        "text/plain" -> "txt"
        "text/markdown" -> "md"
        "application/pdf" -> "pdf"
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" -> "docx"
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" -> "pptx"
        "application/epub+zip" -> "epub"
        "image/png" -> "png"
        "image/jpeg" -> "jpg"
        "image/webp" -> "webp"
        "image/gif" -> "gif"
        else -> null
    }
    if (fallback == null) return this
    val baseLength = (120 - fallback.length - 1).coerceAtLeast(1)
    return buildString {
        append(take(baseLength).trimEnd('.'))
        append('.')
        append(fallback)
    }
}
