package com.llmwiki.ui.wiki

import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.runtime.DisposableEffect
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.LibraryBooks
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Help
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Build
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
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
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
import com.llmwiki.data.SourceListItem
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
    shareUrlToken: Long? = null,
    authReturnUri: String? = null,
    authReturnToken: Long? = null,
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

    // rememberSaveable so rotation / process death can't discard dialogs or unsaved edits
    var showIngestDialog by rememberSaveable { mutableStateOf(false) }
    var pendingShareUrl by rememberSaveable { mutableStateOf<String?>(null) }
    var showChatSheet by rememberSaveable { mutableStateOf(false) }
    var showWorkspaceMenu by remember { mutableStateOf(false) }
    var showHelpDialog by rememberSaveable { mutableStateOf(false) }
    var showSourcesDialog by rememberSaveable { mutableStateOf(false) }
    var showMaintenanceConfirm by rememberSaveable { mutableStateOf(false) }
    var renameWorkspace by remember { mutableStateOf<WorkspaceRow?>(null) }
    var deleteWorkspace by remember { mutableStateOf<WorkspaceRow?>(null) }
    var inlineEditorPageSlug by rememberSaveable { mutableStateOf<String?>(null) }
    var inlineEditorValue by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(TextFieldValue(""))
    }
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

    // Keyed on the event token too, so sharing the SAME url twice re-opens the dialog
    LaunchedEffect(shareUrl, shareUrlToken) {
        if (!shareUrl.isNullOrBlank()) {
            pendingShareUrl = shareUrl
            showIngestDialog = true
        }
    }

    // System back closes search / the inline editor instead of exiting the app
    BackHandler(enabled = uiState.showSearch) { wikiViewModel.clearSearch() }
    BackHandler(enabled = inlineEditorPageSlug != null) {
        inlineEditorPageSlug = null
        inlineEditorValue = TextFieldValue(uiState.pageContent.orEmpty())
    }

    LaunchedEffect(uiState.activePage?.slug) {
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

    LaunchedEffect(authReturnUri, authReturnToken) {
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
        gesturesEnabled = drawerState.isOpen,
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
                        // Notes UI was removed (chat-first workflow); only the wiki
                        // zone is listed. notes/schema stay in Drive & Room untouched.
                        val wikiPages = pages.filter { it.slug !in pinnedSlugs && it.zone == "wiki" }

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
                                    )
                                }
                                item {
                                    HorizontalDivider(Modifier.padding(horizontal = 12.dp, vertical = 4.dp))
                                }
                            }

                            if (wikiPages.isNotEmpty()) {
                                item {
                                    Text(
                                        text = stringResource(R.string.wiki_zone_wiki),
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 2.dp),
                                    )
                                }
                                items(wikiPages, key = { "${it.workspaceId}/${it.accountName}/${it.slug}" }) { page ->
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
                                    )
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
                        showSourcesDialog = true
                        wikiViewModel.loadSources()
                        scope.launch { drawerState.close() }
                    }) {
                        Icon(
                            Icons.AutoMirrored.Filled.LibraryBooks,
                            contentDescription = stringResource(R.string.sources_title),
                        )
                    }
                    // Single maintenance action: health check + dedupe in one pass
                    IconButton(
                        onClick = {
                            showMaintenanceConfirm = true
                            scope.launch { drawerState.close() }
                        },
                        enabled = !uiState.organizeRunning,
                    ) {
                        if (uiState.organizeRunning) {
                            CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(
                                Icons.Default.Build,
                                contentDescription = stringResource(R.string.wiki_maintenance),
                            )
                        }
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
                            val isInlineEditing = inlineEditorPageSlug == editablePage?.slug
                            IconButton(onClick = { wikiViewModel.toggleSearch() }) {
                                Icon(Icons.Default.Search, contentDescription = stringResource(R.string.wiki_search))
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
                            if (uiState.contentLoading || uiState.syncLoading) {
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
                    // Import lives inside the chat sheet's action menu now — one FAB
                    FloatingActionButton(
                        onClick = { showChatSheet = true },
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ) {
                        Icon(Icons.Default.ChatBubbleOutline, contentDescription = stringResource(R.string.wiki_chat))
                    }
                }
            },
        ) { innerPadding ->
            Column(Modifier.fillMaxSize().padding(innerPadding)) {
                uiState.syncError?.let { error ->
                    Surface(color = MaterialTheme.colorScheme.errorContainer) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = error,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f).padding(vertical = 12.dp),
                            )
                            IconButton(onClick = { wikiViewModel.clearSyncError() }) {
                                Icon(
                                    Icons.Default.Close,
                                    contentDescription = stringResource(R.string.action_dismiss),
                                    tint = MaterialTheme.colorScheme.onErrorContainer,
                                )
                            }
                        }
                    }
                }

                uiState.ingestRoutedName?.let { routedName ->
                    Surface(color = MaterialTheme.colorScheme.primaryContainer) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = stringResource(
                                    if (uiState.ingestRoutedCreated) R.string.wiki_ingest_routed_new
                                    else R.string.wiki_ingest_routed,
                                    routedName,
                                ),
                                color = MaterialTheme.colorScheme.onPrimaryContainer,
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f).padding(vertical = 10.dp),
                            )
                            TextButton(onClick = { wikiViewModel.clearIngestNotice() }) {
                                Text(stringResource(R.string.action_dismiss))
                            }
                        }
                    }
                }

                if (uiState.organizeRunning) {
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
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = if (uiState.maintenanceChanges > 0) {
                                        stringResource(
                                            R.string.wiki_maintenance_running_progress,
                                            uiState.maintenanceChanges,
                                        )
                                    } else {
                                        stringResource(R.string.wiki_maintenance_running)
                                    },
                                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                                Text(
                                    text = stringResource(R.string.wiki_maintenance_background_hint),
                                    color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.75f),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                        }
                    }
                }

                // Server-derived: an import started on the phone (or on the web) is still
                // shown after the app is killed and reopened.
                if (uiState.ingestLoading || uiState.activeIngestCount > 0) {
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
                                text = when {
                                    uiState.activeIngestCount > 0 -> stringResource(
                                        R.string.ingest_running_batch,
                                        uiState.activeIngestCount,
                                        uiState.activeIngestPages,
                                    )
                                    uiState.ingestProgress > 0 ->
                                        stringResource(R.string.ingest_running_progress, uiState.ingestProgress)
                                    else -> stringResource(R.string.ingest_running)
                                },
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
                        uiState.pageContent != null -> Column(Modifier.weight(1f).fillMaxWidth()) {
                            MarkdownViewer(
                                markdown = uiState.pageContent!!,
                                onWikiLinkClick = { slug -> wikiViewModel.selectPageBySlug(slug) },
                                modifier = Modifier
                                    .weight(1f)
                                    .fillMaxWidth()
                                    .padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                            if (uiState.backlinks.isNotEmpty()) {
                                HorizontalDivider()
                                Text(
                                    text = stringResource(R.string.wiki_backlinks),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                                )
                                Row(
                                    Modifier
                                        .fillMaxWidth()
                                        .horizontalScroll(rememberScrollState())
                                        .padding(horizontal = 16.dp, vertical = 8.dp),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    uiState.backlinks.forEach { slug ->
                                        AssistChip(
                                            onClick = { wikiViewModel.selectPageBySlug(slug) },
                                            label = { Text(slug.removeSuffix(".md")) },
                                        )
                                    }
                                }
                            }
                        }
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
            onConfirm = { text, autoRoute ->
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
                    wikiViewModel.ingestUrl(text, autoRoute, onDone)
                } else {
                    wikiViewModel.ingestText(
                        extractTitle(text, context.getString(R.string.wiki_untitled)),
                        text,
                        autoRoute,
                        onDone,
                    )
                }
            },
        )
    }

    if (showMaintenanceConfirm) {
        AlertDialog(
            onDismissRequest = { showMaintenanceConfirm = false },
            title = { Text(stringResource(R.string.wiki_maintenance_confirm_title)) },
            text = { Text(stringResource(R.string.wiki_maintenance_confirm_body)) },
            confirmButton = {
                Button(onClick = {
                    showMaintenanceConfirm = false
                    wikiViewModel.runMaintenance { success ->
                        if (success) {
                            scope.launch {
                                snackbarHostState.showSnackbar(context.getString(R.string.wiki_maintenance_done))
                            }
                        }
                    }
                }) {
                    Text(stringResource(R.string.chat_confirm_action))
                }
            },
            dismissButton = {
                TextButton(onClick = { showMaintenanceConfirm = false }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }

    if (showChatSheet) {
        ChatBottomSheet(
            messages = uiState.chatMessages,
            isLoading = uiState.chatLoading,
            input = uiState.chatDraft,
            onInputChange = { wikiViewModel.updateChatDraft(it) },
            errorMessage = uiState.syncError,
            onDismissError = { wikiViewModel.clearSyncError() },
            synthesisSavedSlug = uiState.synthesisSavedSlug,
            profiles = uiState.profiles,
            selectedProfileId = uiState.selectedProfileId,
            onProfileSelected = { wikiViewModel.setSelectedProfile(it) },
            workspaces = uiState.workspaces,
            currentWorkspaceId = uiState.workspace?.id,
            taggedWorkspaceIds = uiState.taggedWorkspaceIds,
            onTagWorkspace = { wikiViewModel.tagWorkspace(it) },
            onUntagWorkspace = { wikiViewModel.untagWorkspace(it) },
            onImportContent = {
                showChatSheet = false
                pendingShareUrl = null
                showIngestDialog = true
            },
            onImportFile = {
                showChatSheet = false
                filePickerLauncher.launch(arrayOf("text/*", "application/json", "application/xml", "text/markdown", "text/x-markdown"))
            },
            onExecuteProposal = { mi, pi -> wikiViewModel.executeProposal(mi, pi) },
            onDismissProposal = { mi, pi -> wikiViewModel.dismissProposal(mi, pi) },
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

    if (showSourcesDialog) {
        SourcesListDialog(
            sources = uiState.sources,
            isLoading = uiState.sourcesLoading,
            reingestingSourceId = uiState.reingestingSourceId,
            onReingest = { wikiViewModel.reingestSource(it) },
            onDismiss = { showSourcesDialog = false },
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
    label: String? = null,
) {
    NavigationDrawerItem(
        label = { Text(label ?: page.title ?: page.slug, maxLines = 1) },
        selected = isSelected,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = 8.dp),
        badge = {
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
    input: String,
    onInputChange: (String) -> Unit,
    errorMessage: String?,
    onDismissError: () -> Unit,
    synthesisSavedSlug: String?,
    profiles: List<LlmProfile>,
    selectedProfileId: String?,
    onProfileSelected: (String?) -> Unit,
    workspaces: List<WorkspaceRow>,
    currentWorkspaceId: String?,
    taggedWorkspaceIds: List<String>,
    onTagWorkspace: (String) -> Unit,
    onUntagWorkspace: (String) -> Unit,
    onImportContent: () -> Unit,
    onImportFile: () -> Unit,
    onExecuteProposal: (messageIndex: Int, proposalIndex: Int) -> Unit,
    onDismissProposal: (messageIndex: Int, proposalIndex: Int) -> Unit,
    onSend: (String) -> Unit,
    onPageClick: (String) -> Unit,
    onSaveSynthesis: (question: String, answer: String, slugs: List<String>) -> Unit,
    onClearSynthesis: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val listState = rememberLazyListState()
    var showActionMenu by remember { mutableStateOf(false) }

    // "@..." fragment at the end of the input opens the workspace tag menu
    val mentionRegex = remember { Regex("(?:^|\\s)@([^\\s@]*)$") }
    val mentionQuery = mentionRegex.find(input)?.groupValues?.get(1)
    val mentionCandidates = if (mentionQuery != null) {
        workspaces
            .filter { it.id != currentWorkspaceId && it.id !in taggedWorkspaceIds }
            .filter { mentionQuery.isBlank() || it.name.contains(mentionQuery, ignoreCase = true) }
            .take(6)
    } else emptyList()

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
                    itemsIndexed(messages) { messageIndex, msg ->
                        ChatBubble(
                            message = msg,
                            allMessages = messages,
                            onPageClick = onPageClick,
                            onSaveSynthesis = onSaveSynthesis,
                            onExecuteProposal = { pi -> onExecuteProposal(messageIndex, pi) },
                            onDismissProposal = { pi -> onDismissProposal(messageIndex, pi) },
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

            // Query failures must be visible INSIDE the full-screen sheet — the
            // scaffold banner renders behind it
            errorMessage?.let { message ->
                Surface(color = MaterialTheme.colorScheme.errorContainer) {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            message,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            modifier = Modifier.weight(1f).padding(vertical = 10.dp),
                        )
                        TextButton(onClick = onDismissError) {
                            Text(stringResource(R.string.action_dismiss))
                        }
                    }
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

            // @-tagged workspace chips (extra context for the next question)
            if (taggedWorkspaceIds.isNotEmpty()) {
                Row(
                    Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    taggedWorkspaceIds.forEach { wsId ->
                        val name = workspaces.firstOrNull { it.id == wsId }?.name ?: wsId
                        AssistChip(
                            onClick = { onUntagWorkspace(wsId) },
                            label = { Text("@$name") },
                            trailingIcon = {
                                Icon(Icons.Default.Close, contentDescription = null, modifier = Modifier.size(14.dp))
                            },
                        )
                    }
                }
            }

            // Workspace mention suggestions while typing "@..."
            if (mentionCandidates.isNotEmpty()) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                    Text(
                        stringResource(R.string.chat_tag_workspace),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 2.dp),
                    )
                    mentionCandidates.forEach { ws ->
                        Text(
                            text = "@${ws.name}",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    onTagWorkspace(ws.id)
                                    // strip the trailing "@..." fragment from the draft
                                    onInputChange(input.substringBeforeLast('@').trimEnd())
                                }
                                .padding(vertical = 8.dp),
                        )
                    }
                }
            }

            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                // Action menu: import content/file + model selection
                Box {
                    IconButton(
                        onClick = { showActionMenu = true },
                        modifier = Modifier.size(56.dp),
                        colors = IconButtonDefaults.iconButtonColors(
                            containerColor = MaterialTheme.colorScheme.secondaryContainer,
                            contentColor = MaterialTheme.colorScheme.onSecondaryContainer,
                        ),
                    ) {
                        Icon(
                            Icons.Default.SmartToy,
                            contentDescription = stringResource(R.string.wiki_chat_menu),
                            modifier = Modifier.size(22.dp),
                        )
                    }
                    DropdownMenu(
                        expanded = showActionMenu,
                        onDismissRequest = { showActionMenu = false },
                    ) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.wiki_import_content)) },
                            leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                            onClick = {
                                showActionMenu = false
                                onImportContent()
                            },
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.wiki_import_file)) },
                            leadingIcon = { Icon(Icons.Default.AttachFile, contentDescription = null) },
                            onClick = {
                                showActionMenu = false
                                onImportFile()
                            },
                        )
                        if (profiles.isNotEmpty()) {
                            HorizontalDivider()
                            Text(
                                stringResource(R.string.wiki_select_model),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                            )
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
                                        showActionMenu = false
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
                    onValueChange = onInputChange,
                    placeholder = { Text(stringResource(R.string.wiki_chat_input_hint)) },
                    modifier = Modifier.weight(1f).heightIn(min = 56.dp),
                    maxLines = 4,
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.Sentences,
                        imeAction = ImeAction.Send,
                    ),
                    keyboardActions = KeyboardActions(onSend = {
                        if (input.isNotBlank() && !isLoading) onSend(input)
                    }),
                )
                IconButton(
                    onClick = { if (input.isNotBlank() && !isLoading) onSend(input) },
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
    onExecuteProposal: (proposalIndex: Int) -> Unit = {},
    onDismissProposal: (proposalIndex: Int) -> Unit = {},
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
        // Destructive-action confirmation cards
        message.proposals.forEachIndexed { proposalIndex, proposal ->
            if (proposal.status == "dismissed") return@forEachIndexed
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ),
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            ) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = when (proposal.action) {
                            "delete_workspace" -> stringResource(
                                R.string.chat_proposal_delete_workspace,
                                proposal.params["name"] ?: proposal.params["workspace_id"] ?: "",
                            )
                            else -> stringResource(
                                R.string.chat_proposal_delete_page,
                                proposal.params["slug"] ?: "",
                            )
                        },
                        style = MaterialTheme.typography.bodySmall,
                    )
                    when (proposal.status) {
                        "pending" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(
                                onClick = { onExecuteProposal(proposalIndex) },
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = MaterialTheme.colorScheme.error,
                                    contentColor = MaterialTheme.colorScheme.onError,
                                ),
                            ) { Text(stringResource(R.string.chat_confirm_action)) }
                            TextButton(onClick = { onDismissProposal(proposalIndex) }) {
                                Text(stringResource(R.string.action_cancel))
                            }
                        }
                        "running" -> CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        "done" -> Icon(
                            Icons.Default.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(18.dp),
                        )
                        "error" -> Text(
                            proposal.error ?: stringResource(R.string.error_op_agent_action),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
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

// ── Sources list dialog (read-only: sources are immutable after ingest) ───

@Composable
private fun SourcesListDialog(
    sources: List<SourceListItem>?,
    isLoading: Boolean,
    reingestingSourceId: String?,
    onReingest: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sources_title)) },
        text = {
            when {
                isLoading || sources == null -> Box(
                    Modifier.fillMaxWidth().padding(vertical = 24.dp),
                    contentAlignment = Alignment.Center,
                ) { CircularProgressIndicator() }
                sources.isEmpty() -> Text(
                    stringResource(R.string.sources_empty),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                else -> LazyColumn(
                    modifier = Modifier.heightIn(max = 420.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(sources) { item ->
                        Column(Modifier.fillMaxWidth()) {
                            Text(
                                text = item.source.title
                                    ?: item.source.url
                                    ?: stringResource(R.string.wiki_untitled),
                                style = MaterialTheme.typography.bodyMedium,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            item.source.url?.let { url ->
                                Text(
                                    text = url,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            val statusText = when {
                                item.jobStatus == "failed" ->
                                    stringResource(R.string.sources_status_failed) +
                                        (item.jobError?.takeIf { it.isNotBlank() }?.let { " — $it" } ?: "")
                                item.source.ingestedAt != null ->
                                    stringResource(R.string.sources_status_done, item.touchedCount)
                                else -> stringResource(R.string.sources_status_running)
                            }
                            val isReingesting = reingestingSourceId == item.source.id
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    text = if (isReingesting) stringResource(R.string.sources_reingesting) else statusText,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = when {
                                        isReingesting -> MaterialTheme.colorScheme.primary
                                        item.jobStatus == "failed" -> MaterialTheme.colorScheme.error
                                        item.source.ingestedAt != null -> MaterialTheme.colorScheme.primary
                                        else -> MaterialTheme.colorScheme.onSurfaceVariant
                                    },
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(
                                    onClick = { onReingest(item.source.id) },
                                    enabled = reingestingSourceId == null,
                                ) {
                                    if (isReingesting) {
                                        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                                    } else {
                                        Icon(
                                            Icons.Default.Refresh,
                                            contentDescription = null,
                                            modifier = Modifier.size(14.dp),
                                        )
                                    }
                                    Text(
                                        text = stringResource(R.string.sources_reingest),
                                        style = MaterialTheme.typography.labelSmall,
                                        modifier = Modifier.padding(start = 4.dp),
                                    )
                                }
                            }
                            HorizontalDivider(Modifier.padding(top = 8.dp))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_dismiss)) }
        },
    )
}

// ── Ingest dialog (URL + text/markdown) ───────────────────────────────────

@Composable
private fun IngestInputDialog(
    initialText: String,
    onDismiss: () -> Unit,
    onConfirm: (String, Boolean) -> Unit,
) {
    var text by rememberSaveable(initialText) { mutableStateOf(initialText) }
    var autoRoute by rememberSaveable { mutableStateOf(true) }

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
                // Target workspace: AI routing (default) vs. current workspace
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { autoRoute = true }
                        .padding(top = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = autoRoute, onClick = { autoRoute = true })
                    Text(stringResource(R.string.wiki_ingest_target_auto), style = MaterialTheme.typography.bodySmall)
                }
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { autoRoute = false },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = !autoRoute, onClick = { autoRoute = false })
                    Text(stringResource(R.string.wiki_ingest_target_current), style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { if (text.isNotBlank()) onConfirm(text.trim(), autoRoute) },
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
                // FilledTonalButton keeps the M3 48dp minimum touch target (36dp FABs failed a11y)
                FilledTonalButton(
                    onClick = { onValueChange(action.apply(value)) },
                    contentPadding = PaddingValues(horizontal = 14.dp),
                ) {
                    Text(action.label, style = MaterialTheme.typography.labelMedium)
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
