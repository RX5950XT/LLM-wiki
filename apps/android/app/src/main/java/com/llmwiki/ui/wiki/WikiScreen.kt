package com.llmwiki.ui.wiki

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Help
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.ChatBubbleOutline
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberDrawerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.viewmodel.compose.viewModel
import com.llmwiki.R
import com.llmwiki.data.parseDriveReconnectSource
import com.llmwiki.data.LlmProfile
import com.llmwiki.data.SearchResult
import com.llmwiki.data.WorkspaceRow
import com.llmwiki.data.room.PageEntity
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WikiScreen(
    workspaceId: String?,
    initialPageSlug: String? = null,
    accountName: String,
    shareUrl: String? = null,
    authReturnUri: String? = null,
    modifier: Modifier = Modifier,
    onNavigateToSettings: (String?) -> Unit = {},
    onNavigateToCreateWorkspace: () -> Unit = {},
    onSignedOut: () -> Unit = {},
    wikiViewModel: WikiViewModel = viewModel(),
) {
    val uiState by wikiViewModel.uiState.collectAsState()
    val pages by wikiViewModel.pages.collectAsState()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    var showIngestDialog by remember { mutableStateOf(false) }
    var pendingShareUrl by remember { mutableStateOf<String?>(null) }
    var showChatSheet by remember { mutableStateOf(false) }
    var showWorkspaceMenu by remember { mutableStateOf(false) }
    var showActiveNoteMenu by remember { mutableStateOf(false) }
    var showHelpDialog by remember { mutableStateOf(false) }
    var showCreateNoteDialog by remember { mutableStateOf(false) }
    var renameWorkspace by remember { mutableStateOf<WorkspaceRow?>(null) }
    var deleteWorkspace by remember { mutableStateOf<WorkspaceRow?>(null) }
    var renameNote by remember { mutableStateOf<PageEntity?>(null) }
    var deleteNote by remember { mutableStateOf<PageEntity?>(null) }
    var inlineEditorPageSlug by remember { mutableStateOf<String?>(null) }
    var inlineEditorValue by remember { mutableStateOf(TextFieldValue("")) }
    val workspaceArrowRotation by animateFloatAsState(
        targetValue = if (showWorkspaceMenu) 180f else 0f,
        label = "workspace-menu-arrow",
    )
    val snackbarHostState = remember { SnackbarHostState() }
    val searchFocusRequester = remember { FocusRequester() }
    val context = LocalContext.current
    val configuration = LocalConfiguration.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        val fileContent = readTextFromUri(context, uri)
        if (fileContent.isNullOrBlank()) {
            scope.launch {
                snackbarHostState.showSnackbar(context.getString(R.string.wiki_snack_ingest_failed))
            }
            return@rememberLauncherForActivityResult
        }
        val fileName = readDisplayName(context, uri)
            ?: context.getString(R.string.wiki_imported_file)
        wikiViewModel.ingestText(fileName, fileContent) { success ->
            scope.launch {
                snackbarHostState.showSnackbar(
                    context.getString(
                        if (success) R.string.wiki_snack_ingest_started
                        else R.string.wiki_snack_ingest_failed,
                    )
                )
            }
        }
    }

    LaunchedEffect(workspaceId, accountName, initialPageSlug) {
        if (accountName.isNotBlank()) wikiViewModel.init(workspaceId, accountName, initialPageSlug)
    }

    LaunchedEffect(configuration.locales.toLanguageTags()) {
        if (accountName.isNotBlank() && uiState.workspace != null) {
            wikiViewModel.syncPages()
        }
    }

    LaunchedEffect(shareUrl) {
        if (!shareUrl.isNullOrBlank()) {
            pendingShareUrl = shareUrl
            showIngestDialog = true
        }
    }

    LaunchedEffect(uiState.activePage?.slug) {
        showActiveNoteMenu = false
        inlineEditorPageSlug = null
    }

    LaunchedEffect(uiState.signedOut) {
        if (uiState.signedOut) onSignedOut()
    }

    LaunchedEffect(uiState.workspacesLoaded, uiState.workspaces.size, accountName) {
        if (accountName.isNotBlank() && uiState.workspacesLoaded && uiState.workspaces.isEmpty()) {
            onNavigateToCreateWorkspace()
        }
    }

    LaunchedEffect(uiState.showSearch) {
        if (uiState.showSearch) {
            runCatching { searchFocusRequester.requestFocus() }
        }
    }

    LaunchedEffect(authReturnUri) {
        val source = parseDriveReconnectSource(authReturnUri)
        if (source == "query" || source == "ingest" || source == "synthesis") {
            wikiViewModel.onDriveReconnectCompleted()
            snackbarHostState.showSnackbar(
                context.getString(R.string.workspace_drive_reconnected)
            )
        }
    }

    DisposableEffect(lifecycleOwner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && accountName.isNotBlank()) {
                wikiViewModel.refreshAfterForeground()
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        gesturesEnabled = !showChatSheet && !showIngestDialog,
        modifier = modifier,
        drawerContent = {
            ModalDrawerSheet(
                drawerContainerColor = MaterialTheme.colorScheme.surface,
                drawerContentColor = MaterialTheme.colorScheme.onSurface,
            ) {
                Spacer(Modifier.height(16.dp))

                Box(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 6.dp),
                ) {
                    OutlinedButton(
                        onClick = { showWorkspaceMenu = true },
                        modifier = Modifier.fillMaxWidth(),
                        shape = MaterialTheme.shapes.medium,
                        colors = ButtonDefaults.outlinedButtonColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant,
                            contentColor = MaterialTheme.colorScheme.onSurface,
                        ),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    text = uiState.workspace?.name ?: stringResource(R.string.wiki_switch_workspace),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Text(
                                    text = stringResource(R.string.wiki_switch_workspace),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Icon(
                                Icons.Default.ArrowDropDown,
                                contentDescription = stringResource(R.string.wiki_switch_workspace),
                                modifier = Modifier.rotate(workspaceArrowRotation),
                            )
                        }
                    }
                    DropdownMenu(
                        expanded = showWorkspaceMenu,
                        onDismissRequest = { showWorkspaceMenu = false },
                        modifier = Modifier.widthIn(min = 280.dp),
                    ) {
                        uiState.workspaces.forEach { workspace ->
                            val selected = workspace.id == uiState.workspace?.id
                            WorkspaceMenuRow(
                                workspaceName = workspace.name,
                                selected = selected,
                                canMoveUp = uiState.workspaces.indexOf(workspace) > 0,
                                canMoveDown = uiState.workspaces.indexOf(workspace) < uiState.workspaces.lastIndex,
                                onSelect = {
                                    showWorkspaceMenu = false
                                    wikiViewModel.switchWorkspace(workspace)
                                    scope.launch { drawerState.close() }
                                },
                                onMoveUp = {
                                    wikiViewModel.moveWorkspaceUp(workspace)
                                },
                                onMoveDown = {
                                    wikiViewModel.moveWorkspaceDown(workspace)
                                },
                                onRename = {
                                    showWorkspaceMenu = false
                                    renameWorkspace = workspace
                                },
                                onDelete = {
                                    showWorkspaceMenu = false
                                    deleteWorkspace = workspace
                                },
                            )
                        }
                        HorizontalDivider(Modifier.padding(vertical = 4.dp))
                        WorkspaceCreateMenuRow(
                            onClick = {
                                showWorkspaceMenu = false
                                scope.launch { drawerState.close() }
                                onNavigateToCreateWorkspace()
                            },
                        )
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 8.dp))

                Box(Modifier.weight(1f)) {
                    if (pages.isEmpty()) {
                        Box(
                            Modifier.fillMaxSize().padding(32.dp),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                stringResource(R.string.wiki_no_pages),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else {
                        val pinnedSlugs = setOf("index.md", "log.md")
                        val pinnedPages = pinnedSlugs.mapNotNull { slug -> pages.firstOrNull { it.slug == slug } }
                        val otherPages = pages.filter { it.slug !in pinnedSlugs }
                        val byZone = otherPages.groupBy { it.zone }
                        val zones = listOf(
                            "wiki" to stringResource(R.string.wiki_zone_wiki),
                            "notes" to stringResource(R.string.wiki_zone_notes),
                        )

                        LazyColumn(Modifier.fillMaxSize()) {
                            // Pinned pages: index.md + log.md always at top
                            if (pinnedPages.isNotEmpty()) {
                                items(pinnedPages, key = { "${it.workspaceId}/${it.accountName}/${it.slug}" }) { page ->
                                    val pinnedLabel = when (page.slug) {
                                        "index.md" -> stringResource(R.string.wiki_index)
                                        else -> stringResource(R.string.wiki_log)
                                    }
                                    PageListItem(
                                        page = page,
                                        label = pinnedLabel,
                                        isSelected = uiState.activePage?.slug == page.slug,
                                        onClick = {
                                            wikiViewModel.selectPage(page)
                                            scope.launch { drawerState.close() }
                                        },
                                        onToggleLock = {
                                            wikiViewModel.toggleLock(page.slug, page.lockedByHuman)
                                        },
                                        onRenameNote = if (page.zone == "notes" && page.slug != "notes/guide.md") {
                                            { renameNote = page }
                                        } else null,
                                        onDeleteNote = if (page.zone == "notes" && page.slug != "notes/guide.md") {
                                            { deleteNote = page }
                                        } else null,
                                    )
                                }
                                item {
                                    HorizontalDivider(Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                                }
                            }

                            // Zone sections
                            zones.forEach { (zone, zoneLabel) ->
                                val zonePages = byZone[zone] ?: emptyList()
                                if (zonePages.isNotEmpty()) {
                                    item {
                                        Text(
                                            text = zoneLabel,
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 2.dp),
                                        )
                                    }
                                    items(zonePages, key = { "${it.workspaceId}/${it.accountName}/${it.slug}" }) { page ->
                                        PageListItem(
                                            page = page,
                                            label = localizedSystemPageLabel(page.slug),
                                            isSelected = uiState.activePage?.slug == page.slug,
                                            onClick = {
                                                wikiViewModel.selectPage(page)
                                                scope.launch { drawerState.close() }
                                            },
                                            onToggleLock = {
                                                wikiViewModel.toggleLock(page.slug, page.lockedByHuman)
                                            },
                                            onRenameNote = if (page.zone == "notes" && page.slug != "notes/guide.md") {
                                                { renameNote = page }
                                            } else null,
                                            onDeleteNote = if (page.zone == "notes" && page.slug != "notes/guide.md") {
                                                { deleteNote = page }
                                            } else null,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }

                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { showHelpDialog = true }) {
                        Icon(
                            Icons.AutoMirrored.Filled.Help,
                            contentDescription = stringResource(R.string.help_title),
                        )
                    }
                    IconButton(onClick = {
                        scope.launch { drawerState.close() }
                        onNavigateToSettings(uiState.workspace?.id)
                    }) {
                        Icon(
                            Icons.Default.Settings,
                            contentDescription = stringResource(R.string.settings_title),
                        )
                    }
                    IconButton(
                        onClick = { wikiViewModel.signOut() },
                        colors = IconButtonDefaults.iconButtonColors(
                            contentColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Icon(
                            Icons.AutoMirrored.Filled.Logout,
                            contentDescription = stringResource(R.string.auth_sign_out),
                        )
                    }
                }
                Spacer(Modifier.height(8.dp))
            }
        },
    ) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background,
            contentColor = MaterialTheme.colorScheme.onBackground,
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = {
                TopAppBar(
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.surface,
                        titleContentColor = MaterialTheme.colorScheme.onSurface,
                        navigationIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        actionIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                    title = {
                        if (uiState.showSearch) {
                            OutlinedTextField(
                                value = uiState.searchQuery,
                                onValueChange = { wikiViewModel.updateSearchQuery(it) },
                                placeholder = { Text(stringResource(R.string.wiki_search_placeholder)) },
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .focusRequester(searchFocusRequester),
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                                keyboardActions = KeyboardActions(onSearch = {}),
                            )
                        } else {
                            Text(
                                uiState.activePage?.let { localizedSystemPageLabel(it.slug) ?: it.title }
                                    ?: uiState.workspace?.name
                                    ?: stringResource(R.string.app_name)
                            )
                        }
                    },
                    navigationIcon = {
                        if (!uiState.showSearch) {
                            IconButton(onClick = { scope.launch { drawerState.open() } }) {
                                Icon(Icons.AutoMirrored.Filled.List, contentDescription = stringResource(R.string.wiki_open_pages))
                            }
                        }
                    },
                    actions = {
                        if (uiState.showSearch) {
                            if (uiState.searchLoading) {
                                CircularProgressIndicator(modifier = Modifier.size(24.dp).padding(end = 4.dp), strokeWidth = 2.dp)
                            }
                            IconButton(onClick = { wikiViewModel.clearSearch() }) {
                                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.wiki_search_close))
                            }
                        } else {
                            val editablePage = uiState.activePage?.takeIf { isHumanEditablePage(it) && uiState.pageContent != null }
                            val activeNote = uiState.activePage?.takeIf { it.zone == "notes" && it.slug != "notes/guide.md" }
                            val isInlineEditing = inlineEditorPageSlug == editablePage?.slug
                            IconButton(onClick = { wikiViewModel.toggleSearch() }) {
                                Icon(Icons.Default.Search, contentDescription = stringResource(R.string.wiki_search))
                            }
                            IconButton(onClick = { showCreateNoteDialog = true }) {
                                Icon(Icons.Default.Add, contentDescription = stringResource(R.string.wiki_create_note))
                            }
                            if (editablePage != null) {
                                if (isInlineEditing) {
                                    IconButton(onClick = {
                                        inlineEditorPageSlug = null
                                        inlineEditorValue = TextFieldValue(uiState.pageContent.orEmpty())
                                    }) {
                                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.action_cancel))
                                    }
                                    IconButton(
                                        onClick = {
                                            wikiViewModel.savePageContent(editablePage.slug, inlineEditorValue.text) { success ->
                                                if (success) {
                                                    inlineEditorPageSlug = null
                                                    scope.launch {
                                                        snackbarHostState.showSnackbar(
                                                            context.getString(R.string.wiki_page_saved)
                                                        )
                                                    }
                                                }
                                            }
                                        },
                                        enabled = !uiState.pageSaveLoading,
                                    ) {
                                        if (uiState.pageSaveLoading) {
                                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                                        } else {
                                            Icon(Icons.Default.Check, contentDescription = stringResource(R.string.action_save))
                                        }
                                    }
                                } else {
                                    IconButton(onClick = {
                                        inlineEditorPageSlug = editablePage.slug
                                        inlineEditorValue = TextFieldValue(uiState.pageContent.orEmpty())
                                    }) {
                                        Icon(Icons.Default.Edit, contentDescription = stringResource(R.string.action_edit))
                                    }
                                }
                            }
                            if (activeNote != null && !isInlineEditing) {
                                Box {
                                    IconButton(onClick = { showActiveNoteMenu = true }) {
                                        Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.workspace_actions))
                                    }
                                    DropdownMenu(
                                        expanded = showActiveNoteMenu,
                                        onDismissRequest = { showActiveNoteMenu = false },
                                    ) {
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.wiki_rename_note)) },
                                            onClick = {
                                                showActiveNoteMenu = false
                                                renameNote = activeNote
                                            },
                                        )
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.wiki_delete_note)) },
                                            onClick = {
                                                showActiveNoteMenu = false
                                                deleteNote = activeNote
                                            },
                                        )
                                    }
                                }
                            }
                            if (uiState.contentLoading) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(24.dp).padding(end = 4.dp),
                                    strokeWidth = 2.dp,
                                )
                            } else {
                                IconButton(onClick = { wikiViewModel.syncPages() }) {
                                    Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.wiki_sync))
                                }
                            }
                        }
                    },
                )
            },
            floatingActionButton = {
                if (!uiState.showSearch) {
                    Column(
                        horizontalAlignment = Alignment.End,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        SmallFloatingActionButton(
                            onClick = { showChatSheet = true },
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                        ) {
                            Icon(Icons.Default.ChatBubbleOutline, contentDescription = stringResource(R.string.wiki_chat))
                        }
                        SmallFloatingActionButton(
                            onClick = { filePickerLauncher.launch(arrayOf("text/*", "application/json", "application/xml", "text/markdown", "text/x-markdown")) },
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                        ) {
                            Icon(Icons.Default.AttachFile, contentDescription = stringResource(R.string.wiki_attach_file))
                        }
                        FloatingActionButton(
                            onClick = { pendingShareUrl = null; showIngestDialog = true },
                            containerColor = MaterialTheme.colorScheme.primary,
                            contentColor = MaterialTheme.colorScheme.onPrimary,
                        ) {
                            Icon(Icons.Default.Add, contentDescription = stringResource(R.string.wiki_ingest_confirm))
                        }
                    }
                }
            },
        ) { innerPadding ->
            Column(Modifier.fillMaxSize().padding(innerPadding)) {
                uiState.syncError?.let { error ->
                    Surface(color = MaterialTheme.colorScheme.errorContainer) {
                        Text(
                            text = error,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth().padding(12.dp),
                        )
                    }
                }

                if (uiState.ingestLoading) {
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(16.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                            )
                            Text(
                                text = stringResource(R.string.ingest_running),
                                color = MaterialTheme.colorScheme.onSecondaryContainer,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }

                if (uiState.showSearch) {
                    SearchResultsPanel(
                        results = uiState.searchResults,
                        query = uiState.searchQuery,
                        isLoading = uiState.searchLoading,
                        onResultClick = { slug ->
                            wikiViewModel.selectSearchResult(slug)
                            scope.launch { drawerState.close() }
                        },
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    )
                } else {
                    when {
                        uiState.activePage == null -> Box(
                            Modifier.weight(1f).fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                if (pages.isEmpty()) stringResource(R.string.wiki_empty_first)
                                else stringResource(R.string.wiki_empty_select),
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        uiState.contentLoading -> Box(
                            Modifier.weight(1f).fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) { CircularProgressIndicator() }
                        inlineEditorPageSlug == uiState.activePage?.slug &&
                            uiState.pageContent != null &&
                            uiState.activePage?.let(::isHumanEditablePage) == true -> InlinePageEditor(
                            value = inlineEditorValue,
                            onValueChange = { inlineEditorValue = it },
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                        uiState.pageContent != null -> MarkdownViewer(
                            markdown = uiState.pageContent!!,
                            onWikiLinkClick = { slug -> wikiViewModel.selectPageBySlug(slug) },
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                        else -> Box(
                            Modifier.weight(1f).fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(stringResource(R.string.wiki_no_content), color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }

    if (showIngestDialog) {
        IngestInputDialog(
            initialText = pendingShareUrl ?: "",
            onDismiss = { showIngestDialog = false; pendingShareUrl = null },
            onConfirm = { text ->
                showIngestDialog = false
                pendingShareUrl = null
                val onDone: (Boolean) -> Unit = { success ->
                    scope.launch {
                        snackbarHostState.showSnackbar(
                            context.getString(
                                if (success) R.string.wiki_snack_ingest_started
                                else R.string.wiki_snack_ingest_failed
                            )
                        )
                    }
                }
                if (isUrl(text)) {
                    wikiViewModel.ingestUrl(text, onDone)
                } else {
                    wikiViewModel.ingestText(
                        extractTitle(text, context.getString(R.string.wiki_untitled)),
                        text,
                        onDone,
                    )
                }
            },
        )
    }

    if (showChatSheet) {
        ChatBottomSheet(
            messages = uiState.chatMessages,
            isLoading = uiState.chatLoading,
            synthesisSavedSlug = uiState.synthesisSavedSlug,
            profiles = uiState.profiles,
            selectedProfileId = uiState.selectedProfileId,
            onProfileSelected = { wikiViewModel.setSelectedProfile(it) },
            onSend = { wikiViewModel.sendQuery(it) },
            onPageClick = { slug ->
                wikiViewModel.selectPageBySlug(slug)
                showChatSheet = false
            },
            onSaveSynthesis = { q, a, slugs -> wikiViewModel.saveSynthesis(q, a, slugs) },
            onClearSynthesis = { wikiViewModel.clearSynthesisSlug() },
            onDismiss = { showChatSheet = false },
        )
    }

    uiState.driveReconnectUrl?.let { reconnectUrl ->
        AlertDialog(
            onDismissRequest = wikiViewModel::dismissDriveReconnectPrompt,
            title = { Text(stringResource(R.string.workspace_drive_reconnect_title)) },
            text = { Text(stringResource(R.string.workspace_drive_reconnect_body)) },
            confirmButton = {
                Button(
                    onClick = {
                        wikiViewModel.dismissDriveReconnectPrompt()
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(reconnectUrl)))
                    },
                ) {
                    Text(stringResource(R.string.workspace_drive_reconnect_action))
                }
            },
            dismissButton = {
                TextButton(onClick = wikiViewModel::dismissDriveReconnectPrompt) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (showHelpDialog) {
        WikiHelpDialog(onDismiss = { showHelpDialog = false })
    }

    if (showCreateNoteDialog) {
        NoteCreateDialog(
            isLoading = uiState.pageSaveLoading,
            onDismiss = { showCreateNoteDialog = false },
            onConfirm = { title ->
                wikiViewModel.createNote(title) { success ->
                    if (success) {
                        showCreateNoteDialog = false
                        scope.launch {
                            snackbarHostState.showSnackbar(
                                context.getString(R.string.wiki_note_created)
                            )
                        }
                    }
                }
            },
        )
    }

    renameNote?.let { page ->
        NoteRenameDialog(
            page = page,
            isLoading = uiState.pageSaveLoading,
            onDismiss = { renameNote = null },
            onConfirm = { title ->
                wikiViewModel.renameNote(page, title) { success ->
                    if (success) renameNote = null
                }
            },
        )
    }

    deleteNote?.let { page ->
        NoteDeleteDialog(
            page = page,
            isLoading = uiState.pageSaveLoading,
            onDismiss = { deleteNote = null },
            onConfirm = {
                wikiViewModel.deleteNote(page) { success ->
                    if (success) deleteNote = null
                }
            },
        )
    }

    renameWorkspace?.let { workspace ->
        WorkspaceRenameDialog(
            workspace = workspace,
            isLoading = uiState.workspaceActionLoading,
            onDismiss = { renameWorkspace = null },
            onConfirm = { newName ->
                wikiViewModel.renameWorkspace(workspace, newName)
                renameWorkspace = null
            },
        )
    }

    deleteWorkspace?.let { workspace ->
        WorkspaceDeleteDialog(
            workspace = workspace,
            isLoading = uiState.workspaceActionLoading,
            onDismiss = { deleteWorkspace = null },
            onConfirm = {
                wikiViewModel.deleteWorkspace(workspace)
                deleteWorkspace = null
            },
        )
    }
}

@Composable
private fun WorkspaceMenuRow(
    workspaceName: String,
    selected: Boolean,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onSelect: () -> Unit,
    onMoveUp: () -> Unit,
    onMoveDown: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    var showActions by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .clickable(onClick = onSelect)
                .padding(vertical = 12.dp),
        ) {
            Text(
                text = workspaceName,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (selected) {
                Text(
                    stringResource(R.string.wiki_current_workspace),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Row(
            modifier = Modifier.widthIn(min = 108.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.End,
        ) {
            if (selected) {
                Icon(
                    Icons.Default.Check,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(10.dp))
            }
            IconButton(
                onClick = { showActions = true },
                modifier = Modifier.size(44.dp),
            ) {
                Icon(
                    Icons.Default.MoreVert,
                    contentDescription = stringResource(R.string.workspace_actions),
                    modifier = Modifier.size(20.dp),
                )
            }
            DropdownMenu(
                expanded = showActions,
                onDismissRequest = { showActions = false },
            ) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workspace_move_up)) },
                    enabled = canMoveUp,
                    onClick = {
                        showActions = false
                        onMoveUp()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workspace_move_down)) },
                    enabled = canMoveDown,
                    onClick = {
                        showActions = false
                        onMoveDown()
                    },
                )
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workspace_rename_title)) },
                    leadingIcon = {
                        Icon(Icons.Default.Edit, contentDescription = null)
                    },
                    onClick = {
                        showActions = false
                        onRename()
                    },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.workspace_delete_title)) },
                    leadingIcon = {
                        Icon(Icons.Default.Delete, contentDescription = null)
                    },
                    onClick = {
                        showActions = false
                        onDelete()
                    },
                )
            }
        }
    }
}

@Composable
private fun WorkspaceCreateMenuRow(
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 72.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.Add, contentDescription = null)
        Spacer(Modifier.width(16.dp))
        Column {
            Text(stringResource(R.string.workspace_create_action))
            Text(
                stringResource(R.string.workspace_create_menu_hint),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun WorkspaceRenameDialog(
    workspace: WorkspaceRow,
    isLoading: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var name by remember(workspace.id) { mutableStateOf(workspace.name) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.workspace_rename_title)) },
        text = {
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.workspace_name)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(name) },
                enabled = name.trim().isNotBlank() && !isLoading,
            ) {
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

@Composable
private fun WorkspaceDeleteDialog(
    workspace: WorkspaceRow,
    isLoading: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.workspace_delete_title)) },
        text = { Text(stringResource(R.string.workspace_delete_body, workspace.name)) },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = !isLoading,
                colors = ButtonDefaults.buttonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
            ) {
                Text(stringResource(R.string.action_delete))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

@Composable
private fun WikiHelpDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.help_title)) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                HelpSection(
                    title = stringResource(R.string.help_workspace_title),
                    body = stringResource(R.string.help_workspace_body),
                )
                HelpSection(
                    title = stringResource(R.string.help_ingest_title),
                    body = stringResource(R.string.help_ingest_body),
                )
                HelpSection(
                    title = stringResource(R.string.help_chat_title),
                    body = stringResource(R.string.help_chat_body),
                )
                HelpSection(
                    title = stringResource(R.string.help_settings_title),
                    body = stringResource(R.string.help_settings_body),
                )
                HelpSection(
                    title = stringResource(R.string.help_drive_title),
                    body = stringResource(R.string.help_drive_body),
                )
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.action_done))
            }
        },
    )
}

@Composable
private fun HelpSection(title: String, body: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            text = body,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// ── Search results panel ────────────────────────────────────────────────────

@Composable
private fun SearchResultsPanel(
    results: List<SearchResult>,
    query: String,
    isLoading: Boolean,
    onResultClick: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier) {
        when {
            isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            query.length >= 2 && results.isEmpty() -> Box(
                Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.wiki_search_empty),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            else -> LazyColumn {
                item { Spacer(Modifier.height(8.dp)) }
                items(results, key = { it.slug }) { result ->
                    ListItem(
                        headlineContent = { Text(result.title ?: result.slug) },
                        supportingContent = {
                            Text(
                                result.slug,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                        trailingContent = {
                            Text(
                                result.kind,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.primary,
                            )
                        },
                        modifier = Modifier.clickable { onResultClick(result.slug) },
                    )
                    HorizontalDivider()
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}

@Composable
private fun PageListItem(
    page: PageEntity,
    isSelected: Boolean,
    onClick: () -> Unit,
    onToggleLock: () -> Unit,
    onRenameNote: (() -> Unit)? = null,
    onDeleteNote: (() -> Unit)? = null,
    label: String? = null,
) {
    var showMenu by remember { mutableStateOf(false) }
    NavigationDrawerItem(
        label = { Text(label ?: page.title ?: page.slug, maxLines = 1) },
        selected = isSelected,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = 8.dp),
        badge = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onToggleLock) {
                    Icon(
                        if (page.lockedByHuman) Icons.Default.Lock else Icons.Default.LockOpen,
                        contentDescription = if (page.lockedByHuman)
                            stringResource(R.string.wiki_locked)
                        else
                            stringResource(R.string.wiki_unlocked),
                        modifier = Modifier.size(20.dp),
                        tint = if (page.lockedByHuman)
                            MaterialTheme.colorScheme.primary
                        else
                            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.35f),
                    )
                }
                if (onRenameNote != null || onDeleteNote != null) {
                    Box {
                        IconButton(onClick = { showMenu = true }) {
                            Icon(
                                Icons.Default.MoreVert,
                                contentDescription = stringResource(R.string.workspace_actions),
                                modifier = Modifier.size(20.dp),
                            )
                        }
                        DropdownMenu(
                            expanded = showMenu,
                            onDismissRequest = { showMenu = false },
                        ) {
                            if (onRenameNote != null) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.wiki_rename_note)) },
                                    onClick = {
                                        showMenu = false
                                        onRenameNote()
                                    },
                                )
                            }
                            if (onDeleteNote != null) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.wiki_delete_note)) },
                                    onClick = {
                                        showMenu = false
                                        onDeleteNote()
                                    },
                                )
                            }
                        }
                    }
                }
            }
        },
    )
}

@Composable
private fun localizedSystemPageLabel(slug: String): String? = when (slug) {
    "notes/guide.md" -> stringResource(R.string.wiki_notes_guide)
    "_schema/ingest.md" -> stringResource(R.string.wiki_schema_ingest)
    "_schema/query.md" -> stringResource(R.string.wiki_schema_query)
    "_schema/lint.md" -> stringResource(R.string.wiki_schema_lint)
    else -> null
}

private fun isHumanEditablePage(page: PageEntity): Boolean =
    page.zone == "notes" || page.zone == "schema"

// ── Chat bottom sheet ──────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatBottomSheet(
    messages: List<ChatMessage>,
    isLoading: Boolean,
    synthesisSavedSlug: String?,
    profiles: List<LlmProfile>,
    selectedProfileId: String?,
    onProfileSelected: (String?) -> Unit,
    onSend: (String) -> Unit,
    onPageClick: (String) -> Unit,
    onSaveSynthesis: (question: String, answer: String, slugs: List<String>) -> Unit,
    onClearSynthesis: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val listState = rememberLazyListState()
    var input by rememberSaveable { mutableStateOf("") }
    var showProfileMenu by remember { mutableStateOf(false) }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(Modifier.fillMaxSize().imePadding()) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(stringResource(R.string.wiki_chat), style = MaterialTheme.typography.titleMedium)
                if (profiles.isNotEmpty()) {
                    val selectedName = profiles.firstOrNull { it.id == selectedProfileId }?.name
                        ?: profiles.firstOrNull { it.isDefault }?.name
                    selectedName?.let {
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
            }
            HorizontalDivider()

            if (messages.isEmpty() && !isLoading) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        stringResource(R.string.wiki_chat_empty),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.weight(1f).padding(horizontal = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    item { Spacer(Modifier.height(4.dp)) }
                    items(messages) { msg ->
                        ChatBubble(
                            message = msg,
                            allMessages = messages,
                            onPageClick = onPageClick,
                            onSaveSynthesis = onSaveSynthesis,
                        )
                    }
                    if (isLoading) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                            }
                        }
                    }
                    item { Spacer(Modifier.height(4.dp)) }
                }
            }

            synthesisSavedSlug?.let {
                Surface(color = MaterialTheme.colorScheme.primaryContainer) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            stringResource(R.string.wiki_synthesis_saved),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        TextButton(onClick = onClearSynthesis) {
                            Text(stringResource(R.string.action_dismiss))
                        }
                    }
                }
            }

            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Profile selector
                if (profiles.isNotEmpty()) {
                    Box {
                        IconButton(
                            onClick = { showProfileMenu = true },
                            modifier = Modifier.size(56.dp),
                            colors = IconButtonDefaults.iconButtonColors(
                                containerColor = MaterialTheme.colorScheme.secondaryContainer,
                                contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                            ),
                        ) {
                            Icon(
                                Icons.Default.SmartToy,
                                contentDescription = stringResource(R.string.wiki_select_model),
                                modifier = Modifier.size(22.dp),
                            )
                        }
                        DropdownMenu(
                            expanded = showProfileMenu,
                            onDismissRequest = { showProfileMenu = false },
                        ) {
                            profiles.forEach { profile ->
                                DropdownMenuItem(
                                    text = {
                                        Column {
                                            Text(profile.name)
                                            Text(
                                                profile.model,
                                                style = MaterialTheme.typography.labelSmall,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    },
                                    onClick = {
                                        onProfileSelected(profile.id)
                                        showProfileMenu = false
                                    },
                                    trailingIcon = {
                                        if (profile.id == selectedProfileId ||
                                            (selectedProfileId == null && profile.isDefault)) {
                                            Icon(
                                                Icons.Default.Check,
                                                contentDescription = null,
                                                modifier = Modifier.size(16.dp),
                                                tint = MaterialTheme.colorScheme.primary,
                                            )
                                        }
                                    },
                                )
                            }
                        }
                    }
                }

                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text(stringResource(R.string.wiki_chat_input_hint)) },
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(onSend = {
                        if (input.isNotBlank() && !isLoading) { onSend(input); input = "" }
                    }),
                )
                IconButton(
                    onClick = { if (input.isNotBlank() && !isLoading) { onSend(input); input = "" } },
                    enabled = input.isNotBlank() && !isLoading,
                    modifier = Modifier.size(56.dp),
                    colors = IconButtonDefaults.iconButtonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                        disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                        disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                    ),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.wiki_send))
                }
            }
        }
    }
}

// ── Chat bubble ────────────────────────────────────────────────────────────

@Composable
private fun ChatBubble(
    message: ChatMessage,
    allMessages: List<ChatMessage>,
    onPageClick: (String) -> Unit,
    onSaveSynthesis: (question: String, answer: String, slugs: List<String>) -> Unit,
) {
    val isUser = message.role == "user"
    val bgColor = if (isUser)
        MaterialTheme.colorScheme.primaryContainer
    else
        MaterialTheme.colorScheme.surfaceVariant
    val textColor = if (isUser)
        MaterialTheme.colorScheme.onPrimaryContainer
    else
        MaterialTheme.colorScheme.onSurface

    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        Card(
            colors = CardDefaults.cardColors(
                containerColor = bgColor,
                contentColor = textColor,
            ),
            modifier = Modifier.fillMaxWidth(if (isUser) 0.85f else 1f),
        ) {
            if (isUser) {
                Text(
                    text = message.content,
                    style = MaterialTheme.typography.bodyMedium,
                    color = textColor,
                    modifier = Modifier.padding(12.dp),
                )
            } else {
                MarkdownViewer(
                    markdown = message.content,
                    onWikiLinkClick = onPageClick,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                )
            }
        }
        if (message.citedSlugs.isNotEmpty()) {
            Text(
                text = stringResource(R.string.wiki_sources, message.citedSlugs.joinToString(", ")),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
            )
            val prevUser = allMessages
                .take(allMessages.indexOf(message).coerceAtLeast(0))
                .lastOrNull { it.role == "user" }
            if (prevUser != null) {
                TextButton(
                    onClick = {
                        onSaveSynthesis(prevUser.content, message.content, message.citedSlugs)
                    },
                ) {
                    Text(stringResource(R.string.query_file_back), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

// ── Ingest dialog (URL + text/markdown) ───────────────────────────────────

@Composable
private fun IngestInputDialog(
    initialText: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var text by remember(initialText) { mutableStateOf(initialText) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.wiki_ingest_title)) },
        text = {
            Column {
                Text(
                    stringResource(R.string.wiki_ingest_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text(stringResource(R.string.wiki_ingest_placeholder)) },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 8,
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { if (text.isNotBlank()) onConfirm(text.trim()) },
                enabled = text.isNotBlank(),
            ) { Text(stringResource(R.string.wiki_ingest_confirm)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}

@Composable
private fun InlinePageEditor(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    modifier: Modifier = Modifier,
) {
    val toolbarActions = remember {
        listOf(
            MarkdownToolbarAction("H1") { applyLinePrefix(it, "# ", "Heading") },
            MarkdownToolbarAction("B") { wrapSelection(it, "**", "**", "bold") },
            MarkdownToolbarAction("I") { wrapSelection(it, "_", "_", "italic") },
            MarkdownToolbarAction("-") { applyLinePrefix(it, "- ", "item") },
            MarkdownToolbarAction("[ ]") { applyLinePrefix(it, "- [ ] ", "task") },
            MarkdownToolbarAction(">") { applyLinePrefix(it, "> ", "quote") },
            MarkdownToolbarAction("</>") { wrapSelection(it, "```\n", "\n```", "code") },
            MarkdownToolbarAction("link") { wrapSelection(it, "[", "](https://example.com)", "label") },
        )
    }

    Column(
        modifier = modifier.verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            toolbarActions.forEach { action ->
                SmallFloatingActionButton(
                    onClick = { onValueChange(action.apply(value)) },
                    containerColor = MaterialTheme.colorScheme.secondaryContainer,
                    contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                    modifier = Modifier.size(36.dp),
                ) {
                    Text(action.label, style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = 420.dp),
            maxLines = 24,
        )
    }
}

@Composable
private fun NoteCreateDialog(
    isLoading: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var title by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = {
            if (!isLoading) onDismiss()
        },
        title = { Text(stringResource(R.string.wiki_create_note)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.wiki_create_note_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it },
                    placeholder = { Text(stringResource(R.string.wiki_untitled)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(title.trim()) },
                enabled = !isLoading && title.trim().isNotEmpty(),
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(stringResource(R.string.action_save))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isLoading) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

@Composable
private fun NoteRenameDialog(
    page: PageEntity,
    isLoading: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var title by remember(page.slug) {
        mutableStateOf(page.title ?: page.slug.removePrefix("notes/").removeSuffix(".md"))
    }

    AlertDialog(
        onDismissRequest = {
            if (!isLoading) onDismiss()
        },
        title = { Text(stringResource(R.string.wiki_rename_note)) },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(title.trim()) },
                enabled = !isLoading && title.trim().isNotEmpty(),
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text(stringResource(R.string.action_save))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isLoading) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

@Composable
private fun NoteDeleteDialog(
    page: PageEntity,
    isLoading: Boolean,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = {
            if (!isLoading) onDismiss()
        },
        title = { Text(stringResource(R.string.wiki_delete_note)) },
        text = {
            Text(stringResource(R.string.wiki_delete_note_confirm, page.title ?: page.slug))
        },
        confirmButton = {
            Button(
                onClick = onConfirm,
                enabled = !isLoading,
                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onError,
                    )
                } else {
                    Text(stringResource(R.string.action_delete))
                }
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isLoading) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}

private data class MarkdownToolbarAction(
    val label: String,
    val apply: (TextFieldValue) -> TextFieldValue,
)

private fun wrapSelection(
    value: TextFieldValue,
    before: String,
    after: String,
    placeholder: String,
): TextFieldValue {
    val selection = value.selection
    val start = selection.start.coerceAtLeast(0)
    val end = selection.end.coerceAtLeast(start)
    val chosen = value.text.substring(start, end).ifBlank { placeholder }
    val inserted = before + chosen + after
    val next = value.text.replaceRange(start, end, inserted)
    val caret = start + inserted.length
    return TextFieldValue(next, TextRange(caret, caret))
}

private fun applyLinePrefix(
    value: TextFieldValue,
    prefix: String,
    placeholder: String,
): TextFieldValue {
    val text = value.text
    val start = value.selection.start.coerceAtLeast(0)
    val end = value.selection.end.coerceAtLeast(start)
    val lineStart = text.lastIndexOf('\n', (start - 1).coerceAtLeast(0)).let { if (it == -1) 0 else it + 1 }
    val lineEndIndex = text.indexOf('\n', end)
    val lineEnd = if (lineEndIndex == -1) text.length else lineEndIndex
    val selected = text.substring(lineStart, lineEnd).ifBlank { placeholder }
    val replaced = selected.split('\n').joinToString("\n") { line ->
        prefix + if (line.isBlank()) placeholder else line
    }
    val next = text.replaceRange(lineStart, lineEnd, replaced)
    val caret = lineStart + replaced.length
    return TextFieldValue(next, TextRange(caret, caret))
}

// ── Helpers ────────────────────────────────────────────────────────────────

private fun isUrl(text: String): Boolean = try {
    val u = java.net.URL(text.trim())
    u.protocol == "http" || u.protocol == "https"
} catch (_: Exception) { false }

private fun extractTitle(text: String, fallbackTitle: String): String =
    text.lines()
        .firstOrNull { it.trim().isNotEmpty() }
        ?.trimStart('#', ' ')
        ?.trim()
        ?.take(80)
        ?: fallbackTitle

private const val MAX_IMPORT_BYTES = 2 * 1024 * 1024L

private fun readTextFromUri(context: android.content.Context, uri: Uri): String? =
    runCatching {
        val fileSize = readFileSize(context, uri)
        if (fileSize != null && fileSize > MAX_IMPORT_BYTES) return null

        context.contentResolver.openInputStream(uri)
            ?.bufferedReader(Charsets.UTF_8)
            ?.use { reader -> reader.readText() }
    }.getOrNull()

private fun readFileSize(context: android.content.Context, uri: Uri): Long? =
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (index >= 0 && !cursor.isNull(index)) cursor.getLong(index) else null
            }
    }.getOrNull()

private fun readDisplayName(context: android.content.Context, uri: Uri): String? =
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (!cursor.moveToFirst()) return@use null
                val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (index >= 0) cursor.getString(index) else null
            }
    }.getOrNull()
