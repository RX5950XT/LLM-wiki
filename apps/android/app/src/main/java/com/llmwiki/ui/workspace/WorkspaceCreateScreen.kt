package com.llmwiki.ui.workspace

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.llmwiki.R
import com.llmwiki.data.parseDriveReconnectSource

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspaceCreateScreen(
    canNavigateBack: Boolean,
    authReturnUri: String? = null,
    onBack: () -> Unit,
    onWorkspaceCreated: (String) -> Unit,
    workspaceCreateViewModel: WorkspaceCreateViewModel = viewModel(),
) {
    val uiState by workspaceCreateViewModel.uiState.collectAsState()
    val context = LocalContext.current
    val snackbarHostState = remember { SnackbarHostState() }

    LaunchedEffect(uiState.createdWorkspaceId) {
        uiState.createdWorkspaceId?.let { workspaceId ->
            workspaceCreateViewModel.consumeCreatedWorkspace()
            onWorkspaceCreated(workspaceId)
        }
    }

    LaunchedEffect(authReturnUri) {
        if (parseDriveReconnectSource(authReturnUri) == "workspace-create") {
            workspaceCreateViewModel.onDriveReconnectCompleted()
            snackbarHostState.showSnackbar(
                context.getString(R.string.workspace_drive_reconnected)
            )
        }
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.workspace_create_title)) },
                navigationIcon = {
                    if (canNavigateBack) {
                        IconButton(onClick = onBack) {
                            Icon(
                                Icons.AutoMirrored.Filled.ArrowBack,
                                contentDescription = stringResource(R.string.action_back),
                            )
                        }
                    }
                },
            )
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.workspace_create_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            OutlinedTextField(
                value = uiState.name,
                onValueChange = workspaceCreateViewModel::updateName,
                label = { Text(stringResource(R.string.workspace_name)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )

            uiState.error?.let { error ->
                Text(
                    text = error,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            Spacer(Modifier.height(4.dp))

            Button(
                onClick = workspaceCreateViewModel::createWorkspace,
                enabled = uiState.name.isNotBlank() && !uiState.submitting,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (uiState.submitting) {
                    CircularProgressIndicator(
                        modifier = Modifier
                            .padding(end = 8.dp)
                            .size(18.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Text(stringResource(R.string.workspace_create_action))
            }
        }
    }

    uiState.driveReconnectUrl?.let { reconnectUrl ->
        AlertDialog(
            onDismissRequest = workspaceCreateViewModel::dismissDriveReconnectPrompt,
            title = { Text(stringResource(R.string.workspace_drive_reconnect_title)) },
            text = { Text(stringResource(R.string.workspace_drive_reconnect_body)) },
            confirmButton = {
                Button(
                    onClick = {
                        workspaceCreateViewModel.dismissDriveReconnectPrompt()
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(reconnectUrl)))
                    },
                ) {
                    Text(stringResource(R.string.workspace_drive_reconnect_action))
                }
            },
            dismissButton = {
                TextButton(onClick = workspaceCreateViewModel::dismissDriveReconnectPrompt) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}
