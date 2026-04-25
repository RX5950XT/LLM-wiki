package com.llmwiki.ui.wiki

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
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
    wikiViewModel: WikiViewModel = viewModel(),
) {
    val uiState by wikiViewModel.uiState.collectAsState()
    val pages by wikiViewModel.pages.collectAsState()
    val drawerState = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()

    var showIngestDialog by remember { mutableStateOf(false) }
    var pendingShareUrl by remember { mutableStateOf<String?>(null) }

    // Initialize ViewModel once we have credentials
    LaunchedEffect(workspaceId, accountName) {
        if (accountName.isNotBlank()) {
            wikiViewModel.init(workspaceId, accountName)
        }
    }

    // Auto-open ingest dialog when a URL is shared into the app
    LaunchedEffect(shareUrl) {
        if (!shareUrl.isNullOrBlank()) {
            pendingShareUrl = shareUrl
            showIngestDialog = true
        }
    }

    ModalNavigationDrawer(
        drawerState = drawerState,
        modifier = modifier,
        drawerContent = {
            ModalDrawerSheet {
                Spacer(modifier = Modifier.height(16.dp))
                Text(
                    text = uiState.workspace?.name ?: "LLM Wiki",
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))

                if (pages.isEmpty()) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "No pages yet.\nTap + to ingest a URL.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                } else {
                    LazyColumn {
                        items(pages, key = { "${it.workspaceId}/${it.slug}" }) { page ->
                            PageListItem(
                                page = page,
                                isSelected = uiState.activePage?.slug == page.slug,
                                onClick = {
                                    wikiViewModel.selectPage(page)
                                    scope.launch { drawerState.close() }
                                },
                            )
                        }
                    }
                }
            }
        },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = {
                        Text(
                            text = uiState.activePage?.title
                                ?: uiState.workspace?.name
                                ?: "LLM Wiki",
                        )
                    },
                    navigationIcon = {
                        IconButton(onClick = { scope.launch { drawerState.open() } }) {
                            Icon(
                                imageVector = Icons.AutoMirrored.Filled.List,
                                contentDescription = "Open pages",
                            )
                        }
                    },
                    actions = {
                        if (uiState.contentLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier
                                    .size(24.dp)
                                    .padding(end = 4.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            IconButton(onClick = { wikiViewModel.syncPages() }) {
                                Icon(
                                    imageVector = Icons.Default.Refresh,
                                    contentDescription = "Sync",
                                )
                            }
                        }
                    },
                )
            },
            floatingActionButton = {
                FloatingActionButton(
                    onClick = {
                        pendingShareUrl = null
                        showIngestDialog = true
                    },
                ) {
                    Icon(Icons.Default.Add, contentDescription = "Ingest URL")
                }
            },
        ) { innerPadding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(innerPadding),
            ) {
                // Error banner
                uiState.syncError?.let { error ->
                    Surface(color = MaterialTheme.colorScheme.errorContainer) {
                        Text(
                            text = error,
                            color = MaterialTheme.colorScheme.onErrorContainer,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(12.dp),
                        )
                    }
                }

                // Content area
                when {
                    uiState.activePage == null -> {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = if (pages.isEmpty())
                                    "Tap + to ingest your first URL"
                                else
                                    "Select a page from the menu",
                                style = MaterialTheme.typography.bodyLarge,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }

                    uiState.contentLoading -> {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }

                    uiState.pageContent != null -> {
                        MarkdownViewer(
                            markdown = uiState.pageContent!!,
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 8.dp),
                        )
                    }

                    else -> {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = "No content available",
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
            }
        }
    }

    if (showIngestDialog) {
        IngestUrlDialog(
            initialUrl = pendingShareUrl ?: "",
            onDismiss = {
                showIngestDialog = false
                pendingShareUrl = null
            },
            onConfirm = { url ->
                showIngestDialog = false
                pendingShareUrl = null
                wikiViewModel.ingestUrl(url) { /* result handled silently */ }
            },
        )
    }
}

@Composable
private fun PageListItem(
    page: PageEntity,
    isSelected: Boolean,
    onClick: () -> Unit,
) {
    NavigationDrawerItem(
        label = {
            Text(
                text = page.title ?: page.slug,
                maxLines = 1,
            )
        },
        selected = isSelected,
        onClick = onClick,
        modifier = Modifier.padding(horizontal = 8.dp),
        badge = if (page.lockedByHuman) ({ Text("✎") }) else null,
    )
}

@Composable
private fun IngestUrlDialog(
    initialUrl: String,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var url by remember(initialUrl) { mutableStateOf(initialUrl) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Ingest URL") },
        text = {
            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text("URL") },
                singleLine = true,
                placeholder = { Text("https://...") },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(
                    onDone = { if (url.isNotBlank()) onConfirm(url) },
                ),
                modifier = Modifier.fillMaxWidth(),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { if (url.isNotBlank()) onConfirm(url) },
                enabled = url.isNotBlank(),
            ) {
                Text("Ingest")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("Cancel") }
        },
    )
}
