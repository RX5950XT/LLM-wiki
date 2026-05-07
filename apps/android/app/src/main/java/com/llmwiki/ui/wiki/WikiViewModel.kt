package com.llmwiki.ui.wiki

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.llmwiki.BuildConfig
import com.llmwiki.R
import com.llmwiki.data.AndroidHttpClient
import com.llmwiki.data.DriveClient
import com.llmwiki.data.LlmProfileRepository
import com.llmwiki.data.LlmProfile
import com.llmwiki.data.PageRepository
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

data class ChatMessage(
    val role: String,
    val content: String,
    val citedSlugs: List<String> = emptyList(),
    val isStreaming: Boolean = false,
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
    val workspaceActionLoading: Boolean = false,
    val ingestLoading: Boolean = false,
    val pageSaveLoading: Boolean = false,
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

    fun init(workspaceIdParam: String?, accountName: String) {
        this.accountName = accountName
        accountNameFlow.value = accountName
        driveClient = DriveClient(getApplication(), accountName)

        refreshWorkspaces(preferredWorkspaceId = workspaceIdParam, syncSelected = true)
        loadProfiles()
    }

    fun refreshAfterForeground() {
        loadProfiles()
        refreshWorkspaces(syncSelected = false)
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
            )
        }
        workspaceId.value = ws.id
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
                            syncError = parseApiError(text, "Failed to rename workspace"),
                        )
                    }
                    return@launch
                }
                if (!isJsonObject(text)) {
                    _uiState.update {
                        it.copy(
                            workspaceActionLoading = false,
                            syncError = nonJsonApiMessage("Failed to rename workspace"),
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
                        syncError = e.toUserFacingMessage("Failed to rename workspace"),
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
                            syncError = parseApiError(text, "Failed to delete workspace"),
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
                            syncError = nonJsonApiMessage("Failed to delete workspace"),
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
                next?.let {
                    syncPagesInternal(it.id)
                    selectDefaultPageIfNeeded(it.id)
                    SyncWorker.schedule(getApplication(), accountName, it.id)
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        workspaceActionLoading = false,
                        syncError = e.toUserFacingMessage("Failed to delete workspace"),
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
            )
        }
        if (page.content == null) loadContent(page)
    }

    fun selectPageBySlug(slug: String) {
        val page = pages.value.find { it.slug == slug } ?: return
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
                _uiState.update { it.copy(syncError = "Page not found: $slug") }
            }
        }
    }

    private fun loadContent(page: PageEntity) {
        viewModelScope.launch {
            try {
                val wsId = workspaceId.value ?: return@launch
                val repo = PageRepository(db, driveClient)
                val content = repo.loadPageContent(wsId, accountName, page.slug)
                _uiState.update { it.copy(pageContent = content, contentLoading = false, syncError = null) }
            } catch (e: Exception) {
                _uiState.update { it.copy(contentLoading = false, syncError = e.toUserFacingMessage("Failed to load page")) }
            }
        }
    }

    fun toggleLock(slug: String, currentLocked: Boolean) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            try {
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.patch(webApiUrl("/api/pages/$wsId/${slug.encodeUrl()}")) {
                        header("Authorization", "Bearer $accessToken")
                        contentType(ContentType.Application.Json)
                        setBody("""{"locked_by_human":${!currentLocked}}""")
                    }
                } ?: return@launch
                val text = response.bodyAsText()

                if (response.status.value !in 200..299) {
                    _uiState.update {
                        it.copy(syncError = parseApiError(text, "Failed to update page lock"))
                    }
                    return@launch
                }

                db.pageDao().updateLock(wsId, accountName, slug, !currentLocked)
                _uiState.update { state ->
                    if (state.activePage?.slug == slug) {
                        state.copy(
                            activePage = state.activePage.copy(lockedByHuman = !currentLocked),
                            syncError = null,
                        )
                    } else {
                        state.copy(syncError = null)
                    }
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(syncError = e.toUserFacingMessage("Failed to update page lock")) }
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
                        syncError = parseApiError(text, "Search failed"),
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
            _uiState.update { it.copy(searchLoading = false, syncError = e.toUserFacingMessage("Search failed")) }
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

    fun sendQuery(userText: String) {
        if (userText.isBlank()) return
        val wsId = workspaceId.value ?: return

        val userMsg = ChatMessage(role = "user", content = userText)
        val history = _uiState.value.chatMessages
        val newHistory = history + userMsg
        val placeholder = ChatMessage(role = "assistant", content = "", isStreaming = true)
        _uiState.update {
            it.copy(
                chatMessages = newHistory + placeholder,
                chatLoading = true,
                synthesisSavedSlug = null,
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
                    val message = parseApiError(response.bodyAsText(), "Query failed")
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
                    val displayText = if (raw.contains(citationDelimiter)) {
                        raw.substring(0, raw.lastIndexOf(citationDelimiter))
                    } else {
                        raw.toString()
                    }
                    _uiState.update { state ->
                        val messages = state.chatMessages.dropLast(1) +
                            placeholder.copy(content = displayText.trimEnd())
                        state.copy(chatMessages = messages)
                    }
                }

                val (text, slugs) = parseCitations(raw.toString())
                _uiState.update { state ->
                    val final = ChatMessage(role = "assistant", content = text.trimEnd(), citedSlugs = slugs)
                    state.copy(
                        chatMessages = state.chatMessages.dropLast(1) + final,
                        chatLoading = false,
                        syncError = null,
                    )
                }
            } catch (e: Exception) {
                _uiState.update { state ->
                    state.copy(
                        chatMessages = state.chatMessages.dropLast(1),
                        chatLoading = false,
                        syncError = e.toUserFacingMessage("Query failed"),
                    )
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
                    val message = parseApiError(text, "Failed to save synthesis")
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
                _uiState.update { it.copy(syncError = e.toUserFacingMessage("Failed to save synthesis")) }
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
                    AndroidHttpClient.instance.patch(webApiUrl("/api/pages/$wsId/${slug.encodeUrl()}")) {
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
                            syncError = parseApiError(text, "Failed to save page"),
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
                        syncError = e.toUserFacingMessage("Failed to save page"),
                    )
                }
                onDone(false)
            }
        }
    }

    fun runLint(onDone: (Boolean) -> Unit = {}) {
        val wsId = workspaceId.value ?: return
        viewModelScope.launch {
            try {
                val bodyJson = buildJsonObject {
                    put("workspace_id", wsId)
                }.toString()
                val response = sendAuthorizedRequest { accessToken ->
                    AndroidHttpClient.instance.post(webApiUrl("/api/lint")) {
                        header("Authorization", "Bearer $accessToken")
                        header("x-llm-wiki-locale", currentUiLocale())
                        contentType(ContentType.Application.Json)
                        setBody(bodyJson)
                    }
                } ?: return@launch
                val text = response.bodyAsText()
                if (response.status.value !in 200..299) {
                    _uiState.update { it.copy(syncError = parseApiError(text, "Lint failed")) }
                    onDone(false)
                    return@launch
                }

                syncPages()
                onDone(true)
            } catch (e: Exception) {
                _uiState.update { it.copy(syncError = e.toUserFacingMessage("Lint failed")) }
                onDone(false)
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

    fun ingestUrl(url: String, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            _uiState.update { it.copy(ingestLoading = true) }
            try {
                val requestBody = buildJsonObject {
                    put("kind", "url")
                    put("url", url)
                    put("workspace_id", wsId)
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
                _uiState.update { it.copy(syncError = e.toUserFacingMessage("Ingest failed")) }
                onDone(false)
            } finally {
                _uiState.update { it.copy(ingestLoading = false) }
            }
        }
    }

    fun ingestText(title: String, content: String, onDone: (Boolean) -> Unit) {
        viewModelScope.launch {
            val wsId = workspaceId.value ?: return@launch
            _uiState.update { it.copy(ingestLoading = true) }
            try {
                val requestBody = buildJsonObject {
                    put("kind", "text")
                    put("title", title)
                    put("content", content)
                    put("workspace_id", wsId)
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
                _uiState.update { it.copy(syncError = e.toUserFacingMessage("Ingest failed")) }
                onDone(false)
            } finally {
                _uiState.update { it.copy(ingestLoading = false) }
            }
        }
    }

    private suspend fun handleIngestResult(
        wsId: String,
        statusCode: Int,
        raw: String,
        onDone: (Boolean) -> Unit,
    ) {
        if (statusCode in 200..299) {
            _uiState.update { it.copy(syncError = null) }
            syncPagesInternal(wsId)
            selectDefaultPageIfNeeded(wsId)
            onDone(true)
            return
        }

        val message = parseApiError(raw, "Ingest failed")
        if (statusCode == 403 && isDriveReconnectError(message)) {
            requestDriveReconnect("ingest", message)
        } else {
            _uiState.update { it.copy(syncError = message) }
        }
        onDone(false)
    }

    private fun refreshWorkspaces(
        preferredWorkspaceId: String? = workspaceId.value,
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

                if (targetId != null) {
                    if (syncSelected || targetId != previousId) {
                        syncPagesInternal(targetId)
                        selectDefaultPageIfNeeded(targetId)
                    }
                    SyncWorker.schedule(getApplication(), accountName, targetId)
                }
            } catch (e: Exception) {
                _uiState.update { it.copy(syncError = e.toUserFacingMessage("Failed to load workspaces")) }
            }
        }
    }

    private suspend fun syncPagesInternal(wsId: String) {
        try {
            val repo = PageRepository(db, driveClient)
            repo.syncPages(wsId, accountName, currentUiLocale())
            val activeSlug = _uiState.value.activePage?.slug
            if (activeSlug != null) {
                val updatedPage = db.pageDao().getPage(wsId, accountName, activeSlug)
                if (updatedPage != null) {
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
            } else {
                _uiState.update { it.copy(syncError = null) }
            }
        } catch (e: Exception) {
            _uiState.update { it.copy(syncError = e.toUserFacingMessage("Sync failed")) }
        }
    }

    private suspend fun selectDefaultPageIfNeeded(wsId: String) {
        val active = _uiState.value.activePage
        if (active?.workspaceId == wsId) return

        val page = db.pageDao().getPage(wsId, accountName, "index.md")
            ?: db.pageDao().getPage(wsId, accountName, "log.md")
            ?: return
        selectPage(page)
    }

    private fun requestDriveReconnect(source: String, message: String) {
        _uiState.update {
            it.copy(
                syncError = message,
                driveReconnectUrl = buildDriveReconnectUrl(source),
            )
        }
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
                            syncError = parseApiError(text, "Failed to reorder workspace"),
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
                        syncError = e.toUserFacingMessage("Failed to reorder workspace"),
                    )
                }
            }
        }
    }
}

private fun parseCitations(raw: String): Pair<String, List<String>> {
    val delimiter = "\u0000CITATIONS\u0000"
    val idx = raw.lastIndexOf(delimiter)
    if (idx < 0) return raw to emptyList()
    val text = raw.substring(0, idx)
    val jsonPart = raw.substring(idx + delimiter.length).trim()
    return try {
        text to Json.decodeFromString<List<String>>(jsonPart)
    } catch (_: Exception) {
        text to emptyList()
    }
}
