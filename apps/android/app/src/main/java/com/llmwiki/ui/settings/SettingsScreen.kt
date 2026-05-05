package com.llmwiki.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Star
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.llmwiki.R
import com.llmwiki.data.AppLanguage
import com.llmwiki.data.LlmProfile
import com.llmwiki.data.ThemeMode

private data class ProfilePreset(
    val label: String,
    val baseUrl: String,
    val model: String,
)

private val providerPresets = listOf(
    ProfilePreset("OpenRouter", "https://openrouter.ai/api/v1", "anthropic/claude-opus-4-7"),
    ProfilePreset("OpenAI", "https://api.openai.com/v1", "gpt-4o"),
    ProfilePreset("Anthropic", "https://api.anthropic.com/v1/", "claude-opus-4-7-20251101"),
    ProfilePreset("Google AI", "https://generativelanguage.googleapis.com/v1beta/openai/", "gemini-2.5-pro"),
    ProfilePreset("Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile"),
    ProfilePreset("Ollama", "http://localhost:11434/v1", "qwen2.5:14b"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    settingsViewModel: SettingsViewModel = viewModel(),
) {
    val uiState by settingsViewModel.uiState.collectAsState()
    var showCreateDialog by remember { mutableStateOf(false) }
    var profileToDelete by remember { mutableStateOf<LlmProfile?>(null) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.action_back),
                        )
                    }
                },
                actions = {
                    IconButton(onClick = settingsViewModel::loadProfiles) {
                        Icon(
                            Icons.Default.Refresh,
                            contentDescription = stringResource(R.string.action_refresh),
                        )
                    }
                },
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item { Spacer(Modifier.height(4.dp)) }

            item {
                SettingsSection(title = stringResource(R.string.settings_account)) {
                    AccountCard(
                        email = uiState.accountEmail,
                        accountId = uiState.accountId,
                    )
                }
            }

            item {
                SettingsSection(title = stringResource(R.string.settings_llm_profiles)) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.End,
                        ) {
                            OutlinedButton(
                                onClick = { showCreateDialog = true },
                                modifier = Modifier.height(40.dp),
                            ) {
                                Icon(
                                    Icons.Default.Add,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                                Spacer(Modifier.size(6.dp))
                                Text(stringResource(R.string.settings_add_profile))
                            }
                        }

                        when {
                            uiState.loading -> Box(
                                modifier = Modifier.fillMaxWidth().padding(20.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                CircularProgressIndicator()
                            }

                            uiState.profiles.isEmpty() -> Text(
                                stringResource(R.string.settings_no_profiles),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )

                            else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                uiState.profiles.forEach { profile ->
                                    ProfileCard(profile = profile, onDelete = { profileToDelete = profile })
                                }
                            }
                        }
                    }
                }
            }

            item {
                SettingsSection(title = stringResource(R.string.settings_theme)) {
                    ThemeSelector(
                        current = uiState.themeMode,
                        onSelect = settingsViewModel::setThemeMode,
                    )
                }
            }

            item {
                SettingsSection(title = stringResource(R.string.settings_language)) {
                    LanguageSelector(
                        current = uiState.language,
                        onSelect = settingsViewModel::setLanguage,
                    )
                }
            }

            uiState.error?.let { error ->
                item {
                    Text(
                        text = error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    if (showCreateDialog) {
        CreateProfileDialog(
            isLoading = uiState.createLoading,
            onDismiss = { showCreateDialog = false },
            onConfirm = { name, baseUrl, apiKey, model, isDefault ->
                settingsViewModel.createProfile(name, baseUrl, apiKey, model, isDefault) { ok ->
                    if (ok) showCreateDialog = false
                }
            },
        )
    }

    profileToDelete?.let { profile ->
        AlertDialog(
            onDismissRequest = { profileToDelete = null },
            title = { Text(stringResource(R.string.settings_delete_profile)) },
            text = { Text(stringResource(R.string.settings_delete_profile_confirm, profile.name)) },
            confirmButton = {
                Button(
                    onClick = {
                        settingsViewModel.deleteProfile(profile.id)
                        profileToDelete = null
                    },
                ) { Text(stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { profileToDelete = null }) {
                    Text(stringResource(R.string.action_cancel))
                }
            },
        )
    }
}

@Composable
private fun SettingsSection(
    title: String,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontWeight = FontWeight.SemiBold,
        )
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                content()
            }
        }
    }
}

@Composable
private fun AccountCard(email: String, accountId: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            modifier = Modifier
                .size(52.dp)
                .background(MaterialTheme.colorScheme.primaryContainer, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = email.firstOrNull()?.uppercase() ?: "U",
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.Bold,
            )
        }
        Spacer(Modifier.size(12.dp))
        Column {
            Text(
                text = email.ifBlank { stringResource(R.string.settings_unknown_account) },
                style = MaterialTheme.typography.bodyLarge,
            )
            if (accountId.isNotBlank()) {
                Text(
                    text = accountId,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ProfileCard(
    profile: LlmProfile,
    onDelete: () -> Unit,
) {
    Surface(
        tonalElevation = if (profile.isDefault) 2.dp else 0.dp,
        color = if (profile.isDefault) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        },
        shape = MaterialTheme.shapes.medium,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(profile.name, style = MaterialTheme.typography.bodyLarge)
                    if (profile.isDefault) {
                        Spacer(Modifier.size(6.dp))
                        Icon(
                            Icons.Default.Star,
                            contentDescription = stringResource(R.string.settings_default_profile),
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
                Text(
                    profile.model,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    profile.baseUrl,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            IconButton(onClick = onDelete) {
                Icon(
                    Icons.Default.Delete,
                    contentDescription = stringResource(R.string.action_delete),
                    tint = MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ThemeSelector(
    current: ThemeMode,
    onSelect: (ThemeMode) -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ThemeOptionButton(
            label = stringResource(R.string.settings_theme_light),
            selected = current == ThemeMode.LIGHT,
            onClick = { onSelect(ThemeMode.LIGHT) },
        )
        ThemeOptionButton(
            label = stringResource(R.string.settings_theme_dark),
            selected = current == ThemeMode.DARK,
            onClick = { onSelect(ThemeMode.DARK) },
        )
        ThemeOptionButton(
            label = stringResource(R.string.settings_theme_system),
            selected = current == ThemeMode.SYSTEM,
            onClick = { onSelect(ThemeMode.SYSTEM) },
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LanguageSelector(
    current: AppLanguage,
    onSelect: (AppLanguage) -> Unit,
) {
    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LanguageOptionButton(
            label = stringResource(R.string.settings_language_system),
            selected = current == AppLanguage.SYSTEM,
            onClick = { onSelect(AppLanguage.SYSTEM) },
        )
        LanguageOptionButton(
            label = stringResource(R.string.settings_language_zh_tw),
            selected = current == AppLanguage.ZH_TW,
            onClick = { onSelect(AppLanguage.ZH_TW) },
        )
        LanguageOptionButton(
            label = stringResource(R.string.settings_language_en),
            selected = current == AppLanguage.EN,
            onClick = { onSelect(AppLanguage.EN) },
        )
    }
}

@Composable
private fun ThemeOptionButton(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    OutlinedButton(onClick = onClick) {
        Text(
            text = label,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun LanguageOptionButton(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    OutlinedButton(onClick = onClick) {
        Text(
            text = label,
            color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CreateProfileDialog(
    isLoading: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (name: String, baseUrl: String, apiKey: String, model: String, isDefault: Boolean) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var baseUrl by remember { mutableStateOf("https://openrouter.ai/api/v1") }
    var apiKey by remember { mutableStateOf("") }
    var model by remember { mutableStateOf("anthropic/claude-opus-4-7") }
    var isDefault by remember { mutableStateOf(false) }

    val isValid = name.isNotBlank() && baseUrl.isNotBlank() && apiKey.isNotBlank() && model.isNotBlank()

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_add_profile)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    providerPresets.forEach { preset ->
                        OutlinedButton(
                            onClick = {
                                name = preset.label
                                baseUrl = preset.baseUrl
                                model = preset.model
                            },
                        ) {
                            Text(preset.label)
                        }
                    }
                }

                HorizontalDivider()

                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(stringResource(R.string.settings_profile_name)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it },
                    label = { Text(stringResource(R.string.settings_profile_base_url)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it },
                    label = { Text(stringResource(R.string.settings_profile_model)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it },
                    label = { Text(stringResource(R.string.settings_profile_api_key)) },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                Row(
                    Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(stringResource(R.string.settings_set_as_default))
                    Switch(checked = isDefault, onCheckedChange = { isDefault = it })
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(name.trim(), baseUrl.trim(), apiKey.trim(), model.trim(), isDefault) },
                enabled = isValid && !isLoading,
            ) {
                if (isLoading) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.size(8.dp))
                }
                Text(stringResource(R.string.action_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isLoading) {
                Text(stringResource(R.string.action_cancel))
            }
        },
    )
}
