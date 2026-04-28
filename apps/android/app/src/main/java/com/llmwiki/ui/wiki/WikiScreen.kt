package com.llmwiki.ui.wiki

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.llmwiki.data.room.PageEntity
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WikiScreen(
    workspaceId: String?,
    accountName: String,
    shareUrl: String? = null,
    modifier: Modifier = Modifier,
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
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(workspaceId, accountName) {
        if (accountName.isNotBlank()) wikiViewModel.init(workspaceId, accountName)
    }

    LaunchedEffect(shareUrl) {
        if (!shareUrl.isNullOrBlank()) {
            pendingShareUrl = shareUrl
            showIngestDialog = true
        }
    }

    LaunchedEffect(uiState.signedOut) {
        if (uiState.signedOut) onSignedOut()
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        modifier = modifier,
        drawerContent = {
            ModalDrawerSheet {
                Spacer(Modifier.height(16.dp))
                Text(
                    text = uiState.workspace?.name ?: "LLM Wiki",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                HorizontalDivider(Modifier.padding(vertical = 8.dp))

                if (pages.isEmpty()) {
                    Box(
                        Modifier.fillMaxWidth().padding(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "No pages yet.\nTap + to ingest.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    LazyColumn(Modifier.weight(1f)) {
                        items(pages, key = { "${it.workspaceId}/${it.slug}" }) { page ->
                            PageListItem(
                                page = page,
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

                HorizontalDivider(Modifier.padding(vertical = 4.dp))
                TextButton(
                    onClick = { wikiViewModel.signOut() },
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                ) {
                    Text("Sign out", color = MaterialTheme.colorScheme.error)
                }
                Spacer(Modifier.height(8.dp))
            }
        },
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = {
                TopAppBar(
                    title = {
                        Text(uiState.activePage?.title ?: uiState.workspace?.name ?: "LLM Wiki")
                    },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(Icons.AutoMirrored.Filled.List, contentDescription = "Open pages")
                        }
                    },
                    actions = {
                        if (uiState.contentLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp).padding(end = 4.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            IconButton(onClick = { wikiViewModel.syncPages() }) {
                                Icon(Icons.Default.Refresh, contentDescription = "Sync")
                            }
                        }
                    },
                )
            },
            floatingActionButton = {
                Column(
                    horizontalAlignment = Alignment.End,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    SmallFloatingActionButton(onClick = { showChatSheet = true }) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Chat")
                    }
                    FloatingActionButton(
                        onClick = { pendingShareUrl = null; showIngestDialog = true },
                    ) {
                        Icon(Icons.Default.Add, contentDescription = "Ingest")
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

                when {
                    uiState.activePage == null -> Box(
                        Modifier.weight(1f).fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            if (pages.isEmpty()) "Tap + to ingest your first source"
                            else "Select a page from the menu",
                            style = MaterialTheme.typography.bodyLarge,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    uiState.contentLoading -> Box(
                        Modifier.weight(1f).fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) { CircularProgressIndicator() }
                    uiState.pageContent != null -> MarkdownViewer(
                        markdown = uiState.pageContent!!,
                        modifier = Modifier
                            .weight(1f)
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                    else -> Box(
                        Modifier.weight(1f).fillMaxWidth(),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text("No content available", color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                            if (success) "Ingest started" else "Ingest failed"
                        )
                    }
                }
                if (isUrl(text)) {
                    wikiViewModel.ingestUrl(text, onDone)
                } else {
                    wikiViewModel.ingestText(extractTitle(text), text, onDone)
                }
            },
        )
    }

    if (showChatSheet) {
        ChatBottomSheet(
            messages = uiState.chatMessages,
            isLoading = uiState.chatLoading,
            synthesisSavedSlug = uiState.synthesisSavedSlug,
            onSend = { wikiViewModel.sendQuery(it) },
            onSaveSynthesis = { q, a, slugs -> wikiViewModel.saveSynthesis(q, a, slugs) },
            onClearSynthesis = { wikiViewModel.clearSynthesisSlug() },
            onDismiss = { showChatSheet = false },
        )
    }
}

// ── Drawer page item with lock toggle ──────────────────────────────────────

@Composable
private fun PageListItem(
    page: PageEntity,
    isSelected: Boolean,
    onClick: () -> Unit,
    onToggleLock: () -> Unit,
) {
    NavigationDrawerItem(
        label = { Text(page.title ?: page.slug, maxLines = 1) },
        selected = isSelected,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = 8.dp),
        badge = {
            IconButton(onClick = onToggleLock) {
                Icon(
                    Icons.Default.Lock,
                    contentDescription = if (page.lockedByHuman) "Locked" else "Unlocked",
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

// ── Chat bottom sheet ──────────────────────────────────────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatBottomSheet(
    messages: List<ChatMessage>,
    isLoading: Boolean,
    synthesisSavedSlug: String?,
    onSend: (String) -> Unit,
    onSaveSynthesis: (question: String, answer: String, slugs: List<String>) -> Unit,
    onClearSynthesis: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val listState = rememberLazyListState()
    var input by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.fillMaxSize(),
    ) {
        Column(Modifier.fillMaxSize().imePadding()) {
            Text(
                "Chat",
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            HorizontalDivider()

            if (messages.isEmpty() && !isLoading) {
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        "Ask anything about your wiki",
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
                            onSaveSynthesis = onSaveSynthesis,
                        )
                    }
                    if (isLoading) {
                        item {
                            Box(Modifier.fillMaxWidth().padding(8.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(20.dp),
                                    strokeWidth = 2.dp,
                                )
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
                            "Saved as synthesis page",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        TextButton(onClick = onClearSynthesis) { Text("Dismiss") }
                    }
                }
            }

            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text("Ask about your wiki…") },
                    modifier = Modifier.weight(1f),
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
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Send")
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
    onSaveSynthesis: (question: String, answer: String, slugs: List<String>) -> Unit,
) {
    val isUser = message.role == "user"
    val bgColor = if (isUser)
        MaterialTheme.colorScheme.primaryContainer
    else
        MaterialTheme.colorScheme.surfaceVariant

    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = if (isUser) Alignment.End else Alignment.Start,
    ) {
        Card(
            colors = CardDefaults.cardColors(containerColor = bgColor),
            modifier = Modifier.fillMaxWidth(if (isUser) 0.85f else 1f),
        ) {
            Text(
                text = message.content,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(12.dp),
            )
        }
        if (message.citedSlugs.isNotEmpty()) {
            Text(
                text = "Sources: ${message.citedSlugs.joinToString(", ")}",
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
                    Text("Save as synthesis page", style = MaterialTheme.typography.labelSmall)
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
        title = { Text("Ingest source") },
        text = {
            Column {
                Text(
                    "Paste a URL, plain text, or Markdown",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 8.dp),
                )
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("https://… or paste text / Markdown") },
                    modifier = Modifier.fillMaxWidth(),
                    maxLines = 8,
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { if (text.isNotBlank()) onConfirm(text.trim()) },
                enabled = text.isNotBlank(),
            ) { Text("Ingest") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// ── Helpers ────────────────────────────────────────────────────────────────

private fun isUrl(text: String): Boolean = try {
    val u = java.net.URL(text.trim())
    u.protocol == "http" || u.protocol == "https"
} catch (_: Exception) { false }

private fun extractTitle(text: String): String =
    text.lines()
        .firstOrNull { it.trim().isNotEmpty() }
        ?.trimStart('#', ' ')
        ?.trim()
        ?.take(80)
        ?: "Untitled"
